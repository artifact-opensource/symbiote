// Symbiote — Simple retry wrapper for provider fetch calls

const RETRY_DELAYS = [2000, 5000, 10000];

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

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      // On retries, ensure a fresh abort signal (previous may have timed out)
      const effectiveInit = attempt > 0 && init.signal instanceof AbortSignal
        ? { ...init, signal: AbortSignal.timeout(120_000) }
        : init;
      const res = await fetch(url, effectiveInit);
      if (res.ok) return res;

      // 401 — token expired (e.g., copilot session token). Invalidate cache and retry once.
      if (res.status === 401 && attempt < RETRY_DELAYS.length) {
        console.warn(`[retry] 401 Unauthorized (attempt ${attempt + 1}) — token may have expired, retrying...`);
        // Signal to callers that cached tokens should be refreshed
        (res as any)._tokenExpired = true;
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        return res;
      }

      // Retry on 429 (rate limit) and 500+ (server errors)
      if (res.status === 429 || res.status >= 500) {
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
