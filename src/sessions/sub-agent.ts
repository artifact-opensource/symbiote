// Symbiote — Sub-agent spawning and management

import { randomUUID } from 'node:crypto';
import type { SubAgentConfig, SubAgentHandle, Session } from './types.js';
import type { SessionManager } from './manager.js';
import type { Provider, ProviderConfig, Message } from '../providers/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from '../agent/runner.js';
import { runAgent } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createSandboxedRegistry, type SessionContext } from '../tools/sandbox.js';
import { PolicyEngine } from '../tools/policy.js';

const MAX_DEPTH = 3;

export class SubAgentManager {
  private agents = new Map<string, SubAgentHandle>();
  private sessionManager: SessionManager;
  private onComplete?: (parentSessionId: string, handle: SubAgentHandle) => void;

  constructor(sessionManager: SessionManager, onComplete?: (parentSessionId: string, handle: SubAgentHandle) => void) {
    this.sessionManager = sessionManager;
    this.onComplete = onComplete;
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

    // Sub-agents ALWAYS get sandboxed at 'standard' tier (no admin escalation)
    const subagentCtx: SessionContext = {
      sessionId,
      adapterId: 'subagent',
      channelType: 'internal',
      chatType: 'direct',
      senderId: config.parentSessionId,
      chatId: config.parentSessionId,
      isOwner: true, // Treated as owner but adapter='subagent' → standard tier
    };
    const sandboxedTools = createSandboxedRegistry(toolRegistry, subagentCtx);

    // Build system prompt for sub-agent
    const systemPrompt = buildSystemPrompt({
      workspace,
      tools: sandboxedTools.list().map(t => t.name),
      extraContext: `You are a sub-agent spawned for a specific task. Complete it and provide a concise result.

IMPORTANT: You have a maximum of ${config.maxIterations ?? 25} iterations. When you see a warning about approaching the limit, immediately wrap up and return your best result so far. Do NOT let yourself hit the wall — provide partial results rather than nothing.

Task: ${config.task}`,
    });

    session.messages.push({ role: 'system', content: systemPrompt });
    session.messages.push({ role: 'user', content: config.task });

    // Run asynchronously — don't await
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

    // Create a policy engine for this sub-agent so it gets iteration warnings
    const policyEngine = new PolicyEngine();
    policyEngine.setSessionPolicy({
      sessionId: session.id,
      tools: {},
      maxIterations: maxIter,
    });

    try {
      const result = await runAgent(session.messages, {
        provider,
        providerConfig: { ...providerConfig, systemPrompt: session.messages[0]?.content as string },
        toolRegistry,
        maxIterations: maxIter,
        sessionId: session.id,
        policyEngine,
      });

      handle.status = 'completed';
      handle.result = result.text;
      handle.completedAt = Date.now();

      session.messages = result.messages;
      if (result.text) session.messages.push({ role: 'assistant', content: result.text });
      this.sessionManager.save(session);

      this.onComplete?.(config.parentSessionId, handle);
    } catch (err) {
      handle.status = 'failed';
      handle.error = err instanceof Error ? err.message : String(err);
      handle.completedAt = Date.now();
      this.onComplete?.(config.parentSessionId, handle);
    }
  }

  kill(sessionId: string): boolean {
    const handle = this.agents.get(sessionId);
    if (!handle || handle.status !== 'running') return false;
    handle.status = 'killed';
    handle.completedAt = Date.now();
    return true;
  }

  steer(sessionId: string, message: string): boolean {
    const handle = this.agents.get(sessionId);
    if (!handle || handle.status !== 'running') return false;
    // Inject a steering message into the sub-agent's session
    const session = this.sessionManager.load(sessionId);
    if (!session) return false;
    session.messages.push({ role: 'user', content: `[Steering from parent]: ${message}` });
    this.sessionManager.save(session);
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
