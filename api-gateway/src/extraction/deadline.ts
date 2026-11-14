export class DeadlineExceededError extends Error {
  constructor() {
    super("Operation deadline exceeded or caller cancelled");
    this.name = "AbortError";
  }
}

// Bound the caller's wait even if credentials or a sender ignore cancellation.
// The losing operation remains observed, so a late rejection is handled.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new RangeError("Deadline must be 1–120000 milliseconds");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new DeadlineExceededError());
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new DeadlineExceededError());
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (parent?.aborted) cancel();
    return await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
