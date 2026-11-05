import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ChatBridge } from './chat-bridge.js';
import { output, run } from './tool-output.js';

export function registerChatTools(ctx: Context, bridge: ChatBridge) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_chat',
    description: [
      'Отвечает в проектный чат Студии Vishvakarma. Вызывайте только для сообщений из чата Студии, в которых указан requestId.',
      'action reply: обычный ответ; action ask: вопрос пользователю с вариантами options (2–8 коротких вариантов), ответ пользователя придёт новым сообщением.',
      'Передавайте requestId из сообщения и короткий содержательный ответ; не повторяйте уже отправленный ответ и не отправляйте ответ обычным сообщением в DSH.',
      'Перед изменением проекта прочитайте его инструментом vishvakarma_adapter_project и сверьте ревизию и цель; изменение допустимо только при access.canUseAgent.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ['reply', 'ask'], description: 'reply — ответ; ask — вопрос с вариантами' },
      requestId: { type: 'string', required: true, description: 'UUID запроса из сообщения чата Студии' },
      body: { type: 'string', required: true, description: 'Текст ответа или вопроса, до 4000 символов' },
      options: { type: 'array', items: { type: 'string' }, description: 'Для ask: 2–8 коротких вариантов ответа' },
    },
    output,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => run(async () => {
      const sessionId = (exec as unknown as { agent?: { id?: string } }).agent?.id;
      if (!sessionId) throw new Error('Нет исполняющей сессии DSH; ответ в чат Студии невозможен.');
      return bridge.reply(sessionId, {
        action: args.action, requestId: args.requestId, body: args.body,
        ...(Array.isArray(args.options) ? { options: args.options.map(String) } : {}),
      });
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'vishvakarma_chat_history',
    description: [
      'Возвращает последние сообщения проектного чата Студии для текущего аккаунта.',
      'Вызывайте только когда для ответа действительно нужен более ранний контекст, чем приложенные последние сообщения.',
      'limit: 1–50, по умолчанию 10. projectId можно не указывать для активного проекта сессии.',
      'Не заменяет чтение проекта и не содержит reasoning/журналов инструментов.',
    ].join(' '),
    parameters: {
      limit: { type: 'number', description: 'Сколько последних сообщений вернуть, 1–50' },
      projectId: { type: 'string', description: 'Необязательный id проекта; по умолчанию проект текущей сессии' },
    },
    output,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => run(async () => {
      const sessionId = (exec as unknown as { agent?: { id?: string } }).agent?.id;
      if (!sessionId) throw new Error('Нет исполняющей сессии DSH; история недоступна.');
      return bridge.history(sessionId, typeof args.limit === 'number' ? args.limit : 10, args.projectId);
    }),
  }));
}
