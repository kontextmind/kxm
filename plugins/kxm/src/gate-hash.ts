import { kxmCanonicalJson, type JsonValue } from "./project-config.ts";
import { kxmSha256 } from "./engine-plan.ts";

export function gateDefinitionHash(id: string, definition: JsonValue): string {
  return kxmSha256(kxmCanonicalJson({ id, ...(definition as object) } as JsonValue));
}

export function gateRegistryHash(registryValue: JsonValue): string {
  return kxmSha256(kxmCanonicalJson(registryValue));
}
