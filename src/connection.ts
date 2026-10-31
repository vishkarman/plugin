import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_VERSION, CAPABILITY, type ServerInfo, type ProjectContext, type SavedChange, type ChangeInput } from '../contracts/index.js';
import { ADAPTER_CAPABILITY, ADAPTER_REBASE_CAPABILITY, type AdapterExample, type AdapterProjectContext, type AdapterChangeInput, type AdapterSavedChange, type AdapterChangeCheck, type ChangeConflict, type SourcePathName, type ExampleKey } from '../contracts/adapters.js';
import type { BuildInfo } from '../contracts/runner.js';

export const defaultCredentialsFile = join(homedir(), 'Library/Application Support/Vishvakarma/dev/config/plugin-credentials.json');
export interface Config { serverUrl: string; credentialsFile: string }
export interface Credentials { origin: string; installationId: string; token: string; tokenId: string }
interface ConflictDetails { baseRevisionId?: string; conflicts?: ChangeConflict[] }
export interface AdapterChangeOptions { action?: 'check' | 'apply'; operationId?: string }
export class ConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly revisionId?: string, readonly operationId?: string,
    readonly details: ConflictDetails = {}) { super(message); }
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
const sourcePath = (value: unknown): value is SourcePathName => value === 'index.html' || value === 'main.tsx' || value === 'style.css';
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function conflictsOf(value: unknown): ChangeConflict[] {
  if (!Array.isArray(value)) return [];
  const result: ChangeConflict[] = [];
  for (const item of value.slice(0, 3)) {
    if (!item || typeof item !== 'object' || !sourcePath(item.path) || !hash(item.baseHash) || !hash(item.currentHash)) continue;
    if (item.code === 'FILE_CHANGED') result.push({ path: item.path, code: item.code, baseHash: item.baseHash, currentHash: item.currentHash });
    else if (item.code === 'BASE_HASH_MISMATCH' && hash(item.expectedHash))
      result.push({ path: item.path, code: item.code, baseHash: item.baseHash, currentHash: item.currentHash, expectedHash: item.expectedHash });
  }
  return result;
}
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
      if (path.startsWith('/api/v1/adapters/') && ((response.status === 409 && data?.error?.code === 'CHANGE_CONFLICT')
        || (response.status === 400 && data?.error?.code === 'RESOURCE_CONFLICT'))) {
        const error = data.error;
        throw new ConnectionError(error.code, error.code === 'CHANGE_CONFLICT'
          ? 'Изменяемый файл изменился после чтения. Ничего не сохранено: перечитайте проект и переоцените правку, не подменяйте базу или хеши для повтора.'
          : 'Хеш файла не совпадает с указанной базовой ревизией. Ничего не сохранено: перечитайте исходники и проверьте запрос.',
        id(error.revisionId) ? error.revisionId : undefined, undefined, {
          ...(id(error.baseRevisionId) ? { baseRevisionId: error.baseRevisionId } : {}),
          conflicts: conflictsOf(error.conflicts),
        });
      }
      const codes: Record<number, [string, string]> = {
        400: ['INVALID_REQUEST', 'Сервер отклонил параметры изменения.'],
        401: ['UNAUTHORIZED', 'Доступ отсутствует или отозван. Подключитесь заново.'],
        403: ['FORBIDDEN', 'Нет доступа к этой установке или операции.'],
        404: ['NOT_FOUND', 'Проект или ресурс не найден.'],
        409: ['CONFLICT', 'Конфликт: перечитайте проект перед новым изменением.'],
        422: ['UNSUPPORTED_OPERATION', 'Адаптер не может выполнить изменение. Перечитайте цель и её доступные операции; для других изменений используйте исходники.'],
        429: ['QUEUE_FULL', 'Очередь сборок заполнена. Дождитесь завершения текущей сборки.'],
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
  async credentials(signal?: AbortSignal, capability?: string): Promise<Credentials> {
    const credentials = await privateJson(this.config.credentialsFile) as Partial<Credentials>;
    // Check the origin before any credential-bearing request, then bind the installation.
    if (credentials.origin !== this.origin) throw new ConnectionError('RECONNECT_REQUIRED', 'Адрес изменился. Для выбранной установки требуется новое подключение.');
    if (!id(credentials.installationId) || !id(credentials.tokenId) || typeof credentials.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credentials.token))
      throw new ConnectionError('CREDENTIALS', 'Некорректный файл подключения.');
    const info = await serverInfo(this.origin, signal);
    if (info.installationId !== credentials.installationId) throw new ConnectionError('RECONNECT_REQUIRED', 'Установка изменилась. Требуется новое подключение.');
    if (capability && !info.capabilities.includes(capability))
      throw new ConnectionError('INCOMPATIBLE', capability === ADAPTER_REBASE_CAPABILITY
        ? 'Сервер не поддерживает проверку параллельных правок. Требуется adapters.checked-rebase.v1; обновите сервер до прототипа 5.'
        : 'Сервер не поддерживает адаптеры исходников. Требуется adapters.source-editing.v1.');
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
  async adapterExamples(signal?: AbortSignal): Promise<{ examples: AdapterExample[] }> {
    const { token } = await this.credentials(signal, ADAPTER_CAPABILITY);
    const result = await request<{ examples: AdapterExample[] }>(this.origin, '/api/v1/adapters/examples', token, undefined, signal);
    if (!Array.isArray(result.examples) || result.examples.some(example => !exampleKey(example.id) || typeof example.name !== 'string'))
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый список примеров.');
    return result;
  }
  async adapterProject(projectId: ExampleKey, open: boolean, targetId?: string, signal?: AbortSignal): Promise<AdapterProjectContext> {
    if (!exampleKey(projectId) || (targetId !== undefined && (!targetId || targetId.length > 256)))
      throw new ConnectionError('INVALID_REQUEST', 'Нужен существующий пример и допустимый идентификатор цели.');
    const { token } = await this.credentials(signal, ADAPTER_CAPABILITY);
    const path = open ? '/api/v1/adapters/examples/' + projectId
      : '/api/v1/adapters/projects/' + projectId + (targetId ? '?targetId=' + encodeURIComponent(targetId) : '');
    const result = await request<AdapterProjectContext>(this.origin, path, token, open ? {} : undefined, signal);
    if (result.projectId !== projectId || !id(result.revisionId) || result.saved !== true || !Array.isArray(result.files)
      || !Array.isArray(result.analysis?.targets) || !Array.isArray(result.instructions))
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый контекст адаптеров.');
    return result;
  }
  async adapterChange(projectId: ExampleKey, baseRevisionId: string, operation: AdapterChangeInput['operation'], signal?: AbortSignal,
    options: AdapterChangeOptions = {}): Promise<AdapterSavedChange | AdapterChangeCheck> {
    const operationId = options.operationId ?? randomUUID(), action = options.action ?? 'apply';
    try {
      if (!exampleKey(projectId) || !id(baseRevisionId) || !id(operationId) || !['check', 'apply'].includes(action))
        throw new ConnectionError('INVALID_REQUEST', 'Нужны существующий проект, UUID прочитанной ревизии/операции и действие check или apply.');
      if (operation.type === 'files' && (operation.files.length < 1 || operation.files.length > 3
        || new Set(operation.files.map(file => file.path)).size !== operation.files.length
        || operation.files.some(file => !hash(file.expectedHash) || file.content.length > 262144)))
        throw new ConnectionError('INVALID_REQUEST', 'Передайте от одного до трёх разных файлов с прочитанными SHA-256; максимум 262144 символа на файл.');
      if (operation.type === 'semantic' && ((!operation.targetId || operation.targetId.length > 256)
        || (!operation.adapterId || operation.adapterId.length > 100) || (!operation.property || operation.property.length > 100)
        || (typeof operation.value === 'string' ? [...operation.value].length > 4096 : !Number.isFinite(operation.value))))
        throw new ConnectionError('INVALID_REQUEST', 'Выберите цель, адаптер, свойство и значение из последнего контекста.');
      const { token } = await this.credentials(signal, ADAPTER_REBASE_CAPABILITY);
      const input: AdapterChangeInput = { operationId, baseRevisionId, rebase: 'if-unchanged', operation };
      const result = await request<AdapterSavedChange | AdapterChangeCheck>(this.origin,
        '/api/v1/adapters/projects/' + projectId + '/changes' + (action === 'check' ? '/check' : ''), token, input, signal);
      if (action === 'check') {
        if (!validCheck(result, projectId, input)) throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый результат проверки; сохранение не подтверждено.');
        return {
          projectId: result.projectId, operationId: result.operationId, baseRevisionId: result.baseRevisionId,
          currentRevisionId: result.currentRevisionId, status: result.status, rebased: result.rebased,
          touchedFiles: [...result.touchedFiles], conflicts: conflictsOf(result.conflicts),
          ...(result.savedResult ? { savedResult: savedResult(result.savedResult) } : {}),
        };
      }
      if (!validSaved(result, projectId, operationId) || (result.baseRevisionId !== undefined && result.baseRevisionId !== baseRevisionId)) {
        throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил сохранённую ревизию.');
      }
      return savedResult(result);
    } catch (error) {
      // Never create a fresh idempotency key to retry an uncertain write.
      if (error instanceof ConnectionError) throw new ConnectionError(error.code, error.message, error.revisionId,
        id(operationId) ? operationId : undefined, { ...error.details, ...(id(baseRevisionId) ? { baseRevisionId } : {}) });
      throw new ConnectionError(signal?.aborted ? 'CANCELLED' : 'UNCONFIRMED', 'Результат не подтверждён. Перечитайте проект.', undefined,
        id(operationId) ? operationId : undefined, id(baseRevisionId) ? { baseRevisionId } : {});
    }
  }
  async adapterBuild(projectId: ExampleKey, revisionId: string, signal?: AbortSignal): Promise<{ id: string }> {
    if (!exampleKey(projectId) || !id(revisionId)) throw new ConnectionError('INVALID_REQUEST', 'Нужны проект и UUID сохранённой ревизии.');
    const { token } = await this.credentials(signal, ADAPTER_CAPABILITY);
    const result = await request<{ id: string }>(this.origin, '/api/v1/adapters/projects/' + projectId + '/builds', token, { revisionId }, signal);
    if (!id(result.id)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил постановку сборки в очередь.');
    return result;
  }
  async buildStatus(buildId: string, signal?: AbortSignal): Promise<BuildInfo> {
    if (!id(buildId)) throw new ConnectionError('INVALID_REQUEST', 'Нужен UUID сборки.');
    const { token } = await this.credentials(signal, ADAPTER_CAPABILITY);
    const result = await request<BuildInfo>(this.origin, '/api/v1/runner/builds/' + buildId, token, undefined, signal);
    if (result.id !== buildId || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(result.status))
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемое состояние сборки.');
    return result;
  }
}
function exampleKey(value: unknown): value is ExampleKey { return ['editorial', 'dashboard', 'scene'].includes(value as string); }
function validSaved(value: any, projectId: ExampleKey, operationId: string): value is AdapterSavedChange {
  return value?.saved === true && value.projectId === projectId && value.operationId === operationId && id(value.revisionId)
    && (value.baseRevisionId === undefined || id(value.baseRevisionId))
    && (value.appliedOnRevisionId === undefined || id(value.appliedOnRevisionId))
    && (value.rebased === undefined || typeof value.rebased === 'boolean');
}
function savedResult(value: AdapterSavedChange): AdapterSavedChange {
  return { projectId: value.projectId, operationId: value.operationId, revisionId: value.revisionId, saved: true,
    ...(value.baseRevisionId === undefined ? {} : { baseRevisionId: value.baseRevisionId }),
    ...(value.appliedOnRevisionId === undefined ? {} : { appliedOnRevisionId: value.appliedOnRevisionId }),
    ...(value.rebased === undefined ? {} : { rebased: value.rebased }) };
}
function validCheck(value: any, projectId: ExampleKey, input: AdapterChangeInput): value is AdapterChangeCheck {
  if (!value || value.projectId !== projectId || value.operationId !== input.operationId || value.baseRevisionId !== input.baseRevisionId
    || !id(value.currentRevisionId) || typeof value.rebased !== 'boolean' || !['ready', 'conflict', 'already-applied'].includes(value.status)
    || !Array.isArray(value.touchedFiles) || value.touchedFiles.length > 3 || !value.touchedFiles.every(sourcePath)
    || !Array.isArray(value.conflicts) || value.conflicts.length > 3 || conflictsOf(value.conflicts).length !== value.conflicts.length) return false;
  if (value.status === 'already-applied') return validSaved(value.savedResult, projectId, input.operationId)
    && (value.savedResult.baseRevisionId === undefined || value.savedResult.baseRevisionId === input.baseRevisionId);
  return value.savedResult === undefined && (value.status === 'ready' ? value.conflicts.length === 0
    : value.conflicts.length > 0 && value.conflicts.every((item: ChangeConflict) => item.code === 'FILE_CHANGED'));
}
