import { Type, type Static } from '@sinclair/typebox';
import type { AdapterProjectContext } from './adapters.js';

export const PRODUCT_CAPABILITY = 'product.history-comments-export.v1';
const Uuid = Type.String({ format: 'uuid' });
export const RevisionLabel = Type.Object({ operationId: Uuid, label: Type.String({ maxLength: 120 }) }, { additionalProperties: false });
export const RevisionRestore = Type.Object({ operationId: Uuid, baseRevisionId: Uuid, revisionId: Uuid }, { additionalProperties: false });
export type RevisionRestoreInput = Static<typeof RevisionRestore>;
export interface RevisionInfo {
  id: string; createdAt: string; label: string; author: string | null; origin: string;
  restoredFrom: string | null; current: boolean; entrypoint: string; fileCount: number | null;
}
export interface HistoryResult { revisions: RevisionInfo[]; nextCursor: string | null; currentRevisionId: string }
export interface RevisionContext extends AdapterProjectContext { history: RevisionInfo }
export const Region = Type.Object({ x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }),
  width: Type.Number({ minimum: 0, maximum: 1 }), height: Type.Number({ minimum: 0, maximum: 1 }),
  viewportWidth: Type.Integer({ minimum: 100, maximum: 4000 }), viewportHeight: Type.Integer({ minimum: 100, maximum: 4000 }),
}, { additionalProperties: false });
export const CommentAnchorInput = Type.Union([
  Type.Object({ kind: Type.Literal('project') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('target'), targetId: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('region'), region: Region }, { additionalProperties: false }),
]);
const CommentBody = Type.String({ minLength: 1, maxLength: 8000 });
export const CommentCreate = Type.Object({ operationId: Uuid, revisionId: Uuid, body: CommentBody, anchor: CommentAnchorInput }, { additionalProperties: false });
export const CommentReply = Type.Object({ operationId: Uuid, body: CommentBody }, { additionalProperties: false });
export const CommentResolve = Type.Object({ operationId: Uuid, resolved: Type.Boolean(), expectedVersion: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export type CommentCreateInput = Static<typeof CommentCreate>;
export type CommentReplyInput = Static<typeof CommentReply>;
export type CommentResolveInput = Static<typeof CommentResolve>;
export type CommentRegion = Static<typeof Region>;
export type CommentAnchor = { kind: 'project' } | { kind: 'region'; region: CommentRegion } |
  { kind: 'target'; targetId: string; path: string; line: number; label: string; fileHash: string };
export interface CommentMessage { id: string; authorId: string; author: string; body: string; createdAt: string }
export interface CommentThread {
  id: string; revisionId: string; anchor: CommentAnchor; anchorStatus: 'current' | 'changed' | 'missing';
  resolved: boolean; version: number; createdAt: string; updatedAt: string; messages: CommentMessage[];
}
export const ExportRequest = Type.Object({ operationId: Uuid, revisionId: Uuid, kind: Type.Union([Type.Literal('source'), Type.Literal('web')]) }, { additionalProperties: false });
export type ExportRequestInput = Static<typeof ExportRequest>;
export interface ExportInfo {
  id: string; projectId: string; revisionId: string; kind: 'source' | 'web'; filename: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'; buildId: string | null; message: string;
  downloadUrl: string | null; browserUrl: string;
}
