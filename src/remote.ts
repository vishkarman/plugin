import type { TypertRemoteContribution, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
export interface StudioConnection { url: string; available: boolean; message: string }
// One explicit, strict SDK descriptor shared by the Host and Client assembly.
export const studioRemote: TypertRemoteContribution = {
  package: '@vishkarman/plugin',
  descriptors: [{
    id: 'vishvakarma/studio', service: 'vishvakarma', namespace: 'vishvakarma', method: 'studio',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: 'StudioConnection', create: () => z.object({ url: z.string(), available: z.boolean(), message: z.string() }).strict() },
  }],
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'vishvakarma/studio': () => Promise<RemoteResult<StudioConnection>> }
}
