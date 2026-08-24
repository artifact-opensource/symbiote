// Symbiote — Cron Resource Budgets (fixes Pain #14)
// Jobs declare resource usage. Scheduler enforces budgets. No overlap burns.

export interface ResourceDeclaration {
  resource: string;
  perRun: number;
  dailyLimit: number;
}

export interface CronJob {
  id: string;
  name: string;
  resources: ResourceDeclaration[];
  execute: () => Promise<void>;
}

interface ResourceTracker {
  resource: string;
  dailyLimit: number;
  used: number;
  resetDate: string; // YYYY-MM-DD
}

export class CronBudgetManager {
  private trackers = new Map<string, ResourceTracker>();
  private jobs = new Map<string, CronJob>();

  /** Register a cron job with its resource declarations */
  registerJob(job: CronJob): void {
    this.jobs.set(job.id, job);
    for (const r of job.resources) {
      if (!this.trackers.has(r.resource)) {
        this.trackers.set(r.resource, {
          resource: r.resource,
          dailyLimit: r.dailyLimit,
          used: 0,
          resetDate: this.today(),
        });
      }
    }
  }

  /** Check if a job can run within budget. Returns reason if not. */
  canRun(jobId: string): { allowed: boolean; reason?: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { allowed: false, reason: `Unknown job: ${jobId}` };

    for (const r of job.resources) {
      const tracker = this.getTracker(r.resource, r.dailyLimit);
      const remaining = tracker.dailyLimit - tracker.used;

      if (r.perRun > remaining) {
        return {
          allowed: false,
          reason: `Resource "${r.resource}" budget exhausted: ${tracker.used}/${tracker.dailyLimit} used, need ${r.perRun}, only ${remaining} remaining`,
        };
      }
    }

    return { allowed: true };
  }

  /** Run a job if budget allows. Deducts resource usage on success. */
  async executeJob(jobId: string): Promise<{ ran: boolean; reason?: string }> {
    const check = this.canRun(jobId);
    if (!check.allowed) {
      console.warn(`⛔ Job "${jobId}" blocked: ${check.reason}`);
      return { ran: false, reason: check.reason };
    }

    const job = this.jobs.get(jobId)!;

    // Reserve budget before running
    for (const r of job.resources) {
      const tracker = this.getTracker(r.resource, r.dailyLimit);
      tracker.used += r.perRun;

      // Warn at 80%
      const pct = tracker.used / tracker.dailyLimit;
      if (pct >= 0.8) {
        console.warn(`⚠️  Resource "${r.resource}" at ${Math.round(pct * 100)}% (${tracker.used}/${tracker.dailyLimit})`);
      }
    }

    try {
      await job.execute();
      return { ran: true };
    } catch (err) {
      console.error(`Job "${jobId}" failed:`, err);
      // Budget is still consumed — the attempt was made
      return { ran: true, reason: `Execution error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Get budget status for all resources */
  status(): { resource: string; used: number; dailyLimit: number; remaining: number; pct: number }[] {
    return [...this.trackers.values()].map(t => {
      this.maybeReset(t);
      return {
        resource: t.resource,
        used: t.used,
        dailyLimit: t.dailyLimit,
        remaining: t.dailyLimit - t.used,
        pct: Math.round((t.used / t.dailyLimit) * 100),
      };
    });
  }

  private getTracker(resource: string, dailyLimit: number): ResourceTracker {
    let tracker = this.trackers.get(resource);
    if (!tracker) {
      tracker = { resource, dailyLimit, used: 0, resetDate: this.today() };
      this.trackers.set(resource, tracker);
    }
    this.maybeReset(tracker);
    return tracker;
  }

  private maybeReset(tracker: ResourceTracker): void {
    const today = this.today();
    if (tracker.resetDate !== today) {
      tracker.used = 0;
      tracker.resetDate = today;
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
