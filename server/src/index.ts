import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { Database } from "bun:sqlite";

type Variables = {
  db: Database;
};

type RegisterDeviceRequest = {
  deviceId?: string;
  installationId?: string;
  appVersion?: string;
  osVersion?: string;
};

type IngestPoint = {
  pointId?: string;
  localSequence?: number;
  stream?: string;
  eventDate?: string;
  receivedAt?: string;
  payload?: string;
  payloadHashSHA256?: string;
};

type IngestRequest = {
  deviceId?: string;
  installationId?: string;
  sentAt?: string;
  points?: IngestPoint[];
};

type PointResult = {
  pointId: string;
  status: "accepted" | "duplicate" | "rejected";
  message: string | null;
};

const VERSION = "server-0.1.0";
const DATA_DIR = process.env.ROBIOS_DATA_DIR ?? join(import.meta.dir, "..", "data");
const DB_PATH = process.env.ROBIOS_DB_PATH ?? join(DATA_DIR, "robios.sqlite");
const BLOBS_DIR = process.env.ROBIOS_BLOBS_DIR ?? join(DATA_DIR, "blobs");
const TOKEN = process.env.ROBIOS_TOKEN ?? "dev-secret";
const PORT = Number(process.env.PORT ?? 8080);

await mkdir(DATA_DIR, { recursive: true });
await mkdir(BLOBS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  app_version TEXT,
  os_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
  point_id TEXT PRIMARY KEY,
  batch_id INTEGER,
  device_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  local_sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  event_date TEXT NOT NULL,
  received_at_device TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash_sha256 TEXT NOT NULL,
  payload_json_valid INTEGER NOT NULL,
  source_id TEXT,
  FOREIGN KEY (batch_id) REFERENCES batches(id)
);

CREATE INDEX IF NOT EXISTS idx_points_stream_event_date ON points(stream, event_date);
CREATE INDEX IF NOT EXISTS idx_points_device_sequence ON points(device_id, local_sequence);
CREATE INDEX IF NOT EXISTS idx_points_payload_hash ON points(payload_hash_sha256);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`);

const app = new Hono<{ Variables: Variables }>();

app.use("*", async (c, next) => {
  c.set("db", db);
  if (!isAuthorized(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/v1/status", (c) => {
  return c.json({
    status: "ok",
    serverTime: new Date().toISOString(),
    version: VERSION,
  });
});

app.post("/v1/devices/register", async (c) => {
  const body = await readJson<RegisterDeviceRequest>(c.req.raw);
  if (!body.deviceId || !body.installationId) {
    return c.json({ error: "invalid_registration" }, 400);
  }

  const now = new Date().toISOString();
  c.get("db")
    .query(`
      INSERT INTO devices (
        device_id, installation_id, app_version, os_version, first_seen_at, last_seen_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        installation_id = excluded.installation_id,
        app_version = excluded.app_version,
        os_version = excluded.os_version,
        last_seen_at = excluded.last_seen_at,
        raw_json = excluded.raw_json
    `)
    .run(
      body.deviceId,
      body.installationId,
      body.appVersion ?? null,
      body.osVersion ?? null,
      now,
      now,
      JSON.stringify(body),
    );

  return c.json({ accepted: true, deviceToken: body.deviceId });
});

app.post("/v1/ingest", async (c) => {
  const body = await readJson<IngestRequest>(c.req.raw);
  if (!body.deviceId || !body.installationId || !body.sentAt || !Array.isArray(body.points)) {
    return c.json({ error: "invalid_ingest" }, 400);
  }

  const now = new Date().toISOString();
  const database = c.get("db");
  const results: PointResult[] = [];
  let acceptedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;

  const batchInsert = database
    .query(`
      INSERT INTO batches (
        device_id, installation_id, sent_at, received_at, point_count, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `)
    .get(
      body.deviceId,
      body.installationId,
      body.sentAt,
      now,
      body.points.length,
      JSON.stringify(body),
    ) as { id: number };

  const batchId = batchInsert.id;
  const pointExists = database.query("SELECT 1 FROM points WHERE point_id = ? LIMIT 1");
  const insertPoint = database.query(`
    INSERT INTO points (
      point_id, batch_id, device_id, installation_id, local_sequence, stream, event_date,
      received_at_device, ingested_at, payload, payload_hash_sha256, payload_json_valid, source_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAcceptedPoints = database.transaction((points: IngestPoint[]) => {
    for (const point of points) {
      const validationError = validatePoint(point);
      const pointId = point.pointId ?? "";
      if (validationError) {
        rejectedCount += 1;
        results.push({ pointId, status: "rejected", message: validationError });
        continue;
      }

      const payload = point.payload as string;
      const expectedHash = sha256Hex(payload);
      if (expectedHash !== point.payloadHashSHA256) {
        rejectedCount += 1;
        results.push({ pointId, status: "rejected", message: "payload hash mismatch" });
        continue;
      }

      if (pointExists.get(pointId)) {
        duplicateCount += 1;
        results.push({ pointId, status: "duplicate", message: null });
        continue;
      }

      insertPoint.run(
        pointId,
        batchId,
        body.deviceId,
        body.installationId,
        point.localSequence,
        point.stream,
        point.eventDate,
        point.receivedAt,
        now,
        payload,
        point.payloadHashSHA256,
        isJson(payload) ? 1 : 0,
        null,
      );
      acceptedCount += 1;
      results.push({ pointId, status: "accepted", message: null });
    }
  });

  insertAcceptedPoints(body.points);

  database
    .query(`
      UPDATE batches
      SET accepted_count = ?, duplicate_count = ?, rejected_count = ?
      WHERE id = ?
    `)
    .run(acceptedCount, duplicateCount, rejectedCount, batchId);

  return c.json({ acceptedCount, duplicateCount, rejectedCount, results });
});

async function handleBlobHead(c: any) {
  const sha256 = c.req.param("sha256");
  if (!isSha256(sha256)) return new Response(null, { status: 400 });
  const path = blobPath(sha256);
  return new Response(null, { status: (await exists(path)) ? 200 : 404 });
}

app.on("HEAD", "/v1/files/blobs/:sha256", handleBlobHead);
app.get("/v1/files/blobs/:sha256", handleBlobHead);

app.put("/v1/files/blobs/:sha256", async (c) => {
  const sha256 = c.req.param("sha256");
  if (!isSha256(sha256)) return c.json({ error: "invalid_hash" }, 400);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256.toLowerCase()) {
    return c.json({ error: "blob hash mismatch" }, 400);
  }

  const path = blobPath(digest);
  const dir = join(BLOBS_DIR, digest.slice(0, 2));
  await mkdir(dir, { recursive: true });

  if (!(await exists(path))) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path).catch(async (error) => {
      await unlink(tmp).catch(() => undefined);
      throw error;
    });
  }

  const now = new Date().toISOString();
  c.get("db")
    .query(`
      INSERT INTO blobs (sha256, size_bytes, storage_path, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        storage_path = excluded.storage_path,
        last_seen_at = excluded.last_seen_at
    `)
    .run(digest, bytes.length, path, now, now);

  return c.json({ stored: true, size: bytes.length });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});

console.log(`robios server listening on http://0.0.0.0:${PORT}`);
console.log(`data dir: ${DATA_DIR}`);

function isAuthorized(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  const supplied = Buffer.from(token);
  const expected = Buffer.from(TOKEN);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function validatePoint(point: IngestPoint): string | null {
  if (!point.pointId) return "missing pointId";
  if (typeof point.localSequence !== "number") return "missing localSequence";
  if (!point.stream) return "missing stream";
  if (!point.eventDate) return "missing eventDate";
  if (!point.receivedAt) return "missing receivedAt";
  if (typeof point.payload !== "string") return "missing payload";
  if (!point.payloadHashSHA256) return "missing payloadHashSHA256";
  if (!isSha256(point.payloadHashSHA256)) return "invalid payloadHashSHA256";
  if (!isJson(point.payload)) return "payload is not valid JSON";
  return null;
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isSha256(value: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function blobPath(sha256: string): string {
  const normalized = sha256.toLowerCase();
  return join(BLOBS_DIR, normalized.slice(0, 2), normalized);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
