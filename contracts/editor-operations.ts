import { Type, type Static } from "@sinclair/typebox";
import type { SourceTarget } from "./adapters.js";

export const EDITOR_OPERATIONS_CAPABILITY = "editor.source-operations.v1";
const Id = Type.String({ minLength: 1, maxLength: 256 });
export const WidthCondition = Type.Object(
  {
    minWidth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    maxWidth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  },
  { additionalProperties: false },
);
export type EditorCondition = Static<typeof WidthCondition>;
export const EditorContextSchema = Type.Object(
  {
    artboardId: Id,
    viewport: Type.Optional(Type.Object({
      width: Type.Integer({minimum:100,maximum:4000}),
      height: Type.Integer({minimum:100,maximum:4000}),
    }, {additionalProperties:false})),
    entrypoint: Type.String({ minLength: 1, maxLength: 240 }),
    width: Type.Integer({ minimum: 1, maximum: 10000 }),
    height: Type.Integer({ minimum: 1, maximum: 10000 }),
  },
  { additionalProperties: false },
);
export type EditorViewContext = Static<typeof EditorContextSchema>;
const Scope = Type.Union([Type.Literal("instance"), Type.Literal("component")]);
export const EditorAction = Type.Union([
  Type.Object(
    {
      type: Type.Literal("geometry"),
      scope: Scope,
      values: Type.Object(
        {
          width: Type.Optional(Type.Number()),
          height: Type.Optional(Type.Number()),
          left: Type.Optional(Type.Number()),
          top: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("reorder"),
      scope: Scope,
      siblingTargetId: Id,
      placement: Type.Union([Type.Literal("before"), Type.Literal("after")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("style"),
      path: Type.String({ maxLength: 240 }),
      selector: Type.String({ minLength: 1, maxLength: 240 }),
      condition: Type.Optional(WidthCondition),
      property: Type.String({ minLength: 1, maxLength: 80 }),
      value: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("insert"),
      componentId: Id,
      props: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Union([
            Type.String({ maxLength: 4096 }),
            Type.Number(),
            Type.Boolean(),
          ]),
        ),
      ),
    },
    { additionalProperties: false },
  ),
]);
export type EditorActionInput = Static<typeof EditorAction>;
export const EditorActionRequest = Type.Object(
  {
    operationId: Type.String({ format: "uuid" }),
    baseRevisionId: Type.String({ format: "uuid" }),
    targetId: Id,
    context: EditorContextSchema,
    action: EditorAction,
  },
  { additionalProperties: false },
);
export type EditorActionRequestInput = Static<typeof EditorActionRequest>;
export interface EditorGeometryProperty {
  property: "width" | "height" | "left" | "top";
  value: number;
  unit: "px";
  path: string;
}
export interface EditorStyleRule {
  path: string;
  selector: string;
  condition?: EditorCondition;
  declarations: Record<string, string>;
  editableProperties: string[];
  limitations: string[];
}
export interface EditorComponent {
  id: string;
  name: string;
  kind: "react" | "html-copy";
  path: string;
  targetId?: string;
  previewTargetId?: string;
  parameters: {
    name: string;
    type: "string" | "number" | "boolean";
    required: boolean;
    value?: string | number | boolean;
  }[];
  insertable: boolean;
  limitations: string[];
  scope: "linked" | "copy";
}
export interface EditorInspection {
  geometry: {
    scope: "instance" | "component";
    properties: EditorGeometryProperty[];
    limitations: string[];
  };
  reorder: {
    available: boolean;
    scope: "instance" | "component";
    siblings: { targetId: string; label: string }[];
    limitations: string[];
  };
  insert: { available: boolean; limitations: string[] };
  styles: EditorStyleRule[];
}
export interface EditorProjectContext {
  instructions: string[];
  projectId: string;
  revisionId: string;
  context: EditorViewContext;
  target: SourceTarget | null;
  inspection: EditorInspection | null;
  components: EditorComponent[];
  tokens: SourceTarget[];
  styleProperties: string[];
  rules: string[];
}
