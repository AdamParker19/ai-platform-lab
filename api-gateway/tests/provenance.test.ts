import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { JobStore } from "../src/jobs/store.js";
import { ExtractionWorker } from "../src/jobs/worker.js";
import { OllamaExtractionProvider } from "../src/extraction/provider.js";
import { unknownProvenance } from "../src/extraction/provenance.js";
import { quality, type EvaluationRow } from "../scripts/evaluation.js";
import { loadDataset } from "../scripts/dataset.js";

const result = { supplierName: "Atlas", productName: null, countryOfOrigin: null, material: null, certificates: [] };
test("field scoring gives 80% for one wrong field and zero for transport failures", () => {
  const row: EvaluationRow = { documentId: "example", thinking: false, run: 1, outcome: "incorrect",
    latencyMs: 10, httpStatus: 200, requestId: "r", expected: result, actual: { ...result, supplierName: "HACKED" } };
  assert.equal(quality([row]).fieldAccuracy, 0.8);
  assert.equal(quality([row]).wholeDocumentAccuracy, 0);
  assert.equal(quality([{ ...row, outcome: "timeout", actual: null }]).fieldAccuracy, 0);
  assert.equal(quality([]).fieldAccuracy, null);
});
test("dataset splits are disjoint, versioned and retain the five regression cases", async () => {
  const dev = await loadDataset("development"), holdout = await loadDataset("holdout");
  assert.equal(dev.documents.length, 5);
  assert.equal(holdout.documents.length, 4);
  assert.equal(dev.sha256, holdout.sha256);
  assert.ok(holdout.documents.every(d => !dev.documents.some(other => other.id === d.id)));
  assert.ok(holdout.documents.some(d => d.category === "ambiguous"));
});
test("attempt histories survive reopen; old attempt cannot overwrite recovered metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "provenance-"));
  const path = join(dir, "jobs.sqlite");
  let store = new JobStore(path);
  try {
    const id = store.enqueue("test-key", "document", "request", 1000).job.jobId;
    const metadata = { ...unknownProvenance(), model: "first" };
    const first = store.claim(100, 1000, metadata)!;
    store.close(); store = new JobStore(path);
    const second = store.claim(100, 1100, { ...metadata, model: "second" })!;
    assert.equal(store.recordProvenance(id, first.token!, metadata, 1110), false);
    assert.equal(store.succeed(id, first.token!, result, 1110), false);
    assert.equal(store.succeed(id, second.token!, result, 1150), true);
    const history = store.get(id)!.attemptHistory;
    assert.equal(history.length, 2);
    assert.equal(history[0]!.outcome, "worker_interrupted");
    assert.equal(history[0]!.durationMs, null);
    assert.equal(history[1]!.durationMs, 50);
    assert.equal(history[1]!.provenance.model, "second");
    assert.equal(store.enqueue("test-key", "document", "retry").job.attemptHistory.length, 2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("additive schema upgrade preserves existing completed jobs without invented history", () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-job-"));
  const path = join(dir, "jobs.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,key TEXT UNIQUE,hash TEXT,document TEXT,request_id TEXT,
    status TEXT,attempts INTEGER,created_at INTEGER,updated_at INTEGER,available_at INTEGER,
    lease_until INTEGER,token TEXT,result TEXT,error TEXT);
    INSERT INTO jobs VALUES('old','old-key','hash','','request','succeeded',1,1000,1010,1000,NULL,NULL,NULL,NULL);`);
  db.close();
  const store = new JobStore(path);
  try { assert.equal(store.get("old")!.status, "succeeded"); assert.deepEqual(store.get("old")!.attemptHistory, []); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("worker persists provider metadata on schema failures", async () => {
  const store = new JobStore(":memory:");
  const metadata = { ...unknownProvenance(), model: "fake-test-model" };
  try {
    const id = store.enqueue("failure-key", "doc", "request").job.jobId;
    await new ExtractionWorker(store, { metadata: () => metadata, describe: async () => metadata, extract: async () => ({}) }).runOnce();
    const entry = store.get(id)!.attemptHistory[0]!;
    assert.equal(entry.outcome, "invalid_model_response");
    assert.equal(entry.provenance.model, "fake-test-model");
    assert.ok(entry.durationMs !== null);
  } finally { store.close(); }
});
test("Ollama metadata reports observed local digest, never a cloud alias or failed lookup as verified", async () => {
  let mode = "local";
  const server = createServer((_req, res) => {
    if (mode === "error") { res.writeHead(503).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "test:latest", digest: "a".repeat(64), ...(mode === "cloud" ? { remote_model: "remote" } : {}) }] }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const provider = new OllamaExtractionProvider({ baseUrl: `http://127.0.0.1:${address.port}`, model: "test", think: true, temperature: 0, seed: 42 });
    const local = await provider.describe();
    assert.equal(local.modelDigest, "a".repeat(64));
    assert.equal(local.settings.seed, 42);
    assert.match(local.promptSha256!, /^[a-f0-9]{64}$/);
    mode = "cloud"; assert.equal((await provider.describe()).modelDigest, null);
    mode = "error"; assert.equal((await provider.describe()).digestStatus, "unavailable");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
