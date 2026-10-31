import { Type, type Static } from '@sinclair/typebox';

export const API_VERSION = 'v1-prototype-1';
export const CAPABILITY = 'demo.set_text';
const Id = Type.String({ format: 'uuid' });
export const Change = Type.Object({
  operationId: Id,
  baseRevisionId: Id,
  operation: Type.Object({
    type: Type.Literal(CAPABILITY),
    resourcePath: Type.Literal('index.html'),
    target: Type.Literal('demo-title'),
    text: Type.String({ maxLength: 4096 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ChangeInput = Static<typeof Change>;
export const Login = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 80 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });
export type LoginInput = Static<typeof Login>;
export const PreviewRequest = Type.Object({
  revisionId: Id,
  fixture: Type.Union([Type.Literal('demo'), Type.Literal('scene')]),
}, { additionalProperties: false });
export type PreviewInput = Static<typeof PreviewRequest>;
export interface ServerInfo {
  apiVersion: string; serverVersion: string; installationId: string; capabilities: string[];
}
export interface ProjectContext {
  projectId: 'demo'; revisionId: string;
  resource: { path: 'index.html'; content: string; sha256: string };
  targets: ['demo-title']; operations: ['demo.set_text'];
}
export interface SavedChange {
  operationId: string; projectId: 'demo'; revisionId: string;
  saved: true; changed: { resourcePath: 'index.html'; target: 'demo-title' };
}
export interface ApiFailure {
  error: { code: string; message: string; revisionId?: string };
}
