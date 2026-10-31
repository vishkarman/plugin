import { PRODUCT_CAPABILITY, type HistoryResult,type RevisionContext,type ExportInfo } from '../contracts/product.js';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_VERSION, CAPABILITY, type ServerInfo, type ProjectContext, type SavedChange, type ChangeInput } from '../contracts/index.js';
import { ADAPTER_CAPABILITY, ADAPTER_REBASE_CAPABILITY, WORKSPACE_CAPABILITY, type ProjectCreateInput, type ProjectUpdateInput, type AssetUploadInput, type AdapterExample, type AdapterProjectContext, type AdapterChangeInput, type AdapterSavedChange, type AdapterChangeCheck, type ChangeConflict, type SourcePathName, type ExampleKey } from '../contracts/adapters.js';
import type { BuildInfo } from '../contracts/runner.js';
import { ACCESS_CAPABILITY, type AuthUser, type ProjectAccess } from '../contracts/access.js';

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
const sourcePath = (value: unknown): value is SourcePathName => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[\x00-\x20\\:?#%]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => !!part && !part.startsWith('.') && !['node_modules', '__proto__', 'prototype', 'constructor'].includes(part));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function conflictsOf(value: unknown): ChangeConflict[] {
  if (!Array.isArray(value)) return [];
  const result: ChangeConflict[] = [];
  for (const item of value.slice(0, 128)) {
    if (!item || typeof item !== 'object' || !sourcePath(item.path) || !(item.baseHash === null || hash(item.baseHash)) || !(item.currentHash === null || hash(item.currentHash))) continue;
    if (item.code === 'FILE_CHANGED') result.push({ path: item.path, code: item.code, baseHash: item.baseHash, currentHash: item.currentHash });
    else if (item.code === 'BASE_HASH_MISMATCH' && (item.expectedHash === null || hash(item.expectedHash)))
      result.push({ path: item.path, code: item.code, baseHash: item.baseHash, currentHash: item.currentHash, expectedHash: item.expectedHash });
  }
  return result;
}
export async function request<T>(origin: string, path: string, token?: string, body?: unknown, signal?: AbortSignal, method?: 'POST' | 'PATCH'): Promise<T> {
  signal?.throwIfAborted();
  try {
    const response = await fetch(origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    });
    const data = await response.json() as any;
    if (!response.ok) {
      if (path.startsWith('/api/v1/adapters/') && ((response.status === 409 && data?.error?.code === 'CHANGE_CONFLICT')
        || ([400, 409].includes(response.status) && data?.error?.code === 'RESOURCE_CONFLICT'))) {
        const error = data.error;
        throw new ConnectionError(error.code, error.code === 'CHANGE_CONFLICT'
          ? 'Изменяемый файл изменился после чтения. Ничего не сохранено: перечитайте проект и переоцените правку, не подменяйте базу или хеши для повтора.'
          : 'Хеш файла не совпадает с указанной базовой ревизией. Ничего не сохранено: перечитайте исходники и проверьте запрос.',
        id(error.revisionId) ? error.revisionId : undefined, undefined, {
          ...(id(error.baseRevisionId) ? { baseRevisionId: error.baseRevisionId } : {}),
          conflicts: conflictsOf(error.conflicts),
        });
      }
      if (response.status === 403 && ['READ_ONLY', 'AGENT_FORBIDDEN'].includes(data?.error?.code)) {
        throw new ConnectionError(data.error.code, data.error.code === 'READ_ONLY'
          ? 'У вас нет права изменять исходники: для агента проект доступен только для чтения. Ничего не сохранено; не повторяйте запись и не обходите права другим инструментом.'
          : 'Владелец не разрешил агенту изменять этот проект. Ничего не сохранено; не повторяйте запись. Для работы через DSH нужен Editor с разрешением агента.');
      }
      if (response.status === 404 && data?.error?.code === 'PROJECT_NOT_FOUND')
        throw new ConnectionError('PROJECT_NOT_FOUND', 'Проект недоступен: он отсутствует или доступ отозван. Перечитайте список доступных проектов; не пытайтесь создать его вместо открытия.');
      const codes: Record<number, [string, string]> = {
        400: ['INVALID_REQUEST', 'Сервер отклонил параметры изменения.'],
        401: ['UNAUTHORIZED', 'Доступ отсутствует или отозван. Подключитесь заново.'],
        403: ['FORBIDDEN', 'Нет права на эту операцию. Не повторяйте её и не обходите ограничение другим инструментом; права меняет владелец проекта.'],
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
  if (!info.capabilities.includes(ACCESS_CAPABILITY))
    throw new ConnectionError('INCOMPATIBLE', 'Сервер не поддерживает права проектов. Требуется access.project-roles.v1; обновите сервер до прототипа 6.');
  if (!info.capabilities.includes(WORKSPACE_CAPABILITY))
    throw new ConnectionError('INCOMPATIBLE', 'Сервер не поддерживает собственные проекты. Требуется workspace.projects.v1; обновите сервер до этапа 1.');
  if (!info.capabilities.includes(PRODUCT_CAPABILITY)) throw new ConnectionError('INCOMPATIBLE','Для этой версии плагина нужен сервер этапа 2: product.history-comments-export.v1. Обновите сервер перед записью.');
  return info;
}
export async function currentUser(origin: string, token: string, signal?: AbortSignal): Promise<AuthUser> {
  const result = await request<{ user: AuthUser }>(origin, '/api/v1/auth/me', token, undefined, signal);
  if (!result?.user || !id(result.user.id) || typeof result.user.username !== 'string' || typeof result.user.isOwner !== 'boolean')
    throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемую учётную запись.');
  return result.user;
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
  async adapterExamples(signal?: AbortSignal): Promise<{ projects: { id: string; name: string; description: string; access: ProjectAccess }[]; templates: AdapterExample[]; canCreate: boolean }> {
    const { token } = await this.credentials(signal, WORKSPACE_CAPABILITY);
    const user = await currentUser(this.origin, token, signal);
    const result = await request<{ projects: { id: string; name: string; description: string; access: ProjectAccess }[] }>(this.origin, '/api/v1/adapters/projects', token, undefined, signal);
    if (!Array.isArray(result.projects) || result.projects.some(project => !validProject(project) || !validAccess(project.access)))
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый список проектов.');
    const templates = user.isOwner ? await request<{ examples: AdapterExample[] }>(this.origin, '/api/v1/adapters/examples', token, undefined, signal) : { examples: [] };
    return { projects: result.projects, templates: templates.examples, canCreate: user.isOwner };
  }
  async adapterProject(projectId: ExampleKey, _open: boolean, targetId?: string, signal?: AbortSignal): Promise<AdapterProjectContext & { studioUrl: string }> {
    if (!projectKey(projectId) || (targetId !== undefined && (!targetId || targetId.length > 256)))
      throw new ConnectionError('INVALID_REQUEST', 'Нужен существующий проект и допустимый идентификатор цели.');
    const { token } = await this.credentials(signal, WORKSPACE_CAPABILITY);
    const path = '/api/v1/adapters/projects/' + projectId + (targetId ? '?targetId=' + encodeURIComponent(targetId) : '');
    const result = await request<AdapterProjectContext>(this.origin, path, token, undefined, signal);
    if (!validContext(result) || result.projectId !== projectId)
      throw new ConnectionError('INCOMPATIBLE', 'Сервер вернул неподдерживаемый контекст проекта.');
    return { ...result, studioUrl: this.origin + '/?project=' + encodeURIComponent(projectId) };
  }
  async createProject(input: Omit<ProjectCreateInput, 'operationId'> & { operationId?: string }, signal?: AbortSignal) {
    const operationId = input.operationId ?? randomUUID();
    return this.workspaceMutation(operationId, undefined, signal, async token => {
      if (!id(operationId) || !input.name.trim() || input.name.length > 120) throw new ConnectionError('INVALID_REQUEST', 'Нужно имя проекта длиной до 120 символов и UUID операции.');
      const result = await request<AdapterProjectContext>(this.origin, '/api/v1/adapters/projects', token, { ...input, operationId }, signal);
      if (!validContext(result)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил создание проекта.');
      return { ...result, operationId, studioUrl: this.origin + '/?project=' + encodeURIComponent(result.projectId) };
    });
  }
  async updateProject(projectId: string, input: Omit<ProjectUpdateInput, 'operationId'> & { operationId?: string }, signal?: AbortSignal) {
    const operationId = input.operationId ?? randomUUID();
    return this.workspaceMutation(operationId, input.baseRevisionId, signal, async token => {
      if (!projectKey(projectId) || !id(input.baseRevisionId) || !id(operationId)) throw new ConnectionError('INVALID_REQUEST', 'Нужны проект и UUID базовой ревизии/операции.');
      const result = await request<AdapterSavedChange>(this.origin, '/api/v1/adapters/projects/' + projectId, token, { ...input, operationId }, signal, 'PATCH');
      if (!validSaved(result, projectId, operationId)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил сохранение настроек проекта.');
      return savedResult(result);
    });
  }
  async asset(projectId: string, input: Omit<AssetUploadInput, 'operationId'> & { operationId?: string }, signal?: AbortSignal) {
    const operationId = input.operationId ?? randomUUID();
    return this.workspaceMutation(operationId, input.baseRevisionId, signal, async token => {
      if (!projectKey(projectId) || !id(input.baseRevisionId) || !id(operationId) || !sourcePath(input.path)
        || !(input.expectedHash === null || hash(input.expectedHash)) || (input.contentBase64 !== null && input.contentBase64.length > 11184812))
        throw new ConnectionError('INVALID_REQUEST', 'Нужны проект, базовая ревизия, относительный путь и SHA-256 ресурса; новый ресурс использует expectedHash:null.');
      const result = await request<AdapterSavedChange>(this.origin, '/api/v1/adapters/projects/' + projectId + '/assets', token, { ...input, operationId }, signal);
      if (!validSaved(result, projectId, operationId)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил сохранение ресурса.');
      return savedResult(result);
    });
  }
  private async workspaceMutation<T>(operationId: string, baseRevisionId: string | undefined, signal: AbortSignal | undefined, action: (token: string) => Promise<T>): Promise<T> {
    try {
      const { token } = await this.credentials(signal, WORKSPACE_CAPABILITY);
      return await action(token);
    } catch (error) {
      if (error instanceof ConnectionError) throw new ConnectionError(error.code, error.message, error.revisionId, operationId,
        { ...error.details, ...(baseRevisionId ? { baseRevisionId } : {}) });
      throw new ConnectionError('UNCONFIRMED', 'Результат не подтверждён. Сохраните operationId и исходные параметры для повторного запроса.', undefined, operationId, { baseRevisionId });
    }
  }
  async adapterChange(projectId: ExampleKey, baseRevisionId: string, operation: AdapterChangeInput['operation'], signal?: AbortSignal,
    options: AdapterChangeOptions = {}): Promise<AdapterSavedChange | AdapterChangeCheck> {
    const operationId = options.operationId ?? randomUUID(), action = options.action ?? 'apply';
    try {
      if (!projectKey(projectId) || !id(baseRevisionId) || !id(operationId) || !['check', 'apply'].includes(action))
        throw new ConnectionError('INVALID_REQUEST', 'Нужны существующий проект, UUID прочитанной ревизии/операции и действие check или apply.');
      if (operation.type === 'files' && (operation.files.length < 1 || operation.files.length > 128
        || new Set(operation.files.map(file => file.path)).size !== operation.files.length
        || operation.files.some(file => !sourcePath(file.path) || !(file.expectedHash === null || hash(file.expectedHash)) || (file.content !== null && file.content.length > 262144))))
        throw new ConnectionError('INVALID_REQUEST', 'Передайте от 1 до 128 разных файлов с прочитанными SHA-256; для нового файла hash:null, для удаления content:null; максимум 262144 символа на файл.');
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
    if (!projectKey(projectId) || !id(revisionId)) throw new ConnectionError('INVALID_REQUEST', 'Нужны проект и UUID сохранённой ревизии.');
    const { token } = await this.credentials(signal, ADAPTER_CAPABILITY);
    const result = await request<{ id: string }>(this.origin, '/api/v1/adapters/projects/' + projectId + '/builds', token, { revisionId }, signal);
    if (!id(result.id)) throw new ConnectionError('INCOMPATIBLE', 'Сервер не подтвердил постановку сборки в очередь.');
    return result;
  }
  async comments(projectId:string,cursor?:string,signal?:AbortSignal) {
    if(!projectKey(projectId)||(cursor!==undefined&&!id(cursor)))throw new ConnectionError('INVALID_REQUEST','Нужны проект и UUID курсора.');
    const {token}=await this.credentials(signal,PRODUCT_CAPABILITY);
    return request(this.origin,'/api/v1/adapters/projects/'+projectId+'/comments'+(cursor?'?cursor='+cursor:''),token,undefined,signal);
  }
  async history(input: {action:'list';projectId:string;cursor?:string}|{action:'read';projectId:string;revisionId:string}|{action:'label';projectId:string;revisionId:string;label:string;operationId?:string}|{action:'restore';projectId:string;revisionId:string;baseRevisionId:string;operationId?:string},signal?:AbortSignal) {
    const operationId='operationId' in input?input.operationId??randomUUID():randomUUID();
    return this.workspaceMutation(operationId,'baseRevisionId' in input?input.baseRevisionId:undefined,signal,async token=>{
      if(!projectKey(input.projectId)||!id(operationId)||('revisionId' in input&&!id(input.revisionId))||('baseRevisionId' in input&&!id(input.baseRevisionId))||('cursor' in input&&input.cursor!==undefined&&!id(input.cursor)))throw new ConnectionError('INVALID_REQUEST','Нужны id проекта и UUID версий/операции.');
      const base='/api/v1/adapters/projects/'+input.projectId;
      if(input.action==='list'){
        const result=await request<HistoryResult>(this.origin,base+'/history'+(input.cursor?'?cursor='+input.cursor:''),token,undefined,signal);
        if(!id(result.currentRevisionId)||!Array.isArray(result.revisions)||result.revisions.some(row=>!id(row.id))||!(result.nextCursor===null||id(result.nextCursor)))throw new ConnectionError('INCOMPATIBLE','Неподдерживаемая история.');return result;
      }
      if(input.action==='read'){
        const result=await request<RevisionContext>(this.origin,base+'/history/'+input.revisionId,token,undefined,signal);
        if(!validContext(result)||result.projectId!==input.projectId||result.revisionId!==input.revisionId)throw new ConnectionError('INCOMPATIBLE','Неподдерживаемая версия.');return result;
      }
      if(input.action==='label'){
        if(input.label.length>120)throw new ConnectionError('INVALID_REQUEST','Название — до 120 символов.');
        const result=await request<{saved:boolean;revisionId:string;operationId:string;label:string}>(this.origin,base+'/history/'+input.revisionId,token,{operationId,label:input.label},signal,'PATCH');
        if(!result.saved||result.revisionId!==input.revisionId||result.operationId!==operationId)throw new ConnectionError('INCOMPATIBLE','Название не подтверждено.');return result;
      }
      const result=await request<AdapterSavedChange>(this.origin,base+'/restore',token,{operationId,baseRevisionId:input.baseRevisionId,revisionId:input.revisionId},signal);
      if(!validSaved(result,input.projectId,operationId))throw new ConnectionError('INCOMPATIBLE','Восстановление не подтверждено.');return savedResult(result);
    });
  }
  async exportProject(input:{action:'start';projectId:string;revisionId:string;kind:'source'|'web';operationId?:string}|{action:'status';exportId:string},signal?:AbortSignal) {
    const operationId=input.action==='start'?input.operationId??randomUUID():randomUUID();
    return this.workspaceMutation(operationId,undefined,signal,async token=>{
      let exportId:string;
      if(input.action==='start'){
        if(!projectKey(input.projectId)||!id(input.revisionId)||!id(operationId)||!['source','web'].includes(input.kind))throw new ConnectionError('INVALID_REQUEST','Нужны проект, UUID версии/операции и формат source или web.');
        const result=await request<{id:string}>(this.origin,'/api/v1/adapters/projects/'+input.projectId+'/exports',token,{operationId,revisionId:input.revisionId,kind:input.kind},signal);exportId=result.id;
      }else exportId=input.exportId;
      if(!id(exportId))throw new ConnectionError('INCOMPATIBLE','Нужен UUID экспорта.');
      const result=await request<ExportInfo>(this.origin,'/api/v1/exports/'+exportId,token,undefined,signal);
      if(result.id!==exportId||!['queued','running','ready','failed','cancelled'].includes(result.status)||result.browserUrl!==this.origin+'/?export='+exportId)throw new ConnectionError('INCOMPATIBLE','Сервер не подтвердил экспорт.');
      return {...result,operationId};
    });
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
function projectKey(value: unknown): value is ExampleKey { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value); }
function validProject(value: any): boolean {
  return value && projectKey(value.id) && typeof value.name === 'string' && typeof value.description === 'string';
}
function validAccess(value: any): value is ProjectAccess {
  return value && ['owner', 'viewer', 'commenter', 'editor'].includes(value.role)
    && typeof value.canComment === 'boolean' && typeof value.canEdit === 'boolean' && typeof value.canManage === 'boolean' && typeof value.canUseAgent === 'boolean'
    && (!value.canUseAgent || value.canEdit) && (!value.canManage || value.role === 'owner')
    && (!['viewer','commenter'].includes(value.role) || !value.canEdit);
}
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
    || !Array.isArray(value.touchedFiles) || value.touchedFiles.length > 128 || !value.touchedFiles.every(sourcePath)
    || !Array.isArray(value.conflicts) || value.conflicts.length > 128 || conflictsOf(value.conflicts).length !== value.conflicts.length) return false;
  if (value.status === 'already-applied') return validSaved(value.savedResult, projectId, input.operationId)
    && (value.savedResult.baseRevisionId === undefined || value.savedResult.baseRevisionId === input.baseRevisionId);
  return value.savedResult === undefined && (value.status === 'ready' ? value.conflicts.length === 0
    : value.conflicts.length > 0 && value.conflicts.every((item: ChangeConflict) => item.code === 'FILE_CHANGED'));
}

function validContext(value: any): value is AdapterProjectContext {
  return value && projectKey(value.projectId) && id(value.revisionId) && value.saved === true
    && typeof value.name === 'string' && sourcePath(value.entrypoint) && Array.isArray(value.assets)
    && Array.isArray(value.files) && value.files.length <= 128
    && value.files.every((file: any) => sourcePath(file.path) && hash(file.sha256) && typeof file.content === 'string')
    && Array.isArray(value.analysis?.targets) && Array.isArray(value.instructions) && validAccess(value.access);
}
