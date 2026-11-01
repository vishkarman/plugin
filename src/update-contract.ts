import { z } from 'zod';

export const updateSettingsSchema = z.object({ development: z.boolean(), directory: z.string().max(4096) }).strict();
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export const updateNoticeSchema = z.enum(['changed', 'current', 'unknown']);
export type UpdateNotice = z.infer<typeof updateNoticeSchema>;
export const updateStatusSchema = z.object({
  available: z.boolean(), profile: z.string(), profileDirectory: z.string(),
  runningVersion: z.string(), installedVersion: z.string(), sourceVersion: z.string(),
  settings: updateSettingsSchema,
  phase: z.enum(['idle', 'checking', 'ready', 'building', 'installing', 'done', 'error']),
  message: z.string(), canUpdate: z.boolean(), restartRequired: z.boolean(), logPath: z.string(),
}).strict();
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
