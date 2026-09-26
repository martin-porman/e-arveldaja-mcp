import type { Config } from "./config.js";
import { sandboxExternalText } from "./external-text-renderer.js";
import { buildConnectionFingerprint } from "./connection-fingerprint.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Thrown for HTTP-level failures (any non-2xx response or retries-exhausted
 * network error). The structured `status` lets callers distinguish 404
 * ("row is gone — safe to drop from reconciliation") from 5xx/network
 * ("transient — retry or surface as unknown") without parsing error.message.
 *
 * `status === "network"` means the request never got an HTTP status code
 * (connection refused, DNS failure, retries exhausted).
 */
export class HttpError extends Error {
  /**
   * Upstream body.error/refused text, already sandbox-wrapped so a
   * downstream LLM treats it as untrusted data. Kept off `Error.message` so
   * audit logs / stderr remain clean; tool-error serialization forwards this
   * property to the MCP response.
   */
  readonly upstream_detail?: string;
  readonly recovery_hint?: string;
  readonly next_actions?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    why: string;
  }>;

  constructor(
    message: string,
    public readonly status: number | "network",
    public readonly method: HttpMethod,
    public readonly path: string,
    options?: {
      upstream_detail?: string;
      recovery_hint?: string;
      next_actions?: Array<{ tool: string; args?: Record<string, unknown>; why: string }>;
    },
  ) {
    super(message);
    this.name = "HttpError";
    if (options?.upstream_detail !== undefined) {
      this.upstream_detail = options.upstream_detail;
    }
    if (options?.recovery_hint !== undefined) {
      this.recovery_hint = options.recovery_hint;
    }
    if (options?.next_actions !== undefined) {
      this.next_actions = options.next_actions;
    }
  }
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;

export class HttpClient {
  public readonly connectionFingerprint: string;
  private lastRequest = Promise.resolve();
  private nextAllowedAt = 0;
  private readonly minIntervalMs = 100; // Max ~10 req/sec

  constructor(
    private config: Config,
    public readonly cacheNamespace = "connection:0",
    private readonly requestGuard?: () => void,
  ) {
    this.connectionFingerprint = buildConnectionFingerprint(config);
  }

  private assertRequestAllowed(): void {
    this.requestGuard?.();
  }

  private async waitForRateLimitTurn(): Promise<void> {
    const enforce = async () => {
      const delayMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
    };
    // Assign before awaiting so concurrent callers chain off this promise
    const myTurn = this.lastRequest.then(enforce, enforce);
    this.lastRequest = myTurn;
    await myTurn;
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private static shouldRetryStatus(method: HttpMethod, status: number): boolean {
    return status === 429 || (method === "GET" && status >= 500);
  }

  private static isRetryableError(error: unknown): boolean {
    return error instanceof Error && (
      error.name === "AbortError" ||
      error.name === "TypeError" ||
      /fetch failed|network/i.test(error.message)
    );
  }

  /**
   * Only idempotent methods may be retried after a network error / timeout.
   * A timed-out or connection-dropped POST/PATCH/DELETE is ambiguous: the
   * server may have already committed the mutation, so a blind retry risks a
   * duplicate booking (invoice, journal, transaction). GET and PUT (full
   * replace) are safe to repeat. Mirrors the GET-only gate in
   * shouldRetryStatus for 5xx responses.
   */
  private static isIdempotentMethod(method: HttpMethod): boolean {
    return method === "GET" || method === "PUT";
  }

  private static formatNetworkError(method: HttpMethod, path: string, error: unknown): HttpError {
    // Only surface the error NAME and a known error CODE — never the raw
    // message. Node's fetch echoes offending values into the message for some
    // failures (e.g. an invalid header value includes the header content), so a
    // malformed bearer token could otherwise leak into HttpError.message,
    // stderr, and the stderr tee.
    const name = error instanceof Error ? error.name : "";
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
    const detail = [name, code].filter(Boolean).join(" ");
    const suffix = detail ? `: ${detail}` : "";
    return new HttpError(
      `CRM request failed: ${method} ${path} → network error${suffix}`,
      "network",
      method,
      path,
    );
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, params } = options;

    const fullUrl = `${this.config.baseUrl}${path}`;
    const url = new URL(fullUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.assertRequestAllowed();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.apiPassword}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const stepToken = process.env.CRM_STEP_TOKEN;
      if (stepToken) {
        headers["X-CRM-Step-Token"] = stepToken;
      }

      await this.waitForRateLimitTurn();
      this.assertRequestAllowed();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);

      try {
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
            // Never auto-follow redirects: fetch would forward the bearer
            // Authorization header and the step token to the redirect target.
            // A trusted internal CRM API does not redirect.
            redirect: "manual",
          });
        } catch (error) {
          if (
            HttpClient.isRetryableError(error) &&
            HttpClient.isIdempotentMethod(method) &&
            attempt < MAX_RETRIES
          ) {
            this.assertRequestAllowed();
            await HttpClient.sleep(INITIAL_RETRY_DELAY_MS * (2 ** attempt));
            continue;
          }
          throw HttpClient.formatNetworkError(method, path, error);
        }

        // With redirect:"manual", a 3xx is surfaced (not followed) as an opaque
        // redirect or a bare 3xx status. Refuse it explicitly rather than let it
        // fall through as a generic error — the auth headers were NOT forwarded.
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          throw new HttpError(
            `CRM request failed: ${method} ${path} → unexpected redirect refused (auth headers not forwarded)`,
            response.status || 502,
            method,
            path,
          );
        }

        if (!response.ok) {
          if (HttpClient.shouldRetryStatus(method, response.status) && attempt < MAX_RETRIES) {
            this.assertRequestAllowed();
            await HttpClient.sleep(INITIAL_RETRY_DELAY_MS * (2 ** attempt));
            continue;
          }

          // The CRM may echo user-supplied content in its refusal (e.g. a
          // manifest reason quoting a supplied field), so we keep
          // `Error.message` free of raw upstream text and stash the
          // sandbox-wrapped detail on a dedicated property for MCP output.
          let upstreamDetail: string | undefined;
          try {
            const errorBody = await response.json() as { error?: string; refused?: string[] };
            const detail = errorBody.error ?? errorBody.refused?.join("; ") ?? "";
            upstreamDetail = sandboxExternalText(detail);
          } catch {
            // Non-JSON error body — don't expose raw text
          }

          throw new HttpError(`CRM ${response.status} on ${method} ${path}`, response.status, method, path, {
            upstream_detail: upstreamDetail,
          });
        }

        if (response.status === 204) {
          return { code: 204, messages: [] } as T;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          // `await` (not a bare `return response.json()`) so the 60s timeout in
          // `finally` clears only AFTER the body is fully read — otherwise a
          // stalled body hangs forever. A body-read failure (connection dropped
          // mid-body after a committed mutation) is classified as a network
          // error so ambiguous-write recovery treats it as an indeterminate
          // commit rather than a raw TypeError.
          try {
            return await response.json() as T;
          } catch (bodyError) {
            throw HttpClient.formatNetworkError(method, path, bodyError);
          }
        }

        // Binary response (e.g. PDF document download) — return as ApiFile-compatible object.
        // Cap buffered size to prevent OOM if the upstream returns an
        // unexpectedly large payload.
        //
        // Caveat: against a hostile/buggy upstream the post-buffer check is
        // reached only AFTER `arrayBuffer()` has already allocated the full
        // body, so it does not prevent memory pressure from a streamed
        // 1 GB body lacking a truthful content-length. A real cap requires
        // streaming the body and aborting once cumulative bytes exceed the
        // limit. Defensible today because the CRM is a trusted internal
        // upstream; treat this as defense-in-depth, not attacker-proof.
        const BINARY_RESPONSE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
          const declaredSize = Number(contentLengthHeader);
          if (Number.isFinite(declaredSize) && declaredSize > BINARY_RESPONSE_MAX_BYTES) {
            throw new HttpError(
              `Binary response too large: ${declaredSize} bytes exceeds ${BINARY_RESPONSE_MAX_BYTES}-byte ceiling`,
              response.status,
              method,
              path,
            );
          }
        }
        const arrayBuf = await response.arrayBuffer();
        if (arrayBuf.byteLength > BINARY_RESPONSE_MAX_BYTES) {
          throw new HttpError(
            `Binary response too large: ${arrayBuf.byteLength} bytes exceeds ${BINARY_RESPONSE_MAX_BYTES}-byte ceiling`,
            response.status,
            method,
            path,
          );
        }
        const base64 = Buffer.from(arrayBuf).toString("base64");
        const disposition = response.headers.get("content-disposition") ?? "";
        const nameMatch = disposition.match(/filename="?([^";\n]+)"?/);
        const name = nameMatch?.[1] ?? "document";
        return { name, contents: base64 } as T;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new HttpError(
      `CRM request failed: ${method} ${path} → retries exhausted`,
      "network",
      method,
      path,
    );
  }
  async get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>(path, { params });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body });
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}
