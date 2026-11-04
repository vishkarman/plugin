import { Type, type Static } from '@sinclair/typebox';

export const ACCESS_CAPABILITY = 'access.project-roles.v1';
/** New plugin and Studio use the account workspace; the capability is optional for old servers. */
export const ACCOUNT_CAPABILITY = 'account.workspace.v1';

export type AccountRole = 'user' | 'admin';
export type AccountStatus = 'active' | 'blocked';

export interface AuthUser {
  id: string; username: string; displayName: string;
  role: AccountRole; canCreateProjects: boolean;
  /** Legacy marker of the original installation account, kept for old clients only. */
  isOwner: boolean;
}
export interface ProjectAccess {
  role: 'owner' | 'viewer' | 'commenter' | 'editor'; canEdit: boolean; canComment: boolean; canManage: boolean; canUseAgent: boolean;
}
export const MemberRole = Type.Union([Type.Literal('viewer'), Type.Literal('commenter'), Type.Literal('editor')]);
export const MemberUpdate = Type.Object({ role: MemberRole, allowAgent: Type.Boolean() }, { additionalProperties: false });
export type MemberUpdateInput = Static<typeof MemberUpdate>;
export const InvitationCreate = Type.Object({ role: MemberRole, allowAgent: Type.Boolean(),
  expiresInHours: Type.Integer({minimum: 1,maximum: 168}), maxUses: Type.Integer({minimum: 1,maximum: 100}),
}, { additionalProperties: false });
export type InvitationCreateInput = Static<typeof InvitationCreate>;
export const GuestCreate = Type.Object({ username: Type.String({minLength: 1,maxLength: 80,pattern: '^[a-zA-Z0-9_.-]+$'}),
  password: Type.String({minLength: 16,maxLength: 256}) }, { additionalProperties: false });
export interface ProjectMember { userId: string; username: string; role: 'viewer' | 'commenter' | 'editor'; allowAgent: boolean }
export interface ProjectInvitation { id: string; role: 'viewer' | 'commenter' | 'editor'; allowAgent: boolean; expiresAt: string; maxUses: number; uses: number; revokedAt: string | null }

export interface ProjectSummary { id: string; name: string; description: string; access: ProjectAccess }
