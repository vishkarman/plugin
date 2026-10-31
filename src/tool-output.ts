import { ConnectionError } from './connection.js';

export const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
export async function run(action: () => Promise<unknown>): Promise<string> {
  try { return JSON.stringify(await action()); }
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
