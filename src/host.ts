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
import { studioRemote, type SelectionRemote, type StudioConnection } from './remote.js';
import { registerAdapterTools } from './adapter-tools.js';
import { registerTargetTools } from './target-tools.js';
import { registerSelectionTools } from './selection-tools.js';
import { ChatBridge } from './chat-bridge.js';
import { registerChatTools } from './chat-tools.js';
import { output, run } from './tool-output.js';
import { PluginUpdates } from './updates.js';
import type { UpdateNotice, UpdateSettings, UpdateStatus } from './update-contract.js';
import { MediaService } from './media-service.js';
import { registerMediaTools } from './media-tools.js';
import { registerImportTools } from './import-tools.js';
import { AgentPolicy } from './agent-policy.js';
import type { GenerateMediaRequest, GenerateMediaResult, MediaProfileSummary, MediaSettings } from './media-contract.js';
import type { MediaConfig } from './media-profiles.js';

export const name = 'vishvakarma';
export const inject = ['tools', 'skills', 'typert', 'compaction', 'tokenMeter'];
export const Config = Schema.object({
  serverUrl: Schema.string().default('http://127.0.0.1:3000').description('Loopback origin Studio; при изменении подключитесь заново.'),
  credentialsFile: Schema.string().default(defaultCredentialsFile).description('Абсолютный путь к приватному JSON подключения; токен не помещайте в конфигурацию DSH.'),
  imageApiKeyEnv: Schema.string().default('OPENROUTER_API_KEY').description('Credential reference ключа OpenRouter; значение вводится в DSH Settings → Models, не в env.'),
  mediaDraftModel: Schema.string().default('google/gemini-2.5-flash-image').description('Модель OpenRouter для профиля core:draft.'),
  mediaFinalModel: Schema.string().default('google/gemini-3-pro-image').description('Модель OpenRouter для профиля core:final.'),
});
class StudioService extends TypertRemoteService {
  private readonly updates: PluginUpdates;
  constructor(ctx: Context, private readonly connection: Connection, config: ConnectionConfig, private readonly media: MediaService) { super(ctx, 'vishvakarma'); this.updates = new PluginUpdates(ctx, config); }
  @Remote
  async studio(): Promise<StudioConnection> {
    try { await serverInfo(this.connection.origin); return { url: this.connection.origin, available: true, message: '' }; }
    catch { return { url: this.connection.origin, available: false, message: 'Сервер Vishvakarma недоступен или несовместим. Запустите сервер и проверьте serverUrl.' }; }
  }
  @Remote
  async selection(): Promise<SelectionRemote> { return this.connection.selection(); }
  @Remote
  async mediaSettings(): Promise<MediaSettings> { return this.media.settings(); }
  @Remote
  async mediaProfiles(): Promise<MediaProfileSummary[]> { return this.media.profiles(); }
  @Remote
  async generateMedia(input: GenerateMediaRequest): Promise<GenerateMediaResult> { return (await this.media.generateFromSelection(input, AbortSignal.timeout(300_000))).result; }
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
  @Remote
  async updatePlugin(): Promise<UpdateStatus> { return this.updates.start('update'); }
}
export function apply(ctx: Context, config: ConnectionConfig & MediaConfig) {
  const connection = new Connection(config);
  const policy = new AgentPolicy();
  const media = new MediaService(ctx, connection, config, policy);
  new StudioService(ctx, connection, config, media);
  ctx.typert.remotes.register(studioRemote);
  const chatBridge = new ChatBridge(ctx, connection, config.credentialsFile, policy);
  ctx.effect(() => chatBridge.start());
  registerChatTools(ctx, chatBridge);
  ctx.tools.register(defineTool({
    name: 'vishvakarma_read_project', description: 'Прочитать исходный demo-проект Vishvakarma, HTML и ревизию. Доступен только первоначальному владельцу установки (legacy demo первого прототипа); владелец проекта не является администратором установки, а собственные и приглашённые проекты читаются через vishvakarma_adapter_project.',
    parameters: {}, output, isConcurrencySafe: () => true,
    execute: async (_args, exec) => run(() => connection.read(exec.signal)),
  }));
  ctx.tools.register(defineTool({
    name: 'vishvakarma_apply_change', description: 'Только первоначальному владельцу установки: заменить текст #demo-title исходного demo в index.html на прочитанной базовой ревизии. Legacy demo не связан с собственными проектами; не обходите этим инструментом ограничения доступа к другим проектам. При конфликте перечитайте проект. Успех — только saved:true.',
    parameters: {
      baseRevisionId: { type: 'string', required: true, description: 'UUID последней прочитанной ревизии' },
      resourcePath: { type: 'string', required: true, enum: ['index.html'] },
      target: { type: 'string', required: true, enum: ['demo-title'] },
      text: { type: 'string', required: true, description: 'Новый текст, до 4096 символов; HTML не исполняется' },
    }, output, isConcurrencySafe: () => false,
    execute: async (args, exec) => run(() => connection.change(args.baseRevisionId, args.text, exec.signal)),
  }));
  registerAdapterTools(ctx, connection);
  registerTargetTools(ctx, connection);
  registerSelectionTools(ctx, connection);
  registerProductTools(ctx, connection);
  registerEditorTools(ctx, connection);
  registerMediaTools(ctx, media);
  registerImportTools(ctx, connection, config.credentialsFile);
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
