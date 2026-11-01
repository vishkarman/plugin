import { Type, type Static } from "@sinclair/typebox";

export const IMPORT_CAPABILITY = "editor.project-import.v1";
export const ImportUpload = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("zip"),
      contentBase64: Type.String({ maxLength: 44739244 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("files"),
      files: Type.Array(
        Type.Object(
          {
            path: Type.String({ minLength: 1, maxLength: 500 }),
            contentBase64: Type.String({ maxLength: 11184812 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 512 },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type ImportUploadInput = Static<typeof ImportUpload>;
export const ImportCreate = Type.Object(
  {
    operationId: Type.String({ format: "uuid" }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    entrypoint: Type.String({ minLength: 1, maxLength: 240 }),
    upload: ImportUpload,
  },
  { additionalProperties: false },
);
export type ImportCreateInput = Static<typeof ImportCreate>;
export interface ImportSummary {
  kind: "vishvakarma" | "sources";
  name: string;
  entrypoints: string[];
  entrypoint: string | null;
  files: { path: string; size: number; kind: "source" | "asset" }[];
  excluded: string[];
  warnings: string[];
  profile: string[];
  dependencies: string[];
}
