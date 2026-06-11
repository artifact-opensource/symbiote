// Symbiote — Provider Error Diagnostics (fixes Pain #7, #8)
// Loud errors, redacted logs, fix suggestions, configurable timeouts

export interface ProviderDiagnostic {
  provider: string;
  status: number;
  url: string;
  headers: Record<string, string>; // redacted
  body: string;
  suggestion: string;
  timestamp: number;
}

/** Known error patterns → fix suggestions */
const ERROR_SUGGESTIONS: { match: (provider: string, status: number, body: string) => boolean; suggestion: string }[] = [
  {
    match: (p, s) => p === 'github-copilot' && s === 403,
    suggestion: '403 from Copilot? Check User-Agent/Editor-Version headers. Required: "User-Agent: GitHubCopilotChat/0.25.0", "Editor-Version: vscode/1.100.0"',
  },
  {
    match: (p, s) => p === 'anthropic' && s === 401,
    suggestion: '401 from Anthropic? Check API key (starts with "sk-ant-"). Verify ANTHROPIC_API_KEY env var.',
  },
  {
    match: (p, s) => p === 'openai' && s === 401,
    suggestion: '401 from OpenAI-compatible endpoint? If using Copilot, check GitHub token.',
  },
  {
    match: (_, s) => s === 429,
    suggestion: 'Rate limited (429). Back off and retry. Check if you\'re exceeding your plan\'s rate limits.',
  },
  {
    match: (_, s) => s === 413,
    suggestion: '413 Body Too Large. Context is too big — trigger compaction or reduce message history.',
  },
  {
    match: (_, s, b) => s === 400 && b.includes('context_length'),
    suggestion: 'Context length exceeded. Reduce message history or use a model with larger context window.',
  },
  {
    match: (_, s) => s >= 500,
    suggestion: 'Server error (5xx). Provider is having issues. Retry with backoff or switch provider.',
  },
];

/** Redact sensitive headers */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  const SENSITIVE = ['authorization', 'x-api-key', 'api-key', 'cookie'];
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE.includes(k.toLowerCase())) {
      redacted[k] = v.slice(0, 8) + '...[REDACTED]';
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

/** Diagnose a provider error and return actionable info */
export function diagnoseError(
  provider: string,
  status: number,
  url: string,
  headers: Record<string, string>,
  body: string,
): ProviderDiagnostic {
  const suggestion = ERROR_SUGGESTIONS.find(e => e.match(provider, status, body))?.suggestion
    ?? `HTTP ${status} from ${provider}. Check the response body for details.`;

  const diagnostic: ProviderDiagnostic = {
    provider,
    status,
    url,
    headers: redactHeaders(headers),
    body: body.slice(0, 2000),
    suggestion,
    timestamp: Date.now(),
  };

  // LOUD logging — never silent
  console.error(`\n🔴 Provider Error [${provider}]`);
  console.error(`   URL: ${url}`);
  console.error(`   Status: ${status}`);
  console.error(`   Headers: ${JSON.stringify(diagnostic.headers)}`);
  console.error(`   Body: ${body.slice(0, 500)}`);
  console.error(`   💡 ${suggestion}\n`);

  return diagnostic;
}

/** Default timeouts per operation type (ms) */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  api: 10_000,
  browser: 60_000,
  exec: 30_000,
  'web-fetch': 15_000,
};

/** Get timeout for an operation, with per-provider override support */
export function getTimeout(
  operation: string,
  providerTimeouts?: Record<string, number>,
): number {
  if (providerTimeouts?.[operation] !== undefined) return providerTimeouts[operation];
  return DEFAULT_TIMEOUTS[operation] ?? 20_000;
}

/** Create an AbortSignal with the appropriate timeout */
export function timeoutSignal(operation: string, providerTimeouts?: Record<string, number>): AbortSignal {
  return AbortSignal.timeout(getTimeout(operation, providerTimeouts));
}
