import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appPath } from '../runtime/platform.js';

export interface GitIdentity {
  userName: string;
  userEmail: string;
}

export type GitAction =
  | 'status'
  | 'diff'
  | 'log'
  | 'branch_list'
  | 'remote_list'
  | 'stage'
  | 'commit'
  | 'fetch'
  | 'pull'
  | 'push';

export interface GitOperation {
  action: GitAction;
  repositoryPath?: string;
  paths?: string[];
  message?: string;
  staged?: boolean;
  limit?: number;
  remote?: string;
  branch?: string;
}

const MAX_OUTPUT_BYTES = 100_000;
const MAX_PATHS = 100;
const MAX_VALUE_LENGTH = 2_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateIdentity(value: unknown): GitIdentity {
  if (!isObject(value) || typeof value.userName !== 'string' || typeof value.userEmail !== 'string') {
    throw new TypeError('Git identity requires userName and userEmail strings.');
  }
  const userName = value.userName.trim();
  const userEmail = value.userEmail.trim();
  if (userName.length > 200 || /[\r\n\0]/.test(userName)) {
    throw new Error('Git user name must be at most 200 characters and cannot contain line breaks.');
  }
  if (userEmail.length > 320 || /[\r\n\0]/.test(userEmail)
    || (userEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail))) {
    throw new Error('Git email must be a valid email address of at most 320 characters.');
  }
  if (Boolean(userName) !== Boolean(userEmail)) {
    throw new Error('Set both Git user name and email, or clear both values.');
  }
  return { userName, userEmail };
}

function validateText(value: unknown, label: string, maximum = MAX_VALUE_LENGTH): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function validatePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATHS
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > MAX_VALUE_LENGTH || item.includes('\0'))) {
    throw new Error(`paths must contain between 1 and ${MAX_PATHS} valid repository-relative paths.`);
  }
  return value as string[];
}

function redactRemoteCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@');
}

function formatGitArgs(identity: GitIdentity, args: string[]): string[] {
  return [
    ...(identity.userName ? ['-c', `user.name=${identity.userName}`] : []),
    ...(identity.userEmail ? ['-c', `user.email=${identity.userEmail}`] : []),
    ...args,
  ];
}

function runProcess(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Git operation was aborted before it started.'));
      return;
    }

    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Git operation timed out after 120 seconds.'));
    }, 120_000);
    const onAbort = () => {
      child.kill();
      finish(new Error('Git operation was aborted.'));
    };
    const finish = (failure?: Error, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve(output);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
        else {
          child.kill();
          finish(new Error(`Git output exceeded the ${MAX_OUTPUT_BYTES} byte limit.`));
        }
      });
    }
    child.once('error', error => finish(new Error(`Could not start Git: ${error.message}`)));
    child.once('close', code => {
      if (settled) return;
      const output = redactRemoteCredentials(Buffer.concat(chunks).toString('utf8')).trim();
      if (code !== 0) {
        finish(new Error(`Git ${args.at(-1) ?? 'operation'} failed${output ? `: ${output}` : ` (exit code ${code})`}.`));
      } else {
        finish(undefined, output || 'Git operation completed successfully.');
      }
    });
  });
}

export class GitService {
  private readonly identityPath: string;

  constructor(identityPath = appPath('integrations', 'git-identity.json')) {
    this.identityPath = identityPath;
  }

  getIdentity(): GitIdentity {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.identityPath, 'utf8'));
      return validateIdentity(parsed);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { userName: '', userEmail: '' };
      throw new Error(`Could not read the saved Git identity at ${this.identityPath}.`, { cause: failure });
    }
  }

  saveIdentity(value: unknown): GitIdentity {
    const identity = validateIdentity(value);
    const directory = path.dirname(this.identityPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.identityPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'w', mode: 0o600 });
      fs.renameSync(temporary, this.identityPath);
    } catch (failure) {
      try { fs.unlinkSync(temporary); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[git] Could not remove temporary identity file ${temporary}:`, cleanupError);
        }
      }
      throw new Error(`Could not save the Git identity at ${this.identityPath}.`, { cause: failure });
    }
    return identity;
  }

  async execute(operation: GitOperation, signal?: AbortSignal): Promise<string> {
    const repositoryPath = path.resolve(operation.repositoryPath?.trim() || process.cwd());
    let stat: fs.Stats;
    try {
      stat = fs.statSync(repositoryPath);
    } catch (failure) {
      throw new Error(`Repository path does not exist: ${repositoryPath}.`, { cause: failure });
    }
    if (!stat.isDirectory()) throw new Error(`Repository path is not a directory: ${repositoryPath}.`);

    const root = await runProcess(['rev-parse', '--show-toplevel'], repositoryPath, signal);
    const identity = this.getIdentity();
    const args = formatGitArgs(identity, ['-C', root, ...this.arguments(operation)]);
    return runProcess(args, repositoryPath, signal);
  }

  private arguments(operation: GitOperation): string[] {
    switch (operation.action) {
      case 'status':
        return ['status', '--short', '--branch'];
      case 'diff':
        return ['diff', ...(operation.staged === true ? ['--cached'] : []), '--', ...(operation.paths ? validatePaths(operation.paths) : [])];
      case 'log': {
        const limit = operation.limit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('limit must be an integer from 1 to 50.');
        return ['log', '--oneline', '--decorate', '-n', String(limit)];
      }
      case 'branch_list':
        return ['branch', '--list'];
      case 'remote_list':
        return ['remote', '-v'];
      case 'stage':
        return ['add', '--', ...validatePaths(operation.paths)];
      case 'commit':
        return ['commit', '-m', validateText(operation.message, 'message', 10_000)];
      case 'fetch':
        return ['fetch', '--prune', ...(operation.remote ? [validateText(operation.remote, 'remote')] : [])];
      case 'pull':
      case 'push': {
        const remote = operation.remote
          ? validateText(operation.remote, 'remote')
          : operation.action === 'push' ? 'origin' : undefined;
        const branch = operation.branch ? validateText(operation.branch, 'branch') : undefined;
        return [
          operation.action,
          ...(remote ? [remote] : []),
          ...(operation.action === 'push' ? [branch ?? 'HEAD'] : branch ? [branch] : []),
        ];
      }
      default:
        throw new Error(`Unsupported Git action: ${String(operation.action)}.`);
    }
  }
}
