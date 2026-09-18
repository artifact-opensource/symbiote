// MEA — Monitor → Execute → Audit loop
// Lightweight audit gate that runs after tool execution but before response delivery.
// Verifies that the executed tools actually satisfied the user's intent.
// This is NOT a new module — it's a gate function called from runner.ts.

export interface MeaAuditResult {
  passed: boolean;
  confidence: number; // 0..1
  reason: string;
  /** If false, the response should be held and a correction attempted */
  shouldRetry: boolean;
  /** What went wrong, if anything */
  failureMode?: 'incomplete' | 'wrong_tool' | 'error_in_output' | 'timeout' | 'none';
}

export interface MeaAuditContext {
  /** The user's original message */
  userMessage: string;
  /** Task type classification */
  taskType: string;
  /** Tools that were called */
  toolCalls: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    success: boolean;
    error?: string;
  }>;
  /** The generated response */
  response: string;
  /** Time taken */
  latencyMs: number;
  /** Whether any tool returned an error */
  hadErrors: boolean;
}

/**
 * The audit gate — runs synchronously after the agent loop completes
 * but before the response is delivered to the user.
 *
 * If the audit fails, the runner can choose to retry or flag the response.
 */
export function auditInteraction(ctx: MeaAuditContext): MeaAuditResult {
  // ── Check 1: Did any tool calls error? ──
  if (ctx.hadErrors) {
    const failedTools = ctx.toolCalls.filter(t => !t.success);
    return {
      passed: false,
      confidence: 0.3,
      reason: `${failedTools.length} tool call(s) failed: ${failedTools.map(t => t.tool).join(', ')}`,
      shouldRetry: failedTools.length <= 2, // Retry if only a few tools failed
      failureMode: 'error_in_output',
    };
  }

  // ── Check 2: Was the response empty or too short? ──
  if (!ctx.response || ctx.response.trim().length < 5) {
    return {
      passed: false,
      confidence: 0.5,
      reason: 'Response was empty or too short',
      shouldRetry: true,
      failureMode: 'incomplete',
    };
  }

  // ── Check 3: Did the user ask for something specific that wasn't addressed? ──
  // Heuristic: check if key nouns/verbs from the user message appear in the response
  const userKeywords = extractKeywords(ctx.userMessage);
  const responseLower = ctx.response.toLowerCase();
  const matchedKeywords = userKeywords.filter(kw => responseLower.includes(kw));

  if (userKeywords.length > 0 && matchedKeywords.length / userKeywords.length < 0.2) {
    return {
      passed: false,
      confidence: 0.4,
      reason: `Response doesn't address user's request — keywords matched: ${matchedKeywords.length}/${userKeywords.length}`,
      shouldRetry: false, // Don't retry — just flag it
      failureMode: 'incomplete',
    };
  }

  // ── Check 4: Timeout check ──
  if (ctx.latencyMs > 60000) {
    return {
      passed: true,
      confidence: 0.6,
      reason: `Response delivered but latency was very high (${ctx.latencyMs}ms)`,
      shouldRetry: false,
      failureMode: 'timeout',
    };
  }

  // ── All checks passed ──
  return {
    passed: true,
    confidence: 0.85,
    reason: 'Audit passed — tools executed successfully, response addresses user query',
    shouldRetry: false,
    failureMode: 'none',
  };
}

/**
 * Extract meaningful keywords from a user message.
 * Filters out common stop words and short tokens.
 */
function extractKeywords(message: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'need', 'to', 'of', 'in',
    'for', 'on', 'at', 'by', 'with', 'from', 'as', 'into', 'about',
    'like', 'through', 'after', 'over', 'between', 'out', 'against',
    'during', 'without', 'before', 'under', 'around', 'among', 'and',
    'or', 'but', 'not', 'no', 'yes', 'so', 'than', 'too', 'very',
    'just', 'also', 'only', 'own', 'same', 'other', 'some', 'such',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
    'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'this',
    'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose',
    'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
    'more', 'most', 'much', 'little', 'less', 'least', 'many', 'every',
    'please', 'hey', 'hi', 'hello', 'ok', 'okay', 'yeah', 'nope',
  ]);

  return message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !stopWords.has(token))
    .slice(0, 15); // Top 15 keywords
}

/**
 * MEA Loop Stats — tracks audit pass/fail rates
 */
export class MeaStats {
  private total = 0;
  private passed = 0;
  private failed = 0;
  private retried = 0;
  private failureModes: Record<string, number> = {};

  record(result: MeaAuditResult): void {
    this.total++;
    if (result.passed) {
      this.passed++;
    } else {
      this.failed++;
      const mode = result.failureMode ?? 'unknown';
      this.failureModes[mode] = (this.failureModes[mode] ?? 0) + 1;
      if (result.shouldRetry) this.retried++;
    }
  }

  getStats() {
    return {
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      retried: this.retried,
      passRate: this.total > 0 ? this.passed / this.total : 1,
      failureModes: { ...this.failureModes },
    };
  }
}

// Singleton
let meaStats: MeaStats | null = null;
export function getMeaStats(): MeaStats {
  if (!meaStats) meaStats = new MeaStats();
  return meaStats;
}
