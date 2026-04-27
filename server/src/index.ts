import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { Database } from "bun:sqlite";

type Variables = {
  db: Database;
  config: ServerConfig;
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
  points?: unknown[];
};

type PointResult = {
  pointId: string;
  status: "accepted" | "duplicate" | "rejected";
  message: string | null;
};

type Migration = {
  version: number;
  name: string;
  sql: string;
};

export type ServerConfig = {
  dataDir: string;
  dbPath: string;
  blobsDir: string;
  token: string;
  port: number;
  maxIngestBytes: number;
  maxPointsPerBatch: number;
  maxPayloadBytes: number;
  maxBlobBytes: number;
};

const VERSION = "server-0.2.0";
const DEFAULT_MAX_INGEST_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_POINTS_PER_BATCH = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
const DEFAULT_MAX_BLOB_BYTES = 250 * 1024 * 1024;

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
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
`,
  },
];

class RequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const dataDir = env.ROBIOS_DATA_DIR ?? join(import.meta.dir, "..", "data");
  const token = env.ROBIOS_TOKEN ?? (isEnabled(env.ROBIOS_ALLOW_DEV_TOKEN) ? "dev-secret" : undefined);
  if (!token) {
    throw new Error("ROBIOS_TOKEN is required. For local-only development, set ROBIOS_ALLOW_DEV_TOKEN=1.");
  }

  return {
    dataDir,
    dbPath: env.ROBIOS_DB_PATH ?? join(dataDir, "robios.sqlite"),
    blobsDir: env.ROBIOS_BLOBS_DIR ?? join(dataDir, "blobs"),
    token,
    port: parseIntegerEnv(env.PORT, 8080, "PORT"),
    maxIngestBytes: parseIntegerEnv(env.ROBIOS_MAX_INGEST_BYTES, DEFAULT_MAX_INGEST_BYTES, "ROBIOS_MAX_INGEST_BYTES"),
    maxPointsPerBatch: parseIntegerEnv(
      env.ROBIOS_MAX_POINTS_PER_BATCH,
      DEFAULT_MAX_POINTS_PER_BATCH,
      "ROBIOS_MAX_POINTS_PER_BATCH",
    ),
    maxPayloadBytes: parseIntegerEnv(env.ROBIOS_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES, "ROBIOS_MAX_PAYLOAD_BYTES"),
    maxBlobBytes: parseIntegerEnv(env.ROBIOS_MAX_BLOB_BYTES, DEFAULT_MAX_BLOB_BYTES, "ROBIOS_MAX_BLOB_BYTES"),
  };
}

export async function prepareStorage(config: ServerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(dirname(config.dbPath), { recursive: true });
  await mkdir(config.blobsDir, { recursive: true });
}

export function openDatabase(config: ServerConfig): Database {
  const db = new Database(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}

export function applyMigrations(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);

  const applied = db
    .query("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string }[];
  const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));

  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration || migration.name !== row.name) {
      throw new Error(`Unknown schema migration state: version ${row.version} (${row.name})`);
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length === 0) return;

  const runPending = db.transaction((migrations: Migration[]) => {
    const insertMigration = db.query(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of migrations) {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, formatUtcTimestamp());
    }
  });

  runPending(pending);
}

export function createRobiosApp(db: Database, config: ServerConfig): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    if (!isAuthorized(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof RequestError) {
      return c.json({ error: error.code }, error.status as 400);
    }

    console.error("request failed", error);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/v1/status", (c) => {
    return c.json({
      status: "ok",
      serverTime: formatUtcTimestamp(),
      version: VERSION,
    });
  });

  app.post("/v1/devices/register", async (c) => {
    const body = await readJsonWithLimit<RegisterDeviceRequest>(c.req.raw, c.get("config").maxIngestBytes);
    if (!isRegisterDeviceRequest(body)) {
      return c.json({ error: "invalid_registration" }, 400);
    }

    const now = formatUtcTimestamp();
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
    const config = c.get("config");
    const body = await readJsonWithLimit<IngestRequest>(c.req.raw, config.maxIngestBytes);
    if (!isIngestRequest(body)) {
      return c.json({ error: "invalid_ingest" }, 400);
    }

    if (body.points.length > config.maxPointsPerBatch) {
      throw new RequestError(413, "batch_too_large");
    }

    for (const point of body.points) {
      if (isRecord(point) && typeof point.payload === "string" && Buffer.byteLength(point.payload, "utf8") > config.maxPayloadBytes) {
        throw new RequestError(413, "payload_too_large");
      }
    }

    const outcome = ingestBatch(c.get("db"), body, formatUtcTimestamp());
    return c.json(outcome);
  });

  async function handleBlobHead(c: any) {
    const sha256 = c.req.param("sha256");
    if (!isSha256(sha256)) return new Response(null, { status: 400 });
    return new Response(null, { status: (await exists(blobPath(sha256, c.get("config").blobsDir))) ? 200 : 404 });
  }

  app.on("HEAD", "/v1/files/blobs/:sha256", handleBlobHead);
  app.get("/v1/files/blobs/:sha256", handleBlobHead);

  app.put("/v1/files/blobs/:sha256", async (c) => {
    const sha256 = c.req.param("sha256");
    if (!isSha256(sha256)) return c.json({ error: "invalid_hash" }, 400);

    const digestParam = sha256.toLowerCase();
    const config = c.get("config");
    const path = blobPath(digestParam, config.blobsDir);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });

    const tmp = join(dir, `${digestParam}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
    const { digest, size } = await writeRequestBodyToTemp(c.req.raw, tmp, config.maxBlobBytes);
    if (digest !== digestParam) {
      await unlink(tmp).catch(() => undefined);
      return c.json({ error: "blob hash mismatch" }, 400);
    }

    if (await exists(path)) {
      await unlink(tmp).catch(() => undefined);
    } else {
      await rename(tmp, path).catch(async (error) => {
        await unlink(tmp).catch(() => undefined);
        throw error;
      });
    }

    const now = formatUtcTimestamp();
    c.get("db")
      .query(`
        INSERT INTO blobs (sha256, size_bytes, storage_path, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          storage_path = excluded.storage_path,
          last_seen_at = excluded.last_seen_at
      `)
      .run(digest, size, path, now, now);

    return c.json({ stored: true, size });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}

export async function startServer(config = loadConfig()) {
  await prepareStorage(config);
  const db = openDatabase(config);
  const app = createRobiosApp(db, config);
  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  });

  console.log(`robios server listening on http://0.0.0.0:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);
  return { server, db, config };
}

export function formatUtcTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ingestBatch(db: Database, body: IngestRequest, now: string) {
  const insertBatch = db.query(`
    INSERT INTO batches (
      device_id, installation_id, sent_at, received_at, point_count, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `);
  const insertPoint = db.query(`
    INSERT INTO points (
      point_id, batch_id, device_id, installation_id, local_sequence, stream, event_date,
      received_at_device, ingested_at, payload, payload_hash_sha256, payload_json_valid, source_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(point_id) DO NOTHING
  `);
  const updateBatch = db.query(`
    UPDATE batches
    SET accepted_count = ?, duplicate_count = ?, rejected_count = ?
    WHERE id = ?
  `);

  const runIngest = db.transaction((requestBody: IngestRequest) => {
    const results: PointResult[] = [];
    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;

    const batch = insertBatch.get(
      requestBody.deviceId,
      requestBody.installationId,
      requestBody.sentAt,
      now,
      requestBody.points?.length ?? 0,
      JSON.stringify(requestBody),
    ) as { id: number };

    for (const rawPoint of requestBody.points ?? []) {
      const pointId = pointIdForResult(rawPoint);
      const validationError = validatePoint(rawPoint);
      if (validationError) {
        rejectedCount += 1;
        results.push({ pointId, status: "rejected", message: validationError });
        continue;
      }

      const point = rawPoint as IngestPoint;
      const payload = point.payload as string;
      const expectedHash = sha256Hex(payload);
      if (expectedHash !== (point.payloadHashSHA256 as string).toLowerCase()) {
        rejectedCount += 1;
        results.push({ pointId, status: "rejected", message: "payload hash mismatch" });
        continue;
      }

      const result = insertPoint.run(
        pointId,
        batch.id,
        requestBody.deviceId,
        requestBody.installationId,
        point.localSequence,
        point.stream,
        point.eventDate,
        point.receivedAt,
        now,
        payload,
        (point.payloadHashSHA256 as string).toLowerCase(),
        1,
        null,
      ) as { changes: number };

      if (result.changes === 0) {
        duplicateCount += 1;
        results.push({ pointId, status: "duplicate", message: null });
      } else {
        acceptedCount += 1;
        results.push({ pointId, status: "accepted", message: null });
      }
    }

    updateBatch.run(acceptedCount, duplicateCount, rejectedCount, batch.id);
    return { acceptedCount, duplicateCount, rejectedCount, results };
  });

  return runIngest(body);
}

function isAuthorized(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const suppliedToken = authHeader.slice("Bearer ".length);
  const supplied = createHash("sha256").update(suppliedToken).digest();
  const expected = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(supplied, expected);
}

async function readJsonWithLimit<T>(request: Request, maxBytes: number): Promise<T> {
  const text = await readTextWithLimit(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestError(400, "malformed_json");
  }
}

async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  checkContentLength(request, maxBytes);

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new RequestError(413, "request_too_large");
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(concatBytes(chunks, totalBytes));
}

async function writeRequestBodyToTemp(request: Request, tmpPath: string, maxBytes: number) {
  checkContentLength(request, maxBytes);

  const hash = createHash("sha256");
  const writer = createWriteStream(tmpPath, { flags: "wx" });
  let size = 0;

  try {
    const body = request.body;
    if (body) {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBytes) {
          throw new RequestError(413, "blob_too_large");
        }
        size += value.byteLength;
        hash.update(value);
        if (!writer.write(value)) {
          await once(writer, "drain");
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.end(resolve);
    });
  } catch (error) {
    writer.destroy();
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  return { digest: hash.digest("hex"), size };
}

function checkContentLength(request: Request, maxBytes: number): void {
  const value = request.headers.get("content-length");
  if (!value) return;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestError(400, "invalid_content_length");
  }
  if (parsed > maxBytes) {
    throw new RequestError(413, "request_too_large");
  }
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validatePoint(point: unknown): string | null {
  if (!isRecord(point)) return "point must be an object";
  if (!isNonEmptyString(point.pointId)) return "missing pointId";
  if (typeof point.localSequence !== "number") return "missing localSequence";
  if (!isNonEmptyString(point.stream)) return "missing stream";
  if (!isNonEmptyString(point.eventDate)) return "missing eventDate";
  if (!isNonEmptyString(point.receivedAt)) return "missing receivedAt";
  if (typeof point.payload !== "string") return "missing payload";
  if (!isNonEmptyString(point.payloadHashSHA256)) return "missing payloadHashSHA256";
  if (!isSha256(point.payloadHashSHA256)) return "invalid payloadHashSHA256";
  if (!isJson(point.payload)) return "payload is not valid JSON";
  return null;
}

function isRegisterDeviceRequest(value: unknown): value is RegisterDeviceRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.deviceId) &&
    isNonEmptyString(value.installationId) &&
    (value.appVersion === undefined || typeof value.appVersion === "string") &&
    (value.osVersion === undefined || typeof value.osVersion === "string")
  );
}

function isIngestRequest(value: unknown): value is IngestRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.deviceId) &&
    isNonEmptyString(value.installationId) &&
    isNonEmptyString(value.sentAt) &&
    Array.isArray(value.points)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function pointIdForResult(point: unknown): string {
  return isRecord(point) && typeof point.pointId === "string" ? point.pointId : "";
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

function blobPath(sha256: string, blobsDir: string): string {
  const normalized = sha256.toLowerCase();
  return join(blobsDir, normalized.slice(0, 2), normalized);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseIntegerEnv(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

if (import.meta.main) {
  try {
    await startServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
