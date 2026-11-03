import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";

async function address(server: Server): Promise<string> {
  if (!server.listening) await once(server, "listening");
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${value.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("POST /api/generate proxies a safe, mockable contract", async t => {
  let mode: "success" | "invalid" | "malformed" | "failure" | "timeout" | "upstream504" = "success";
  let forwardedId = "";
  const upstream = createServer((req, res) => {
    forwardedId = String(req.headers["x-request-id"] ?? "");
    if (mode === "timeout") return;
    if (mode === "failure") { res.writeHead(503).end(); return; }
    if (mode === "upstream504") { res.writeHead(504).end(); return; }
    res.setHeader("content-type", "application/json");
    if (mode === "malformed") { res.end("{oops"); return; }
    res.end(JSON.stringify(mode === "invalid"
      ? { text: "", modelVersion: "mock-genai-v1", requestId: forwardedId, latencyMs: 1 }
      : { text: "[MOCK] Received: Explain RAG", modelVersion: "mock-genai-v1", requestId: forwardedId, latencyMs: 1.25 }));
  }).listen(0, "127.0.0.1");
  const gateway = createApp({ inferenceUrl: await address(upstream), timeoutMs: 100 }).listen(0, "127.0.0.1");
  const url = await address(gateway);
  const post = (body: string) => fetch(`${url}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  try {
    await t.test("valid generation, model version and request ID correlation", async () => {
      mode = "success";
      const response = await post(JSON.stringify({ prompt: "Explain RAG" }));
      assert.equal(response.status, 200);
      const output = await response.json() as { text: string; modelVersion: string; requestId: string; latencyMs: number };
      assert.equal(output.text, "[MOCK] Received: Explain RAG");
      assert.equal(output.modelVersion, "mock-genai-v1");
      assert.equal(output.requestId, forwardedId);
      assert.equal(response.headers.get("x-request-id"), forwardedId);
      assert.equal(output.latencyMs, 1.25);
    });
    await t.test("invalid prompt, extra fields and malformed JSON", async () => {
      for (const body of ['{}', '{"prompt":" "}', '{"prompt":42}', '{"prompt":"ok","extra":1}', '{']) {
        const response = await post(body);
        assert.equal(response.status, 400);
        const payload = await response.json() as { error: { code: string }; requestId: string };
        assert.ok(payload.error.code);
        assert.equal(payload.requestId, response.headers.get("x-request-id"));
      }
      const oversized = await post(JSON.stringify({ prompt: "a".repeat(2100) }));
      assert.equal(oversized.status, 400);
    });
    await t.test("upstream errors are sanitized", async () => {
      mode = "failure";
      const response = await post('{"prompt":"hello"}');
      assert.equal(response.status, 502);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "UPSTREAM_FAILURE");
    });
    await t.test("invalid upstream responses return 502", async () => {
      mode = "invalid";
      assert.equal((await post('{"prompt":"hello"}')).status, 502);
      mode = "malformed";
      const malformed = await post('{"prompt":"hello"}');
      assert.equal(malformed.status, 502);
      assert.equal((await malformed.json() as { error: { code: string } }).error.code, "INVALID_UPSTREAM_RESPONSE");
    });
    await t.test("upstream HTTP 504 remains a timeout", async () => {
      mode = "upstream504";
      assert.equal((await post('{"prompt":"hello"}')).status, 504);
    });
    await t.test("gateway deadline returns 504", async () => {
      mode = "timeout";
      assert.equal((await post('{"prompt":"hello"}')).status, 504);
    });
    await close(upstream);
    await t.test("unreachable inference returns 502", async () => {
      assert.equal((await post('{"prompt":"hello"}')).status, 502);
    });
  } finally {
    await close(gateway);
    if (upstream.listening) await close(upstream);
  }
});
