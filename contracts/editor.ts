import { Type, type Static } from "@sinclair/typebox";
export const EDITOR_CAPABILITY = "editor.artboards-preferences.v1";
export const PNG_CAPABILITY = "editor.png.v1";
export const ArtboardId = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
});
const Coordinate = Type.Number({ minimum: -1000000, maximum: 1000000 });
export const GuideSchema = Type.Object(
  {
    id: ArtboardId,
    axis: Type.Union([Type.Literal("x"), Type.Literal("y")]),
    position: Coordinate,
  },
  { additionalProperties: false },
);
export const ArtboardSchema = Type.Object(
  {
    id: ArtboardId,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    x: Coordinate,
    y: Coordinate,
    width: Type.Integer({ minimum: 100, maximum: 4000 }),
    height: Type.Integer({ minimum: 100, maximum: 4000 }),
    entrypoint: Type.String({ minLength: 1, maxLength: 240 }),
    guides: Type.Array(GuideSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
export type Artboard = Static<typeof ArtboardSchema>;
export const EditorAuthoringSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    artboards: Type.Array(ArtboardSchema, { minItems: 1, maxItems: 32 }),
  },
  { additionalProperties: false },
);
export type EditorAuthoring = Static<typeof EditorAuthoringSchema>;
export const EditorAuthoringUpdate = Type.Object(
  {
    operationId: Type.String({ format: "uuid" }),
    baseRevisionId: Type.String({ format: "uuid" }),
    expectedAuthoringVersion: Type.Optional(Type.Integer({ minimum: 0 })),
    authoring: EditorAuthoringSchema,
  },
  { additionalProperties: false },
);
export type EditorAuthoringUpdateInput = Static<typeof EditorAuthoringUpdate>;
export interface EditorState {
  projectId: string;
  revisionId: string;
  authoringVersion: number;
  authoring: EditorAuthoring;
}
export const EditorPreferencesSchema = Type.Object(
  {
    grid: Type.Boolean(),
    guides: Type.Boolean(),
    snap: Type.Boolean(),
    gridSize: Type.Integer({ minimum: 1, maximum: 256 }),
  },
  { additionalProperties: false },
);
export type EditorPreferences = Static<typeof EditorPreferencesSchema>;
export const EditorPreferencesUpdate = Type.Object(
  {
    operationId: Type.String({ format: "uuid" }),
    expectedVersion: Type.Integer({ minimum: 0 }),
    preferences: EditorPreferencesSchema,
  },
  { additionalProperties: false },
);
export type EditorPreferencesUpdateInput = Static<
  typeof EditorPreferencesUpdate
>;
export interface EditorPreferencesState {
  version: number;
  preferences: EditorPreferences;
}
