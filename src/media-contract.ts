import { z } from 'zod';

/** Строка-идентификатор опциональной серверной возможности; повторяет server/contracts/media.ts. */
export const MEDIA_CAPABILITY = 'media.generation.v1';
export const MEDIA_PROFILES_CAPABILITY = 'media.profiles.v1';

export const MANUAL_GENERATION_MODES = ['agent', 'direct'] as const;
export type ManualGenerationMode = (typeof MANUAL_GENERATION_MODES)[number];

/** Платформенная настройка ручного запуска, читается плагином у сервера. */
export interface MediaSettings {
  manualGenerationMode: ManualGenerationMode;
  /** false — сервер не поддерживает настройку; панель работает только через агента. */
  supported: boolean;
}

export const mediaSettingsSchema = z.object({
  manualGenerationMode: z.enum(MANUAL_GENERATION_MODES),
  supported: z.boolean(),
}).strict();

/** Одна запись каталога профилей; без секретов. */
export interface MediaProfileSummary {
  id: string;
  title: string;
  description: string;
  model: string;
  resolution: string | null;
  costHintUsd: number | null;
  explicitOnly: boolean;
  configured: boolean;
  available: boolean;
}

export const mediaProfileSummarySchema = z.object({
  id: z.string(), title: z.string(), description: z.string(), model: z.string(),
  resolution: z.string().nullable(), costHintUsd: z.number().nullable(),
  explicitOnly: z.boolean(), configured: z.boolean(), available: z.boolean(),
}).strict();

/** Профиль в каталоге сервера: без credential и без провайдерских секретов. */
export interface ServerMediaProfile {
  id: string;
  title: string;
  description: string;
  model: string;
  resolution: string | null;
  maxCount: number;
  timeoutMs: number;
  costHintUsd: number | null;
  explicitOnly: boolean;
  promptSuffix: string;
}

export const serverMediaProfileSchema = z.object({
  id: z.string(), title: z.string(), description: z.string(), model: z.string(),
  resolution: z.string().nullable(), maxCount: z.number().int(), timeoutMs: z.number().int(),
  costHintUsd: z.number().nullable(), explicitOnly: z.boolean(), promptSuffix: z.string(),
}).strict();

/** Запрос прямой генерации из панели DSH; проект и выделение Host читает сам. */
export interface GenerateMediaRequest {
  prompt: string;
  profile?: string;
  aspectRatio?: string;
  replace?: boolean;
}

export const generateMediaRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  profile: z.string().min(1).max(80).optional(),
  aspectRatio: z.string().min(1).max(16).optional(),
  replace: z.boolean().optional(),
}).strict();

export interface GeneratedMediaAsset {
  path: string;
  sha256: string;
  mime: string;
  size: number;
  /** Настоящий alpha-канал в сохранённом файле. */
  hasAlpha?: boolean;
}

export const generatedMediaAssetSchema = z.object({
  path: z.string(), sha256: z.string(), mime: z.string(), size: z.number().int().nonnegative(),
  hasAlpha: z.boolean().optional(),
}).strict();

export interface GenerateMediaResult {
  projectId: string;
  revisionId: string;
  profile: string;
  model: string;
  assets: GeneratedMediaAsset[];
  replaced: boolean;
  costUsd: number | null;
  studioUrl: string;
}

export const generateMediaResultSchema = z.object({
  projectId: z.string(), revisionId: z.string(), profile: z.string(), model: z.string(),
  assets: z.array(generatedMediaAssetSchema), replaced: z.boolean(),
  costUsd: z.number().nullable(), studioUrl: z.string(),
}).strict();
