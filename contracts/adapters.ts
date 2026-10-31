import { Type, type Static } from '@sinclair/typebox';
import type { ProjectAccess } from './access.js';
import type { SceneSource, BuildInfo } from './runner.js';

export const ADAPTER_CAPABILITY = 'adapters.source-editing.v1';
export const ADAPTER_REBASE_CAPABILITY = 'adapters.checked-rebase.v1';
export const TemplateId = Type.Union([Type.Literal('editorial'), Type.Literal('dashboard'), Type.Literal('scene')]);
export type TemplateKey = Static<typeof TemplateId>;
export const ExampleId = Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' });
export type ExampleKey = string;
export const WORKSPACE_CAPABILITY = 'workspace.projects.v1';
export const AdapterParams = Type.Object({ id: ExampleId }, { additionalProperties: false });
export const SourcePath = Type.String({ minLength: 1, maxLength: 240 });
export type SourcePathName = Static<typeof SourcePath>;
export const EditScope = Type.Union([Type.Literal('instance'), Type.Literal('component'), Type.Literal('token')]);
export type TargetScope = Static<typeof EditScope>;
export const SemanticEdit = Type.Object({
  type: Type.Literal('semantic'), targetId: Type.String({ minLength: 1, maxLength: 256 }),
  adapterId: Type.String({ minLength: 1, maxLength: 100 }), scope: EditScope,
  property: Type.String({ minLength: 1, maxLength: 100 }), value: Type.Union([Type.String({ maxLength: 4096 }), Type.Number()]),
}, { additionalProperties: false });
export const FileEdit = Type.Object({
  type: Type.Literal('files'), files: Type.Array(Type.Object({
    path: SourcePath, expectedHash: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]), content: Type.Union([Type.String({ maxLength: 262144 }), Type.Null()]),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
}, { additionalProperties: false });
export const AdapterChange = Type.Object({
  operationId: Type.String({ format: 'uuid' }), baseRevisionId: Type.String({ format: 'uuid' }),
  rebase: Type.Optional(Type.Literal('if-unchanged')),
  operation: Type.Union([SemanticEdit, FileEdit]),
}, { additionalProperties: false });
export type SemanticOperation = Static<typeof SemanticEdit>;
export type AdapterChangeInput = Static<typeof AdapterChange>;
export const AdapterBuild = Type.Object({ revisionId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });

export interface AdapterOperation {
  adapterId: string; property: string; label: string; scope: TargetScope;
  value: string | number; valueType: 'text' | 'color' | 'number';
}
export interface SourceTarget {
  id: string; label: string; kind: 'dom' | 'scene' | 'token'; scope: TargetScope;
  source: { path: SourcePathName; start: number; end: number; line: number };
  operations: AdapterOperation[]; limitations: string[]; relatedTargetIds: string[];
}
export interface AdapterAnalysis {
  profile: string[]; adapters: { id: string; version: string }[]; targets: SourceTarget[]; diagnostics: string[];
}
export interface AdapterInstruction { adapterId: string; version: string; text: string }
export interface AdapterExample { id: TemplateKey; name: string; description: string }
export interface AdapterProjectContext {
  access: ProjectAccess;
  projectId: ExampleKey; name: string; revisionId: string; saved: true;
  entrypoint: string; assets: (SourceAsset & { url: string })[];
  files: { path: SourcePathName; content: string; sha256: string }[];
  analysis: AdapterAnalysis; instructions: AdapterInstruction[];
  design: { description: string; rules: string[] };
  latest: BuildInfo | null;
  preview: (BuildInfo & { revisionId: string }) | null;
}
export interface AdapterSavedChange {
  projectId: ExampleKey; revisionId: string; saved: true; operationId: string;
  baseRevisionId?: string; appliedOnRevisionId?: string; rebased?: boolean;
}
export type ChangeConflict = {
  path: SourcePathName; code: 'FILE_CHANGED'; baseHash: string | null; currentHash: string | null;
} | {
  path: SourcePathName; code: 'BASE_HASH_MISMATCH'; baseHash: string | null; currentHash: string | null; expectedHash: string | null;
};
export interface AdapterChangeCheck {
  projectId: ExampleKey; operationId: string; baseRevisionId: string; currentRevisionId: string;
  status: 'ready' | 'conflict' | 'already-applied'; rebased: boolean;
  touchedFiles: SourcePathName[]; conflicts: ChangeConflict[]; savedResult?: AdapterSavedChange;
}
// Immutable source files remain authoritative; preview instrumentation is derived from them.
export type AdapterSource = SceneSource;

export interface SourceAsset { path: string; sha256: string; mime: string; size: number }
const RequestOperationId = Type.String({ format: 'uuid' });
const ProjectName = Type.String({ minLength: 1, maxLength: 120 });
const Description = Type.String({ maxLength: 4096 });
const Rules = Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 32 });
export const ProjectCreate = Type.Object({ operationId: RequestOperationId, name: ProjectName,
  template: Type.Optional(Type.Union([TemplateId, Type.Literal('empty')])), description: Type.Optional(Description),
  rules: Type.Optional(Rules), entrypoint: Type.Optional(SourcePath),
}, { additionalProperties: false });
export type ProjectCreateInput = Static<typeof ProjectCreate>;
export const ProjectUpdate = Type.Object({ operationId: RequestOperationId, baseRevisionId: RequestOperationId,
  name: Type.Optional(ProjectName), description: Type.Optional(Description), rules: Type.Optional(Rules), entrypoint: Type.Optional(SourcePath),
}, { additionalProperties: false });
export type ProjectUpdateInput = Static<typeof ProjectUpdate>;
export const AssetUpload = Type.Object({ operationId: RequestOperationId, baseRevisionId: RequestOperationId, path: SourcePath,
  mime: Type.String({ minLength: 1, maxLength: 100 }), contentBase64: Type.Union([Type.String({ maxLength: 11184812 }), Type.Null()]),
  expectedHash: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
}, { additionalProperties: false });
export type AssetUploadInput = Static<typeof AssetUpload>;
