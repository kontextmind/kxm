// Path inventory derived from the kxm-control OpenAPI document.
// The revision helper below is emitted by kxm_control.clientgen. Do not edit.
export const controlPaths = [
  "/health",
  "/v1/account",
  "/v1/registration",
  "/v1/tenants",
  "/v1/tenants/{tenant_id}",
  "/v1/tenants/{tenant_id}/artifacts/{name}",
  "/v1/tenants/{tenant_id}/memberships",
  "/v1/tenants/{tenant_id}/projects",
  "/v1/tenants/{tenant_id}/projects/{project_id}/repositories",
  "/v1/tenants/{tenant_id}/projects/{project_id}/revisions",
  "/v1/tenants/{tenant_id}/projects/{project_id}/revisions/{revision_id}",
] as const;

export interface Denied {
  code: string;
  message: string;
}

export interface RevisionView {
  revisionId: string;
  sha256: string;
  canonical: string;
}

export async function publishRevision(input: {
  baseUrl: string;
  token: string;
  tenantId: string;
  projectId: string;
  document: Record<string, unknown>;
}): Promise<RevisionView> {
  const path = `/v1/tenants/${encodeURIComponent(input.tenantId)}/projects/${encodeURIComponent(input.projectId)}/revisions`;
  const response = await fetch(`${input.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ document: input.document }),
  });
  if (!response.ok) {
    throw new Error(`control_api_${response.status}`);
  }
  return (await response.json()) as RevisionView;
}
