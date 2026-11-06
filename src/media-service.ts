import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AdapterProjectContext, SourceAsset } from '../contracts/adapters.js';
import { Connection, ConnectionError } from './connection.js';
import { MediaError, generateImages, type ImageReference, type ProviderImage } from './media-provider.js';
import { DEFAULT_PROFILE_ID, builtinProfiles, type MediaConfig, type MediaProfile } from './media-profiles.js';
import type { GenerateMediaRequest, GenerateMediaResult, GeneratedMediaAsset, MediaProfileSummary, MediaSettings, ServerMediaProfile } from './media-contract.js';

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extension(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}

function slug(value: string): string {
  const ascii = value.normalize('NFKD').replace(/[^\x00-\x7f]/g, ' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return ascii || 'image';
}

export interface GenerateInput {
  projectId: string;
  /** Базовая ревизия, прочитанная агентом; при конфликте сервис перечитывает проект. */
  baseRevisionId?: string;
  prompt: string;
  profileId?: string;
  name?: string;
  aspectRatio?: string;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  transparent?: boolean;
  seed?: number;
  count?: number;
  sourceAsset?: string;
  replace?: boolean;
}

export interface MediaPreview {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

export interface MediaGenerationOutcome {
  result: GenerateMediaResult;
  images: ProviderImage[];
}

export class MediaService {
  constructor(private readonly ctx: Context, private readonly connection: Connection, private readonly config: MediaConfig) {}

  /** Каталог профилей; секретов здесь нет, только статус «настроен». */
  async profiles(): Promise<MediaProfileSummary[]> {
    const profiles = await this.catalog();
    return await Promise.all(profiles.map(async profile => ({
      id: profile.id, title: profile.title, description: profile.description,
      model: profile.model, resolution: profile.resolution, costHintUsd: profile.costHintUsd,
      explicitOnly: profile.explicitOnly, configured: await this.credentialConfigured(profile),
      available: true,
    })));
  }

  /** Администратор платформы задаёт каталог профилей на сервере; встроенные — запасной вариант. */
  private async catalog(signal?: AbortSignal): Promise<MediaProfile[]> {
    try {
      const remote = await this.connection.mediaProfiles(signal);
      if (remote.supported && remote.profiles.length) {
        const profiles = remote.profiles.map(profile => this.fromServer(profile));
        if (profiles.some(profile => profile.id === DEFAULT_PROFILE_ID)) return profiles;
      }
    } catch { /* старая установка или недоступный каталог: встроенные профили */ }
    return builtinProfiles(this.config);
  }

  private fromServer(profile: ServerMediaProfile): MediaProfile {
    return {
      ...profile,
      provider: 'openrouter',
      credential: this.config.imageApiKeyEnv || 'OPENROUTER_API_KEY',
      scope: 'installation',
    };
  }

  async settings(signal?: AbortSignal): Promise<MediaSettings> {
    try { return await this.connection.mediaSettings(signal); }
    catch { return { manualGenerationMode: 'agent', supported: false }; }
  }

  /** Прямой запуск из панели DSH: проект и выделение Host читает сам. */
  async generateFromSelection(input: GenerateMediaRequest, signal: AbortSignal): Promise<MediaGenerationOutcome> {
    const selection = await this.connection.selection(signal);
    if (!selection.supported || !selection.selection) throw new MediaError('NO_SELECTION', 'В Studio ничего не выделено.', 'Выделите проект или изображение в Studio и повторите.');
    if (selection.access && !selection.access.canUseAgent) throw new MediaError('AGENT_FORBIDDEN', 'В этом проекте агенту не разрешены правки.', 'Попросите владельца проекта включить разрешение агенту.');
    const { projectId, revisionId, targetId } = selection.selection;
    let sourceAsset: SourceAsset | null = null;
    if (input.replace) {
      sourceAsset = await this.resolveSelectedAsset(projectId, targetId, signal);
      if (!sourceAsset) throw new MediaError('NO_TARGET_IMAGE', 'Не удалось определить изображение выделенного элемента.', 'Выделите элемент <img> с изображением или используйте режим через агента.');
    }
    return await this.generate({
      projectId, baseRevisionId: revisionId, prompt: input.prompt, profileId: input.profile,
      aspectRatio: input.aspectRatio, replace: input.replace === true, sourceAsset: sourceAsset?.path,
    }, signal);
  }

  async generate(input: GenerateInput, signal: AbortSignal): Promise<MediaGenerationOutcome> {
    if (!input.prompt.trim()) throw new MediaError('INVALID_REQUEST', 'Нужен непустой промпт.');
    if ([...input.prompt].length > 4000) throw new MediaError('INVALID_REQUEST', 'Промпт длиннее 4000 символов.');
    const catalog = await this.catalog(signal);
    const profile = catalog.find(item => item.id === (input.profileId || DEFAULT_PROFILE_ID));
    if (!profile) throw new MediaError('PROFILE_UNKNOWN', `Профиль «${input.profileId ?? ''}» не найден.`, `Доступны: ${catalog.map(item => item.id).join(', ')}.`);
    const apiKey = await this.resolveCredential(profile);
    const context = await this.connection.adapterProject(input.projectId, false, undefined, signal);
    if (input.sourceAsset) {
      const source = context.assets.find(asset => asset.path === input.sourceAsset);
      if (!source || !IMAGE_MIME.has(source.mime)) throw new MediaError('ASSET_NOT_FOUND', `Ресурс «${input.sourceAsset}» не найден в проекте или не является изображением.`);
    }
    const source = input.sourceAsset ? context.assets.find(asset => asset.path === input.sourceAsset) ?? null : null;
    const references: ImageReference[] = [];
    if (source && source.mime) {
      const bytes = await this.connection.assetBytes(input.projectId, source.sha256, context.revisionId, signal);
      references.push(bytes);
    }
    const count = input.replace ? 1 : Math.max(1, Math.min(profile.maxCount, input.count ?? 1));
    const outputFormat = input.outputFormat ?? profile.outputFormat ?? 'png';
    if (input.transparent && !['png', 'webp'].includes(outputFormat)) throw new MediaError('INVALID_REQUEST', 'Прозрачность поддерживается только для PNG/WebP.');
    const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]);
    let providerResult;
    try {
      providerResult = await generateImages(apiKey, {
        profile, prompt: input.prompt, aspectRatio: input.aspectRatio, outputFormat,
        transparent: input.transparent, seed: input.seed, count, references: references.length ? references : undefined,
      }, timeoutSignal);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if (signal.aborted) throw new MediaError('CANCELLED', 'Генерация отменена.');
      throw new MediaError('GENERATION_FAILED', 'Генерация изображения не удалась.', 'Повторите запрос или выберите другой профиль.');
    }

    let baseRevisionId = input.baseRevisionId ?? context.revisionId;
    const assets: GeneratedMediaAsset[] = [];
    for (let index = 0; index < providerResult.images.length; index += 1) {
      const image = providerResult.images[index];
      const hash = sha256(image.bytes);
      const replace = input.replace === true && index === 0 && !!source && providerResult.images.length === 1;
      const path = replace && source ? source.path : `assets/generated/${slug(input.name || input.prompt)}-${hash.slice(0, 8)}.${extension(image.mime)}`;
      const expectedHash = replace && source ? source.sha256 : null;
      const operationId = randomUUID();
      const contentBase64 = image.bytes.toString('base64');
      let saved = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!baseRevisionId) throw new MediaError('NO_REVISION', 'Не удалось определить ревизию проекта.');
        try {
          saved = await this.connection.asset(input.projectId, {
            baseRevisionId, path, mime: image.mime, expectedHash, contentBase64, operationId,
          }, signal);
          break;
        } catch (error) {
          if (!(error instanceof ConnectionError) || attempt === 1) throw this.uploadError(error);
          if (!['CONFLICT', 'REVISION_CONFLICT', 'TRANSPORT', 'UNAVAILABLE', 'UNCONFIRMED'].includes(error.code)) throw this.uploadError(error);
          const fresh = await this.connection.adapterProject(input.projectId, false, undefined, signal);
          if (replace && fresh.assets.find(asset => asset.path === path)?.sha256 !== expectedHash) {
            throw new MediaError('RESOURCE_CONFLICT', 'Выбранное изображение изменилось, пока шла генерация.', 'Перечитайте проект и повторите; ничего не перезаписано.');
          }
          baseRevisionId = fresh.revisionId;
        }
      }
      if (!saved?.revisionId) throw new MediaError('SAVE_FAILED', 'Не удалось сохранить сгенерированный ресурс.', 'Перечитайте проект и повторите.');
      baseRevisionId = saved.revisionId;
      assets.push({ path, sha256: hash, mime: image.mime, size: image.bytes.length });
    }

    return {
      images: providerResult.images,
      result: {
        projectId: input.projectId, revisionId: baseRevisionId, profile: profile.id, model: profile.model,
        assets, replaced: input.replace === true, costUsd: providerResult.costUsd,
        studioUrl: this.connection.origin + '/?project=' + encodeURIComponent(input.projectId),
      },
    };
  }

  /** Вложение превью для image-блока; null, если сервис недоступен или route не принимает изображения. */
  async previewAttachment(image: ProviderImage, name: string, exec: any): Promise<MediaPreview | null> {
    const attachments: any = this.ctx.get('attachments');
    if (!attachments?.saveImage) return null;
    const llm: any = this.ctx.get('llm');
    const header = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = header?.provider ?? exec?.agent?.options?.provider;
    const model = header?.model ?? exec?.agent?.options?.model;
    if (!llm?.resolveModelInfo || !provider || !model) return null;
    try {
      const info = await llm.resolveModelInfo(provider, model, exec.signal);
      if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) return null;
      const ref = await attachments.saveImage({ data: image.bytes, mediaType: image.mime, name });
      return {
        attachmentId: String(ref.attachmentId), mediaType: String(ref.mediaType), bytes: Number(ref.bytes),
        width: Number(ref.width), height: Number(ref.height), ...(ref.name ? { name: String(ref.name) } : {}),
      };
    } catch { return null; }
  }

  private async resolveSelectedAsset(projectId: string, targetId: string | null, signal: AbortSignal): Promise<SourceAsset | null> {
    if (!targetId) return null;
    const context: AdapterProjectContext = await this.connection.adapterProject(projectId, false, targetId, signal);
    const target = context.analysis.targets.find(item => item.id === targetId);
    if (!target) return null;
    const file = context.files.find(item => item.path === target.source.path);
    if (!file) return null;
    const snippet = file.content.slice(target.source.start, target.source.end);
    const candidates = context.assets.filter(asset => IMAGE_MIME.has(asset.mime)
      && (snippet.includes(asset.path) || snippet.includes('./' + asset.path) || snippet.includes(asset.path.split('/').at(-1) ?? '\u0000')));
    return candidates.length === 1 ? candidates[0] : null;
  }

  private uploadError(error: unknown): MediaError {
    if (error instanceof ConnectionError) {
      if (error.code === 'AGENT_FORBIDDEN' || error.code === 'READ_ONLY')
        return new MediaError(error.code, 'Нет права сохранить изображение в проект.', 'Проверьте права проекта и разрешение агенту.');
      if (error.code === 'RESOURCE_CONFLICT' || error.code === 'CHANGE_CONFLICT')
        return new MediaError('RESOURCE_CONFLICT', 'Ресурс изменился, пока шла генерация.', 'Перечитайте проект и повторите; ничего не перезаписано.');
      if (error.code === 'PROJECT_NOT_FOUND') return new MediaError('PROJECT_NOT_FOUND', 'Проект недоступен.', 'Перечитайте список доступных проектов.');
      return new MediaError('SAVE_FAILED', 'Не удалось сохранить сгенерированный ресурс.', 'Перечитайте проект и повторите.');
    }
    return new MediaError('SAVE_FAILED', 'Не удалось сохранить сгенерированный ресурс.', 'Перечитайте проект и повторите.');
  }

  private async resolveCredential(profile: MediaProfile): Promise<string> {
    const credentials: any = this.ctx.get('credentials');
    if (!credentials?.resolve) throw new MediaError('CREDENTIALS_UNAVAILABLE', 'Хранилище ключей DSH недоступно.', 'Откройте DSH и проверьте настройки моделей.');
    try {
      const hit = await credentials.resolve(profile.credential);
      if (hit?.value && typeof hit.value === 'string') return hit.value;
    } catch { /* ниже — понятная ошибка */ }
    throw new MediaError('MISSING_CREDENTIAL', `Ключ ${profile.credential} не настроен.`, 'DSH Settings → Models → Add model provider → OpenRouter, затем вставьте ключ.');
  }

  private async credentialConfigured(profile: MediaProfile): Promise<boolean> {
    const credentials: any = this.ctx.get('credentials');
    if (!credentials) return false;
    try {
      if (credentials.describe) return !!((await credentials.describe(profile.credential))?.configured);
      if (credentials.resolve) return !!(await credentials.resolve(profile.credential));
    } catch { return false; }
    return false;
  }
}

export { DEFAULT_PROFILE_ID };
