import { createHmac, randomUUID } from "node:crypto";
import { canonicalWorkflowEvidenceKey } from "../plugins/kxm/src/workflow.ts";

const [runId, signalKey, status, summary, ...evidenceArgs] = process.argv.slice(2);
const serverUrl = process.env.KXM_SERVER_URL?.trim() || "http://127.0.0.1:7331";
const definitionId = process.env.KXM_WORKFLOW_ID?.trim();
const secret = process.env.KXM_WORKFLOW_SIGNAL_SECRET?.trim();

if (!runId || !signalKey || !status || !summary || !definitionId || !secret) {
  console.error([
    "Usage: workflow-signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]",
    "Required environment: KXM_WORKFLOW_ID, KXM_WORKFLOW_SIGNAL_SECRET",
    "Optional environment: KXM_SERVER_URL, KXM_SIGNAL_DELIVERY_ID",
  ].join("\n"));
  process.exitCode = 2;
} else if (status !== "passed" && status !== "warning" && status !== "failed") {
  console.error("status must be passed, warning, or failed");
  process.exitCode = 2;
} else {
  const evidenceEntries = new Map<string, string>();
  for (const value of evidenceArgs) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("evidence must use <required-key>=<evidence> syntax");
    }
    const key = canonicalWorkflowEvidenceKey(value.slice(0, separator));
    const proof = value.slice(separator + 1).trim();
    if (!key || !proof) throw new Error("evidence must use <required-key>=<evidence> syntax");
    if (evidenceEntries.has(key)) throw new Error(`duplicate normalized evidence key: ${key}`);
    evidenceEntries.set(key, proof);
  }
  const evidence = Object.fromEntries(evidenceEntries);
  const body = JSON.stringify({ status, summary, evidence });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const deliveryId = process.env.KXM_SIGNAL_DELIVERY_ID?.trim() || `example-${randomUUID()}`;
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
