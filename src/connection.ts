import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_VERSION, CAPABILITY, type ServerInfo, type ProjectContext, type SavedChange, type ChangeInput } from '../contracts/index.js';

export const defaultCredentialsFile = join(homedir(), 'Library/Application Support/Vishvakarma/dev/config/plugin-credentials.json');
export interface Config { serverUrl: string; credentialsFile: string }
export interface Credentials { origin: string; installationId: string; token: string; tokenId: string }
export class ConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly revisionId?: string) { super(message); }
}
export function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw 0;
    return url.origin;
  } catch { throw new ConnectionError('CONFIGURATION', 'Укажите HTTP origin на loopback, без пути и секретов.'); }
}
export async function privateJson(file: string): Promise<unknown> {
  if (!isAbsolute(file)) throw new ConnectionError('CONFIGURATION', 'credentialsFile должен быть абсолютным путём.');
  try {
    const info = await stat(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16384) throw 0;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { throw new ConnectionError('CREDENTIALS', 'Не удалось прочитать приватный файл подключения (требуются права 0600).'); }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export async function request<T>(origin: string, path: string, token?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    });
    const data = await response.json() as any;
    if (!response.ok) {
      const codes: Record<number, [string, string]> = {
        400: ['INVALID_REQUEST', 'Сервер отклонил параметры изменения.'],
        401: ['UNAUTHORIZED', 'Доступ отсутствует или отозван. Подключитесь заново.'],
        403: ['FORBIDDEN', 'Нет доступа к этой установке или операции.'],
        404: ['NOT_FOUND', 'Проект или ресурс не найден.'],
        409: ['CONFLICT', 'Конфликт: перечитайте проект перед новым изменением.'],
        503: ['UNAVAILABLE', 'Сохранение не подтверждено. Перечитайте проект после восстановления связи.'],
      };
      const [code, message] = codes[response.status] ?? ['HTTP_ERROR', 'Сервер не подтвердил операцию.'];
      throw new ConnectionError(code, message, id(data?.error?.revisionId) ? data.error.revisionId : undefined);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(signal?.aborted ? 'CANCELLED' : 'TRANSPORT', 'Нет подтверждённого ответа сервера. Отмена или потеря связи не означает, что запись не состоялась. Перечитайте проект.');
  }
}
export async function serverInfo(origin: string, signal?: AbortSignal): Promise<ServerInfo> {
  const info = await request<ServerInfo>(origin, '/api/v1/server', undefined, undefined, signal);
  if (info.apiVersion !== API_VERSION || !id(info.installationId) || !info.capabilities?.includes(CAPABILITY))
    throw new ConnectionError('INCOMPATIBLE', 'Установка не поддерживает API этого прототипа.');
  return info;
}
export class Connection {
  readonly origin: string;
  constructor(readonly config: Config) { this.origin = originOf(config.serverUrl); }
  async credentials(signal?: AbortSignal): Promise<Credentials> {
    const credentials = await privateJson(this.config.credentialsFile) as Partial<Credentials>;
    // Check the origin before any credential-bearing request, then bind the installation.
    if (credentials.origin !== this.origin) throw new ConnectionError('RECONNECT_REQUIRED', 'Адрес изменился. Для выбранной установки требуется новое подключение.');
    if (!id(credentials.installationId) || !id(credentials.tokenId) || typeof credentials.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credentials.token))
      throw new ConnectionError('CREDENTIALS', 'Некорректный файл подключения.');
    const info = await serverInfo(this.origin, signal);
    if (info.installationId !== credentials.installationId) throw new ConnectionError('RECONNECT_REQUIRED', 'Установка изменилась. Требуется новое подключение.');
    return credentials as Credentials;
  }
  async read(signal?: AbortSignal): Promise<ProjectContext> {
    const { token } = await this.credentials(signal);
    const result = await request<ProjectContext>(this.origin, '/api/v1/projects/demo', token, undefined, signal);
    if (result.projectId !== 'demo' || !id(result.revisionId) || result.resource?.path !== 'index.html' || typeof result.resource?.content !== 'string')
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый контекст.');
    return result;
  }
  async change(baseRevisionId: string, text: string, signal?: AbortSignal): Promise<SavedChange> {
    if (!id(baseRevisionId) || [...text].length > 4096) throw new ConnectionError('INVALID_REQUEST', 'Нужна исходная UUID-ревизия и текст длиной до 4096 символов.');
    const { token } = await this.credentials(signal);
    const input: ChangeInput = { operationId: randomUUID(), baseRevisionId, operation: { type: CAPABILITY, resourcePath: 'index.html', target: 'demo-title', text } };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await request<SavedChange>(this.origin, '/api/v1/projects/demo/changes', token, input, signal);
        if (result.saved !== true || result.operationId !== input.operationId || !id(result.revisionId)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил сохранённую ревизию.');
        return result;
      } catch (error) {
        // Only a transport retry; keep the exact operationId, base, and payload.
        if (attempt !== 0 || signal?.aborted || !(error instanceof ConnectionError) || error.code !== 'TRANSPORT') throw error;
      }
    }
  }
}
