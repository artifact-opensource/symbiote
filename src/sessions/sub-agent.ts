// Symbiote — Sub-agent spawning and management

import { randomUUID } from 'node:crypto';
import type { SubAgentConfig, SubAgentHandle, Session } from './types.js';
import type { SessionManager } from './manager.js';
import type { Provider, ProviderConfig, Message } from '../providers/types.js';
import type { ToolExecutor } from '../agent/runner.js';
import { runAgent } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createSandboxedRegistry, type SessionContext } from '../tools/sandbox.js';
import { PolicyEngine } from '../tools/policy.js';

const MAX_DEPTH = 3;

interface RuntimeState {
  session: Session;
  abortController: AbortController;
  pendingSteering: Message[];
  killed: boolean;
}

export class SubAgentManager {
  private agents = new Map<string, SubAgentHandle>();
  private runtimes = new Map<string, RuntimeState>();
  private sessionManager: SessionManager;
  private onComplete?: (parentSessionId: string, handle: SubAgentHandle) => void;

  constructor(sessionManager: SessionManager, onComplete?: (parentSessionId: string, handle: SubAgentHandle) => void) {
    this.sessionManager = sessionManager;
    this.onComplete = onComplete;
  }

  getDepth(sessionId: string): number {
    return this.sessionManager.load(sessionId)?.metadata.depth ?? 0;
  }

  async spawn(
    config: SubAgentConfig,
    provider: Provider,
    providerConfig: ProviderConfig,
    toolRegistry: ToolExecutor,
    workspace: string,
  ): Promise<SubAgentHandle> {
    if (config.depth >= MAX_DEPTH) {
      return {
        sessionId: '',
        task: config.task,
        status: 'failed',
        startedAt: Date.now(),
        error: `Max sub-agent depth (${MAX_DEPTH}) reached`,
      };
    }

    const sessionId = `subagent:${randomUUID().slice(0, 8)}`;
    const session = this.sessionManager.create(sessionId, {
      label: `Sub-agent: ${config.task.slice(0, 50)}`,
      provider: config.provider ?? providerConfig.model,
      model: config.model ?? providerConfig.model,
      parentSessionId: config.parentSessionId,
      depth: config.depth,
    });

    const handle: SubAgentHandle = {
      sessionId,
      task: config.task,
      status: 'running',
      startedAt: Date.now(),
    };
    this.agents.set(sessionId, handle);

    const subagentCtx: SessionContext = {
      sessionId,
      adapterId: 'subagent',
      channelType: 'internal',
      chatType: 'direct',
      senderId: config.parentSessionId,
      isOwner: false,
    };
    const sandboxedTools = createSandboxedRegistry(toolRegistry, subagentCtx);

    const systemPrompt = buildSystemPrompt({
      workspace,
      tools: sandboxedTools.list().map(t => t.name),
      extraContext: `You are a sub-agent spawned for a specific task. Complete it and provide a concise result.

IMPORTANT: You have a maximum of ${config.maxIterations ?? 25} iterations. When you see a warning about approaching the limit, immediately wrap up and return your best result so far. Do NOT let yourself hit the wall — provide partial results rather than nothing.

Task: ${config.task}`,
    });

    session.messages.push({ role: 'system', content: systemPrompt });
    session.messages.push({ role: 'user', content: config.task });

    this.runSubAgent(session, handle, config, provider, providerConfig, sandboxedTools);

    return handle;
  }

  private async runSubAgent(
    session: Session,
    handle: SubAgentHandle,
    config: SubAgentConfig,
    provider: Provider,
    providerConfig: ProviderConfig,
    toolRegistry: ToolExecutor,
  ): Promise<void> {
    const maxIter = config.maxIterations ?? 25;
    const policyEngine = new PolicyEngine();
    policyEngine.setSessionPolicy({
      sessionId: session.id,
      tools: {},
      maxIterations: maxIter,
    });

    try {
      while (true) {
        if (this.runtimes.get(session.id)?.killed) {
          handle.status = 'killed';
          handle.completedAt = Date.now();
          this.sessionManager.save(session);
          this.onComplete?.(config.parentSessionId, handle);
          return;
        }

        const runtime: RuntimeState = {
          session,
          abortController: new AbortController(),
          pendingSteering: [],
          killed: false,
        };
        this.runtimes.set(session.id, runtime);

        const result = await runAgent(session.messages, {
          provider,
          providerConfig: { ...providerConfig, systemPrompt: session.messages[0]?.content as string },
          toolRegistry,
          maxIterations: maxIter,
          sessionId: session.id,
          policyEngine,
          abortSignal: runtime.abortController.signal,
        });

        session.messages = result.messages;
        if (result.text) {
          session.messages.push({ role: 'assistant', content: result.text });
        }

        if (runtime.killed) {
          handle.status = 'killed';
          handle.completedAt = Date.now();
          this.sessionManager.save(session);
          this.onComplete?.(config.parentSessionId, handle);
          return;
        }

        if (runtime.pendingSteering.length > 0) {
          session.messages.push(...runtime.pendingSteering);
          this.sessionManager.save(session);
          continue;
        }

        if (result.aborted) {
          handle.status = 'failed';
          handle.error = 'Sub-agent aborted before completion';
          handle.completedAt = Date.now();
          this.sessionManager.save(session);
          this.onComplete?.(config.parentSessionId, handle);
          return;
        }

        handle.status = 'completed';
        handle.result = result.text;
        handle.completedAt = Date.now();
        this.sessionManager.save(session);
        this.onComplete?.(config.parentSessionId, handle);
        return;
      }
    } catch (err) {
      if (this.runtimes.get(session.id)?.killed) {
        handle.status = 'killed';
      } else {
        handle.status = 'failed';
        handle.error = err instanceof Error ? err.message : String(err);
      }
      handle.completedAt = Date.now();
      this.onComplete?.(config.parentSessionId, handle);
    } finally {
      this.runtimes.delete(session.id);
    }
  }

  kill(sessionId: string): boolean {
    const handle = this.agents.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!handle || handle.status !== 'running' || !runtime) return false;
    runtime.killed = true;
    runtime.abortController.abort('killed');
    return true;
  }

  steer(sessionId: string, message: string): boolean {
    const handle = this.agents.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!handle || handle.status !== 'running' || !runtime) return false;
    runtime.pendingSteering.push({ role: 'user', content: `[Steering from parent]: ${message}` });
    runtime.abortController.abort('steered');
    return true;
  }

  get(sessionId: string): SubAgentHandle | undefined {
    return this.agents.get(sessionId);
  }

  list(): SubAgentHandle[] {
    return [...this.agents.values()];
  }

  listRunning(): SubAgentHandle[] {
    return [...this.agents.values()].filter(a => a.status === 'running');
  }
}
