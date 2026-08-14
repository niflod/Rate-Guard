import type { RetryOutcome } from "../retry/backoff.js";
import { retry, success } from "../retry/backoff.js";

export interface ProviderRequest {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit;
  /** Estimate of tokens consumed by the request (for TPM). */
  readonly estimatedTokens?: number;
}

export interface ProviderResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface ProviderClient {
  call<T>(req: ProviderRequest): Promise<RetryOutcome<ProviderResponse<T>>>;
}

export interface DefaultProviderClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injectable fetch function (for tests). Default: global fetch. */
  readonly fetchFn?: typeof fetch;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  // Can be seconds (HTTP-date rarely used here).
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

export class DefaultProviderClient implements ProviderClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: DefaultProviderClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async call<T>(req: ProviderRequest): Promise<RetryOutcome<ProviderResponse<T>>> {
    const url = `${this.baseUrl}${req.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...req.headers,
    };
    try {
      const res = await this.fetchFn(url, {
        method: req.method ?? "POST",
        headers,
        body: req.body,
      });
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));

      if (res.status === 429) {
        return retry("Rate limited (HTTP 429)", {
          status: 429,
          retryAfterMs,
          retryable: true,
        });
      }
      if (res.status >= 500) {
        return retry(`Server error (HTTP ${res.status})`, {
          status: res.status,
          retryAfterMs,
          retryable: true,
        });
      }
      if (res.status >= 400) {
        const text = await res.text().catch(() => "");
        return retry(`Client error (HTTP ${res.status}): ${text}`, {
          status: res.status,
          retryable: false,
        });
      }
      const body = (await this.parseBody<T>(res)) as T;
      return success<ProviderResponse<T>>({
        status: res.status,
        headers: res.headers,
        body,
      });
    } catch (err) {
      // Network/DNS/connection-closed error -> retryable.
      const reason = err instanceof Error ? err.message : String(err);
      return retry(`Network failure: ${reason}`, { status: 0, retryable: true });
    }
  }

  private async parseBody<T>(res: Response): Promise<unknown> {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text();
  }
}
