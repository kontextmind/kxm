import { isAlias, isCollection, isMap, isScalar, parseDocument, visit } from "yaml";

/** Restricted JSON-compatible YAML limits used by KXM configuration. */
export const KXM_YAML_LIMITS = Object.freeze({
  maxDocumentBytes: 256 * 1024,
  maxDepth: 32,
  maxScalarBytes: 64 * 1024,
  maxCollectionItems: 4096,
  maxTotalNodes: 16_384,
  maxKeys: 8192,
});

const ALLOWED_YAML_TAGS = new Set([
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortIssues(issues) {
  return [...issues].sort((left, right) => compareCodeUnits(left.file, right.file)
    || compareCodeUnits(left.phase, right.phase)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.message, right.message));
}

function issue(phase, code, file, message) {
  return { phase, code, file, message };
}

export class RestrictedYamlError extends Error {
  /**
   * @param {readonly { phase: string, code: string, file: string, message: string }[]} issues
   */
  constructor(issues) {
    const sorted = sortIssues(issues);
    super(sorted.map((entry) => `${entry.file}: ${entry.code}: ${entry.message}`).join("\n"));
    this.name = "RestrictedYamlError";
    this.issues = sorted;
  }
}

function fail(phase, code, file, message) {
  throw new RestrictedYamlError([issue(phase, code, file, message)]);
}

function decodeUtf8(input, label) {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("parse", "invalid_utf8", label, "document is not valid UTF-8");
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(value, label, path = "$", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("parse", "non_json_number", label, `${path} is not a finite JSON number`);
    return;
  }
  if (!value || typeof value !== "object") fail("parse", "non_json_value", label, `${path} is not JSON-compatible`);
  if (seen.has(value)) fail("parse", "cyclic_value", label, `${path} is cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, candidate] of value.entries()) assertJsonValue(candidate, label, `${path}[${index}]`, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("parse", "constructed_object", label, `${path} has a forbidden constructed type`);
    }
    for (const [key, candidate] of Object.entries(value)) assertJsonValue(candidate, label, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

/** Parse the restricted, JSON-compatible YAML profile used by all KXM configuration. */
export function parseRestrictedYaml(
  input,
  label = "<yaml>",
  limits = KXM_YAML_LIMITS,
) {
  const byteLength = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength > limits.maxDocumentBytes) {
    fail("parse", "document_too_large", label, `document exceeds ${limits.maxDocumentBytes} bytes`);
  }
  const text = decodeUtf8(input, label);
  const document = parseDocument(text, {
    customTags: [],
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail("parse", "invalid_yaml", label, document.errors.map((error) => error.message).join("; "));
  }
  if (document.warnings.length > 0) {
    fail("parse", "yaml_warning", label, document.warnings.map((warning) => warning.message).join("; "));
  }

  let nodes = 0;
  let keys = 0;
  visit(document, (_key, node, path) => {
    nodes += 1;
    if (nodes > limits.maxTotalNodes) fail("parse", "node_limit", label, `document exceeds ${limits.maxTotalNodes} nodes`);
    if (path.length > limits.maxDepth) fail("parse", "depth_limit", label, `document exceeds nesting depth ${limits.maxDepth}`);
    if (isAlias(node)) fail("parse", "alias_forbidden", label, "aliases are forbidden");
    if (node && typeof node === "object" && "anchor" in node && typeof node.anchor === "string") {
      fail("parse", "anchor_forbidden", label, "anchors are forbidden");
    }
    if (isCollection(node) && node.items.length > limits.maxCollectionItems) {
      fail("parse", "collection_limit", label, `collection exceeds ${limits.maxCollectionItems} items`);
    }
    if (isMap(node)) {
      keys += node.items.length;
      if (keys > limits.maxKeys) fail("parse", "key_limit", label, `document exceeds ${limits.maxKeys} mapping keys`);
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          fail("parse", "non_string_key", label, "mapping keys must be strings");
        }
      }
    }
    if (isScalar(node) && typeof node.value === "string" && Buffer.byteLength(node.value, "utf8") > limits.maxScalarBytes) {
      fail("parse", "scalar_limit", label, `scalar exceeds ${limits.maxScalarBytes} bytes`);
    }
    if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string" && !ALLOWED_YAML_TAGS.has(node.tag)) {
      fail("parse", "tag_forbidden", label, `tag ${node.tag} is forbidden`);
    }
  });

  const value = document.toJS({ maxAliasCount: 0 });
  assertJsonValue(value, label);
  if (!isJsonObject(value)) fail("parse", "root_not_object", label, "resource root must be a mapping");
  return value;
}
