import { Type, type Static } from '@sinclair/typebox';
import type { ExampleKey } from './adapters.js';

export const COLLABORATION_CAPABILITY = 'collaboration.source-text.v1';
export const CollaborationUpdate = Type.Object({
  operationId: Type.String({ format: 'uuid' }),
  baseSequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
  update: Type.String({ minLength: 4, maxLength: 349528, pattern: '^[A-Za-z0-9+/]+={0,2}$' }),
}, { additionalProperties: false });
export type CollaborationUpdateInput = Static<typeof CollaborationUpdate>;
export interface CollaborationState {
  protocolVersion: 'yjs-v1'; paths: string[]; projectId: ExampleKey; sequence: number; revisionId: string; state: string;
}
export interface CollaborationSaved {
  projectId: ExampleKey; sequence: number; revisionId: string; operationId: string; saved: true;
}
export interface CollaborationEvent {
  projectId: ExampleKey; sequence: number; revisionId: string; update: string; paths: string[];
}
