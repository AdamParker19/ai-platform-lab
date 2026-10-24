import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { JobStore, JobConflict, JobCapacity } from "../src/jobs/store.js";
import { ExtractionWorker } from "../src/jobs/worker.js";
const result = { supplierName: "Meridian", productName: null, countryOfOrigin: null, material: null, certificates: [] };

test("durability, replay after completion, conflict and bounded capacity", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  const path = join(dir, "jobs.sqlite");
  let store = new JobStore(path, 3, 1);
  try {
    const first = store.enqueue("submit-001", "Supplier: Meridian", "request-a", 1000);
    store.close(); store = new JobStore(path, 3, 1);
    assert.equal(store.enqueue("submit-001", "Supplier: Meridian", "request-b").job.jobId, first.job.jobId);
    assert.throws(() => store.enqueue("submit-001", "Different", "r"), JobConflict);
    assert.throws(() => store.enqueue("submit-002", "Other", "r"), JobCapacity);
    const job = store.claim(100, 1000)!;
    assert.equal(store.succeed(job.id, job.token!, result, 1050), true);
    assert.equal(store.enqueue("submit-001", "Supplier: Meridian", "r").job.status, "succeeded");
    assert.deepEqual(store.get(job.id)!.result, result);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("separate processes submitting the same key create exactly one job", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-race-"));
  const path = join(dir, "jobs.sqlite");
  new JobStore(path).close();
  const code = `import {JobStore} from './src/jobs/store.ts'; const s=new JobStore(process.argv[1]); console.log(s.enqueue('same-key-123','document','request').job.jobId); s.close();`;
  try {
    const outputs = await Promise.all(Array.from({ length: 4 }, async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { errors += c; });
      const [exit] = await once(child, "close"); assert.equal(exit, 0, errors); return output.trim();
    }));
    assert.equal(new Set(outputs).size, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("expired leases recover crashed work and reject stale results; crashes are bounded", () => {
  const s = new JobStore(":memory:");
  try {
    s.enqueue("lease-key", "document", "request", 1000);
    const a = s.claim(100, 1000)!;
    assert.equal(s.claim(100, 1050), undefined);
    assert.equal(s.succeed(a.id, a.token!, result, 1100), false);
    const b = s.claim(100, 1100)!;
    assert.equal(b.attempts, 2);
    assert.equal(s.succeed(a.id, a.token!, result, 1110), false);
    assert.equal(s.fail(a.id, a.token!, "bad", true, 1110), false);
    const c = s.claim(100, 1200)!; assert.equal(c.attempts, 3);
    assert.equal(s.claim(100, 1300), undefined);
    assert.equal(s.get(c.id)!.status, "failed");
    assert.equal(s.get(c.id)!.error, "worker_interrupted");
  } finally { s.close(); }
});

test("provider failures back off and stop after three attempts", () => {
  const s = new JobStore(":memory:");
  try {
    const id = s.enqueue("retry-key", "document", "request", 1000).job.jobId;
    for (const now of [1000, 2001, 4002]) {
      const j = s.claim(100, now)!;
      assert.equal(s.fail(j.id, j.token!, "provider_unavailable", true, now), true);
      assert.equal(s.claim(100, now + 1), undefined);
    }
    assert.equal(s.get(id)!.status, "failed"); assert.equal(s.get(id)!.attempts, 3);
  } finally { s.close(); }
});

test("HTTP accepts once, polls result, returns conflict and rejects bad requests", async () => {
  const store = new JobStore(":memory:");
  const server = createApp({ inferenceUrl: "http://localhost:9999", timeoutMs: 100, jobStore: store }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/extraction-jobs`;
  const post = (document: string, key = "submission-001") => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ document }) });
  try {
    assert.equal((await post("doc", "bad")).status, 400);
    assert.equal((await post(" ")).status, 400);
    const accepted = await post("Supplier: Meridian"); assert.equal(accepted.status, 202);
    const job = await accepted.json() as { jobId: string; status: string };
    assert.equal(job.status, "queued");
    assert.equal(accepted.headers.get("location"), `/api/extraction-jobs/${job.jobId}`);
    const replay = await post("Supplier: Meridian"); assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal((await replay.json() as { jobId: string }).jobId, job.jobId);
    assert.equal((await post("Different")).status, 409);
    assert.equal((await fetch(`${url}/unknown`)).status, 404);
    const worker = new ExtractionWorker(store, { extract: async () => result });
    assert.equal(await worker.runOnce(), true);
    const done = await fetch(`${url}/${job.jobId}`);
    const body = await done.json() as { status: string; result: unknown; document?: string };
    assert.equal(body.status, "succeeded"); assert.deepEqual(body.result, result); assert.equal(body.document, undefined);
    assert.equal(await worker.runOnce(), false);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); }
});

test("invalid schemas fail immediately; uncooperative providers hit a hard deadline", async () => {
  for (const invalid of [true, false]) {
    const store = new JobStore(":memory:");
    try {
      const id = store.enqueue("failure-key", "document", "request").job.jobId;
      const worker = new ExtractionWorker(store, { extract: async () => invalid ? {} : new Promise(() => {}) }, 20);
      await worker.runOnce();
      const job = store.get(id)!;
      assert.equal(job.status, invalid ? "failed" : "queued");
      assert.equal(job.error, invalid ? "invalid_model_response" : "extraction_timeout");
    } finally { store.close(); }
  }
});
