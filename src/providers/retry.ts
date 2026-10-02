// Symbiote — Simple retry wrapper for provider fetch calls
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from './types.js';

const RETRY_DELAYS = [2000, 5000, 10000];
// 429s are survivable if we wait long enough — OpenRouter/most providers reset
// within a minute. Use a longer, dedicated backoff ladder for rate limits.
const RATE_LIMIT_DELAYS = [2000, 5000, 10000, 20000, 40000];

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

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retryTimeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= RATE_LIMIT_DELAYS.length; attempt++) {
    try {
      // On retries, ensure a fresh abort signal (previous may have timed out)
      const effectiveInit = attempt > 0 && init.signal instanceof AbortSignal
        ? { ...init, signal: AbortSignal.timeout(retryTimeoutMs) }
        : init;
      const res = await fetch(url, effectiveInit);
      if (res.ok) return res;

      // Authentication failures are provider-specific and are not transient.
      // Copilot owns its token-refresh loop; API-key providers should fail fast.
      if (res.status === 401) return res;

      // Retry on 429 (rate limit) — honor Retry-After header when present,
      // otherwise fall back to an extended backoff ladder. Daily-quota
      // exhaustion (vs. a transient per-minute limit) can't recover within
      // our retry window, so fail fast instead of burning ~77s per message.
      if (res.status === 429) {
        const body = await res.clone().text().catch(() => '');
        const isDailyQuota = /free-models-per-day|per-day|daily/i.test(body);
        if (isDailyQuota) {
          console.warn('[retry] 429 daily quota exhausted — failing fast (retrying won\'t help until reset)');
          return res;
        }
        if (attempt < RATE_LIMIT_DELAYS.length) {
          const retryAfterMs = parseRetryAfter(res);
          const delayMs = retryAfterMs ?? RATE_LIMIT_DELAYS[attempt];
          console.warn(`[retry] 429 rate limited (attempt ${attempt + 1}/${RATE_LIMIT_DELAYS.length + 1}) — retrying in ${(delayMs / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delayMs));
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
      if (attempt < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
    }
  }
  throw lastError ?? new Error('Fetch failed after retries');
}
