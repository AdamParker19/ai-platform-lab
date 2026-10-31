import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSmokeOptions, runSmoke, estimateCost, offlineSender } from "../scripts/bedrock-smoke.js";

test("offline smoke exercises five cases with no model quality or fabricated usage/cost", async () => {
  let calls = 0;
  const report = await runSmoke(parseSmokeOptions([], {}), async (command, options) => { calls++; return offlineSender(command, options); });
  assert.equal(calls, 5);
  assert.equal(report.mode, "offline");
  assert.equal(report.summary.complete, true);
  assert.equal(report.summary.modelQuality, null);
  assert.equal(report.summary.estimatedCostUsd, null);
  assert.deepEqual(report.rows.map(r => r.outcome), ["verified", "needs_review", "needs_review", "mismatch", "mismatch"]);
  assert.equal(report.summary.supplierVerifiedCases, 1);
  assert.equal(new Set(report.rows.map(r => r.requestId)).size, 5);
  assert.ok(report.rows.every(r => r.telemetry?.inputTokens === null));
  assert.match(report.dataset.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.configuration, { plannedCalls: 5, maxAttemptsPerCall: 1, maxOutputTokens: 256, timeoutMs: 30000, warmupCalls: 0 });
});

test("live mode requires explicit flag, model identity and both reviewed prices", () => {
  assert.equal(parseSmokeOptions([], { BEDROCK_MODEL_ID: "a-real-model" }).live, false);
  assert.equal(parseSmokeOptions([], { BEDROCK_MODEL_ID: "a-real-model" }).modelId, "offline-simulated-model");
  for (const args of [["--live"], ["--live", "--input-usd-per-million", "1"], ["--unknown", "x"],
    ["--input-usd-per-million", "NaN"], ["--input-usd-per-million", "-1"], ["--live", "--live"]]) {
    assert.throws(() => parseSmokeOptions(args, {}));
  }
  assert.throws(() => parseSmokeOptions(["--live", "--input-usd-per-million", "1", "--output-usd-per-million", "2"], {}), /BEDROCK_MODEL_ID/);
  const config = parseSmokeOptions(["--live", "--input-usd-per-million", "1", "--output-usd-per-million", "2"], { BEDROCK_MODEL_ID: "available-model" });
  assert.equal(config.live, true);
  assert.equal(config.inputPrice, 1);
});

test("permission/transport failure produces partial evidence and stops, with unknown cost", async () => {
  const config = parseSmokeOptions(["--live", "--input-usd-per-million", "1", "--output-usd-per-million", "2"], { BEDROCK_MODEL_ID: "test" });
  let calls = 0;
  const report = await runSmoke(config, async () => { calls++; const e = new Error("private-message"); e.name = "AccessDeniedException"; throw e; });
  assert.equal(calls, 1);
  assert.equal(report.summary.complete, false);
  assert.equal(report.rows[0]!.outcome, "access_denied");
  assert.equal(report.summary.estimatedCostUsd, null);
  assert.equal(report.summary.modelQuality?.exactMatchRate, null);
  assert.ok(!JSON.stringify(report).includes("private-message"));
});

test("estimated cost uses observed usage and supplied rates; missing usage stays unknown", async () => {
  const report = await runSmoke(parseSmokeOptions([], {}));
  const telemetry = report.rows[0]!.telemetry!;
  assert.equal(estimateCost(telemetry, 1, 2), null);
  assert.equal(estimateCost({ ...telemetry, inputTokens: 1000, outputTokens: 100 }, 1, 2), 0.0012);
  assert.equal(estimateCost({ ...telemetry, inputTokens: 1000, outputTokens: 100 }, null, 2), null);
});

test("mocked wire responses exercise complete live-report token and cost accounting", async () => {
  const config = parseSmokeOptions(["--live", "--input-usd-per-million", "1", "--output-usd-per-million", "2"], { BEDROCK_MODEL_ID: "test" });
  const report = await runSmoke(config, async (command, options) => ({ ...await offlineSender(command, options),
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, metrics: { latencyMs: 10 } }));
  assert.equal(report.summary.complete, true);
  assert.equal(report.summary.modelQuality?.exactMatches, 2);
  assert.equal(report.summary.modelQuality?.exactMatchRate, 0.4);
  assert.ok(Math.abs(report.summary.estimatedCostUsd! - 0.0007) < 1e-12);
  assert.ok(report.rows.every(r => r.telemetry?.inputTokens === 100));
});

test("CLI defaults to offline even with AWS/model settings, saves evidence and protects an existing report", () => {
  const directory = mkdtempSync(join(tmpdir(), "bedrock-smoke-"));
  const output = join(directory, "report.json");
  const args = ["--import", "tsx", "scripts/bedrock-smoke.ts", "--output", output];
  const env = { ...process.env, BEDROCK_MODEL_ID: "never-invoked", AWS_PROFILE: "nonexistent-offline-profile", AWS_EC2_METADATA_DISABLED: "true" };
  try {
    const first = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const saved = readFileSync(output, "utf8");
    const report = JSON.parse(saved);
    assert.equal(report.mode, "offline");
    assert.equal(report.summary.modelQuality, null);
    assert.equal(report.rows.length, 5);
    assert.equal(typeof report.workingTreeDirty, "boolean");
    const second = spawnSync(process.execPath, args, { env, encoding: "utf8" });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), saved);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
