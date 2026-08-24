// Symbiote — Memory Index Integrity (fixes Pain #15)
// Validate on startup. Auto-rebuild if corrupt. Atomic writes.

import fs from 'node:fs';
import path from 'node:path';

export interface IntegrityCheckResult {
  healthy: boolean;
  issues: string[];
  rebuilt: boolean;
}

export interface IndexPaths {
  indexDir: string;
  vectorsFile: string;  // e.g. vectors.bin
  hnswFile: string;     // e.g. index.hnsw
  bm25File: string;     // e.g. bm25_index.json
  minVectorsSize?: number; // minimum expected size in bytes
  minHnswSize?: number;
}

/**
 * Validate HEKTOR index files. Check sizes, basic consistency.
 */
export function validateIndex(paths: IndexPaths): { healthy: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check vectors file
  if (!fs.existsSync(paths.vectorsFile)) {
    issues.push(`Vectors file missing: ${paths.vectorsFile}`);
  } else {
    const size = fs.statSync(paths.vectorsFile).size;
    if (size < (paths.minVectorsSize ?? 1000)) {
      issues.push(`Vectors file suspiciously small: ${size} bytes (expected > ${paths.minVectorsSize ?? 1000})`);
    }
  }

  // Check HNSW index
  if (!fs.existsSync(paths.hnswFile)) {
    issues.push(`HNSW index missing: ${paths.hnswFile}`);
  } else {
    const size = fs.statSync(paths.hnswFile).size;
    if (size < (paths.minHnswSize ?? 100)) {
      issues.push(`HNSW index suspiciously small: ${size} bytes — likely corrupt (empty index)`);
    }
  }

  // Check BM25 index
  if (!fs.existsSync(paths.bm25File)) {
    issues.push(`BM25 index missing: ${paths.bm25File}`);
  } else {
    const size = fs.statSync(paths.bm25File).size;
    if (size < 50) {
      issues.push(`BM25 index suspiciously small: ${size} bytes`);
    }
  }

  return { healthy: issues.length === 0, issues };
}

/**
 * Run a test query against the index to verify it actually works.
 */
export async function testQuery(
  searchFn: (query: string) => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await searchFn('test query health check');
    if (result.includes('error') || result.includes('Error')) {
      return { ok: false, error: result.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Atomic file write: write to .tmp, fsync, rename.
 * Prevents corruption from interrupted writes.
 */
export function atomicWrite(filePath: string, data: Buffer | string): void {
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    if (typeof data === 'string') {
      fs.writeSync(fd, data);
    } else {
      fs.writeSync(fd, data, 0, data.length);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Full integrity check + auto-rebuild if needed.
 */
export async function checkAndRepair(
  paths: IndexPaths,
  rebuildFn: () => Promise<void>,
): Promise<IntegrityCheckResult> {
  const validation = validateIndex(paths);

  if (validation.healthy) {
    return { healthy: true, issues: [], rebuilt: false };
  }

  console.warn(`⚠️  Index integrity issues found:`);
  for (const issue of validation.issues) {
    console.warn(`   - ${issue}`);
  }

  console.log('🔄 Auto-rebuilding index from source data...');
  try {
    await rebuildFn();
    // Re-validate after rebuild
    const recheck = validateIndex(paths);
    if (recheck.healthy) {
      console.log('✅ Index rebuilt successfully');
      return { healthy: true, issues: validation.issues, rebuilt: true };
    } else {
      console.error('❌ Index still unhealthy after rebuild');
      return { healthy: false, issues: recheck.issues, rebuilt: true };
    }
  } catch (err) {
    console.error('❌ Index rebuild failed:', err);
    return { healthy: false, issues: [...validation.issues, `Rebuild failed: ${err}`], rebuilt: false };
  }
}
