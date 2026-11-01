import { Type, type Static } from '@sinclair/typebox';
export const PREVIEW_CAPABILITY = 'preview.live.v1';
export const PREVIEW_BRIDGE_VERSION = 1;
export const PreviewRequest = Type.Object({
  revisionId: Type.String({ format: 'uuid' }),
  mode: Type.Optional(Type.Union([Type.Literal('live'), Type.Literal('frozen')])),
}, { additionalProperties: false });
export type PreviewRequestInput = Static<typeof PreviewRequest>;
export interface PreviewState {
  projectId: string; mode: 'live' | 'frozen'; revisionId: string;
  runtimeId: string | null; inputKey: string | null; toolchainKey: string | null;
  status: 'unprepared' | 'waiting' | 'updating' | 'ready' | 'error'; message: string;
  applied: { revisionId: string; inputKey: string; epoch: string; generation: number } | null;
  targetMap: { ids: string[]; domIds: Record<string,string> } | null;
}
export interface PreviewLease {
  token: string; url: string; expiresAt: string; runtimeId: string;
}
export interface PreviewBinding {
  bridgeVersion: number; projectId: string; entrypoint: string; revisionId: string;
  inputKey: string; epoch: string; generation: number; nonce: string;
}
