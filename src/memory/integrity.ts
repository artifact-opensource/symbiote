// Symbiote — Embedded VDB Integrity
// Validates the actual JSONL document store and metadata index.

import fs from 'node:fs';

export interface IntegrityCheckResult {
  healthy: boolean;
  issues: string[];
  rebuilt: boolean;
}

export interface IndexPaths {
  documentsFile: string;
  indexFile: string;
}

export function validateIndex(paths: IndexPaths): { healthy: boolean; issues: string[] } {
  const issues: string[] = [];
  const documents = new Set<string>();

  if (fs.existsSync(paths.documentsFile)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(paths.documentsFile, 'utf-8').split(/\r?\n/);
    } catch (error) {
      return { healthy: false, issues: [`Unable to read ${paths.documentsFile}: ${String(error)}`] };
    }

    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
      const line = lines[lineNumber - 1].trim();
      if (!line) continue;
      try {
        const document = JSON.parse(line) as Record<string, unknown>;
        if (typeof document.id !== 'string' || typeof document.text !== 'string') {
          issues.push(`Invalid VDB document at ${paths.documentsFile}:${lineNumber}: id/text missing`);
          continue;
        }
        if (documents.has(document.id)) {
          issues.push(`Duplicate VDB document ID ${document.id} at line ${lineNumber}`);
          continue;
        }
        documents.add(document.id);
      } catch (error) {
        issues.push(`Invalid JSON at ${paths.documentsFile}:${lineNumber}: ${String(error)}`);
      }
    }
  }

  if (fs.existsSync(paths.indexFile)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(paths.indexFile, 'utf-8')) as Record<string, unknown>;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        issues.push(`Invalid VDB metadata index: ${paths.indexFile}`);
      } else {
        for (const key of ['documentCount', 'termCount', 'lastSaved']) {
          if (typeof metadata[key] !== 'number') issues.push(`VDB metadata index missing numeric ${key}`);
        }
      }
    } catch (error) {
      issues.push(`Unable to parse VDB metadata index ${paths.indexFile}: ${String(error)}`);
    }
  }

  return { healthy: issues.length === 0, issues };
}

export async function checkAndRepair(
  paths: IndexPaths,
  rebuildFn: () => Promise<void>,
): Promise<IntegrityCheckResult> {
  const validation = validateIndex(paths);
  if (validation.healthy) return { healthy: true, issues: [], rebuilt: false };

  console.warn('[vdb] Integrity issues found:');
  for (const issue of validation.issues) console.warn(`  - ${issue}`);

  try {
    await rebuildFn();
    const recheck = validateIndex(paths);
    return {
      healthy: recheck.healthy,
      issues: validation.issues,
      rebuilt: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[vdb] Rebuild failed: ${detail}`);
    return { healthy: false, issues: [...validation.issues, `Rebuild failed: ${detail}`], rebuilt: false };
  }
}
