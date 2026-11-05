import { Type, type Static } from '@sinclair/typebox';
import type { ProjectAccess } from './access.js';

/** Shared selection contract for Studio publishing and the DSH plugin reading it. */
export const SELECTION_VERSION = 1 as const;

const ProjectId = Type.String({ minLength: 1, maxLength: 120 });
const RevisionId = Type.String({ format: 'uuid' });
const ArtboardId = Type.String({ minLength: 1, maxLength: 120 });
const ArtboardEntrypoint = Type.String({ minLength: 1, maxLength: 240 });
const TargetId = Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]);
const TargetLabel = Type.String({ maxLength: 120 });
const SurfaceId = Type.String({ minLength: 1, maxLength: 64 });
const Seq = Type.Integer({ minimum: 0 });

export const SelectionWrite = Type.Object({
  version: Type.Literal(SELECTION_VERSION),
  kind: Type.Literal('selection'),
  projectId: ProjectId,
  revisionId: RevisionId,
  artboardId: Type.Optional(ArtboardId),
  artboardEntrypoint: Type.Optional(ArtboardEntrypoint),
  targetId: TargetId,
  targetLabel: Type.Optional(TargetLabel),
  surfaceId: SurfaceId,
  seq: Seq,
}, { additionalProperties: false });
export type SelectionWriteInput = Static<typeof SelectionWrite>;

export const SelectionClear = Type.Object({
  version: Type.Literal(SELECTION_VERSION),
  surfaceId: SurfaceId,
  seq: Seq,
}, { additionalProperties: false });
export type SelectionClearInput = Static<typeof SelectionClear>;

/** The persisted snapshot returned to readers; `targetId: null` means the project without an element. */
export interface SelectionRecord {
  version: typeof SELECTION_VERSION;
  kind: 'selection';
  projectId: string;
  revisionId: string;
  artboardId?: string;
  artboardEntrypoint?: string;
  targetId: string | null;
  targetLabel?: string;
  capturedAt: string;
}

export interface SelectionAccount { username: string; displayName: string }

/** Successful read; `access` and `projectName` are null when no snapshot exists. */
export interface SelectionSnapshot {
  supported: true;
  selection: SelectionRecord | null;
  access: ProjectAccess | null;
  projectName: string | null;
  account: SelectionAccount;
}

export interface SelectionSaveResponse { saved: boolean; capturedAt: string | null }
export interface SelectionClearResponse { cleared: boolean }
