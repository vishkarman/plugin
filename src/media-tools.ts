import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MediaService } from './media-service.js';
import { MediaError } from './media-provider.js';
import { DEFAULT_PROFILE_ID } from './media-profiles.js';
import { output } from './tool-output.js';

const assetSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    sha256: { type: 'string', required: true },
    mime: { type: 'string', required: true },
    size: { type: 'integer', required: true },
    hasAlpha: { type: 'boolean' },
  },
} as const;

const previewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const;

const generateOutput = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    projectId: { type: 'string' },
    revisionId: { type: 'string' },
    profile: { type: 'string' },
    model: { type: 'string' },
    assets: { type: 'array', items: assetSchema },
    replaced: { type: 'boolean' },
    costUsd: { type: 'number' },
    studioUrl: { type: 'string' },
    warning: { type: 'string' },
    preview: previewSchema,
    error: {
      type: 'object', additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
        hint: { type: 'string' },
      },
    },
  },
} as const;

function failure(error: unknown) {
  const media = error instanceof MediaError
    ? error
    : new MediaError('GENERATION_FAILED', 'Генерация изображения не удалась.', 'Повторите запрос или выберите другой профиль.');
  return { ok: false as const, error: { code: media.code, message: media.message, ...(media.hint ? { hint: media.hint } : {}) } };
}

export function registerMediaTools(ctx: Context, media: MediaService) {
  ctx.tools.register(defineTool({
    name: 'vishvakarma_generate_image',
    description: 'Сгенерировать изображение по промпту или доработать существующее (sourceAsset) и сохранить его ресурсом проекта. '
      + `По умолчанию используй профиль ${DEFAULT_PROFILE_ID}: он дешевле и быстрее. `
      + 'Профиль core:final — только если в текущем сообщении пользователь прямо просит качество/финал/для продакшена; прошлые просьбы не действуют. '
      + 'передай sourceAsset и replace:true, чтобы заменить выбранное изображение, сохранив путь. '
      + 'Другие профили — только из vishvakarma_media_profiles; не выдумывай id. Возможности профиля проверяй по фактическому результату, не по имени модели. '
      + 'После сохранения используй путь из assets в HTML/React и вызови vishvakarma_preview. Байты изображения в аргументы не передавай.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Идентификатор доступного проекта из list' },
      baseRevisionId: { type: 'string', required: true, description: 'UUID последней прочитанной ревизии проекта' },
      prompt: { type: 'string', required: true, description: 'Описание изображения или изменения; для refine — что изменить, сохраняя композицию' },
      name: { type: 'string', description: 'Короткое имя файла, например hero-workshop; путь формируется в assets/generated/' },
      profile: { type: 'string', description: `Профиль генерации; по умолчанию ${DEFAULT_PROFILE_ID}. Список — vishvakarma_media_profiles` },
      kind: { type: 'string', enum: ['hero', 'illustration', 'background', 'texture', 'photo', 'icon'] },
      aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '21:9'], description: 'Аспект; для refine лучше сохранить аспект исходника' },
      outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      transparent: { type: 'boolean', description: 'Прозрачный фон; только для PNG/WebP' },
      sourceAsset: { type: 'string', description: 'Путь ресурса проекта для refine или замены, например assets/generated/hero-abcd1234.png' },
      replace: { type: 'boolean', description: 'Заменить sourceAsset тем же путём (история сохранит старую версию); только вместе с sourceAsset' },
      seed: { type: 'number' },
      count: { type: 'integer', description: 'Сколько изображений запросить; ограничено профилем' },
      preview: { type: 'boolean', description: 'Вернуть превью агенту, если модель принимает изображения; по умолчанию да для одного изображения' },
    },
    output: {
      schema: generateOutput,
      render: (_args: unknown, value: any) => {
        const { preview, ...rest } = value;
        const blocks: any[] = [{ type: 'text', text: JSON.stringify(rest) }];
        if (preview) blocks.push({ type: 'image', attachment: preview });
        return blocks;
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      if (args.replace && !args.sourceAsset) return failure(new MediaError('INVALID_REQUEST', 'replace требует sourceAsset.', 'Укажите путь существующего изображения.'));
      try {
        const outcome = await media.generate({
          projectId: args.projectId, baseRevisionId: args.baseRevisionId, prompt: args.prompt,
          profileId: args.profile, name: args.name, aspectRatio: args.aspectRatio,
          outputFormat: args.outputFormat, transparent: args.transparent, seed: args.seed,
          count: args.count, sourceAsset: args.sourceAsset, replace: args.replace === true,
        }, exec.signal);
        let preview: Awaited<ReturnType<MediaService['previewAttachment']>> = null;
        if (args.preview !== false && outcome.images.length) {
          const first = outcome.result.assets[0];
          preview = await media.previewAttachment(outcome.images[0], first?.path.split('/').at(-1) ?? 'image.png', exec);
        }
        const { costUsd, ...rest } = outcome.result;
        const missingAlpha = args.transparent === true && outcome.images.some(image => !image.hasAlpha);
        const warning = missingAlpha
          ? 'Модель вернула непрозрачное изображение: прозрачность не поддерживается. Не проверяй пиксели вручную; перегенерируй с явным сплошным фоном (без transparent) или выбери модель с alpha.'
          : null;
        return { ok: true as const, ...rest, ...(typeof costUsd === 'number' ? { costUsd } : {}), ...(warning ? { warning } : {}), ...(preview ? { preview } : {}) };
      } catch (error) { return failure(error); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'vishvakarma_media_profiles',
    description: 'Показать доступные профили генерации изображений: когда применять, модель, разрешение, примерную цену и настроен ли ключ. '
      + 'Вызывай перед использованием не-дефолтного профиля или когда пользователь называет профиль. '
      + 'Каталог и модели настраивает администратор платформы в Studio → Администрирование → Генерация; '
      + 'если настройки нет, используются встроенные core:draft и core:final.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    execute: async (_args, _exec) => JSON.stringify({ profiles: await media.profiles() }),
  }));
}
