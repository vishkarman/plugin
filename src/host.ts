import {registerEditorTools} from './editor-tools.js';
import { registerProductTools } from './product-tools.js';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import '@deepseek-ai/dsh-typert-registry';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Connection, defaultCredentialsFile, serverInfo, type Config as ConnectionConfig } from './connection.js';
import { studioRemote, type StudioConnection } from './remote.js';
import { registerAdapterTools } from './adapter-tools.js';
import { output, run } from './tool-output.js';
import { PluginUpdates } from './updates.js';
import type { UpdateNotice, UpdateSettings, UpdateStatus } from './update-contract.js';

export const name = 'vishvakarma';
export const inject = ['tools', 'skills', 'typert'];
export const Config = Schema.object({
  serverUrl: Schema.string().default('http://127.0.0.1:3000').description('Loopback origin Studio; при изменении подключитесь заново.'),
  credentialsFile: Schema.string().default(defaultCredentialsFile).description('Абсолютный путь к приватному JSON подключения; токен не помещайте в конфигурацию DSH.'),
});
class StudioService extends TypertRemoteService {
  private readonly updates: PluginUpdates;
  constructor(ctx: Context, private readonly connection: Connection, config: ConnectionConfig) { super(ctx, 'vishvakarma'); this.updates = new PluginUpdates(ctx, config); }
  @Remote
  async studio(): Promise<StudioConnection> {
    try { await serverInfo(this.connection.origin); return { url: this.connection.origin, available: true, message: '' }; }
    catch { return { url: this.connection.origin, available: false, message: 'Сервер Vishvakarma недоступен или несовместим. Запустите сервер и проверьте serverUrl.' }; }
  }
  @Remote
  async updateStatus(): Promise<UpdateStatus> { return this.updates.status(); }
  @Remote
  async updateNotice(): Promise<UpdateNotice> { return this.updates.notice(); }
  @Remote
  async saveUpdateSettings(settings: UpdateSettings): Promise<UpdateStatus> { return this.updates.saveSettings(settings); }
  @Remote
  async checkUpdate(): Promise<UpdateStatus> { return this.updates.start('check'); }
  @Remote
  async installUpdate(): Promise<UpdateStatus> { return this.updates.start('install'); }
}
export function apply(ctx: Context, config: ConnectionConfig) {
  const connection = new Connection(config);
  new StudioService(ctx, connection, config);
  ctx.typert.remotes.register(studioRemote);
  ctx.tools.register(defineTool({
    name: 'vishvakarma_read_project', description: 'Прочитать исходный demo-проект Vishvakarma, HTML и ревизию. Доступен только владельцу установки; гости работают с доступными проектами через vishvakarma_adapter_project.',
    parameters: {}, output, isConcurrencySafe: () => true,
    execute: async (_args, exec) => run(() => connection.read(exec.signal)),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_apply_change', description: 'Только владельцу установки: заменить текст #demo-title исходного demo в index.html на прочитанной базовой ревизии. Не обходите этим инструментом ограничения доступа к другим проектам. При конфликте перечитайте проект. Успех — только saved:true.',
    parameters: {
      baseRevisionId: { type: 'string', required: true, description: 'UUID последней прочитанной ревизии' },
      resourcePath: { type: 'string', required: true, enum: ['index.html'] },
      target: { type: 'string', required: true, enum: ['demo-title'] },
      text: { type: 'string', required: true, description: 'Новый текст, до 4096 символов; HTML не исполняется' },
    }, output, isConcurrencySafe: () => false,
    execute: async (args, exec) => run(() => connection.change(args.baseRevisionId, args.text, exec.signal)),
  }));
  registerAdapterTools(ctx, connection);
  registerProductTools(ctx, connection);
  registerEditorTools(ctx, connection);
  const skillDir = fileURLToPath(new URL('../skills/vishvakarma/', import.meta.url));
  const skillPath = skillDir + 'SKILL.md';
  ctx.skills.registerProvider(() => ({
    name: 'vishvakarma',
    async list(options) {
      const source = await readFile(skillPath, { encoding: 'utf8', signal: options.signal });
      const metadata = parse(source.split('---')[1]);
      return [{ name: 'vishvakarma', description: metadata.description, path: skillPath,
        invocation: { modelInvocable: true, userInvocable: true }, provider: 'vishvakarma', source: 'bundled',
        rank: BUNDLED_SKILL_RANK, resourceBase: { kind: 'directory', path: skillDir }, locator: skillPath }];
    },
    async get(candidate, options) {
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      const source = await readFile(skillPath, { encoding: 'utf8', signal: options.signal });
      return { ...summary, content: source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') };
    },
  }));
}
