// Symbiote — Simple retry wrapper for provider fetch calls
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from './types.js';

const RETRY_DELAYS = [2000, 5000, 10000];
// Bound rate-limit retries so a long server reset cannot stall an interaction.
const RATE_LIMIT_DELAYS = [2000, 5000, 10000, 20000, 40000];
const MAX_RATE_LIMIT_RETRY_MS = RATE_LIMIT_DELAYS.reduce((sum, delay) => sum + delay, 0);

export function createRequestSignal(timeoutMs: number, parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  if (parentSignal.aborted) return parentSignal;

  const controller = new AbortController();
  parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
  timeoutSignal.addEventListener('abort', () => controller.abort(timeoutSignal.reason), { once: true });
  return controller.signal;
}

// 400-class errors that are transient (backend quirks, not user errors)
const RETRYABLE_400_PATTERNS = [
  'assistant message prefill',
  'conversation must end with',
];

function isRetryable400(status: number, body?: string): boolean {
  if (status !== 400 || !body) return false;
  const lower = body.toLowerCase();
  return RETRYABLE_400_PATTERNS.some(p => lower.includes(p));
}

/** Parse a Retry-After header (seconds or HTTP-date) into a millisecond delay. */
function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
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

async function getRateLimitInfo(res: Response): Promise<{ remaining?: number; resetAt?: number }> {
  const info: { remaining?: number; resetAt?: number } = {};
  const readHeaders = (headers: Headers): void => {
    const remaining = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining');
    if (remaining !== null && Number.isFinite(Number(remaining))) info.remaining = Number(remaining);
    info.resetAt ??= parseResetTime(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'));
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
  for (let attempt = 0; attempt <= RATE_LIMIT_DELAYS.length; attempt++) {
    if (init.signal?.aborted) {
      throw init.signal.reason instanceof Error ? init.signal.reason : new Error('Request aborted');
    }
    try {
      const requestSignal = createRequestSignal(retryTimeoutMs, init.signal ?? undefined);
      const effectiveInit = { ...init, signal: requestSignal };
      const res = await fetch(url, effectiveInit);
      if (res.ok) return res;

      // Authentication failures are provider-specific and are not transient.
      // Copilot owns its token-refresh loop; API-key providers should fail fast.
      if (res.status === 401) return res;

      // Retry a 429 only when the provider's reset fits within our bounded retry
      // window. This uses generic rate-limit metadata instead of assuming a
      // particular provider's quota type, limit, or reset schedule.
      if (res.status === 429) {
        const rateLimitInfo = await getRateLimitInfo(res);
        const retryAfterMs = parseRetryAfter(res);
        const resetDelayMs = rateLimitInfo.remaining === 0 && rateLimitInfo.resetAt !== undefined
          ? Math.max(0, rateLimitInfo.resetAt - Date.now())
          : undefined;
        const providerDelayMs = retryAfterMs ?? (resetDelayMs && resetDelayMs > 0 ? resetDelayMs : undefined);
        const delayMs = providerDelayMs ?? RATE_LIMIT_DELAYS[attempt];
        const remainingRetryWindowMs = MAX_RATE_LIMIT_RETRY_MS - rateLimitWaitedMs;

        if (delayMs !== undefined && delayMs > remainingRetryWindowMs) {
          console.warn(`[retry] 429 reset is beyond the retry window (${Math.ceil(delayMs / 1000)}s); returning response`);
          return res;
        }
        if (attempt < RATE_LIMIT_DELAYS.length) {
          console.warn(`[retry] 429 rate limited (attempt ${attempt + 1}/${RATE_LIMIT_DELAYS.length + 1}) — retrying in ${(delayMs / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delayMs));
          rateLimitWaitedMs += delayMs;
          continue;
        }
        return res;
      }

      // Retry on 500+ (server errors)
      if (res.status >= 500) {
        if (attempt < RETRY_DELAYS.length) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        return res;
      }

      // Retry on known-transient 400 errors (copilot backend quirks)
      if (res.status === 400 && attempt < RETRY_DELAYS.length) {
        const body = await res.clone().text().catch(() => '');
        if (isRetryable400(res.status, body)) {
          console.warn(`[retry] Retryable 400 (attempt ${attempt + 1}): ${body.slice(0, 200)}`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (init.signal?.aborted || /timeout/i.test(lastError.name)) throw lastError;
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
    }
  }
  throw lastError ?? new Error('Fetch failed after retries');
}
