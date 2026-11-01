import type { TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { updateNoticeSchema, updateSettingsSchema, updateStatusSchema, type UpdateNotice, type UpdateSettings, type UpdateStatus } from './update-contract.js';
export interface StudioConnection { url: string; available: boolean; message: string }
// One explicit, strict SDK descriptor shared by the Host and Client assembly.
export const studioRemote: TypertRemoteContribution = {
  package: '@vishkarman/plugin',
  descriptors: [{
    id: 'vishvakarma/studio', service: 'vishvakarma', namespace: 'vishvakarma', method: 'studio',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'StudioConnection', create: () => z.object({ url: z.string(), available: z.boolean(), message: z.string() }).strict() },
  }, {
    id: 'vishvakarma/updateNotice', service: 'vishvakarma', namespace: 'vishvakarma', method: 'updateNotice',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'UpdateNotice', create: () => updateNoticeSchema },
  }, ...['updateStatus', 'checkUpdate', 'installUpdate', 'saveUpdateSettings'].map(method => ({
    id: `vishvakarma/${method}`, service: 'vishvakarma', namespace: 'vishvakarma', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'saveUpdateSettings' ? [{ name: 'settings', wire: 'settings', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'UpdateSettings', create: () => updateSettingsSchema } }] : [],
    result: { mode: 'strict' as const, typeSymbol: 'UpdateStatus', create: () => updateStatusSchema },
  }))],
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'vishvakarma/studio': () => Promise<RemoteResult<StudioConnection>>;
    'vishvakarma/updateStatus': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/updateNotice': () => Promise<RemoteResult<UpdateNotice>>;
    'vishvakarma/checkUpdate': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/installUpdate': () => Promise<RemoteResult<UpdateStatus>>;
    'vishvakarma/saveUpdateSettings': (settings: UpdateSettings) => Promise<RemoteResult<UpdateStatus>>;
  }
}
