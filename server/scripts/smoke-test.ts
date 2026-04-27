import { createHash } from "node:crypto";

const baseUrl = process.env.ROBIOS_BASE_URL ?? "http://127.0.0.1:8080";
const token = process.env.ROBIOS_TOKEN ?? "dev-secret";

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return body;
}

const status = await request("/v1/status");
console.log("status", status);

const deviceId = "smoke-device";
const installationId = "smoke-installation";
await request("/v1/devices/register", {
  method: "POST",
  body: JSON.stringify({ deviceId, installationId, appVersion: "smoke", osVersion: "bun" }),
});
console.log("registered device");

const payload = JSON.stringify({ kind: "smoke", at: new Date().toISOString() });
const payloadHashSHA256 = createHash("sha256").update(payload, "utf8").digest("hex");
const pointId = crypto.randomUUID();
const ingest = await request("/v1/ingest", {
  method: "POST",
  body: JSON.stringify({
    deviceId,
    installationId,
    sentAt: new Date().toISOString(),
    points: [
      {
        pointId,
        localSequence: Date.now(),
        stream: "smoke.test",
        eventDate: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        payload,
        payloadHashSHA256,
      },
    ],
  }),
});
console.log("ingest", ingest);

const duplicate = await request("/v1/ingest", {
  method: "POST",
  body: JSON.stringify({
    deviceId,
    installationId,
    sentAt: new Date().toISOString(),
    points: [
      {
        pointId,
        localSequence: Date.now(),
        stream: "smoke.test",
        eventDate: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        payload,
        payloadHashSHA256,
      },
    ],
  }),
});
console.log("duplicate", duplicate);

const blob = new TextEncoder().encode("hello robios");
const blobHash = createHash("sha256").update(blob).digest("hex");
const missing = await fetch(`${baseUrl}/v1/files/blobs/${blobHash}`, {
  method: "HEAD",
  headers: { Authorization: `Bearer ${token}` },
});
console.log("blob missing status", missing.status);

const putBlob = await request(`/v1/files/blobs/${blobHash}`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
  },
  body: blob,
});
console.log("put blob", putBlob);

const existing = await fetch(`${baseUrl}/v1/files/blobs/${blobHash}`, {
  method: "HEAD",
  headers: { Authorization: `Bearer ${token}` },
});
console.log("blob existing status", existing.status);

if (ingest.acceptedCount !== 1 || duplicate.duplicateCount !== 1 || missing.status !== 404 || existing.status !== 200) {
  throw new Error("smoke test assertions failed");
}

console.log("smoke test passed");
