// Symbiote — Session persistence (JSON files) — legacy compatibility wrapper
// Phase 2 uses SessionManager instead, but this remains for backward compat

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session, SessionSummary, SessionMetadata } from './types.js';

const DEFAULT_DIR = '.mach6/sessions';

function defaultMetadata(): SessionMetadata {
  return { messageCount: 0, tokenUsage: { input: 0, output: 0 }, toolsUsed: {}, depth: 0 };
}

export class SessionStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? path.join(os.homedir(), DEFAULT_DIR);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  load(id: string): Session | null {
    const p = this.filePath(id);
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Session;
      if (!data.metadata || !('messageCount' in data.metadata)) {
        data.metadata = defaultMetadata();
      }
      return data;
    } catch {
      return null;
    }
  }

  save(session: Session): void {
    session.updatedAt = Date.now();
    fs.writeFileSync(this.filePath(session.id), JSON.stringify(session, null, 2));
  }

  create(id: string): Session {
    const session: Session = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      metadata: defaultMetadata(),
    };
    this.save(session);
    return session;
  }

  delete(id: string): boolean {
    try { fs.unlinkSync(this.filePath(id)); return true; } catch { return false; }
  }

  list(): SessionSummary[] {
    try {
      const summaries: SessionSummary[] = [];
      for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as Session;
          summaries.push({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length });
        } catch { /* skip */ }
      }
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }
}
