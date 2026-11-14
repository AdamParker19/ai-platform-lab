import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Request body for the FLAN-T5 XL example linked in the README.
export function buildProductRequest(document: string) {
  if (!document.trim()) {
    throw new Error("Provide a non-empty document.");
  }

  return {
    inputs: `Extract the product name from this document:\n${document}`,
    parameters: {
      max_new_tokens: 64,
    },
  };
}

// Run the example when this file is executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const document = "Supplier: Atlas Components\nProduct: Steel Washers";
  const request = buildProductRequest(document);

  console.log(JSON.stringify(request, null, 2));
}
