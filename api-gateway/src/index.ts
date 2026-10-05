import { createApp } from "./app.js";

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const port = positiveInteger("PORT", 3000, 65535);
const timeoutMs = positiveInteger("INFERENCE_TIMEOUT_MS", 3000, 60000);
const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:8000";
if (!["http:", "https:"].includes(new URL(inferenceUrl).protocol)) throw new Error("Invalid INFERENCE_URL");
const server = createApp({ inferenceUrl, timeoutMs }).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ service: "api-gateway", event: "listening", port }));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
