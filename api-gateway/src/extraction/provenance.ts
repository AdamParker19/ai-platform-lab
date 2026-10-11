import { createHash } from "node:crypto";

export type Provenance = {
  provider: string;
  model: string | null;
  modelDigest: string | null;
  digestStatus: "unavailable" | "observed";
  observedAt: string | null;
  promptSha256: string | null;
  settings: { think: boolean | null; temperature: number | null; seed: number | null; format: string | null };
};
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export function unknownProvenance(): Provenance {
  return { provider: "unknown", model: null, modelDigest: null, digestStatus: "unavailable",
    observedAt: null, promptSha256: null, settings: { think: null, temperature: null, seed: null, format: null } };
}
