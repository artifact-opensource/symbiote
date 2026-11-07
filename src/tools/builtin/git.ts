import { GitService, type GitAction, type GitOperation } from '../../git/service.js';
import type { ToolDefinition } from '../types.js';

const actions: GitAction[] = [
  'status', 'diff', 'log', 'branch_list', 'remote_list', 'stage', 'commit', 'fetch', 'pull', 'push',
];

export function createGitTool(service = new GitService()): ToolDefinition {
  return {
    name: 'git',
    description: 'Operate on any local Git repository using the installed Git CLI and its configured SSH/credential helpers. Supports GitHub, GitLab, Gitee, Bitbucket, Azure DevOps, Codeberg, and any standard Git remote. Use push only when explicitly requested by the user.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions, description: 'Git operation to perform.' },
        repositoryPath: { type: 'string', description: 'Path to a local repository; defaults to the current workspace or assigned project.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Repository-relative paths for diff or stage.' },
        message: { type: 'string', description: 'Commit message for commit.' },
        staged: { type: 'boolean', description: 'For diff, show the staged diff instead of unstaged changes.' },
        limit: { type: 'number', description: 'For log, number of commits to show (1–50, default 10).' },
        remote: { type: 'string', description: 'Optional Git remote name for fetch, pull, or push.' },
        branch: { type: 'string', description: 'Optional branch for pull or push.' },
      },
      required: ['action'],
    },
    idempotency: {
      class: 'external',
      externalSystem: 'Git',
      irreversibleReason: 'Git operations may publish repository changes or alter remote state. Use push only after explicit user instruction.',
      idempotencyKey: input => `git:${String(input.action ?? '')}:${String(input.repositoryPath ?? process.cwd())}:${String(input.remote ?? '')}:${String(input.branch ?? '')}`,
    },
    async execute(input, options) {
      if (typeof input.action !== 'string' || !actions.includes(input.action as GitAction)) {
        throw new Error(`action must be one of: ${actions.join(', ')}.`);
      }
      const operation: GitOperation = {
        action: input.action as GitAction,
        ...(typeof input.repositoryPath === 'string' ? { repositoryPath: input.repositoryPath } : {}),
        ...(input.paths !== undefined ? { paths: input.paths as string[] } : {}),
        ...(typeof input.message === 'string' ? { message: input.message } : {}),
        ...(typeof input.staged === 'boolean' ? { staged: input.staged } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(typeof input.remote === 'string' ? { remote: input.remote } : {}),
        ...(typeof input.branch === 'string' ? { branch: input.branch } : {}),
      };
      return service.execute(operation, options?.signal);
    },
  };
}

export const gitTool = createGitTool();
