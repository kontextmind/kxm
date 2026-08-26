import { createHmac, randomUUID } from "node:crypto";

const [runId, signalKey, status, summary, ...evidence] = process.argv.slice(2);
const serverUrl = process.env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331";
const definitionId = process.env.PI_MESH_WORKFLOW_ID?.trim();
const secret = process.env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();

if (!runId || !signalKey || !status || !summary || !definitionId || !secret) {
  console.error([
    "Usage: workflow-signal <runId> <signalKey> <passed|warning|failed> <summary> [evidence ...]",
    "Required environment: PI_MESH_WORKFLOW_ID, PI_MESH_WORKFLOW_SIGNAL_SECRET",
    "Optional environment: PI_MESH_SERVER_URL, PI_MESH_SIGNAL_DELIVERY_ID",
  ].join("\n"));
  process.exitCode = 2;
} else if (status !== "passed" && status !== "warning" && status !== "failed") {
  console.error("status must be passed, warning, or failed");
  process.exitCode = 2;
} else {
  const body = JSON.stringify({ status, summary, evidence });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const deliveryId = process.env.PI_MESH_SIGNAL_DELIVERY_ID?.trim() || `example-${randomUUID()}`;
  const endpoint = [
    serverUrl.replace(/\/$/, ""),
    "v1/webhooks",
    encodeURIComponent(definitionId),
    "runs",
    encodeURIComponent(runId),
    "signals",
    encodeURIComponent(signalKey),
  ].join("/");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-mesh-delivery-id": deliveryId,
    },
    body,
  });
  const responseBody = await response.text();
  let parsedBody: unknown = responseBody;
  try {
    parsedBody = JSON.parse(responseBody) as unknown;
  } catch {
    // Preserve a non-JSON proxy or server response for diagnostics.
  }
  console.log(JSON.stringify({ status: response.status, deliveryId, body: parsedBody }, null, 2));
  if (!response.ok) process.exitCode = 1;
}
