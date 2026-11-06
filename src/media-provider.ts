import type { MediaProfile } from './media-profiles.js';

/** Ошибка генерации с машинным кодом и подсказкой агенту/пользователю. */
export class MediaError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message); }
}

export interface ImageReference {
  bytes: Buffer;
  mime: string;
}

export interface ImageProviderRequest {
  profile: MediaProfile;
  prompt: string;
  aspectRatio?: string;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  transparent?: boolean;
  seed?: number;
  count?: number;
  references?: ImageReference[];
}

export interface ProviderImage {
  bytes: Buffer;
  mime: string;
}

export interface ImageProviderResult {
  images: ProviderImage[];
  costUsd: number | null;
  model: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/images';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Определить формат по сигнатуре: заявленному media_type не доверяем. */
function sniffImageMediaType(data: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF'
    && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function providerError(status: number, message: string): MediaError {
  if (status === 401) return new MediaError('CREDENTIAL_REJECTED', 'OpenRouter отклонил ключ. Проверьте ключ в настройках DSH.', 'Введите актуальный ключ OpenRouter: DSH Settings → Models → OpenRouter.');
  if (status === 402) return new MediaError('NO_CREDITS', 'На балансе OpenRouter недостаточно кредитов для этой генерации.', 'Пополните баланс OpenRouter или выберите более дешёвый профиль.');
  if (status === 404) return new MediaError('MODEL_UNAVAILABLE', 'Модель профиля недоступна в OpenRouter.', 'Выберите другой профиль или обновите модель в конфигурации плагина.');
  if (status === 429) return new MediaError('RATE_LIMITED', 'OpenRouter временно ограничил частоту запросов.', 'Повторите позже; не запускайте несколько генераций параллельно.');
  if (status === 400) return new MediaError('INVALID_REQUEST', message || 'OpenRouter отклонил параметры генерации.', 'Сократите/перепишите промпт или измените аспект и профиль.');
  if (status === 413) return new MediaError('ASSET_TOO_LARGE', 'Запрос или результат генерации превышает допустимый размер.', 'Уменьшите разрешение профиля или число изображений.');
  if (status === 524) return new MediaError('GENERATION_TIMEOUT', 'OpenRouter не успел выполнить генерацию (edge timeout).', 'Повторите запрос или выберите более быстрый профиль.');
  if (status >= 500) return new MediaError('PROVIDER_UNAVAILABLE', 'OpenRouter временно недоступен или не смог выполнить генерацию.', 'Повторите позже; неуспешная генерация не списывается.');
  return new MediaError('PROVIDER_ERROR', message || 'Генерация не удалась.', 'Повторите запрос или выберите другой профиль.');
}

function moderationError(message: string): boolean {
  return /moderation|safety|policy|refus|blocked/i.test(message);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestOnce(apiKey: string, request: ImageProviderRequest, signal: AbortSignal): Promise<ImageProviderResult> {
  const profile = request.profile;
  const outputFormat = request.outputFormat ?? profile.outputFormat ?? 'png';
  if (request.transparent && !['png', 'webp'].includes(outputFormat)) {
    throw new MediaError('INVALID_REQUEST', 'Прозрачный фон поддерживается только для PNG или WebP.', 'Выберите PNG/WebP или отключите прозрачность.');
  }
  const prompt = profile.promptSuffix ? request.prompt.trim() + '\n\n' + profile.promptSuffix : request.prompt.trim();
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt,
    output_format: outputFormat,
  };
  if (profile.resolution) body.resolution = profile.resolution;
  if (request.aspectRatio && request.aspectRatio !== 'auto') body.aspect_ratio = request.aspectRatio;
  if (request.seed !== undefined) body.seed = request.seed;
  if (profile.maxCount > 1 && request.count !== undefined) body.n = Math.max(1, Math.min(profile.maxCount, request.count));
  if (request.transparent) body.background = 'transparent';
  if (request.references?.length) {
    body.input_references = request.references.slice(0, 8).map(reference => ({
      type: 'image_url',
      image_url: { url: `data:${reference.mime};base64,${reference.bytes.toString('base64')}` },
    }));
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw new MediaError('GENERATION_TIMEOUT', 'Генерация прервана по таймауту или отменена.', 'Повторите запрос или выберите более быстрый профиль.');
    throw new MediaError('PROVIDER_UNAVAILABLE', 'Не удалось связаться с OpenRouter.', 'Проверьте интернет и повторите; неуспешная генерация не списывается.');
  }

  const text = await response.text();
  let payload: any;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const raw = typeof payload?.error === 'string' ? payload.error
      : typeof payload?.error?.message === 'string' ? payload.error.message
      : typeof payload?.message === 'string' ? payload.message : '';
    if (moderationError(raw)) throw new MediaError('CONTENT_REFUSED', 'Модель отклонила промпт по правилам безопасности.', 'Перепишите промпт без недопустимого содержания; не повторяйте тот же запрос.');
    throw providerError(response.status, raw);
  }

  const items = Array.isArray(payload?.data) ? payload.data : [];
  if (!items.length) throw new MediaError('PROVIDER_ERROR', 'OpenRouter не вернул изображение.', 'Повторите запрос или выберите другой профиль.');
  const images: ProviderImage[] = [];
  for (const item of items.slice(0, 10)) {
    if (typeof item?.b64_json !== 'string' || !item.b64_json) {
      throw new MediaError('PROVIDER_ERROR', 'OpenRouter вернул изображение в неподдерживаемом формате.', 'Повторите запрос или выберите другой профиль.');
    }
    const bytes = Buffer.from(item.b64_json, 'base64');
    if (!bytes.length) throw new MediaError('PROVIDER_ERROR', 'OpenRouter вернул пустое изображение.', 'Повторите запрос.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new MediaError('ASSET_TOO_LARGE', 'Изображение больше 8 МиБ и не помещается в ресурс проекта.', 'Выберите разрешение 1K/2K или формат WebP/JPEG.');
    }
    const sniffed = sniffImageMediaType(bytes);
    const declared = typeof item.media_type === 'string' ? item.media_type.toLowerCase() : '';
    if (!sniffed || (declared && declared !== sniffed && !ALLOWED_MIME.has(declared))) {
      throw new MediaError('UNSUPPORTED_FORMAT', `Формат изображения не поддерживается: ${declared || 'неизвестен'}.`, 'Используйте PNG, JPEG или WebP; SVG и GIF не принимаются.');
    }
    images.push({ bytes, mime: sniffed });
  }
  const cost = typeof payload?.usage?.cost === 'number' ? payload.usage.cost : null;
  return { images, costUsd: cost, model: profile.model };
}

/** Сгенерировать изображения через OpenRouter Images API с одним безопасным ретраем. */
export async function generateImages(apiKey: string, request: ImageProviderRequest, signal: AbortSignal): Promise<ImageProviderResult> {
  try {
    return await requestOnce(apiKey, request, signal);
  } catch (error) {
    if (!(error instanceof MediaError)) throw error;
    if (!['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'GENERATION_TIMEOUT'].includes(error.code) || signal.aborted) throw error;
    try { await delay(1200, signal); } catch { throw error; }
    return requestOnce(apiKey, request, signal);
  }
}
