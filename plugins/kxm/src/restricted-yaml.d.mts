export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface KxmYamlLimits {
  maxDocumentBytes: number;
  maxDepth: number;
  maxScalarBytes: number;
  maxCollectionItems: number;
  maxTotalNodes: number;
  maxKeys: number;
}

export const KXM_YAML_LIMITS: Readonly<KxmYamlLimits>;

export interface RestrictedYamlIssue {
  phase: "parse";
  code: string;
  file: string;
  message: string;
}

export class RestrictedYamlError extends Error {
  readonly issues: readonly RestrictedYamlIssue[];
  constructor(issues: readonly RestrictedYamlIssue[]);
}

export function parseRestrictedYaml(
  input: string | Uint8Array,
  label?: string,
  limits?: Readonly<KxmYamlLimits>,
): JsonObject;
