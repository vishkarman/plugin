import { ConnectionError } from './connection.js';

export const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
const MAX_OUTPUT_CHARS = 120_000;
export async function run(action: () => Promise<unknown>): Promise<string> {
  try {
    const text = JSON.stringify(await action());
    if (text.length > MAX_OUTPUT_CHARS) return JSON.stringify({ truncated: true, originalChars: text.length,
      hint: 'Результат сокращён. Используйте vishvakarma_read_target или более узкий запрос.',
      preview: text.slice(0, 40_000) });
    return text;
  }
  catch (error) {
    return JSON.stringify({ error: error instanceof ConnectionError ? {
      code: error.code, message: error.message,
      ...(error.revisionId ? { revisionId: error.revisionId } : {}),
      ...(error.operationId ? { operationId: error.operationId } : {}),
      ...(error.details.baseRevisionId ? { baseRevisionId: error.details.baseRevisionId } : {}),
      ...(error.details.conflicts ? { conflicts: error.details.conflicts } : {}),
    } : { code: 'UNCONFIRMED', message: 'Результат не подтверждён. Перечитайте проект.' } });
  }
}
