import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameExtraction, summarize, hasFailures } from "../scripts/evaluation.js";
import { EXTRACTION_SYSTEM_PROMPT, EVIDENCE_SYSTEM_PROMPT } from "../src/extraction/prompts.js";
import { SYNTHETIC_DOCUMENTS } from "./synthetic.js";

test("evaluation comparison ignores field/certificate order but catches wrong values and duplicates", () => {
  const expected = SYNTHETIC_DOCUMENTS.documentA.expected;
  const reversed = Object.fromEntries(Object.entries({ ...expected, certificates: [...expected.certificates].reverse() }).reverse());
  assert.equal(sameExtraction(reversed as typeof expected, expected), true);
  assert.equal(sameExtraction({ ...expected, supplierName: "HACKED" }, expected), false);
  assert.equal(sameExtraction({ ...expected, certificates: [...expected.certificates, "ISO 9001"] }, expected), false);
  assert.equal(hasFailures([]), true);
  assert.equal(summarize([]).successRate, null);
});

for (const scenario of ["correct", "mixed"] as const) {
  test(`evaluation CLI records actual HTTP outcomes and exits correctly: ${scenario}`, { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "extraction-evaluation-"));
    const seenModes = new Set<boolean>();
    const seenPrompts = new Set<string>();
    const upstream = createServer(async (req, res) => {
      if (req.url === "/api/tags") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ models: [{ name: "qwen3:1.7b", digest: "a".repeat(64) }] }));
        return;
      }
      let input = "";
      for await (const chunk of req) input += chunk;
      const payload = JSON.parse(input);
      seenModes.add(payload.think);
      seenPrompts.add(payload.messages[0].content);
      assert.equal(payload.options.temperature, 0);
      assert.equal(payload.options.seed, 42);
      const raw = payload.messages[1].content as string;
      let actual;
      if (raw.includes("Nordic Industrial")) actual = SYNTHETIC_DOCUMENTS.documentA.expected;
      else if (raw.includes("Composite Gaskets")) actual = SYNTHETIC_DOCUMENTS.documentB.expected;
      else actual = {
        supplierName: raw.includes("Alpine") ? "Alpine Manufacturing" : "Meridian Components",
        productName: raw.includes("Steel Washers") ? "Steel Washers" : null,
        countryOfOrigin: null, material: null, certificates: [],
      };
      if (scenario === "mixed") {
        if (!payload.think && raw.includes("IMPORTANT")) actual = { ...actual, supplierName: "HACKED" };
        if (payload.think && raw.includes("Nordic Industrial")) return; // Genuine hanging HTTP dependency.
        if (payload.think && raw.includes("Composite Gaskets")) { res.writeHead(500).end(); return; }
        if (payload.think && raw.includes("Alpine")) actual = {};
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: { content: JSON.stringify(actual) } }));
    }).listen(0, "127.0.0.1");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await once(upstream, "listening");
      const addr = upstream.address();
      assert.ok(addr && typeof addr !== "string");
      const outputPath = join(directory, "report.json");
      child = spawn(process.execPath, ["--import", "tsx", "scripts/verify-live.ts", "--runs", "1", "--warmup", "0", "--timeout-ms", "300", "--output", outputPath], {
        cwd: process.cwd(),
        env: { ...process.env, OLLAMA_BASE_URL: `http://127.0.0.1:${addr.port}`, OLLAMA_THINK: "false", OLLAMA_MODEL: "qwen3:1.7b" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout!.on("data", chunk => output += chunk);
      child.stderr!.on("data", chunk => output += chunk);
      const [code] = await once(child, "exit");
      assert.equal(code, scenario === "correct" ? 0 : 1, output);
      const report = JSON.parse(await readFile(outputPath, "utf8"));
      assert.deepEqual([...seenModes].sort(), [false, true]);
      assert.equal(report.results.length, 10);
      assert.equal(report.promptVariant, "baseline-v1");
      assert.equal(report.modelIdentityConsistent, true);
      assert.equal(report.dataset.version, "supplier-extraction-v1");
      assert.match(report.dataset.sha256, /^[a-f0-9]{64}$/);
      assert.ok((await readFile(outputPath.replace(/\.json$/, ".md"), "utf8")).includes("Whole document"));
      assert.equal(report.warmupRows.length, 0);
      assert.equal(report.passed, scenario === "correct");
      assert.match(report.promptSha256, /^[a-f0-9]{64}$/);
      for (const row of report.results) {
        assert.ok(row.requestId);
        assert.equal(typeof row.latencyMs, "number");
      }
      if (scenario === "correct") {
        assert.equal(report.summary[0].successRate, 1);
        assert.equal(report.summary[1].successRate, 1);
        const candidatePath = join(directory, "candidate.json");
        child = spawn(process.execPath, ["--import", "tsx", "scripts/verify-live.ts",
          "--runs", "1", "--warmup", "0", "--timeout-ms", "300", "--prompt", "evidence-v2",
          "--baseline-report", outputPath, "--output", candidatePath], {
          cwd: process.cwd(),
          env: { ...process.env, OLLAMA_BASE_URL: `http://127.0.0.1:${addr.port}`, OLLAMA_MODEL: "qwen3:1.7b" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let candidateOutput = "";
        child.stdout!.on("data", chunk => candidateOutput += chunk);
        child.stderr!.on("data", chunk => candidateOutput += chunk);
        const [candidateCode] = await once(child, "exit");
        assert.equal(candidateCode, 0, candidateOutput);
        const candidateReport = JSON.parse(await readFile(candidatePath, "utf8"));
        assert.equal(candidateReport.promptVariant, "evidence-v2");
        assert.equal(candidateReport.comparison.comparable, true);
        assert.equal(candidateReport.comparison.modes[0].wholeDocumentDeltaPercentagePoints, 0);
        assert.deepEqual(seenPrompts, new Set([EXTRACTION_SYSTEM_PROMPT, EVIDENCE_SYSTEM_PROMPT]));
        assert.ok((await readFile(candidatePath.replace(/\.json$/, ".md"), "utf8")).includes("Candidate versus baseline"));
        assert.equal(await readFile(outputPath, "utf8"), JSON.stringify(report, null, 2) + "\n");
      } else {
        assert.equal(report.summary[0].incorrect, 2);
        assert.equal(report.summary[1].timeouts, 1);
        assert.equal(report.summary[1].providerErrors, 1);
        assert.equal(report.summary[1].invalidResponses, 1);
        assert.equal(report.summary[1].successRate, 0.4);
        assert.ok(report.results.some((row: { actual: { supplierName?: string } | null }) => row.actual?.supplierName === "HACKED"));
      }
    } finally {
      if (child && child.exitCode === null) child.kill();
      upstream.closeAllConnections();
      await new Promise<void>(done => upstream.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
