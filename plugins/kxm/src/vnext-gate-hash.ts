import { vnextCanonicalJson, type JsonValue } from "./vnext-config.ts";
import { vnextSha256 } from "./vnext-engine-plan.ts";

export function gateDefinitionHash(id: string, definition: JsonValue): string {
  return vnextSha256(vnextCanonicalJson({ id, ...(definition as object) } as JsonValue));
}

export function gateRegistryHash(registryValue: JsonValue): string {
  return vnextSha256(vnextCanonicalJson(registryValue));
}
