import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentChatClaim, ChatContextValue } from '../contracts/chat.js';
import type { Connection } from './connection.js';
import type { AgentPolicy } from './agent-policy.js';

type SessionBinding = { sessionId: string };
type ActiveWork = {
  requestId: string; projectId: string; sessionId: string; leaseToken: string;
  reminders: number; lastBeat: number; lastActivity?: string; lastActivityAt?: number;
};

const POLL_MS = 1_500;
const WATCH_MS = 5_000;
const BEAT_MS = 60_000;
const PRESENCE_MS = 30_000;
const MAX_REMINDERS = 2;

/** Image generation is priced by OpenRouter usage when present; otherwise use the profile hint. */
function mediaGenerationCost(args: string, resultText: string) {
  try {
    const payload = JSON.parse(resultText);
    if (typeof payload?.costUsd === 'number' && payload.costUsd > 0) return payload.costUsd;
  } catch { /* result may be an error string */ }
  try {
    const parsed = JSON.parse(args);
    return parsed.profile === 'core:final' ? 0.12 : 0.04;
  } catch { return 0.04; }
}

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
  private readonly sessionUsage = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; steps: number; toolCalls: number; mediaCostUsd: number; seen: number; turnIndex: number; pending: Map<string, { name: string; args: string }> }>();
  private readonly childParents = new Map<string, string>();
  private readonly compactingSessions = new Set<string>();
  private lastProjectId: string | null = null;
  private lastSessionId: string | null = null;
  private compacting = false;
  private lastAutoCompactAt = 0;
  private agentPresets: any = null;
  private instanceId = '';
  private accountId = '';
  private busy = false;
  private stopped = false;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly ctx: Context, private readonly connection: Connection, credentialsFile: string, private readonly policy?: AgentPolicy, private readonly contextBudget = 131_072) {
    this.stateDir = join(dirname(credentialsFile), 'chat');
    this.stateFile = join(this.stateDir, 'instance.json');
    this.bindingFile = join(this.stateDir, 'sessions.json');
    (this.ctx as any).on?.('session/event', (session: any) => this.trackSessionUsage(session));
    try { (this.ctx as any).inject?.(['agentPresets'], (child: any) => { this.agentPresets = child?.agentPresets ?? null; }); } catch { /* optional capability */ }
  }

  /** Accumulate provider usage for every session, including subagents spawned by a project turn. */
  private trackSessionUsage(session: any) {
    try {
      const raw = String(session?.id ?? session?.sessionId ?? '');
      if (!raw) return;
      const key = raw.replace(/^session-/, '');
      const events = session?.snapshotEvents?.() ?? [];
      let turnIndex = 0;
      for (let index = events.length - 1; index >= 0; index -= 1) if (events[index]?.type === 'turn/start') { turnIndex = index; break; }
      let state = this.sessionUsage.get(key);
      if (!state || state.turnIndex !== turnIndex) {
        state = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0, toolCalls: 0, mediaCostUsd: 0, seen: turnIndex, turnIndex, pending: new Map() };
        this.sessionUsage.set(key, state);
      }
      for (const event of events.slice(state.seen)) {
        if (event?.type === 'assistant/message') {
          state.steps += 1;
          const used = event.data?.usage ?? {};
          state.inputTokens += Number(used.inputTokens) || 0;
          state.outputTokens += Number(used.outputTokens) || 0;
          state.cacheReadTokens += Number(used.cacheReadTokens) || 0;
          state.cacheWriteTokens += Number(used.cacheWriteTokens) || 0;
        }
        if (event?.type === 'subagent/catalog' && event.data?.childId) this.childParents.set(String(event.data.childId).replace(/^session-/, ''), key);
        if (event?.type === 'tool/result') {
          const started = JSON.stringify(event.data?.message?.content ?? '');
          for (const match of started.matchAll(/started subagent ([0-9a-f-]{36})/g)) this.childParents.set(match[1], key);
        }
        if (event?.type === 'tool/call') {
          state.toolCalls += 1;
          const callId = String(event.data?.callId ?? '');
          if (callId) state.pending.set(callId, { name: String(event.data?.name ?? ''), args: String(event.data?.arguments ?? '') });
          this.publishActivity(key, String(event.data?.name ?? ''), String(event.data?.arguments ?? ''));
        }
        if (event?.type === 'tool/result') {
          const callId = String(event.data?.message?.toolCallId ?? event.data?.toolCallId ?? '');
          const call = callId ? state.pending.get(callId) : undefined;
          if (call?.name === 'vishvakarma_generate_image') {
            const text = (event.data?.message?.content ?? []).map((block: any) => block?.text ?? '').join(' ');
            state.mediaCostUsd += mediaGenerationCost(call.args, text);
            state.pending.delete(callId);
          }
        }
      }
      state.seen = events.length;
    } catch { /* usage is advisory */ }
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
      randomUUID(), input.action === 'ask' ? input.options ?? ['Да', 'Нет'] : undefined, this.traceFor(work.sessionId), this.usageFor(work.sessionId));
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
    try {
      const context = await this.measureContext();
      await this.connection.chatPresence(this.instanceId, online, context ?? undefined);
    } catch { /* reconnect later */ }
  }

  private async measureContext(): Promise<{ projectId: string; totalTokens: number; contextWindow?: number; contextBudget?: number; compacting?: boolean } | null> {
    if (!this.lastProjectId || !this.lastSessionId) return null;
    try {
      const found = await this.resolveAgentAny(this.lastSessionId);
      const agent = found && !('error' in found) ? found.agent : null;
      const session = agent?.session ?? null;
      const meter = this.ctx.get('tokenMeter') as any;
      const measured = session && meter?.measure ? await Promise.resolve(meter.measure(session)) : null;
      let provider = '', model = '', contextWindow: number | undefined;
      for (const event of (session?.snapshotEvents?.() ?? []) as any[]) {
        if (event?.type === 'request/context') {
          const window = Number(event.data?.contextWindow);
          if (Number.isInteger(window) && window > 0) contextWindow = window;
        }
        if (event?.type === 'request/header') {
          const config = event.data?.header?.config;
          if (typeof config?.provider === 'string' && typeof config?.model === 'string') { provider = config.provider; model = config.model; }
        }
      }
      const llm = this.ctx.get('llm') as any;
      const info = provider && model && typeof llm?.resolveModelInfo === 'function'
        ? await Promise.resolve(llm.resolveModelInfo(provider, model)).catch(() => null) : null;
      contextWindow = contextWindow ?? (Number(info?.context?.contextWindow) || undefined);
      if (!contextWindow) {
        const projections = this.ctx.get('sessionProjections') as any;
        const snapshot = session && projections?.snapshot ? await Promise.resolve(projections.snapshot(session)).catch(() => null) : null;
        contextWindow = Number(snapshot?.contextPressure?.contextWindow) || undefined;
      }
      const totalTokens = Math.max(0, Number(measured?.totalTokens) || 0);
      if (totalTokens > this.contextBudget && this.active.size === 0 && !this.compacting && Date.now() - this.lastAutoCompactAt > 60_000) {
        this.lastAutoCompactAt = Date.now();
        void this.autoCompact(agent);
      }
      return { projectId: this.lastProjectId, totalTokens, ...(contextWindow ? { contextWindow } : {}), contextBudget: this.contextBudget, compacting: this.compactingSessions.has(this.lastSessionId.replace(/^session-/, '')) };
    } catch { return null; }
  }

  /** The compaction engine belongs to the preset revision held by this agent. */
  private compactionEngine(agent: any) {
    try {
      const presets = this.agentPresets ?? this.ctx.get('agentPresets');
      return presets?.serviceFor?.(agent, 'compaction') ?? null;
    } catch { return null; }
  }

  /** One serialized compaction attempt; DSH owns the summary and durable checkpoint. */
  private async autoCompact(agent: any) {
    if (this.compacting || !agent) return;
    this.compacting = true;
    try {
      const engine = this.compactionEngine(agent);
      if (typeof engine?.compactNow !== 'function') return;
      await engine.compactNow(agent, AbortSignal.timeout(120_000));
    } catch { /* busy or transport: retry after the interval */ }
    finally { this.compacting = false; }
  }

  private async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!this.accountId) this.accountId = (await this.connection.account()).id;
      const next = await this.connection.agentChatNext();
      if (!next) { await this.presence(true); return; }
      const session = await this.sessionFor(next.projectId);
      const reconcile = next.status === 'reconciling';
      const claimed = await this.connection.claimChat(next.id, session.sessionId, this.instanceId, reconcile);
      if (!claimed) return;
      if (claimed.reconcile) {
        // Do not deliver again: the previous worker may have already run this request.
        await this.connection.chatReconcile(claimed.id, claimed.leaseToken, session.sessionId, 'unknown').catch(() => {});
        return;
      }
      await this.deliver(claimed, session.sessionId, session.fresh);
    } catch (error) {
      this.ctx.logger?.warn?.('vishvakarma chat: ' + String(error));
    } finally {
      this.busy = false;
    }
  }

  private async sessionFor(projectId: string): Promise<{ sessionId: string; fresh: boolean }> {
    const controller = this.ctx.get('sessionController') as any;
    if (!controller || typeof controller.create !== 'function') throw new Error('sessionController недоступен в этой сборке DSH');
    const { installationId } = await this.connection.credentials();
    const key = installationId + ':' + this.accountId + ':' + projectId;
    const saved = this.bindings[key];
    if (saved) {
      const found = await controller.resolveAgent(saved);
      if (found && !('error' in found)) { this.lastProjectId = projectId; this.lastSessionId = saved; return { sessionId: saved, fresh: false }; }
      const reason = String(found?.error?.message ?? 'неизвестная ошибка');
      // An occupied or restoring session must never be replaced by a second one.
      if (!/not found|unknown session|missing|не найдена|нет сессии/i.test(reason)) throw new Error('сессия проекта недоступна: ' + reason);
      delete this.bindings[key];
      await this.writeJson(this.bindingFile, { bindings: this.bindings });
    }
    const workspaceDir = join(this.stateDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    const created = await controller.create({ cwd: workspaceDir });
    const sessionId = String(created.sessionId);
    if (typeof controller.rename === 'function') await Promise.resolve(controller.rename({ sessionId, title: 'Vishvakarma' })).catch(() => {});
    this.bindings[key] = sessionId;
    this.lastProjectId = projectId;
    this.lastSessionId = sessionId;
    await this.writeJson(this.bindingFile, { bindings: this.bindings });
    return { sessionId, fresh: true };
  }

  private async deliver(claimed: AgentChatClaim, sessionId: string, fresh: boolean) {
    const controller = this.ctx.get('sessionController') as any;
    await this.applyEffort(sessionId, claimed.effort);
    const found = await controller.resolveAgent(sessionId);
    if (!found || 'error' in found) throw new Error('сессия проекта недоступна перед доставкой');
    const history = await this.connection.chatHistory(claimed.projectId, fresh ? 4 : 3).catch(() => ({ items: [] }));
    const previous = history.items.filter(item => item.id !== claimed.messageId).slice(fresh ? -4 : -2);
    const text = chatPrompt(claimed, previous, fresh);
    const message = Object.freeze({
      id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'vishvakarma-chat', requestId: claimed.id },
    });
    this.policy?.begin(claimed.id, claimed.projectId, claimed.message);
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

  /** Change the reasoning effort on the existing session through DSH's session-local model selection. */
  private async applyEffort(sessionId: string, effort: 'normal' | 'max') {
    try {
      const controller = this.ctx.get('sessionController') as any;
      if (!controller || typeof controller.selectModel !== 'function') return;
      const found = await controller.resolveAgent(sessionId);
      if (!found || 'error' in found) return;
      const events = found.agent?.session?.snapshotEvents?.() ?? [];
      let route: { provider: string; model: string } | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const header = events[i]?.type === 'request/header' ? events[i]?.data?.header : undefined;
        const config = header?.config;
        if (typeof config?.provider === 'string' && typeof config?.model === 'string') { route = { provider: config.provider, model: config.model }; break; }
      }
      const llm = this.ctx.get('llm') as any;
      if (!route && llm?.listProviders) {
        // A brand-new session has no request yet: use the catalog only when it is unambiguous.
        const providers = await Promise.resolve(llm.listProviders());
        const candidates: Array<{ provider: string; model: string }> = [];
        for (const provider of providers ?? []) {
          const models = await Promise.resolve(llm.listModels(provider.id));
          for (const model of models ?? []) candidates.push({ provider: provider.id, model: model.id ?? model.name });
        }
        if (candidates.length === 1) route = candidates[0];
      }
      if (!route) return;
      let target: string | undefined;
      const info = typeof llm?.resolveModelInfo === 'function' ? await Promise.resolve(llm.resolveModelInfo(route.provider, route.model)).catch(() => null) : null;
      const efforts = info?.reasoning?.efforts ?? [];
      if (effort === 'max') target = efforts.find((item: any) => item.id === 'max')?.id ?? efforts.at?.(-1)?.id;
      else target = efforts.find((item: any) => item.id === 'medium')?.id
        ?? efforts.find((item: any) => item.id === 'low')?.id
        ?? info?.reasoning?.defaultEffort;
      if (effort === 'max' && !target) return;
      await Promise.resolve(controller.selectModel({ sessionId, provider: route.provider, model: route.model, ...(target ? { reasoningEffort: target } : {}) }));
    } catch (error) {
      this.ctx.logger?.warn?.('vishvakarma chat: не удалось переключить effort: ' + String(error));
    }
  }

  /** Send one throttled, factual line about the current tool action, including child subagents. */
  private publishActivity(sessionId: string, toolName: string, args = '') {
    try {
      const bare = sessionId.replace(/^session-/, '');
      let work = [...this.active.values()].find(item => item.sessionId.replace(/^session-/, '') === bare);
      let prefix = '';
      if (!work) {
        const parent = this.childParents.get(bare);
        if (!parent) return;
        work = [...this.active.values()].find(item => item.sessionId.replace(/^session-/, '') === parent);
        prefix = 'субагент: ';
      }
      if (!work) return;
      const labels: Record<string, string> = {
        vishvakarma_adapter_project: 'читает проект', read_image: 'смотрит изображения', bash: 'выполняет команды',
        write: 'меняет исходники', patch: 'меняет исходники', edit: 'меняет исходники',
        vishvakarma_write_files: 'меняет исходники', vishvakarma_editor: 'меняет исходники', vishvakarma_edit_target: 'меняет исходники',
        vishvakarma_import_files: 'публикует файлы',
        vishvakarma_preview: 'проверяет предпросмотр', vishvakarma_build: 'проверяет сборку',
        vishvakarma_generate_image: 'генерирует изображение', vishvakarma_media_profiles: 'смотрит профили генерации',
        subagent: 'запускает субагента', todo_write: 'обновляет план', list_agents: 'координирует субагентов', send_message: 'координирует субагентов',
      };
      const label = labels[toolName];
      if (!label) return;
      const waiting = toolName === 'bash' && /sleep\s+\d+|wait\s+for|подожд/i.test(args);
      const next = prefix + (waiting ? (prefix ? 'ждёт завершения' : 'ждёт субагента') : label);
      if (next === work.lastActivity && Date.now() - (work.lastActivityAt ?? 0) < 2500) return;
      work.lastActivity = next; work.lastActivityAt = Date.now();
      void this.connection.chatActivity(work.requestId, work.leaseToken, work.sessionId, next).catch(() => {});
    } catch { /* activity is advisory */ }
  }

  /** Provider usage and step counts for the current turn, including child subagent sessions. */
  private usageFor(sessionId: string) {
    try {
      const agents = this.ctx.get('agents') as any;
      const events = agents?.get?.(sessionId)?.session?.snapshotEvents?.() ?? [];
      let start = 0;
      for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'turn/start') { start = i; break; }
      const parentEvents = events.slice(start);
      const own = this.sessionUsage.get(sessionId.replace(/^session-/, ''));
      const usage = { inputTokens: own?.inputTokens ?? 0, outputTokens: own?.outputTokens ?? 0,
        cacheReadTokens: own?.cacheReadTokens ?? 0, cacheWriteTokens: own?.cacheWriteTokens ?? 0,
        steps: own?.steps ?? 0, toolCalls: own?.toolCalls ?? 0, mediaCostUsd: own?.mediaCostUsd ?? 0 };
      if (!usage.steps) {
        for (const event of parentEvents) {
          if (event?.type === 'assistant/message') {
            usage.steps += 1;
            const used = event.data?.usage ?? {};
            usage.inputTokens += Number(used.inputTokens) || 0;
            usage.outputTokens += Number(used.outputTokens) || 0;
            usage.cacheReadTokens += Number(used.cacheReadTokens) || 0;
            usage.cacheWriteTokens += Number(used.cacheWriteTokens) || 0;
          }
          if (event?.type === 'tool/call') usage.toolCalls += 1;
        }
      }
      const children = new Set<string>();
      for (const event of parentEvents) {
        if (event?.type === 'subagent/catalog' && event.data?.childId) children.add(String(event.data.childId));
        if (event?.type === 'tool/result') {
          const text = JSON.stringify(event.data?.message?.content ?? '');
          for (const match of text.matchAll(/started subagent ([0-9a-f-]{36})/g)) children.add(match[1]);
        }
      }
      for (const child of children) {
        const used = this.sessionUsage.get(child);
        if (!used) continue;
        usage.inputTokens += used.inputTokens; usage.outputTokens += used.outputTokens;
        usage.cacheReadTokens += used.cacheReadTokens; usage.cacheWriteTokens += used.cacheWriteTokens;
        usage.steps += used.steps; usage.toolCalls += used.toolCalls; usage.mediaCostUsd += used.mediaCostUsd;
      }
      return usage.steps ? { ...usage, subagents: children.size } : undefined;
    } catch { return undefined; }
  }

  /** On-demand project chat history for the agent; the bridge caps the response size. */
  async history(sessionId: string, limit = 10, projectId?: string) {
    const target = projectId ?? this.projectForSession(sessionId);
    if (!target) throw new Error('Нет активного проекта для этой сессии; укажите projectId.');
    const safe = Math.min(50, Math.max(1, Math.trunc(limit) || 10));
    const result = await this.connection.chatHistory(target, safe);
    return { projectId: target, items: result.items.map(item => ({ role: item.role, createdAt: item.createdAt, body: item.body.slice(0, 400) })) };
  }

  private projectForSession(sessionId: string): string | null {
    for (const [key, value] of Object.entries(this.bindings)) if (value === sessionId) return key.split(':').slice(2).join(':');
    return null;
  }

  /** Compact user-facing trace of what the agent did in this turn; never raw reasoning. */
  private traceFor(sessionId: string): Array<{ label: string; detail?: string }> {
    try {
      const agents = this.ctx.get('agents') as any;
      const events = agents?.get?.(sessionId)?.session?.snapshotEvents?.() ?? [];
      let start = 0;
      for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'turn/start') { start = i; break; }
      const counts = new Map<string, number>();
      const order: string[] = [];
      const add = (label: string) => { if (!counts.has(label)) order.push(label); counts.set(label, (counts.get(label) ?? 0) + 1); };
      const map: Record<string, string> = {
        vishvakarma_adapter_project: 'прочитал проект', read_image: 'посмотрел изображения', bash: 'выполнил shell-команды',
        write: 'изменил файлы', patch: 'изменил файлы', edit: 'изменил файлы',
        vishvakarma_write_files: 'изменил исходники', vishvakarma_editor: 'изменил элемент', vishvakarma_edit_target: 'изменил элемент',
        vishvakarma_preview: 'проверил предпросмотр', vishvakarma_build: 'проверил сборку',
        subagent: 'запустил субагента', todo_write: 'обновил план', list_agents: 'координировал субагентов', send_message: 'координировал субагентов',
        vishvakarma_history: 'посмотрел историю версий', vishvakarma_comments: 'посмотрел обсуждения',
        vishvakarma_generate_image: 'сгенерировал изображение', vishvakarma_media_profiles: 'посмотрел профили генерации',
      };
      for (const event of events.slice(start)) {
        if (event?.type !== 'tool/call') continue;
        const name = String(event.data?.name ?? '');
        if (!name || name === 'skill' || name === 'vishvakarma_chat') continue;
        add(map[name] ?? 'выполнил действие');
      }
      return order.slice(0, 8).map(label => { const n = counts.get(label) ?? 0; return n > 1 ? { label: label + ' ×' + n } : { label }; });
    } catch { return []; }
  }

  private async resolveAgentAny(sessionId: string) {
    const controller = this.ctx.get('sessionController') as any;
    if (!controller?.resolveAgent) return null;
    const bare = sessionId.replace(/^session-/, '');
    for (const candidate of [sessionId, bare, 'session-' + bare]) {
      try {
        const found = await controller.resolveAgent(candidate);
        if (found && !('error' in found)) return found;
      } catch { /* try the next identity form */ }
    }
    return null;
  }

  /** Child subagent sessions started from a parent turn, read from the durable catalog. */
  private childSessions(sessionId: string): string[] {
    try {
      const agents = this.ctx.get('agents') as any;
      const bare = sessionId.replace(/^session-/, '');
      const agent = agents?.get?.(sessionId) ?? agents?.get?.(bare) ?? agents?.get?.('session-' + bare);
      const events = agent?.session?.snapshotEvents?.() ?? [];
      const ids = new Set<string>();
      for (const event of events) {
        if (event?.type === 'subagent/catalog' && event.data?.childId) ids.add(String(event.data.childId));
        if (event?.type === 'tool/result') {
          const text = JSON.stringify(event.data?.message?.content ?? '');
          for (const match of text.matchAll(/started subagent ([0-9a-f-]{36})/g)) ids.add(match[1]);
        }
      }
      return [...ids];
    } catch { return []; }
  }

  /** Feature-detect the live agent cancellation surface across DSH builds. */
  private async stopAgent(sessionId: string) {
    try {
      const controller = this.ctx.get('sessionController') as any;
      for (const child of this.childSessions(sessionId)) {
        for (const candidate of [child, 'session-' + child.replace(/^session-/, '')]) {
          try { await this.stopAgent(candidate); } catch { /* child is optional */ }
        }
      }
      const found = await this.resolveAgentAny(sessionId);
      const agent = found && !('error' in found) ? found.agent : null;
      const names = ['interrupt', 'abort', 'cancelTurn', 'abortTurn', 'interruptTurn', 'stopTurn', 'cancel', 'stop'];
      for (const target of [agent, agent?.session]) {
        if (!target) continue;
        for (const method of names) {
          if (typeof target[method] !== 'function') continue;
          try { await Promise.resolve(target[method]()); return true; } catch { /* try the next surface */ }
        }
      }
      for (const method of ['cancel', 'interrupt', 'cancelTurn', 'abort', 'stop']) {
        if (typeof controller?.[method] !== 'function') continue;
        try { await Promise.resolve(controller[method]({ sessionId })); return true; } catch { /* try the next surface */ }
      }
      this.ctx.logger?.warn?.('vishvakarma chat: не найден способ остановить агента в этой сборке DSH');
      return false;
    } catch (error) {
      this.ctx.logger?.warn?.('vishvakarma chat: остановка агента не удалась: ' + String(error));
      return false;
    }
  }

  private async beatActive() {
    if (this.stopped) return;
    const agents = this.ctx.get('agents') as any;
    for (const work of this.active.values()) {
      try {
        const current = await this.connection.chatRequestStatus(work.requestId).catch(() => ({ status: null }));
        if (current.status === 'cancelled') {
          await this.stopAgent(work.sessionId);
          this.active.delete(work.requestId);
          continue;
        }
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

function chatPrompt(request: AgentChatClaim, previous: { role: string; body: string }[], fresh: boolean) {
  const history = previous.slice(-(fresh ? 4 : 2)).map(item =>
    (item.role === 'user' ? 'Пользователь: ' : item.role === 'agent' ? 'Агент: ' : 'Система: ') + item.body.slice(0, 400));
  return [
    'Сообщение из чата Vishvakarma по проекту «' + request.projectId + '».',
    '',
    'Текущее сообщение пользователя:',
    request.message.slice(0, 4000),
    '',
    'Что видит пользователь сейчас:',
    ...contextLines(request.context),
    ...(history.length ? ['', fresh ? 'Контекст начала чата:' : 'Предыдущие сообщения для непрерывности:', ...history] : []),
    '',
    'Принципы работы:',
    '1. Выполни именно текущее поручение. Каждый шаг либо создаёт запрошенный результат, либо устраняет конкретную неопределённость, мешающую его получить или принять.',
    '2. Выбирай наименее затратный пригодный способ. Дополнительное качество, расширение области и повторная дорогая операция требуют основания в текущем сообщении; прошлые сообщения такого разрешения не продлевают.',
    '3. При ошибке инструмента не повторяй дорогую операцию и не заменяй её самодельной (PIL/SVG/другим провайдером). Проверь, не сохранился ли результат, останови зависимые правки и сообщи пользователю.',
    '4. Заканчивай, когда согласованные свойства результата подтверждены. Не придумывай новую цель и не полируй то, о чём не просили.',
    '',
    'Практически: для одной цели используй vishvakarma_read_target и vishvakarma_edit_target; не читай проект целиком и не дублируй проверки bash. Готовые локальные файлы публикуй через vishvakarma_import_files. Ответь в чат Студии через vishvakarma_chat action reply (или ask) с requestId ' + request.id + '; обычным сообщением DSH не отвечай. Пиши по-русски, мужской род, без технических ID/ревизий и без повтора текста пользователя.',
  ].join('\n');
}
