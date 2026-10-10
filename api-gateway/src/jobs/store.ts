import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtractionResult } from "../extraction/schema.js";

type Row = {
  id: string; key: string; hash: string; document: string; request_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number; created_at: number; updated_at: number; available_at: number;
  lease_until: number | null; token: string | null; result: string | null; error: string | null;
};
export class JobConflict extends Error {}
export class JobCapacity extends Error {}
export class JobStore {
  private db: DatabaseSync;
  constructor(path: string, private maxAttempts = 3, private capacity = 1000) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 1000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
        document TEXT NOT NULL, request_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL, lease_until INTEGER, token TEXT, result TEXT, error TEXT
      ); CREATE INDEX IF NOT EXISTS jobs_pickup ON jobs(status, available_at);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined;
  }
  get(id: string) {
    const row = this.row(id);
    return row ? this.publicJob(row) : undefined;
  }
  private publicJob(row: Row) {
    return { jobId: row.id, status: row.status, attempts: row.attempts,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.result ? { result: JSON.parse(row.result) as ExtractionResult } : {}),
      ...(row.error ? { error: row.error } : {}) };
  }
  enqueue(key: string, document: string, requestId: string, now = Date.now()) {
    const hash = createHash("sha256").update(document).digest("hex");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE key=?").get(key) as Row | undefined;
      if (existing) {
        if (existing.hash !== hash) throw new JobConflict("Key already used for another document");
        return { job: this.publicJob(existing), replayed: true };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
      if (count.n >= this.capacity) throw new JobCapacity("Job store is full");
      const id = randomUUID();
      this.db.prepare(`INSERT INTO jobs(id,key,hash,document,request_id,status,created_at,updated_at,available_at)
        VALUES(?,?,?,?,?,'queued',?,?,?)`).run(id, key, hash, document, requestId, now, now, now);
      return { job: this.get(id)!, replayed: false };
    });
  }
  // A lease makes crashed work eligible again. A fresh token fences off stale workers.
  claim(leaseMs: number, now = Date.now()): Row | undefined {
    return this.transaction(() => {
      this.db.prepare(`UPDATE jobs SET status='failed',error='worker_interrupted',document='',
        token=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<=? AND attempts>=?`)
        .run(now, now, this.maxAttempts);
      this.db.prepare(`UPDATE jobs SET status='queued',token=NULL,lease_until=NULL,updated_at=?,available_at=?
        WHERE status='running' AND lease_until<=? AND attempts<?`).run(now, now, now, this.maxAttempts);
      // Global concurrency one, even if a second local worker is accidentally started.
      if (this.db.prepare("SELECT id FROM jobs WHERE status='running' LIMIT 1").get()) return undefined;
      const next = this.db.prepare("SELECT id FROM jobs WHERE status='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1")
        .get(now) as { id: string } | undefined;
      if (!next) return undefined;
      this.db.prepare(`UPDATE jobs SET status='running',attempts=attempts+1,token=?,lease_until=?,updated_at=?,error=NULL WHERE id=?`)
        .run(randomUUID(), now + leaseMs, now, next.id);
      return this.row(next.id);
    });
  }
  succeed(id: string, token: string, result: ExtractionResult, now = Date.now()) {
    return this.db.prepare(`UPDATE jobs SET status='succeeded',result=?,document='',error=NULL,token=NULL,
      lease_until=NULL,updated_at=? WHERE id=? AND token=? AND status='running' AND lease_until>?`)
      .run(JSON.stringify(result), now, id, token, now).changes === 1;
  }
  fail(id: string, token: string, error: string, retryable: boolean, now = Date.now()) {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row || row.status !== "running" || row.token !== token || row.lease_until! <= now) return false;
      const retry = retryable && row.attempts < this.maxAttempts;
      this.db.prepare(`UPDATE jobs SET status=?,error=?,token=NULL,lease_until=NULL,updated_at=?,available_at=?,document=? WHERE id=?`)
        .run(retry ? "queued" : "failed", error, now, now + 1000 * 2 ** (row.attempts - 1), retry ? row.document : "", id);
      return true;
    });
  }
  close() { this.db.close(); }
}
