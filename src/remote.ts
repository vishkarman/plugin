import type { TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { updateNoticeSchema, updateSettingsSchema, updateStatusSchema, type UpdateNotice, type UpdateSettings, type UpdateStatus } from './update-contract.js';
import type { SelectionSnapshot } from '../contracts/selection.js';
import {
  generateMediaRequestSchema, generateMediaResultSchema, mediaProfileSummarySchema, mediaSettingsSchema,
  type GenerateMediaRequest, type GenerateMediaResult, type MediaProfileSummary, type MediaSettings,
} from './media-contract.js';
export interface StudioConnection { url: string; available: boolean; message: string }
/** `supported:false` is the documented old-server fallback, never an error. */
export type SelectionRemote = SelectionSnapshot | { supported: false };
const accessSchema = z.object({
  role: z.enum(['owner', 'viewer', 'commenter', 'editor']),
  canEdit: z.boolean(), canComment: z.boolean(), canManage: z.boolean(), canUseAgent: z.boolean(),
}).strict();
const selectionRecordSchema = z.object({
  version: z.literal(1), kind: z.literal('selection'),
  projectId: z.string(), revisionId: z.string(),
  artboardId: z.string().optional(), artboardEntrypoint: z.string().optional(),
  targetId: z.string().nullable(), targetLabel: z.string().optional(), capturedAt: z.string(),
}).strict();
const selectionSnapshotSchema = z.object({
  supported: z.literal(true),
  selection: selectionRecordSchema.nullable(),
  access: accessSchema.nullable(),
  projectName: z.string().nullable(),
  account: z.object({ username: z.string(), displayName: z.string() }).strict(),
}).strict();
const selectionUnsupportedSchema = z.object({ supported: z.literal(false) }).strict();
// One explicit, strict SDK descriptor shared by the Host and Client assembly.
export const studioRemote: TypertRemoteContribution = {
  package: '@vishkarman/plugin',
  descriptors: [{
    id: 'vishvakarma/studio', service: 'vishvakarma', namespace: 'vishvakarma', method: 'studio',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'StudioConnection', create: () => z.object({ url: z.string(), available: z.boolean(), message: z.string() }).strict() },
  }, {
    id: 'vishvakarma/selection', service: 'vishvakarma', namespace: 'vishvakarma', method: 'selection',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'SelectionSnapshot', create: () => z.union([selectionSnapshotSchema, selectionUnsupportedSchema]) },
  }, {
    id: 'vishvakarma/mediaSettings', service: 'vishvakarma', namespace: 'vishvakarma', method: 'mediaSettings',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'MediaSettings', create: () => mediaSettingsSchema },
  }, {
    id: 'vishvakarma/mediaProfiles', service: 'vishvakarma', namespace: 'vishvakarma', method: 'mediaProfiles',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'MediaProfileSummary[]', create: () => z.array(mediaProfileSummarySchema) },
  }, {
    id: 'vishvakarma/generateMedia', service: 'vishvakarma', namespace: 'vishvakarma', method: 'generateMedia',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: { mode: 'strict', typeSymbol: 'GenerateMediaRequest', create: () => generateMediaRequestSchema } }],
    result: { mode: 'strict', typeSymbol: 'GenerateMediaResult', create: () => generateMediaResultSchema },
  }, {
    id: 'vishvakarma/updateNotice', service: 'vishvakarma', namespace: 'vishvakarma', method: 'updateNotice',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'UpdateNotice', create: () => updateNoticeSchema },
  }, ...['updateStatus', 'checkUpdate', 'installUpdate', 'updatePlugin', 'updateLocal', 'saveUpdateSettings'].map(method => ({
    id: `vishvakarma/${method}`, service: 'vishvakarma', namespace: 'vishvakarma', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'saveUpdateSettings' ? [{ name: 'settings', wire: 'settings', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'UpdateSettings', create: () => updateSettingsSchema } }] : [],
    result: { mode: 'strict' as const, typeSymbol: 'UpdateStatus', create: () => updateStatusSchema },
  }))],
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'vishvakarma/studio': () => Promise<RemoteResult<StudioConnection>>;
    'vishvakarma/selection': () => Promise<RemoteResult<SelectionRemote>>;
    'vishvakarma/mediaSettings': () => Promise<RemoteResult<MediaSettings>>;
    'vishvakarma/mediaProfiles': () => Promise<RemoteResult<MediaProfileSummary[]>>;
    'vishvakarma/generateMedia': (input: GenerateMediaRequest) => Promise<RemoteResult<GenerateMediaResult>>;
    'vishvakarma/updateStatus': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/updateNotice': () => Promise<RemoteResult<UpdateNotice>>;
    'vishvakarma/checkUpdate': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/installUpdate': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/updatePlugin': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/updateLocal': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/saveUpdateSettings': (settings: UpdateSettings) => Promise<RemoteResult<UpdateStatus>>;
  }
}
