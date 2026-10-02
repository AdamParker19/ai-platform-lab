import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";

async function address(server: Server) {
  if (!server.listening) await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${addr.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("gateway validates inputs and handles inference outcomes", async t => {
  let mode = "ok";
  let forwardedRequestId = "";
  const upstream = createServer((req, res) => {
    forwardedRequestId = String(req.headers["x-request-id"]);
    if (mode === "timeout") return;
    if (mode === "error") { res.writeHead(500).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(mode === "invalid" ? {} : {
      prediction: "positive", confidence: 0.7, modelVersion: "test-v1",
    }));
  }).listen(0, "127.0.0.1");
  const gateway = createApp({ inferenceUrl: await address(upstream), timeoutMs: 100 }).listen(0, "127.0.0.1");
  const url = await address(gateway);
  const post = (body: string) => fetch(`${url}/api/analyze`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  try {
    await t.test("success propagates version and request ID", async () => {
      const response = await post(JSON.stringify({ text: "amazing" }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).modelVersion, "test-v1");
      assert.equal(response.headers.get("x-request-id"), forwardedRequestId);
    });
    await t.test("invalid input and malformed JSON", async () => {
      for (const body of ['{}', '{"text":" "}', '{"text":42}', '{']) {
        assert.equal((await post(body)).status, 400);
      }
      assert.equal((await post(JSON.stringify({text: "x".repeat(40000)}))).status, 413);
    });
    for (const [scenario, status] of [["error", 502], ["invalid", 502], ["timeout", 504]] as const) {
      await t.test(scenario, async () => {
        mode = scenario;
        assert.equal((await post('{"text":"good"}')).status, status);
      });
    }
    await close(upstream);
    await t.test("unavailable upstream", async () => {
      assert.equal((await post('{"text":"good"}')).status, 502);
    });
  } finally {
    await close(gateway);
    if (upstream.listening) await close(upstream);
  }
});
