"""Emit the Studio path inventory and the revision helper.

The OpenAPI document comes from the FastAPI app. `controlPaths` is that
document's path inventory. `RevisionView` and `publishRevision` are the
revision helper this module emits; they are not inferred from the schema.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Mapping


def dump_openapi(spec: Mapping[str, object]) -> str:
    return json.dumps(spec, indent=2, sort_keys=True) + "\n"


def generate_studio_client(spec: Mapping[str, object]) -> str:
    paths = spec.get("paths")
    if not isinstance(paths, dict) or not paths:
        raise ValueError("openapi contract has no paths")
    listed = "\n".join(f"  {json.dumps(path)}," for path in sorted(paths))
    return f"""// Path inventory derived from the kxm-control OpenAPI document.
// The revision helper below is emitted by kxm_control.clientgen. Do not edit.
export const controlPaths = [
{listed}
] as const;

export interface Denied {{
  code: string;
  message: string;
}}

export interface RevisionView {{
  revisionId: string;
  sha256: string;
  canonical: string;
}}

export async function publishRevision(input: {{
  baseUrl: string;
  token: string;
  tenantId: string;
  projectId: string;
  document: Record<string, unknown>;
}}): Promise<RevisionView> {{
  const path = `/v1/tenants/${{encodeURIComponent(input.tenantId)}}/projects/${{encodeURIComponent(input.projectId)}}/revisions`;
  const response = await fetch(`${{input.baseUrl}}${{path}}`, {{
    method: "POST",
    headers: {{
      authorization: `Bearer ${{input.token}}`,
      "content-type": "application/json",
    }},
    body: JSON.stringify({{ document: input.document }}),
  }});
  if (!response.ok) {{
    throw new Error(`control_api_${{response.status}}`);
  }}
  return (await response.json()) as RevisionView;
}}
"""


def write_generated_contracts() -> None:
    from kxm_control.api import app

    root = Path(__file__).parents[2]
    spec = app.openapi()
    (root / "contract" / "openapi.json").write_text(dump_openapi(spec))
    (root / "generated" / "studio-client.ts").write_text(generate_studio_client(spec))


def main() -> None:
    write_generated_contracts()


if __name__ == "__main__":
    main()
