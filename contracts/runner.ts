import { Type, type Static } from '@sinclair/typebox';

export const RUNNER_CAPABILITY = 'runner.react-scene';
export const SceneFiles = Type.Object({
  'index.html': Type.String({ minLength: 1, maxLength: 262144 }),
  'main.tsx': Type.String({ minLength: 1, maxLength: 262144 }),
  'style.css': Type.String({ maxLength: 262144 }),
}, { additionalProperties: false });
export type SceneSource = Static<typeof SceneFiles>;
export const SnapshotRequest = Type.Object({ files: SceneFiles }, { additionalProperties: false });
export const BuildRequest = Type.Object({ snapshotId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
export const BuildParams = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface BuildInfo {
  id: string; snapshotId: string; sourceHash: string; status: BuildStatus;
  createdAt: string; finishedAt: string | null; imageId: string | null;
  errorCode: string | null; diagnostics: string;
}
export interface RunnerState {
  snapshot: { id: string; sourceHash: string } | null;
  latest: BuildInfo | null;
  preview: BuildInfo | null;
}
