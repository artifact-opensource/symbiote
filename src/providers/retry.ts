// Symbiote — Simple retry wrapper for provider fetch calls
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from './types.js';

const RETRY_DELAYS = [2000, 5000, 10000];
// Bound rate-limit retries so a long server reset cannot stall an interaction.
const RATE_LIMIT_DELAYS = [2000, 5000, 10000, 20000, 40000];
const MAX_RATE_LIMIT_RETRY_MS = RATE_LIMIT_DELAYS.reduce((sum, delay) => sum + delay, 0);
// Jitter factor: randomize delay by +/- 30% to prevent thundering-herd retries.
const JITTER_FACTOR = 0.3;
function jitterDelay(ms: number): number {
  const jitter = ms * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(ms + jitter));
}

export function createRequestSignal(timeoutMs: number, parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

// 400-class errors that are transient (backend quirks, not user errors)
const RETRYABLE_400_PATTERNS = [
  'assistant message prefill',
  'conversation must end with',
];

export class ProviderFetchRetriesExhaustedError extends Error {
  readonly code = 'PROVIDER_FETCH_RETRIES_EXHAUSTED';

  constructor(cause: Error) {
    super(`Provider request failed after ${RETRY_DELAYS.length} retries: ${cause.message}`, { cause });
    this.name = 'ProviderFetchRetriesExhaustedError';
  }
}

function isRetryable400(status: number, body?: string): boolean {
  if (status !== 400 || !body) return false;
  const lower = body.toLowerCase();
  return RETRYABLE_400_PATTERNS.some(p => lower.includes(p));
}

/** Parse a Retry-After value (seconds or HTTP-date) into a millisecond delay. */
function parseRetryAfterValue(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function parseResetTime(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const timestampMs = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return timestampMs;
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : dateMs;
}

async function getRateLimitInfo(res: Response): Promise<{ remaining?: number; resetAt?: number; retryAfterMs?: number }> {
  const info: { remaining?: number; resetAt?: number; retryAfterMs?: number } = {};
  const readHeaders = (headers: Headers): void => {
    const remaining = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining');
    if (remaining !== null && Number.isFinite(Number(remaining))) info.remaining = Number(remaining);
    info.resetAt ??= parseResetTime(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'));
    info.retryAfterMs ??= parseRetryAfterValue(headers.get('retry-after'));
  };
  readHeaders(res.headers);

  try {
    const body = await res.clone().json() as {
      error?: { metadata?: { headers?: Record<string, string> } };
    };
    const metadataHeaders = body.error?.metadata?.headers;
    if (metadataHeaders) {
      const normalizedHeaders = new Headers(metadataHeaders);
      readHeaders(normalizedHeaders);
    }
  } catch {
    // Rate-limit metadata is optional; use the HTTP headers when the body is not JSON.
  }
  return info;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryTimeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: Error | undefined;
  let rateLimitWaitedMs = 0;
  let rateLimitRetries = 0;
  let transientRetries = 0;
  const throwIfAborted = (): void => {
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error ? init.signal.reason : new Error('Request aborted');
    }
  };
  const waitForRetry = async (delayMs: number): Promise<void> => {
    throwIfAborted();
    if (!init.signal) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void): void => {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error('Request aborted'),
      ));
      const timer = setTimeout(() => finish(resolve), delayMs);
      init.signal?.addEventListener('abort', onAbort, { once: true });
      if (init.signal?.aborted) onAbort();
    });
  };
  while (true) {
    throwIfAborted();
    try {
      const requestSignal = createRequestSignal(retryTimeoutMs, init.signal ?? undefined);
      const effectiveInit = { ...init, signal: requestSignal };
      const res = await fetch(url, effectiveInit);
      if (res.ok) return res;

      // Authentication failures are provider-specific and are not transient.
      // Copilot owns its token-refresh loop; API-key providers should fail fast.
      if (res.status === 401) return res;

      // 402 = Payment Required / insufficient credits — NOT retryable, fail fast.
      if (res.status === 402) return res;

      // Retry a 429 only when the provider's reset fits within our bounded retry
      // window. This uses generic rate-limit metadata instead of assuming a
      // particular provider's quota type, limit, or reset schedule.
      if (res.status === 429) {
        const rateLimitInfo = await getRateLimitInfo(res);
        throwIfAborted();
        const retryAfterMs = parseRetryAfterValue(res.headers.get('retry-after')) ?? rateLimitInfo.retryAfterMs;
        const resetDelayMs = rateLimitInfo.remaining === 0 && rateLimitInfo.resetAt !== undefined
          ? Math.max(0, rateLimitInfo.resetAt - Date.now())
          : undefined;
        const providerDelayMs = retryAfterMs ?? (resetDelayMs && resetDelayMs > 0 ? resetDelayMs : undefined);
        if (rateLimitRetries >= RATE_LIMIT_DELAYS.length) return res;
        const delayMs = providerDelayMs ?? jitterDelay(RATE_LIMIT_DELAYS[rateLimitRetries]);
        const remainingRetryWindowMs = MAX_RATE_LIMIT_RETRY_MS - rateLimitWaitedMs;

        if (delayMs > remainingRetryWindowMs) {
          console.warn(`[retry] 429 reset is beyond the retry window (${Math.ceil(delayMs / 1000)}s); returning response`);
          return res;
        }
        console.warn(`[retry] 429 rate limited (attempt ${rateLimitRetries + 1}/${RATE_LIMIT_DELAYS.length + 1}) — retrying in ${(delayMs / 1000).toFixed(1)}s...`);
        await waitForRetry(delayMs);
        rateLimitWaitedMs += delayMs;
        rateLimitRetries++;
        continue;
      }

      // Retry on 500+ (server errors)
      if (res.status >= 500) {
        if (transientRetries < RETRY_DELAYS.length) {
          await waitForRetry(jitterDelay(RETRY_DELAYS[transientRetries]));
          transientRetries++;
          continue;
        }
        return res;
      }

      // Retry on known-transient 400 errors (copilot backend quirks)
      if (res.status === 400 && transientRetries < RETRY_DELAYS.length) {
        const body = await res.clone().text().catch(() => '');
        if (isRetryable400(res.status, body)) {
          console.warn(`[retry] Retryable 400 (attempt ${transientRetries + 1}): ${body.slice(0, 200)}`);
          await waitForRetry(jitterDelay(RETRY_DELAYS[transientRetries]));
          transientRetries++;
          continue;
        }
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (init.signal?.aborted || /timeout/i.test(lastError.name)) throw lastError;
      if (transientRetries < RETRY_DELAYS.length) {
        await waitForRetry(jitterDelay(RETRY_DELAYS[transientRetries]));
        transientRetries++;
        continue;
      }
      throw new ProviderFetchRetriesExhaustedError(lastError);
    }
  }
}
