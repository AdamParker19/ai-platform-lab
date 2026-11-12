import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { BedrockExtractionProvider, BedrockExtractionError, type RequestEvent, type BedrockTelemetry,
  type BedrockProviderOptions, type ConverseReply } from "../src/extraction/bedrock.js";
import { withDeadline } from "../src/extraction/deadline.js";
import { createApp } from "../src/app.js";

const result = { supplierName: "Atlas", productName: null, countryOfOrigin: null, material: null, certificates: [] };
const reply = (): ConverseReply => ({ $metadata: { requestId: "aws-123" }, stopReason: "end_turn",
  output: { message: { role: "assistant", content: [{ text: JSON.stringify(result) }] } } });
function fixture(overrides: Partial<BedrockProviderOptions> = {}) {
  const events: RequestEvent[] = [];
  const summaries: BedrockTelemetry[] = [];
  const provider = new BedrockExtractionProvider({ modelId: "test-model", region: "ap-south-1",
    resolveCredentials: async () => {}, send: async () => reply(),
    onLifecycle: e => events.push(e), onTelemetry: e => summaries.push(e), ...overrides });
  return { provider, events, summaries };
}
const failure = (expected: string) => (e: unknown) => e instanceof BedrockExtractionError && e.category === expected;

test("success emits ordered lifecycle with separate local and AWS IDs", async () => {
  const { provider, events, summaries } = fixture();
  assert.deepEqual(await provider.extract("Supplier: Atlas", { requestId: "local-123" }), result);
  assert.deepEqual(events.map(e => e.stage), ["starting", "credentials_resolved", "request_started", "response_received", "completed"]);
  assert.ok(events.every(e => e.requestId === "local-123" && Number.isFinite(Date.parse(e.timestamp))));
  assert.ok(events.every((e, i) => i === 0 || e.elapsedMs >= events[i - 1]!.elapsedMs));
  assert.equal(events[2]!.awsRequestId, null);
  assert.equal(events[3]!.awsRequestId, "aws-123");
  assert.equal(summaries.length, 1);
});

test("cooperative hanging sender receives cancellation and returns near deadline", async () => {
  let cancelled = false;
  const { provider, events } = fixture({ timeoutMs: 30,
    send: (_command, { abortSignal }) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => { cancelled = true; reject(abortSignal.reason); }, { once: true });
    }) });
  const start = performance.now();
  await assert.rejects(provider.extract("Supplier: Atlas"), failure("timeout"));
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 20 && elapsed < 500, `elapsed=${elapsed}`);
  assert.equal(cancelled, true);
  assert.equal(events.at(-1)!.stage, "failed");
  assert.equal(events.at(-1)!.errorCategory, "timeout");
});

test("deadline bounds an uncooperative sender and ignores a late rejection", async () => {
  let rejectLate!: (e: Error) => void;
  const { provider, events, summaries } = fixture({ timeoutMs: 20,
    send: () => new Promise((_resolve, reject) => { rejectLate = reject; }) });
  await assert.rejects(provider.extract("Supplier: Atlas"), failure("timeout"));
  rejectLate(new Error("PRIVATE LATE RESPONSE"));
  await delay(10);
  assert.equal(summaries.length, 1);
  assert.deepEqual(events.map(e => e.stage), ["starting", "credentials_resolved", "request_started", "failed"]);
});

test("credentials are inside deadline; late resolution cannot start an SDK call", async () => {
  let release!: () => void;
  let calls = 0;
  const { provider, events } = fixture({ timeoutMs: 20,
    resolveCredentials: () => new Promise<void>(resolve => { release = resolve; }),
    send: async () => { calls++; return reply(); } });
  await assert.rejects(provider.extract("Supplier: Atlas"), failure("timeout"));
  release();
  await delay(10);
  assert.equal(calls, 0);
  assert.deepEqual(events.map(e => e.stage), ["starting", "failed"]);
});

test("credential failure emits failed before request_started", async () => {
  let calls = 0;
  const { provider, events } = fixture({ resolveCredentials: async () => {
    throw Object.assign(new Error("PRIVATE CREDENTIAL"), { name: "CredentialsProviderError" });
  }, send: async () => { calls++; return reply(); } });
  await assert.rejects(provider.extract("Supplier: Atlas"), failure("credentials_error"));
  assert.equal(calls, 0);
  assert.deepEqual(events.map(e => e.stage), ["starting", "failed"]);
});

test("access denial and throttling retain safe metadata with one attempt", async () => {
  for (const [name, status, category] of [["AccessDeniedException", 403, "authorization_error"],
    ["ThrottlingException", 429, "throttled"], ["Error", 429, "throttled"],
    ["Error", 403, "authorization_error"], ["ExpiredTokenException", 403, "credentials_error"]] as const) {
    let calls = 0;
    const { provider, events } = fixture({ send: async () => {
      calls++;
      throw Object.assign(new Error("PRIVATE SDK MESSAGE"), { name, $metadata: { requestId: "aws-error", httpStatusCode: status } });
    } });
    await assert.rejects(provider.extract("Supplier: Atlas"), failure(category));
    assert.equal(calls, 1);
    const last = events.at(-1)!;
    assert.equal(last.stage, "failed");
    assert.equal(last.errorCategory, category);
    assert.equal(last.awsRequestId, "aws-error");
    assert.equal(last.failure?.httpStatus, status);
  }
});

test("document, prompts, credentials and SDK messages never enter lifecycle or summary logs", async () => {
  const document = "PRIVATE-DOCUMENT";
  const secret = "PRIVATE-ACCESS-KEY PRIVATE-SECRET-KEY PRIVATE-SESSION-TOKEN";
  const { provider, events, summaries } = fixture({ resolveCredentials: async () => { void secret; }, send: async command => {
    throw Object.assign(new Error(`${secret} ${JSON.stringify(command.input)}`),
      { name: "AccessDeniedException", $metadata: { requestId: "contains spaces and secrets " + secret, httpStatusCode: 403 } });
  } });
  await assert.rejects(provider.extract(document), failure("authorization_error"));
  const serialized = JSON.stringify({ events, summaries });
  for (const value of [document, ...secret.split(" "), "<document>", "supplierName"]) assert.ok(!serialized.includes(value));
  assert.equal(events.at(-1)!.awsRequestId, null);
});

test("injected sender skips credential claim unless a resolver is supplied", async () => {
  const { provider, events } = fixture({ resolveCredentials: undefined });
  await provider.extract("Supplier: Atlas");
  assert.ok(!events.some(e => e.stage === "credentials_resolved"));
});

test("caller cancellation bounds waiting and pre-cancellation skips all operations", async () => {
  let calls = 0;
  const controller = new AbortController();
  const { provider, events } = fixture({ timeoutMs: 1000, send: () => { calls++; return new Promise(() => {}); } });
  const pending = provider.extract("Supplier: Atlas", { signal: controller.signal });
  await delay(5);
  controller.abort();
  await assert.rejects(pending, failure("timeout"));
  assert.equal(calls, 1);
  assert.equal(events.at(-1)!.stage, "failed");
  await assert.rejects(provider.extract("Supplier: Atlas", { signal: controller.signal }), failure("timeout"));
  assert.equal(calls, 1);
});

test("invalid JSON fails after response_received and logger errors cannot change outcomes", async () => {
  const { provider, events } = fixture({ send: async () => ({ ...reply(), output: { message: { role: "assistant", content: [{ text: "PRIVATE MALFORMED JSON" }] } } }) });
  await assert.rejects(provider.extract("Supplier: Atlas"), failure("invalid_response"));
  assert.deepEqual(events.slice(-2).map(e => e.stage), ["response_received", "failed"]);
  assert.deepEqual(await fixture({ onLifecycle: () => { throw new Error("logger down"); } }).provider.extract("Supplier: Atlas"), result);
});

test("gateway enforces its deadline even when a provider ignores cancellation", async () => {
  let signal: AbortSignal | undefined;
  const server = createApp({ inferenceUrl: "http://127.0.0.1:9999", timeoutMs: 100,
    llmTimeoutMs: 20, extractionProvider: { extract: (_document, options) => { signal = options?.signal; return new Promise(() => {}); } } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/extract`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: "Supplier: Atlas" }), signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: "LLM extraction timed out" });
    assert.equal(signal?.aborted, true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("deadline helper validates bounds and clears its timer after success", async () => {
  for (const ms of [0, -1, NaN, 1.5, 120001]) await assert.rejects(withDeadline(async () => 1, ms), RangeError);
  let saved!: AbortSignal;
  assert.equal(await withDeadline(async signal => { saved = signal; return 42; }, 10), 42);
  await delay(20);
  assert.equal(saved.aborted, false);
});
