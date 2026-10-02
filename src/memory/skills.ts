// Symbiote — Skill file ingestion
//
// Mirrors the Memograph import pattern: skill files (markdown, optionally
// with a YAML-lite frontmatter block for name/description, matching the
// `SKILL.md` convention) are scanned from a workspace directory and indexed
// into the same embedded VDB so they're retrievable via memory_recall /
// comb_recall / context-store retrieval. Read-only scan — never mutates
// the skill files themselves.

import fs from 'node:fs';
import path from 'node:path';
import type { VDBDocument, VectorDB } from './vdb.js';

export interface SkillMeta {
  name: string;
  description: string;
  file: string;
}

export interface SkillImportResult {
  files: number;
  indexed: number;
  skipped: number;
  failures: number;
  skills: SkillMeta[];
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).trim().split('\n')) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, '') };
}

export function resolveSkillsDir(workspace: string, configuredPath = process.env.SYMBIOTE_SKILLS_DIR): string {
  if (configuredPath) return path.resolve(configuredPath);
  return path.resolve(workspace, 'skills');
}

function scanSkillFiles(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  const filenames: string[] = [];
  const pending = [skillsDir];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) filenames.push(path.join(dir, entry.name));
    }
  }
  filenames.sort();
  return filenames;
}

function describeSkill(skillsDir: string, filePath: string): SkillMeta {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const relDir = path.relative(skillsDir, path.dirname(filePath));
  const name = meta.name || (relDir && relDir !== '.' ? path.basename(relDir) : path.basename(filePath, '.md'));
  const firstLine = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
  const description = (meta.description || firstLine).slice(0, 200);
  return { name, description, file: filePath };
}

/** Lightweight scan for the system prompt — names + descriptions only, no VDB access. */
export function listSkillSummaries(workspace: string): SkillMeta[] {
  const skillsDir = resolveSkillsDir(workspace);
  const summaries: SkillMeta[] = [];
  for (const filePath of scanSkillFiles(skillsDir)) {
    try {
      summaries.push(describeSkill(skillsDir, filePath));
    } catch {
      // Non-fatal — skip unreadable file in the summary list
    }
  }
  return summaries;
}

/** Index skill file contents into the VDB, same idempotent dedup as Memograph import. */
export function importSkillFiles(database: VectorDB, skillsDir: string): SkillImportResult {
  const result: SkillImportResult = { files: 0, indexed: 0, skipped: 0, failures: 0, skills: [] };

  let filenames: string[];
  try {
    filenames = scanSkillFiles(skillsDir);
  } catch (error) {
    result.failures++;
    console.error(`[skills] storage scan failed (${skillsDir}): ${error instanceof Error ? error.message : error}`);
    return result;
  }

  for (const filePath of filenames) {
    result.files++;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { body } = parseFrontmatter(raw);
      const meta = describeSkill(skillsDir, filePath);
      const doc: VDBDocument = {
        id: `skill:${path.relative(skillsDir, filePath).replace(/[\\/]/g, ':')}`,
        text: body.trim() || raw.trim(),
        source: 'skill',
        role: 'context',
        timestamp: Date.now(),
        namespace: `skill:${meta.name}`,
        metadata: { name: meta.name, description: meta.description, file: filePath },
      };
      if (database.index(doc)) result.indexed++; else result.skipped++;
      result.skills.push(meta);
    } catch (error) {
      result.failures++;
      console.error(`[skills] import failed (${filePath}): ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}
