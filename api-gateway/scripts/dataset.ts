import { readFile } from "node:fs/promises";
import { z } from "zod";
import { extractionSchema } from "../src/extraction/schema.js";
import { sha256 } from "../src/extraction/provenance.js";

const schema = z.object({
  version: z.string().min(1),
  annotationPolicy: z.string().min(1),
  documents: z.array(z.object({
    id: z.string().min(1), raw: z.string().min(1).max(10000),
    split: z.enum(["development", "holdout"]),
    category: z.enum(["ordinary", "missing", "ambiguous", "injection"]),
    expected: extractionSchema,
  }).strict()).min(1),
}).strict();
export async function loadDataset(split: "development" | "holdout" | "all") {
  const raw = await readFile(new URL("../evaluation/dataset-v1.json", import.meta.url), "utf8");
  const dataset = schema.parse(JSON.parse(raw));
  if (new Set(dataset.documents.map(d => d.id)).size !== dataset.documents.length) throw new Error("Duplicate fixture IDs");
  return { ...dataset, sha256: sha256(raw),
    documents: dataset.documents.filter(d => split === "all" || d.split === split) };
}
