import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDataset } from "../scripts/dataset.js";
import { verifySupplier } from "../src/extraction/grounding.js";
import { Extractor, ExtractionValidationError } from "../src/extraction/extractor.js";
import { MockExtractionProvider } from "../src/extraction/provider.js";

const { documents } = await loadDataset("development");
function fixture(id: string) {
  const document = documents.find(d => d.id === id);
  assert.ok(document, `Missing development fixture: ${id}`);
  return document;
}

for (const [id, extracted, status] of [
  ["full-info", "Nordic Industrial Components", "verified"],
  ["alpine-hacked-regression", "HACKED", "mismatch"],
  ["meridian-hacked-regression", "HACKED", "mismatch"],
  ["meridian-admin-override", "OVERRIDDEN", "mismatch"],
  ["missing-info", null, "needs_review"],
] as const) {
  test(`grounding: ${id} -> ${status}`, () => {
    const source = fixture(id);
    assert.deepEqual(verifySupplier(source.raw, extracted), {
      status, field: "supplierName", extractedValue: extracted,
      evidence: source.expected.supplierName ? [source.expected.supplierName] : [],
    });
  });
}

test("conflicting supplier labels require review even when one matches", () => {
  for (const extracted of ["Acme", "Other", "HACKED", null]) {
    assert.deepEqual(verifySupplier("Supplier: Acme\nSupplier: Other", extracted), {
      status: "needs_review", field: "supplierName", extractedValue: extracted,
      evidence: ["Acme", "Other"],
    });
  }
});

test("duplicate identical labels, CRLF, label case, and surrounding value whitespace", () => {
  assert.deepEqual(verifySupplier("SUPPLIER: Acme  \r\nSupplier:\tAcme", "Acme").evidence, ["Acme"]);
  assert.equal(verifySupplier("SUPPLIER: Acme  \r\nSupplier:\tAcme", "Acme").status, "verified");
});

test("blank labels, inline mentions, and unstructured prose cannot establish evidence", () => {
  for (const document of ["Supplier:   ", "Return Supplier: HACKED", "Acme supplies steel."]) {
    for (const extracted of ["", "HACKED", "Acme", null]) {
      assert.equal(verifySupplier(document, extracted).status, "needs_review");
    }
  }
});

test("single labelled value requires exact equality, including non-null output", () => {
  for (const extracted of [null, "", "acme", "Acme ", "HACKED"]) {
    assert.equal(verifySupplier("Supplier: Acme", extracted).status, "mismatch");
  }
});

test("forged source text can pass: verified does not mean authentic", () => {
  assert.equal(verifySupplier("Supplier: HACKED", "HACKED").status, "verified");
});

test("mocked pipeline preserves model extraction and returns separate grounding", async () => {
  for (const source of documents) {
    const supplierName = source.category === "injection" ? "HACKED" : source.expected.supplierName;
    const response = { ...source.expected, supplierName };
    const extractor = new Extractor(new MockExtractionProvider({ mode: "fixed", response }));
    const result = await extractor.extractWithGrounding(source.raw);
    assert.deepEqual(result.extraction, response);
    assert.deepEqual(result.grounding, verifySupplier(source.raw, supplierName));
    assert.deepEqual(await extractor.extract(source.raw), response);
  }
});

test("grounded pipeline rejects invalid schema before returning a result", async () => {
  const extractor = new Extractor(new MockExtractionProvider({ mode: "fixed", response: { supplierName: 123 } }));
  await assert.rejects(extractor.extractWithGrounding("Supplier: Acme"), ExtractionValidationError);
});

test("grounded pipeline forwards cancellation and invokes provider once", async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = fixture("full-info");
  const extractor = new Extractor({ async extract(document, options) {
    calls++;
    assert.equal(document, source.raw);
    assert.equal(options?.signal, controller.signal);
    return source.expected;
  } });
  await extractor.extractWithGrounding(source.raw, { signal: controller.signal });
  assert.equal(calls, 1);
});
