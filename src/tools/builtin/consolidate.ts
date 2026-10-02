// Symbiote — Persona consolidation digest
//
// Read-only tool: surfaces recently staged memory (COMB notes, session
// highlights) so the agent can decide what's durable enough to fold into
// USER.md. This never writes anything itself — consolidation stays an
// explicit, reviewable edit/write call the agent (or owner) makes.

import type { ToolDefinition } from '../types.js';
import { getSharedVectorDB } from '../../memory/vdb.js';

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

function formatEntries(entries: Array<{ text: string; timestamp: number }>): string[] {
  return entries.map(e => {
    const date = new Date(e.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    const preview = e.text.length > 280 ? `${e.text.slice(0, 280)}...` : e.text;
    return `- [${date}] ${preview}`;
  });
}

export const personaDigestTool: ToolDefinition = {
  name: 'persona_digest',
  description: 'Pull a digest of recently staged memory (COMB notes, session highlights) to review for persona consolidation. Read-only — does not write anything. After reviewing, fold durable recurring facts about the user/workspace into USER.md yourself with edit/write; skip one-off or already-captured details.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days back to look (default 7)' },
    },
  },
  async execute(input) {
    const days = Number(input.days ?? 7);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const db = getSharedVectorDB(getWorkspace());

    const combNotes = db.recent('comb', 50).filter(d => d.timestamp >= since);
    const sessionNotes = db.recent('session', 30).filter(d => d.timestamp >= since);

    if (combNotes.length === 0 && sessionNotes.length === 0) {
      return `No staged memory in the last ${days} day(s) to consolidate.`;
    }

    const lines: string[] = [`Memory digest — last ${days} day(s):`, ''];
    if (combNotes.length > 0) {
      lines.push(`## COMB notes (${combNotes.length})`, ...formatEntries(combNotes), '');
    }
    if (sessionNotes.length > 0) {
      lines.push(`## Session highlights (${sessionNotes.length})`, ...formatEntries(sessionNotes));
    }
    return lines.join('\n');
  },
};
