import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface GatewayLockRecord {
  pid: number;
  token: string;
  startedAt: number;
}

const INITIALIZATION_GRACE_MS = 10_000;

function isGatewayLockRecord(value: unknown): value is GatewayLockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<GatewayLockRecord>;
  return Number.isInteger(record.pid) && (record.pid ?? 0) > 0
    && typeof record.token === 'string'
    && typeof record.startedAt === 'number';
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

export function acquireGatewayInstanceLock(workspace: string): () => void {
  const directory = path.join(path.resolve(workspace), '.session');
  const lockPath = path.join(directory, 'gateway-instance.lock');
  const token = randomUUID();
  fs.mkdirSync(directory, { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        token,
        startedAt: Date.now(),
      } satisfies GatewayLockRecord), 'utf8');
      fs.fsyncSync(descriptor);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      let existingContents: string;
      let modifiedAt: number;
      try {
        existingContents = fs.readFileSync(lockPath, 'utf8');
        modifiedAt = fs.statSync(lockPath).mtimeMs;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readError;
      }

      let existing: unknown;
      try {
        existing = JSON.parse(existingContents);
      } catch {
        existing = null;
      }
      if (isGatewayLockRecord(existing) && isProcessRunning(existing.pid)) {
        throw new Error(`A Symbiote Gateway is already running for ${path.resolve(workspace)} (PID ${existing.pid}).`);
      }
      if (!isGatewayLockRecord(existing) && Date.now() - modifiedAt < INITIALIZATION_GRACE_MS) {
        throw new Error(`A Symbiote Gateway is initializing its instance lock at ${lockPath}.`);
      }

      try {
        if (fs.readFileSync(lockPath, 'utf8') !== existingContents) continue;
        fs.unlinkSync(lockPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cleanupError;
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  if (!acquired) {
    throw new Error(`Could not acquire the Symbiote Gateway instance lock at ${lockPath}.`);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<GatewayLockRecord>;
      if (existing.token === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[gateway] Could not release instance lock ${lockPath}:`, error);
      }
    }
  };
  process.once('exit', release);
  return release;
}
