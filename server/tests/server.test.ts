import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyMigrations,
  createRobiosApp,
  formatUtcTimestamp,
  loadConfig,
  openDatabase,
  prepareStorage,
  type ServerConfig,
} from "../src/index";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const cleanupTasks: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const cleanup = cleanupTasks.pop();
    if (cleanup) await cleanup();
  }
});

describe("configuration", () => {
  test("requires an explicit token unless local dev fallback is enabled", () => {
    expect(() => loadConfig({})).toThrow(/ROBIOS_TOKEN/);
    expect(loadConfig({ ROBIOS_ALLOW_DEV_TOKEN: "1" }).token).toBe("dev-secret");
    expect(loadConfig({ ROBIOS_TOKEN: "configured" }).token).toBe("configured");
  });

  test("formats UTC timestamps without fractional seconds", () => {
    expect(formatUtcTimestamp(new Date("2026-04-26T19:30:00.123Z"))).toBe("2026-04-26T19:30:00Z");
  });
});

describe("migrations", () => {
  test("applies the initial schema and tracks it", async () => {
    const harness = await createHarness();
    const row = harness.db
      .query("SELECT version, name FROM schema_migrations WHERE version = 1")
      .get() as { version: number; name: string } | null;

    expect(row).toEqual({ version: 1, name: "initial_schema" });
  });

  test("refuses unknown migration state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "robios-migration-test-"));
    cleanupTasks.push(async () => {
      await rm(dataDir, { recursive: true, force: true });
    });

    const db = new Database(join(dataDir, "robios.sqlite"));
    cleanupTasks.push(async () => db.close());

    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (999, 'future_schema', '2026-04-26T19:30:00Z');
    `);

    expect(() => applyMigrations(db)).toThrow(/Unknown schema migration state/);
  });
});

describe("API", () => {
  test("rejects unauthorized requests", async () => {
    const { app } = await createHarness();
    const response = await app.request("/v1/status");
    expect(response.status).toBe(401);
  });

  test("returns status with the client-compatible timestamp format", async () => {
    const { app } = await createHarness();
    const response = await app.request("/v1/status", { headers: authHeaders() });
    const body = await response.json() as { status: string; serverTime: string; version: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^server-/);
    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("registers and updates devices", async () => {
    const { app, db } = await createHarness();
    const first = await postJson(app, "/v1/devices/register", {
      deviceId: "device-1",
      installationId: "install-1",
      appVersion: "1.0",
      osVersion: "iOS",
    });
    const second = await postJson(app, "/v1/devices/register", {
      deviceId: "device-1",
      installationId: "install-2",
      appVersion: "1.1",
      osVersion: "iOS 26",
    });
    const row = db
      .query("SELECT installation_id, app_version, os_version FROM devices WHERE device_id = ?")
      .get("device-1") as { installation_id: string; app_version: string; os_version: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(row).toEqual({ installation_id: "install-2", app_version: "1.1", os_version: "iOS 26" });
  });

  test("accepts valid ingest points and detects duplicates atomically", async () => {
    const { app, db } = await createHarness();
    const point = makePoint({ pointId: "point-1" });

    const accepted = await postJson(app, "/v1/ingest", makeIngest([point]));
    const acceptedBody = await accepted.json() as { acceptedCount: number; results: { status: string }[] };
    const duplicate = await postJson(app, "/v1/ingest", makeIngest([point]));
    const duplicateBody = await duplicate.json() as { duplicateCount: number; results: { status: string }[] };
    const row = db.query("SELECT COUNT(*) AS count FROM points WHERE point_id = ?").get("point-1") as { count: number };

    expect(accepted.status).toBe(200);
    expect(acceptedBody.acceptedCount).toBe(1);
    expect(acceptedBody.results[0].status).toBe("accepted");
    expect(duplicate.status).toBe(200);
    expect(duplicateBody.duplicateCount).toBe(1);
    expect(duplicateBody.results[0].status).toBe("duplicate");
    expect(row.count).toBe(1);
  });

  test("reports mixed accepted, duplicate, and rejected ingest results", async () => {
    const { app, db } = await createHarness();
    const duplicatePoint = makePoint({ pointId: "duplicate-point" });
    await postJson(app, "/v1/ingest", makeIngest([duplicatePoint]));

    const acceptedPoint = makePoint({ pointId: "accepted-point" });
    const rejectedPoint = makePoint({ pointId: "rejected-point", payloadHashSHA256: hash("different") });
    const response = await postJson(app, "/v1/ingest", makeIngest([duplicatePoint, acceptedPoint, rejectedPoint]));
    const body = await response.json() as {
      acceptedCount: number;
      duplicateCount: number;
      rejectedCount: number;
      results: { pointId: string; status: string; message: string | null }[];
    };
    const batch = db
      .query("SELECT accepted_count, duplicate_count, rejected_count FROM batches ORDER BY id DESC LIMIT 1")
      .get() as { accepted_count: number; duplicate_count: number; rejected_count: number };

    expect(response.status).toBe(200);
    expect(body.acceptedCount).toBe(1);
    expect(body.duplicateCount).toBe(1);
    expect(body.rejectedCount).toBe(1);
    expect(body.results.map((result) => result.status)).toEqual(["duplicate", "accepted", "rejected"]);
    expect(body.results[2].message).toBe("payload hash mismatch");
    expect(batch).toEqual({ accepted_count: 1, duplicate_count: 1, rejected_count: 1 });
  });

  test("rejects malformed and oversized ingest requests", async () => {
    const malformed = await createHarness();
    const malformedResponse = await malformed.app.request("/v1/ingest", {
      method: "POST",
      headers: authHeaders(),
      body: "{",
    });
    expect(malformedResponse.status).toBe(400);

    const oversizedBody = await createHarness({ maxIngestBytes: 10 });
    const oversizedBodyResponse = await postJson(oversizedBody.app, "/v1/ingest", makeIngest([makePoint()]));
    expect(oversizedBodyResponse.status).toBe(413);

    const oversizedBatch = await createHarness({ maxPointsPerBatch: 1 });
    const oversizedBatchResponse = await postJson(oversizedBatch.app, "/v1/ingest", makeIngest([makePoint(), makePoint()]));
    expect(oversizedBatchResponse.status).toBe(413);

    const oversizedPayload = await createHarness({ maxPayloadBytes: 8 });
    const oversizedPayloadResponse = await postJson(oversizedPayload.app, "/v1/ingest", makeIngest([
      makePoint({ payload: JSON.stringify({ long: "payload" }) }),
    ]));
    expect(oversizedPayloadResponse.status).toBe(413);
  });

  test("handles blob existence, hash verification, idempotent upload, and size limits", async () => {
    const { app, db, config } = await createHarness();
    const bytes = new TextEncoder().encode("hello robios");
    const sha256 = hash(bytes);

    const missing = await app.request(`/v1/files/blobs/${sha256}`, { method: "HEAD", headers: authHeaders() });
    const mismatch = await app.request(`/v1/files/blobs/${hash("other")}`, {
      method: "PUT",
      headers: authHeaders("application/octet-stream"),
      body: bytes,
    });
    const stored = await app.request(`/v1/files/blobs/${sha256}`, {
      method: "PUT",
      headers: authHeaders("application/octet-stream"),
      body: bytes,
    });
    const storedAgain = await app.request(`/v1/files/blobs/${sha256}`, {
      method: "PUT",
      headers: authHeaders("application/octet-stream"),
      body: bytes,
    });
    const existing = await app.request(`/v1/files/blobs/${sha256}`, { method: "HEAD", headers: authHeaders() });
    const row = db.query("SELECT COUNT(*) AS count FROM blobs WHERE sha256 = ?").get(sha256) as { count: number };
    const file = await stat(join(config.blobsDir, sha256.slice(0, 2), sha256));

    expect(missing.status).toBe(404);
    expect(mismatch.status).toBe(400);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ stored: true, size: bytes.byteLength });
    expect(storedAgain.status).toBe(200);
    expect(existing.status).toBe(200);
    expect(row.count).toBe(1);
    expect(file.size).toBe(bytes.byteLength);

    const limited = await createHarness({ maxBlobBytes: 3 });
    const tooLarge = await limited.app.request(`/v1/files/blobs/${hash("abcd")}`, {
      method: "PUT",
      headers: authHeaders("application/octet-stream"),
      body: "abcd",
    });
    expect(tooLarge.status).toBe(413);
  });
});

async function createHarness(overrides: Partial<ServerConfig> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "robios-server-test-"));
  const config: ServerConfig = {
    dataDir,
    dbPath: join(dataDir, "robios.sqlite"),
    blobsDir: join(dataDir, "blobs"),
    token: "test-secret",
    port: 0,
    maxIngestBytes: 5 * 1024 * 1024,
    maxPointsPerBatch: 1_000,
    maxPayloadBytes: 512 * 1024,
    maxBlobBytes: 250 * 1024 * 1024,
    ...overrides,
  };

  await prepareStorage(config);
  const db = openDatabase(config);
  const app = createRobiosApp(db, config);

  cleanupTasks.push(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { app, db, config };
}

function authHeaders(contentType = "application/json", token = "test-secret") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
  };
}

function postJson(app: Harness["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

function makeIngest(points: unknown[]) {
  return {
    deviceId: "device-1",
    installationId: "install-1",
    sentAt: "2026-04-26T19:30:00Z",
    points,
  };
}

function makePoint(overrides: Partial<{
  pointId: string;
  localSequence: number;
  stream: string;
  eventDate: string;
  receivedAt: string;
  payload: string;
  payloadHashSHA256: string;
}> = {}) {
  const payload = overrides.payload ?? JSON.stringify({ kind: "test", id: crypto.randomUUID() });
  return {
    pointId: crypto.randomUUID(),
    localSequence: 1,
    stream: "test.stream",
    eventDate: "2026-04-26T19:30:00Z",
    receivedAt: "2026-04-26T19:30:00Z",
    payload,
    payloadHashSHA256: hash(payload),
    ...overrides,
  };
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
