// Symbiote — Tool Policy Engine (fixes Pain #6, #12)
// Clean allow/deny, no phantom queues, dynamic iteration limits, resource budgets

export type PolicyDecision = 'allow' | 'deny';

export interface ToolPolicy {
  tool: string;
  decision: PolicyDecision;
  reason?: string;
}

export interface SessionPolicy {
  sessionId: string;
  /** Per-tool overrides. If not listed, falls through to default. */
  tools: Record<string, PolicyDecision>;
  /** Iteration limit for this session */
  maxIterations?: number;
  /** Complexity hint: 'simple' (10 iter), 'complex' (50 iter) */
  complexity?: 'simple' | 'complex';
}

export interface ResourceBudget {
  resource: string;
  dailyLimit: number;
  perRun?: number;
  used: number;
  resetAt: number; // ms epoch — when to reset daily counter
}

const DEFAULT_LIMITS: Record<string, number> = {
  simple: 10,
  complex: 50,
};

const DEFAULT_TOOL_POLICY: PolicyDecision = 'allow';

export class PolicyEngine {
  private sessionPolicies = new Map<string, SessionPolicy>();
  private globalDeny = new Set<string>(); // tools denied for everyone
  private budgets = new Map<string, ResourceBudget>();

  /** Set global deny list */
  setGlobalDeny(tools: string[]): void {
    this.globalDeny = new Set(tools);
  }

  /** Configure policy for a session */
  setSessionPolicy(policy: SessionPolicy): void {
    this.sessionPolicies.set(policy.sessionId, policy);
  }

  /** Check if a tool is allowed for a session. No phantom queues — immediate answer. */
  check(sessionId: string, toolName: string): { allowed: boolean; reason?: string } {
    // Global deny takes precedence
    if (this.globalDeny.has(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" is globally denied` };
    }

    const sp = this.sessionPolicies.get(sessionId);
    if (sp?.tools[toolName] === 'deny') {
      return { allowed: false, reason: `Tool "${toolName}" denied for session ${sessionId}` };
    }
    if (sp?.tools[toolName] === 'allow') {
      return { allowed: true };
    }

    // Default policy
    return { allowed: DEFAULT_TOOL_POLICY === 'allow' };
  }

  /** Get iteration limit for a session */
  getIterationLimit(sessionId: string): number {
    const sp = this.sessionPolicies.get(sessionId);
    if (sp?.maxIterations) return sp.maxIterations;
    const complexity = sp?.complexity ?? 'complex';
    return DEFAULT_LIMITS[complexity] ?? 25;
  }

  /**
   * Check iteration progress. Returns warning message if approaching limit.
   */
  checkIteration(sessionId: string, current: number): { ok: boolean; warning?: string } {
    const limit = this.getIterationLimit(sessionId);
    const ratio = current / limit;

    if (ratio >= 1) {
      return { ok: false, warning: `Iteration limit reached (${current}/${limit}). Stopping.` };
    }
    if (ratio >= 0.8) {
      return { ok: true, warning: `Approaching iteration limit: ${current}/${limit} (${Math.round(ratio * 100)}%)` };
    }
    return { ok: true };
  }

  // ── Resource Budgets ──

  /** Register a resource budget */
  registerBudget(resource: string, dailyLimit: number, perRun?: number): void {
    const now = Date.now();
    const resetAt = this.nextMidnight(now);
    this.budgets.set(resource, { resource, dailyLimit, perRun, used: 0, resetAt });
  }

  /** Try to consume resource. Returns true if allowed. */
  consumeResource(resource: string, amount: number): { allowed: boolean; remaining: number; reason?: string } {
    const budget = this.budgets.get(resource);
    if (!budget) return { allowed: true, remaining: Infinity }; // no budget = unlimited

    // Reset if past midnight
    if (Date.now() >= budget.resetAt) {
      budget.used = 0;
      budget.resetAt = this.nextMidnight(Date.now());
    }

    // Check per-run limit
    if (budget.perRun !== undefined && amount > budget.perRun) {
      return { allowed: false, remaining: budget.dailyLimit - budget.used, reason: `Exceeds per-run limit (${amount} > ${budget.perRun})` };
    }

    // Check daily limit
    if (budget.used + amount > budget.dailyLimit) {
      return { allowed: false, remaining: budget.dailyLimit - budget.used, reason: `Daily budget exhausted (${budget.used}/${budget.dailyLimit})` };
    }

    budget.used += amount;
    const remaining = budget.dailyLimit - budget.used;

    // Warn at 80%
    if (budget.used / budget.dailyLimit >= 0.8) {
      console.warn(`⚠️  Resource "${resource}" at ${Math.round((budget.used / budget.dailyLimit) * 100)}% of daily budget (${budget.used}/${budget.dailyLimit})`);
    }

    return { allowed: true, remaining };
  }

  /** Get budget status for a resource */
  getBudgetStatus(resource: string): ResourceBudget | undefined {
    const budget = this.budgets.get(resource);
    if (budget && Date.now() >= budget.resetAt) {
      budget.used = 0;
      budget.resetAt = this.nextMidnight(Date.now());
    }
    return budget;
  }

  private nextMidnight(now: number): number {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }
}
