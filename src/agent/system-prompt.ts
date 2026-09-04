// Symbiote — System prompt builder
// Assembles identity, personality, and operational context from workspace .md files
// This is the soul of the agent — workspace files ARE the configuration

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SystemPromptParams {
  workspace: string;
  tools: string[];
  channel?: string;          // whatsapp | discord | etc.
  chatType?: string;         // direct | group
  senderId?: string;
  extraContext?: string;
  /** Override workspace files to load (for multi-persona support) */
  workspaceFiles?: { path: string; label: string; required?: boolean }[];
}

/** Files loaded in order. Each becomes a labeled section. Missing files are silently skipped. */
const WORKSPACE_FILES = [
  { path: 'SOUL.md',       label: 'Soul',              required: false },
  { path: 'IDENTITY.md',   label: 'Identity',          required: false },
  { path: 'USER.md',       label: 'About the User',    required: false },
  { path: 'AGENTS.md',     label: 'Operating Protocol', required: false },
  { path: 'BOOTSTRAP.md',  label: 'Operational DNA',    required: false },
  { path: 'TOOLS.md',      label: 'Tool Notes',        required: false },
  { path: 'HEARTBEAT.md',  label: 'Heartbeat Config',  required: false },
  { path: 'WORKFLOW_AUTO.md', label: 'Active Workflows', required: false },
];

/** Max bytes per file to prevent context blowup */
const MAX_FILE_BYTES = 30_000;

/** Max total prompt size (~120K chars, leaves room for conversation) */
const MAX_TOTAL_CHARS = 120_000;

function readFileSafe(filePath: string, maxBytes: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return null;
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + '\n\n[... truncated at ' + maxBytes + ' bytes]';
    }
    return content.trim() || null;
  } catch {
    return null;
  }
}

function readTodayMemory(workspace: string): string | null {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const memPath = path.join(workspace, 'memory', `${dateStr}.md`);
  return readFileSafe(memPath, 15_000); // Smaller limit for daily memory
}

function readYesterdayMemory(workspace: string): string | null {
  const yesterday = new Date(Date.now() - 86_400_000);
  const dateStr = yesterday.toISOString().split('T')[0];
  const memPath = path.join(workspace, 'memory', `${dateStr}.md`);
  return readFileSafe(memPath, 10_000);
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const parts: string[] = [];
  let totalChars = 0;

  function addSection(label: string, content: string): boolean {
    const section = `## ${label}\n${content}\n`;
    if (totalChars + section.length > MAX_TOTAL_CHARS) return false;
    parts.push(section);
    totalChars += section.length;
    return true;
  }

  // ── Runtime header ──
  const now = new Date();
  const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localTime = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

  addSection('Runtime', [
    `- Date: ${localTime}`,
    `- Timezone: ${tz}`,
    `- Host: ${os.hostname()}`,
    `- OS: ${os.platform()} ${os.arch()}`,
    `- Workspace: ${params.workspace}`,
    `- Channel: ${params.channel ?? 'unknown'}`,
    `- Chat type: ${params.chatType ?? 'unknown'}`,
    params.senderId ? `- Sender: ${params.senderId}` : '',
  ].filter(Boolean).join('\n'));

  // ── Workspace files (personality, identity, protocols) ──
  const filesToLoad = params.workspaceFiles ?? WORKSPACE_FILES;
  for (const file of filesToLoad) {
    const filePath = path.join(params.workspace, file.path);
    const content = readFileSafe(filePath, MAX_FILE_BYTES);
    if (content) {
      if (!addSection(file.label, content)) break; // Hit size limit
    }
  }

  // ── Today's memory ──
  const todayMem = readTodayMemory(params.workspace);
  if (todayMem) {
    addSection('Today\'s Memory', todayMem);
  }

  // ── Yesterday's memory (smaller) ──
  const yesterdayMem = readYesterdayMemory(params.workspace);
  if (yesterdayMem) {
    addSection('Yesterday\'s Memory', yesterdayMem);
  }

  // ── Tools ──
  if (params.tools.length > 0) {
    addSection('Available Tools', [
      `You have access to: ${params.tools.join(', ')}`,
      '',
      'Call tools when needed. For file operations, use read/write. For shell commands, use exec.',
      'Be resourceful — look things up before asking.',
    ].join('\n'));
  }

  // ── Extra context (channel-specific, message metadata, etc.) ──
  if (params.extraContext) {
    addSection('Context', params.extraContext);
  }

  // ── Guidelines (kept minimal — SOUL.md and AGENTS.md carry the real personality) ──
  addSection('Core Guidelines', [
    '- Embody your SOUL.md persona. No generic chatbot behavior.',
    '- Follow AGENTS.md operating protocols (memory, delegation, safety).',
    '- Use TOOLS.md for local specifics (credentials locations, CLI commands).',
    '- Be direct and concise. Help, don\'t perform helpfulness.',
    '- Use tools proactively — read before asking, search before guessing.',
    '- When in group chats: participate, don\'t dominate.',
    '- Private things stay private. When in doubt, ask before external actions.',
    '- Write to memory files — mental notes don\'t survive restarts.',
    '- Each user message starts with <<message_id=ID>>. Use this ID for reactions (message tool with action="react") and mark_read.',
  ].join('\n'));

  return parts.join('\n');
}
