/**
 * A non-2xx response from an LLM / embedding provider.
 *
 * `retryable` decides whether a stage's retry loop tries again. Only transient statuses are
 * retried (408, 409, 425, 429, 5xx); a 400/401/403/404 will fail identically every time, so
 * retrying it just triples the latency and the log noise before reporting the same error.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(provider: string, status: number, body: string) {
    super(`${provider} API error ${status}: ${summarizeProviderBody(body)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryable = isRetryableStatus(status);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Network failures, timeouts and transient HTTP statuses are retryable; a rejected request is not. */
export function isRetryableError(error: unknown): boolean {
  return !(error instanceof ProviderHttpError) || error.retryable;
}

/**
 * Providers return a JSON envelope (`{"error": {"message", "code"|"status"|"type"}}`). Surface the
 * human message plus the machine code instead of 500 characters of pretty-printed JSON — this
 * string is what the UI shows as the run's warning.
 */
export function summarizeProviderBody(body: string): string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const envelope = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: unknown; message?: unknown };
    const error = envelope?.error;
    if (error && typeof error === "object") {
      const { message, code, status, type } = error as Record<string, unknown>;
      const tag = [code, status, type].find((value) => typeof value === "string" && value.length > 0);
      if (typeof message === "string" && message) return tag ? `${message} [${tag}]` : message;
    }
    if (typeof error === "string" && error) return error;
    if (typeof envelope?.message === "string" && envelope.message) return envelope.message;
  } catch {
    // not JSON — fall through to the raw (bounded) body
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 500);
}
