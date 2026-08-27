/**
 * Symbiote work journal.
 *
 * A compact resumable state object for long-horizon work. This is intentionally
 * smaller and more structured than raw chat history so it survives truncation,
 * aborts, and checkpoint-based resumes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkJournalEntry {
  ts: number;
  kind: 'objective' | 'progress' | 'decision' | 'risk' | 'checkpoint';
  summary: string;
  details?: string;
}

export interface WorkJournalState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  objective: string;
  activeFiles: string[];
  pendingTasks: string[];
  completedTasks: string[];
  lastDecision?: string;
  entries: WorkJournalEntry[];
}

export class WorkJournal {
  private file: string;
  private state: WorkJournalState;

  constructor(opts: { dir: string; sessionId: string; objective: string; activeFiles?: string[] }) {
    this.file = path.join(opts.dir, `${opts.sessionId}.work-journal.json`);
    this.state = {
      sessionId: opts.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      objective: opts.objective,
      activeFiles: opts.activeFiles ?? [],
      pendingTasks: [],
      completedTasks: [],
      entries: [],
    };
  }

  static restore(file: string): WorkJournalState | null {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkJournalState;
    } catch {
      return null;
    }
  }

  add(kind: WorkJournalEntry['kind'], summary: string, details?: string): void {
    this.state.updatedAt = Date.now();
    this.state.entries.push({ ts: Date.now(), kind, summary, details });
    this.persist();
  }

  setObjective(objective: string): void {
    this.state.objective = objective;
    this.add('objective', objective);
  }

  setActiveFiles(files: string[]): void {
    this.state.activeFiles = [...new Set(files)];
    this.persist();
  }

  setPendingTasks(tasks: string[]): void {
    this.state.pendingTasks = [...tasks];
    this.persist();
  }

  markCompleted(task: string): void {
    this.state.completedTasks.push(task);
    this.state.pendingTasks = this.state.pendingTasks.filter(t => t !== task);
    this.add('progress', `Completed: ${task}`);
  }

  setDecision(decision: string): void {
    this.state.lastDecision = decision;
    this.add('decision', decision);
  }

  snapshot(): WorkJournalState {
    return structuredClone(this.state);
  }

  persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}
