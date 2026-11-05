import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentChatClaim, ChatContextValue } from '../contracts/chat.js';
import type { Connection } from './connection.js';

type SessionBinding = { sessionId: string };
type ActiveWork = {
  requestId: string; projectId: string; sessionId: string; leaseToken: string;
  reminders: number; lastBeat: number;
};

const POLL_MS = 1_500;
const WATCH_MS = 5_000;
const BEAT_MS = 60_000;
const PRESENCE_MS = 30_000;
const MAX_REMINDERS = 2;

/**
 * Host bridge between the Vishvakarma project chat and one DSH session per project.
 *
 * Responsibilities: claim one queued request with a lease, ensure/renew only its own session,
 * deliver a frozen context prompt, let the agent answer through the `vishvakarma_chat` tool, and
 * report presence. It never keeps project history and never starts another agent runtime.
 */
export class ChatBridge {
  private readonly stateDir: string;
  private readonly bindingFile: string;
  private readonly stateFile: string;
  private bindings: Record<string, string> = {};
  private readonly active = new Map<string, ActiveWork>();
  private instanceId = '';
  private accountId = '';
  private busy = false;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly ctx: Context, private readonly connection: Connection, credentialsFile: string) {
    this.stateDir = join(dirname(credentialsFile), 'chat');
    this.stateFile = join(this.stateDir, 'instance.json');
    this.bindingFile = join(this.stateDir, 'sessions.json');
  }

  start(): () => void {
    void this.initialize().then(() => {
      if (this.stopped) return;
      this.timers.push(setInterval(() => void this.tick(), POLL_MS));
      this.timers.push(setInterval(() => void this.presence(true), PRESENCE_MS));
      this.timers.push(setInterval(() => void this.beatActive(), WATCH_MS));
    }).catch(error => { this.ctx.logger?.warn?.('vishvakarma chat: инициализация моста не удалась: ' + String(error)); });
    return () => {
      this.stopped = true;
      for (const timer of this.timers) clearInterval(timer);
      this.timers = [];
      void this.presence(false);
    };
  }

  /** Called by the agent tool; the executing session must own the active request. */
  async reply(sessionId: string, input: { action: 'reply' | 'ask'; requestId: string; body: string; options?: string[] }) {
    const work = this.active.get(input.requestId);
    if (!work || work.sessionId !== sessionId) throw new Error('Запрос не принадлежит этой сессии DSH или уже завершён. Не повторяйте ответ.');
    const result = await this.connection.chatAnswer(input.requestId, work.leaseToken, work.sessionId, input.body,
      randomUUID(), input.action === 'ask' ? input.options ?? ['Да', 'Нет'] : undefined);
    this.active.delete(input.requestId);
    return { answered: true, requestId: input.requestId, messageId: result.message.id };
  }

  private async initialize() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try { this.instanceId = JSON.parse(await readFile(this.stateFile, 'utf8')).instanceId; } catch { /* first run */ }
    if (!this.instanceId) {
      this.instanceId = randomUUID();
      await this.writeJson(this.stateFile, { instanceId: this.instanceId });
    }
    try { this.bindings = JSON.parse(await readFile(this.bindingFile, 'utf8')).bindings ?? {}; } catch { this.bindings = {}; }
  }

  private async writeJson(file: string, value: unknown) {
    await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  private async presence(online: boolean) {
    if (!this.instanceId) return;
    try { await this.connection.chatPresence(this.instanceId, online); } catch { /* reconnect later */ }
  }

  private async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!this.accountId) this.accountId = (await this.connection.account()).id;
      const next = await this.connection.agentChatNext();
      if (!next) { await this.presence(true); return; }
      const sessionId = await this.sessionFor(next.projectId);
      const claimed = await this.connection.claimChat(next.id, sessionId, this.instanceId);
      if (!claimed) return;
      await this.deliver(claimed, sessionId);
    } catch (error) {
      this.ctx.logger?.warn?.('vishvakarma chat: ' + String(error));
    } finally {
      this.busy = false;
    }
  }

  private async sessionFor(projectId: string) {
    const controller = this.ctx.get('sessionController') as any;
    if (!controller || typeof controller.create !== 'function') throw new Error('sessionController недоступен в этой сборке DSH');
    const { installationId } = await this.connection.credentials();
    const key = installationId + ':' + this.accountId + ':' + projectId;
    const saved = this.bindings[key];
    if (saved) {
      const found = await controller.resolveAgent(saved);
      if (found && !('error' in found)) return saved;
      // Occupied, restoring, or transient failures must not be replaced by a second session.
      throw new Error('сессия проекта недоступна: ' + String(found?.error?.message ?? 'неизвестная ошибка'));
    }
    const workspaceDir = join(this.stateDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    const created = await controller.create({ cwd: workspaceDir });
    const sessionId = String(created.sessionId);
    if (typeof controller.rename === 'function') await Promise.resolve(controller.rename({ sessionId, title: 'Vishvakarma' })).catch(() => {});
    this.bindings[key] = sessionId;
    await this.writeJson(this.bindingFile, { bindings: this.bindings });
    return sessionId;
  }

  private async deliver(claimed: AgentChatClaim, sessionId: string) {
    const controller = this.ctx.get('sessionController') as any;
    const found = await controller.resolveAgent(sessionId);
    if (!found || 'error' in found) throw new Error('сессия проекта недоступна перед доставкой');
    const history = await this.connection.chatHistory(claimed.projectId).catch(() => ({ items: [] }));
    const text = chatPrompt(claimed, history.items);
    const message = Object.freeze({
      id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'vishvakarma-chat', requestId: claimed.id },
    });
    found.agent.followup(message);
    const sessions = this.ctx.get('sessions') as any;
    if (sessions?.flush) await sessions.flush(found.agent.session);
    await this.connection.chatDelivered(claimed.id, claimed.leaseToken, sessionId);
    await this.connection.chatWorking(claimed.id, claimed.leaseToken, sessionId);
    this.active.set(claimed.id, {
      requestId: claimed.id, projectId: claimed.projectId, sessionId, leaseToken: claimed.leaseToken,
      reminders: 0, lastBeat: Date.now(),
    });
  }

  private async beatActive() {
    if (this.stopped) return;
    const agents = this.ctx.get('agents') as any;
    for (const work of this.active.values()) {
      try {
        if (Date.now() - work.lastBeat >= BEAT_MS) {
          await this.connection.chatWorking(work.requestId, work.leaseToken, work.sessionId);
          work.lastBeat = Date.now();
        }
        const agent = agents?.get?.(work.sessionId);
        if (agent?.status === 'running') continue;
        if (work.reminders < MAX_REMINDERS) {
          work.reminders += 1;
          const found = await (this.ctx.get('sessionController') as any).resolveAgent(work.sessionId);
          if (found && !('error' in found)) {
            found.agent.followup(Object.freeze({
              id: randomUUID(), role: 'user', content: [{ type: 'text',
                text: 'Напоминание: пользователь ждёт ответа в чате Vishvakarma. Ответь инструментом vishvakarma_chat action reply с requestId ' + work.requestId + ', хотя бы коротко. Не повторяй работу.' }],
              source: { kind: 'vishvakarma-chat-reminder', requestId: work.requestId },
            }));
            const sessions = this.ctx.get('sessions') as any;
            if (sessions?.flush) await sessions.flush(found.agent.session);
          }
        } else {
          await this.connection.chatFailed(work.requestId, work.leaseToken, work.sessionId, 'агент завершил ход без ответа; отправьте сообщение заново');
          this.active.delete(work.requestId);
        }
      } catch (error) {
        this.ctx.logger?.warn?.('vishvakarma chat: контроль ответа: ' + String(error));
      }
    }
  }
}

function contextLines(context: ChatContextValue) {
  const lines = ['Проект: ' + context.projectId, 'Ревизия: ' + context.revisionId];
  if (context.artboardEntrypoint) lines.push('Страница: ' + context.artboardEntrypoint + (context.artboardId ? ' (' + context.artboardId + ')' : ''));
  if (context.targetId) lines.push('Выбранный объект: «' + (context.targetLabel ?? context.targetId) + '» (targetId ' + context.targetId + ')');
  else lines.push('Выбран проект без конкретного объекта.');
  return lines;
}

function chatPrompt(request: AgentChatClaim, history: { role: string; body: string }[]) {
  const recent = history.slice(-20).map(item => (item.role === 'user' ? 'Пользователь: ' : item.role === 'agent' ? 'Агент: ' : 'Система: ') + item.body.slice(0, 500));
  return [
    'Сообщение из чата Vishvakarma по проекту «' + request.projectId + '».',
    '',
    'Что видит пользователь сейчас:',
    ...contextLines(request.context),
    '',
    ...(recent.length ? ['Последние сообщения проектного чата:', ...recent, ''] : []),
    'Прочитай проект инструментом vishvakarma_adapter_project (action: read) и сверь ревизию и цель перед правкой.',
    'Это запрос ' + request.id + '. Ответь пользователю в проектном чате инструментом vishvakarma_chat: action reply (или action ask с options, если нужен выбор) и requestId ' + request.id + '.',
    'Не отправляй сам ответ обычным сообщением: пользователь читает чат Студии.',
    'Изменения допустимы только при access.canUseAgent по текущим правам.',
  ].join('\n');
}
