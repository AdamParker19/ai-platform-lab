import test from "node:test";
import assert from "node:assert/strict";
import { buildProductRequest } from "../scripts/jumpstart-preflight.js";

test("builds the documented JSON body for the product extraction example", () => {
  const document = "Supplier: Atlas Components\nProduct: Steel Washers";

  assert.deepEqual(buildProductRequest(document), {
    inputs: "Extract the product name from this document:\nSupplier: Atlas Components\nProduct: Steel Washers",
    parameters: { max_new_tokens: 64 },
  });
});

test("preserves the supplied document when preparing a different request", () => {
  const document = "Supplier: Café Parts\r\nProduct: Brass Bolts\r\n";
  const request = buildProductRequest(document);

  assert.equal(request.inputs.slice(request.inputs.indexOf("\n") + 1), document);
});

test("rejects an empty or whitespace-only document before preparing a request", () => {
  for (const document of ["", " \t\r\n"]) {
    assert.throws(() => buildProductRequest(document), /Provide a non-empty document/);
  }
});
