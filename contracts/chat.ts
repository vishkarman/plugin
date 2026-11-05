import { Type, type Static } from '@sinclair/typebox';

export const CHAT_TTL_MS = 15 * 60_000;
export const CHAT_LEASE_MS = 5 * 60_000;
export const CHAT_MESSAGE_MAX = 4_000;
export const CHAT_HISTORY_LIMIT = 40;

const Uuid = Type.String({ format: 'uuid' });
const ProjectId = Type.String({ minLength: 1, maxLength: 120 });

/** Frozen visual context sent with a user message; same fields as the selection snapshot. */
export const ChatContext = Type.Object({
  version: Type.Literal(1),
  kind: Type.Literal('selection'),
  projectId: ProjectId,
  revisionId: Uuid,
  artboardId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  artboardEntrypoint: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  targetId: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  targetLabel: Type.Optional(Type.String({ maxLength: 120 })),
  capturedAt: Type.String({ minLength: 1, maxLength: 40 }),
}, { additionalProperties: false });
export type ChatContextValue = Static<typeof ChatContext>;

export const ChatSend = Type.Object({
  message: Type.String({ minLength: 1, maxLength: CHAT_MESSAGE_MAX }),
  context: ChatContext,
  idempotencyKey: Uuid,
  replyToMessageId: Type.Optional(Uuid),
}, { additionalProperties: false });
export type ChatSendInput = Static<typeof ChatSend>;

export const ChatCancel = Type.Object({ requestId: Uuid }, { additionalProperties: false });
export const ChatClaim = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  instanceId: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false });
export const ChatSignal = Type.Object({
  leaseToken: Uuid, sessionId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export const ChatFailed = Type.Object({
  leaseToken: Uuid, sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  error: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });
export const ChatTraceItem = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 160 }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });
export const ChatAnswer = Type.Object({
  leaseToken: Uuid, sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ minLength: 1, maxLength: CHAT_MESSAGE_MAX }),
  idempotencyKey: Uuid,
  askOptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 8 })),
  trace: Type.Optional(Type.Array(ChatTraceItem, { maxItems: 12 })),
}, { additionalProperties: false });
export const ChatClaimBody = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  instanceId: Type.String({ minLength: 1, maxLength: 120 }),
  reconcile: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const ChatReconcile = Type.Object({
  leaseToken: Uuid,
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  result: Type.Union([Type.Literal('accepted'), Type.Literal('not-accepted'), Type.Literal('unknown')]),
}, { additionalProperties: false });
export const ChatPresence = Type.Object({
  instanceId: Type.String({ minLength: 1, maxLength: 120 }), online: Type.Boolean(),
}, { additionalProperties: false });

export type ChatRole = 'user' | 'agent' | 'system';
export type ChatRequestStatus = 'queued' | 'claimed' | 'delivered' | 'working' | 'reconciling' | 'awaiting_user' | 'answered' | 'failed' | 'cancelled' | 'expired';

export interface ChatMessage {
  id: string; projectId: string; role: ChatRole; body: string; createdAt: string;
  requestId?: string | null; replyToMessageId?: string | null; askOptions?: string[] | null;
  trace?: Array<{ label: string; detail?: string }> | null;
}
export interface ChatRequest {
  id: string; messageId: string; projectId: string; status: ChatRequestStatus;
  attempts: number; expiresAt: string; createdAt: string; error?: string | null;
  deliveredAt?: string | null; answeredAt?: string | null; thinkingMs?: number | null;
}
export interface ChatState {
  messages: ChatMessage[];
  requests: ChatRequest[];
  agentOnline: boolean;
  canUseAgent: boolean;
}
export interface AgentChatRequest {
  id: string; projectId: string; context: ChatContextValue; expiresAt: string; status: ChatRequestStatus;
}
export interface AgentChatClaim extends AgentChatRequest { leaseToken: string; reconcile: boolean }
export interface AgentChatHistory { items: ChatMessage[] }
