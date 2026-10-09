import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { extractionSchema } from "../src/extraction/schema.js";
import { MockExtractionProvider, OllamaExtractionProvider } from "../src/extraction/provider.js";
import { Extractor, ExtractionValidationError } from "../src/extraction/extractor.js";
import { SYNTHETIC_DOCUMENTS } from "./synthetic.js";

async function address(server: Server) {
  if (!server.listening) await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${addr.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("extraction schema enforces data contract", async (t) => {
  await t.test("accepts fully populated valid extraction", () => {
    const valid = {
      supplierName: "Nordic Industrial",
      productName: "Bolts",
      countryOfOrigin: "SE",
      material: "Steel",
      certificates: ["ISO 9001"],
    };
    const parsed = extractionSchema.safeParse(valid);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data, valid);
    }
  });

  await t.test("accepts null for missing scalar fields and empty certificates array", () => {
    const validWithNulls = {
      supplierName: null,
      productName: null,
      countryOfOrigin: null,
      material: null,
      certificates: [],
    };
    const parsed = extractionSchema.safeParse(validWithNulls);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data, validWithNulls);
    }
  });

  await t.test("rejects when certificates is not an array", () => {
    const invalidCert = {
      supplierName: "Acme",
      productName: "Gadget",
      countryOfOrigin: "US",
      material: "Plastic",
      certificates: null,
    };
    const parsed = extractionSchema.safeParse(invalidCert);
    assert.equal(parsed.success, false);
  });

  await t.test("rejects invalid scalar field types", () => {
    const invalidTypes = {
      supplierName: 12345,
      productName: "Widget",
      countryOfOrigin: "CA",
      material: "Wood",
      certificates: [],
    };
    const parsed = extractionSchema.safeParse(invalidTypes);
    assert.equal(parsed.success, false);
  });

  await t.test("rejects missing keys", () => {
    const missingKeys = {
      productName: "Widget",
    };
    const parsed = extractionSchema.safeParse(missingKeys);
    assert.equal(parsed.success, false);
  });
});

test("extractor class validates model response with schema", async (t) => {
  await t.test("returns valid extraction result when provider succeeds", async () => {
    const mockProvider = new MockExtractionProvider({
      mode: "fixed",
      response: SYNTHETIC_DOCUMENTS.documentA.expected,
    });
    const extractor = new Extractor(mockProvider);
    const result = await extractor.extract("Some document");
    assert.deepEqual(result, SYNTHETIC_DOCUMENTS.documentA.expected);
  });

  await t.test("throws ExtractionValidationError when provider returns invalid structure", async () => {
    const mockProvider = new MockExtractionProvider({
      mode: "fixed",
      response: { invalid: true },
    });
    const extractor = new Extractor(mockProvider);
    await assert.rejects(
      () => extractor.extract("Some document"),
      (err: unknown) => err instanceof ExtractionValidationError
    );
  });
});

test("POST /api/extract reliability controls and error scenarios", async (t) => {
  const mockProvider = new MockExtractionProvider({
    mode: "fixed",
    response: SYNTHETIC_DOCUMENTS.documentA.expected,
  });

  const app = createApp({
    inferenceUrl: "http://127.0.0.1:9999",
    timeoutMs: 1000,
    extractionProvider: mockProvider,
    llmTimeoutMs: 200,
    maxDocumentLength: 5000,
  });

  const gateway = app.listen(0, "127.0.0.1");
  const baseUrl = await address(gateway);

  const postExtract = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
    fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers,
      body,
    });

  try {
    await t.test("valid extraction returns 200 with validated JSON and request ID", async () => {
      mockProvider.setBehavior({
        mode: "fixed",
        response: SYNTHETIC_DOCUMENTS.documentA.expected,
      });

      const response = await postExtract(JSON.stringify({ document: SYNTHETIC_DOCUMENTS.documentA.raw }));
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("x-request-id"));
      const body = await response.json();
      assert.deepEqual(body, SYNTHETIC_DOCUMENTS.documentA.expected);
    });

    await t.test("missing document returns HTTP 400", async () => {
      const response = await postExtract(JSON.stringify({ other: "data" }));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.ok(body.error);
    });

    await t.test("empty or whitespace document returns HTTP 400", async () => {
      for (const emptyDoc of ["", "   ", "\n\t  "]) {
        const response = await postExtract(JSON.stringify({ document: emptyDoc }));
        assert.equal(response.status, 400);
      }
    });

    await t.test("extra fields in request body returns HTTP 400", async () => {
      const response = await postExtract(JSON.stringify({ document: "Supplier: Acme", extra: "forbidden" }));
      assert.equal(response.status, 400);
    });

    await t.test("non-string document returns HTTP 400", async () => {
      const response = await postExtract(JSON.stringify({ document: 12345 }));
      assert.equal(response.status, 400);
    });

    await t.test("oversized document exceeds max length returns HTTP 400", async () => {
      const oversizedText = "A".repeat(5001);
      const response = await postExtract(JSON.stringify({ document: oversizedText }));
      assert.equal(response.status, 400);
    });

    await t.test("oversized JSON payload exceeding body limit returns HTTP 413", async () => {
      const hugeText = "X".repeat(40000);
      const response = await postExtract(JSON.stringify({ document: hugeText }));
      assert.equal(response.status, 413);
    });

    await t.test("invalid model response returns HTTP 502", async () => {
      mockProvider.setBehavior({
        mode: "fixed",
        response: {
          supplierName: 123,
          certificates: "Not an array",
        },
      });

      const response = await postExtract(JSON.stringify({ document: "Supplier: Some Co" }));
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error, "Invalid model response");
    });

    await t.test("LLM provider error returns HTTP 502", async () => {
      mockProvider.setBehavior({
        mode: "error",
        error: new Error("Ollama connection refused"),
      });

      const response = await postExtract(JSON.stringify({ document: "Supplier: Some Co" }));
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error, "Extraction service unavailable");
    });

    await t.test("LLM request exceeding deadline returns HTTP 504", async () => {
      mockProvider.setBehavior({
        mode: "timeout",
        delayMs: 1000,
      });

      const response = await postExtract(JSON.stringify({ document: "Supplier: Slow Co" }));
      assert.equal(response.status, 504);
      const body = await response.json();
      assert.equal(body.error, "LLM extraction timed out");
    });
  } finally {
    await close(gateway);
  }
});

test("synthetic documents contract testing", async (t) => {
  const mockProvider = new MockExtractionProvider({
    mode: "map",
    responses: {
      [SYNTHETIC_DOCUMENTS.documentA.raw]: SYNTHETIC_DOCUMENTS.documentA.expected,
      [SYNTHETIC_DOCUMENTS.documentB.raw]: SYNTHETIC_DOCUMENTS.documentB.expected,
      [SYNTHETIC_DOCUMENTS.documentC.raw]: SYNTHETIC_DOCUMENTS.documentC.expected,
    },
  });

  const app = createApp({
    inferenceUrl: "http://127.0.0.1:9999",
    timeoutMs: 1000,
    extractionProvider: mockProvider,
  });

  const gateway = app.listen(0, "127.0.0.1");
  const baseUrl = await address(gateway);

  try {
    await t.test("Document A extracts all fields", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: SYNTHETIC_DOCUMENTS.documentA.raw }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), SYNTHETIC_DOCUMENTS.documentA.expected);
    });

    await t.test("Document B extracts missing values as null and certificates as empty array", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: SYNTHETIC_DOCUMENTS.documentB.raw }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.supplierName, null);
      assert.deepEqual(data.certificates, []);
      assert.deepEqual(data, SYNTHETIC_DOCUMENTS.documentB.expected);
    });

    await t.test("Document C resists prompt injection and extracts legitimate supplier name", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: SYNTHETIC_DOCUMENTS.documentC.raw }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.supplierName, "Alpine Manufacturing");
      assert.notEqual(data.supplierName, "HACKED");
    });
  } finally {
    await close(gateway);
  }
});
