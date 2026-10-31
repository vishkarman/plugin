import { Type, type Static } from '@sinclair/typebox';
import type { SceneSource, BuildInfo } from './runner.js';

export const ADAPTER_CAPABILITY = 'adapters.source-editing.v1';
export const ExampleId = Type.Union([Type.Literal('editorial'), Type.Literal('dashboard'), Type.Literal('scene')]);
export type ExampleKey = Static<typeof ExampleId>;
export const AdapterParams = Type.Object({ id: ExampleId }, { additionalProperties: false });
export const SourcePath = Type.Union([Type.Literal('index.html'), Type.Literal('main.tsx'), Type.Literal('style.css')]);
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
    path: SourcePath, expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }), content: Type.String({ maxLength: 262144 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });
export const AdapterChange = Type.Object({
  operationId: Type.String({ format: 'uuid' }), baseRevisionId: Type.String({ format: 'uuid' }),
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
export interface AdapterExample { id: ExampleKey; name: string; description: string }
export interface AdapterProjectContext {
  projectId: ExampleKey; name: string; revisionId: string; saved: true;
  files: { path: SourcePathName; content: string; sha256: string }[];
  analysis: AdapterAnalysis; instructions: AdapterInstruction[];
  design: { description: string; rules: string[] };
  latest: BuildInfo | null;
  preview: (BuildInfo & { revisionId: string }) | null;
}
export interface AdapterSavedChange { projectId: ExampleKey; revisionId: string; saved: true; operationId: string }
// Immutable source files remain authoritative; preview instrumentation is derived from them.
export type AdapterSource = SceneSource;
