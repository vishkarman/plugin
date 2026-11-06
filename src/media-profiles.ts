/**
 * Профили генерации изображений — данные, а не отдельные инструменты.
 *
 * Этап 1: только встроенные `core:draft` и `core:final`. Каталог admin/user-профилей
 * добавляется позже; слияние и namespaced id заложены в типах.
 */

export type MediaProfileScope = 'builtin' | 'installation' | 'user';

export interface MediaProfile {
  id: string;
  title: string;
  /** Описание для модели: когда выбирать профиль. */
  description: string;
  provider: 'openrouter';
  /** Credential reference, не значение ключа. */
  credential: string;
  model: string;
  resolution: string | null;
  maxCount: number;
  timeoutMs: number;
  costHintUsd: number | null;
  /** Подсказка скиллу: использовать только по явной просьбе/ручному выбору. */
  explicitOnly: boolean;
  outputFormat?: 'png' | 'jpeg' | 'webp';
  /** Техническая обвязка, которую агент не должен придумывать сам. */
  promptSuffix: string;
  scope: MediaProfileScope;
}

/** Часть конфигурации плагина, относящаяся к генерации. */
export interface MediaConfig {
  imageApiKeyEnv?: string;
  mediaDraftModel?: string;
  mediaFinalModel?: string;
}

export function builtinProfiles(config: MediaConfig = {}): MediaProfile[] {
  return [
    {
      id: 'core:draft',
      title: 'Быстрый черновик',
      description: 'Быстрая и дешёвая генерация для итераций и первого варианта. Используй по умолчанию, если пользователь не просил качество и не выбрал другой профиль.',
      provider: 'openrouter',
      credential: config.imageApiKeyEnv || 'OPENROUTER_API_KEY',
      model: config.mediaDraftModel || 'google/gemini-2.5-flash-image',
      resolution: '1K',
      maxCount: 1,
      timeoutMs: 90_000,
      costHintUsd: 0.04,
      explicitOnly: false,
      promptSuffix: 'clean composition, no text, no watermark, no UI chrome',
      scope: 'builtin',
    },
    {
      id: 'core:final',
      title: 'Финальное качество',
      description: 'Качественная/финальная генерация. Только по прямой просьбе в текущем сообщении или при ручном выборе качества.',
      provider: 'openrouter',
      credential: config.imageApiKeyEnv || 'OPENROUTER_API_KEY',
      model: config.mediaFinalModel || 'google/gemini-3-pro-image',
      resolution: '2K',
      maxCount: 1,
      timeoutMs: 300_000,
      costHintUsd: 0.12,
      explicitOnly: true,
      promptSuffix: 'high detail, production quality, natural materials, no text, no watermark, no UI chrome',
      scope: 'builtin',
    },
  ];
}

export const DEFAULT_PROFILE_ID = 'core:draft';

export function findProfile(id: string | undefined, config: MediaConfig = {}): MediaProfile | undefined {
  const wanted = id || DEFAULT_PROFILE_ID;
  return builtinProfiles(config).find(profile => profile.id === wanted);
}

export function profileIds(config: MediaConfig = {}): string {
  return builtinProfiles(config).map(profile => profile.id).join(', ');
}
