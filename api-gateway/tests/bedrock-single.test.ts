import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSingleOptions } from "../scripts/bedrock-single.js";
import { saveSmokeReport, offlineSender } from "../scripts/bedrock-smoke.js";

const env = { BEDROCK_MODEL_ID: "test-model", BEDROCK_REGION: "ap-south-1" };

test("single command selects live mode with exactly one case, bounded deadline and unknown cost by default", () => {
  const config = parseSingleOptions([], env);
  assert.equal(config.live, true);
  assert.equal(config.caseLimit, 1);
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.inputPrice, null);
  assert.equal(config.outputPrice, null);
  assert.equal(config.region, "ap-south-1");
  assert.match(config.output, /evaluation-results[/\\]bedrock-single-live-/);
  assert.equal(parseSingleOptions(["--offline"], {}).live, false);
  assert.equal(parseSingleOptions([], { ...env, AWS_REGION: "us-east-1" }).region, "ap-south-1");
});

test("single command rejects bad arguments, missing model and invalid or partial prices", () => {
  assert.throws(() => parseSingleOptions([], {}), /BEDROCK_MODEL_ID/);
  for (const args of [["--live"], ["--offline", "--offline"], ["--output"], ["--output", "a", "--output", "b"]]) {
    assert.throws(() => parseSingleOptions(args, env));
  }
  for (const timeout of ["0", "120001", "NaN", "0.5"]) assert.throws(() => parseSingleOptions([], { ...env, BEDROCK_TIMEOUT_MS: timeout }));
  assert.throws(() => parseSingleOptions([], { ...env, BEDROCK_INPUT_USD_PER_MILLION: "1" }), /both/);
  assert.throws(() => parseSingleOptions([], { ...env, BEDROCK_INPUT_USD_PER_MILLION: "secret" }), /Invalid BEDROCK_INPUT/);
});

test("success, malformed JSON and AWS denial each make one call and persist their evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bedrock-single-"));
  try {
    for (const mode of ["success", "invalid", "denied"] as const) {
      let calls = 0;
      const output = join(directory, `${mode}.json`);
      const config = parseSingleOptions(["--output", output], env);
      const report = await saveSmokeReport(config, async (command, options) => {
        calls++;
        if (mode === "denied") throw Object.assign(new Error("PRIVATE-SDK-MESSAGE"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403, requestId: "aws-denied" } });
        const reply = await offlineSender(command, options);
        if (mode === "invalid") reply.output = { message: { role: "assistant", content: [{ text: "PRIVATE-INVALID-JSON" }] } };
        return reply;
      });
      assert.equal(calls, 1);
      assert.equal(report.rows.length, 1);
      assert.equal(report.configuration.plannedCalls, 1);
      assert.equal(report.summary.complete, true);
      assert.equal(report.summary.modelQuality?.totalCases, 1);
      assert.equal(report.rows[0]!.outcome, mode === "success" ? "verified" : mode === "invalid" ? "invalid_response" : "authorization_error");
      const saved = readFileSync(output, "utf8");
      assert.ok(!saved.includes("PRIVATE-"));
      assert.equal(JSON.parse(saved).rows[0].lifecycle.at(-1).stage, mode === "success" ? "completed" : "failed");
      await assert.rejects(saveSmokeReport(config, async () => { calls++; throw new Error("must not call"); }), { code: "EEXIST" });
      assert.equal(calls, 1);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("single deadline persists timeout even if the sender never settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bedrock-single-timeout-"));
  try {
    const config = parseSingleOptions(["--output", join(directory, "timeout.json")], { ...env, BEDROCK_TIMEOUT_MS: "20" });
    let calls = 0;
    const report = await saveSmokeReport(config, () => { calls++; return new Promise(() => {}); });
    assert.equal(calls, 1);
    assert.equal(report.rows[0]!.errorCategory, "timeout");
    assert.equal(JSON.parse(readFileSync(config.output, "utf8")).rows[0].lifecycle.at(-1).stage, "failed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("single CLI works outside the project directory, ignores unrelated .env, and saves one offline case", () => {
  const directory = mkdtempSync(join(tmpdir(), "bedrock-single-cli-"));
  const output = join(directory, "single.json");
  writeFileSync(join(directory, ".env"), "BEDROCK_TIMEOUT_MS=INVALID-UNRELATED-ENV\n");
  const script = resolve("scripts/bedrock-single.ts");
  const args = ["--import", import.meta.resolve("tsx"), script, "--offline", "--output", output];
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AWS_PROFILE: "nonexistent-offline-profile", AWS_EC2_METADATA_DISABLED: "true" };
  delete childEnv.BEDROCK_TIMEOUT_MS;
  try {
    const child = spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8", timeout: 10000,
      env: childEnv });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stderr, /loading api-gateway\/.env/);
    assert.match(child.stderr, /Starting case 1\/1/);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.mode, "offline");
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].outcome, "verified");
    const collision = spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8", timeout: 10000 });
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /Report already exists/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
