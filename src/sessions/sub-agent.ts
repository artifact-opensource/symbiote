// Symbiote — Sub-agent spawning and management

import { randomUUID } from 'node:crypto';
import type { SubAgentConfig, SubAgentHandle, Session } from './types.js';
import type { SessionManager } from './manager.js';
import type { Provider, ProviderConfig, Message } from '../providers/types.js';
import type { ToolExecutor } from '../agent/runner.js';
import type { ContextStore } from '../agent/context-store.js';
import { runAgent } from '../agent/runner.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createSandboxedRegistry, type SessionContext } from '../tools/sandbox.js';
import { PolicyEngine } from '../tools/policy.js';
import { BlinkController, DEFAULT_BLINK_CONFIG } from '../agent/blink.js';
import { EXPANDED_CAP as PULSE_EXPANDED_CAP } from '../agent/pulse.js';

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
  private getContextStore?: () => ContextStore | undefined;

  constructor(
    sessionManager: SessionManager,
    onComplete?: (parentSessionId: string, handle: SubAgentHandle) => void,
    getContextStore?: () => ContextStore | undefined,
  ) {
    this.sessionManager = sessionManager;
    this.onComplete = onComplete;
    this.getContextStore = getContextStore;
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

    const sessionId = config.projectId && config.agentId
      ? `agent-${config.projectId}-${config.agentId}-${randomUUID()}`
      : config.projectId
        ? `project-${config.projectId}-${randomUUID()}`
        : `subagent:${randomUUID()}`;
    const session = this.sessionManager.create(sessionId, {
      label: 'Sub-agent conversation',
      provider: config.provider ?? providerConfig.model,
      model: config.model ?? providerConfig.model,
      parentSessionId: config.parentSessionId,
      depth: config.depth,
      sessionKind: 'subagent',
      projectId: config.projectId,
      agentId: config.agentId,
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
      workspaceRoot: workspace,
      ...(config.parentTier ? { inheritedTier: config.parentTier } : {}),
    };
    const sandboxedTools = createSandboxedRegistry(toolRegistry, subagentCtx);

    const systemPrompt = buildSystemPrompt({
      workspace,
      tools: sandboxedTools.list().map(t => t.name),
      extraContext: `You are a sub-agent spawned for a specific task. Complete it and provide a concise result.

IMPORTANT: Your iteration cap per runner pass is ${config.maxIterations ?? 100}.${config.maxIterations === undefined ? ` PULSE may expand it up to ${PULSE_EXPANDED_CAP}.` : ''} BLINK allows at most ${DEFAULT_BLINK_CONFIG.maxDepth} passes and ${DEFAULT_BLINK_CONFIG.maxTotalIterations} total iterations for this turn. If either limit is reached, preserve progress and report that the task is incomplete. Do not stop early solely because the current pass is approaching its limit. Continue within the allowed budget, validate the work, and report only genuine blockers.

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
    const maxIter = config.maxIterations ?? 100;
    const blinkCtrl = new BlinkController({ enabled: true, prepareAt: 3, cooldownMs: 1000 });
    const todoScope = `subagent-${randomUUID()}`;
    const policyEngine = new PolicyEngine();
    policyEngine.setSessionPolicy({
      sessionId: session.id,
      tools: {},
      maxIterations: config.maxIterations ?? PULSE_EXPANDED_CAP,
    });

    try {
      while (blinkCtrl.shouldContinue()) {
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
          turnIterationBudget: blinkCtrl.getRemainingIterations(),
          sessionId: session.id,
          googleWorkspaceAccessToken: config.googleWorkspaceAccessToken,
          contextStore: this.getContextStore?.(),
          todoScope,
          policyEngine,
          abortSignal: runtime.abortController.signal,
          blinkController: blinkCtrl,
          onEvent: event => {
            if (event.type === 'thinking_delta') {
              this.recordActivity(handle, 'reasoning', 'Reasoning');
            } else if (event.type === 'text_delta') {
              this.recordActivity(handle, 'writing', 'Writing response');
            }
          },
          onToolStart: name => {
            handle.activity = `Executing ${name}`;
            handle.activeTool = name;
            handle.operations = [...(handle.operations ?? []), { name, status: 'running' as const, startedAt: Date.now() }].slice(-12);
            handle.activityLog = [...(handle.activityLog ?? []), {
              timestamp: Date.now(),
              kind: 'tool' as const,
              label: `Started ${name}`,
              toolName: name,
              status: 'running' as const,
            }].slice(-80);
          },
          onToolEnd: name => {
            const operations = [...(handle.operations ?? [])];
            for (let index = operations.length - 1; index >= 0; index--) {
              if (operations[index].name === name && operations[index].status === 'running') {
                operations[index] = { ...operations[index], status: 'done', completedAt: Date.now() };
                break;
              }
            }
            handle.operations = operations;
            delete handle.activeTool;
            const activityLog = [...(handle.activityLog ?? [])];
            for (let index = activityLog.length - 1; index >= 0; index--) {
              if (activityLog[index].kind === 'tool' && activityLog[index].toolName === name && activityLog[index].status === 'running') {
                activityLog[index] = { ...activityLog[index], label: `Completed ${name}`, status: 'done' };
                break;
              }
            }
            handle.activityLog = activityLog.slice(-80);
            this.recordActivity(handle, 'reasoning', 'Reasoning');
          },
        });

        session.messages = result.messages;
        if (result.text && !result.maxIterationsHit) {
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
          blinkCtrl.recordComplete(result.iterations, result.toolCalls.length);
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

        if (result.maxIterationsHit) {
          if (blinkCtrl.needsBlink(true, result.iterations)) {
            blinkCtrl.recordBlink(result.iterations, result.toolCalls.length);
            this.sessionManager.save(session);
            await new Promise(resolve => setTimeout(resolve, blinkCtrl.getCooldownMs()));
            continue;
          }
          handle.status = 'failed';
          handle.error = 'Sub-agent reached its iteration or continuation limit before completing the task';
          handle.completedAt = Date.now();
          this.sessionManager.save(session);
          this.onComplete?.(config.parentSessionId, handle);
          return;
        }

        handle.status = 'completed';
        handle.result = result.text;
        handle.completedAt = Date.now();
        handle.activityLog = [...(handle.activityLog ?? []), {
          timestamp: Date.now(),
          kind: 'writing' as const,
          label: 'Run completed',
        }].slice(-80);
        this.sessionManager.save(session);
        this.onComplete?.(config.parentSessionId, handle);
        return;
      }

      handle.status = 'failed';
      handle.error = 'Sub-agent reached its iteration or continuation limit before completing the task';
      handle.completedAt = Date.now();
      this.sessionManager.save(session);
      this.onComplete?.(config.parentSessionId, handle);
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

  private recordActivity(handle: SubAgentHandle, kind: 'reasoning' | 'writing', label: string): void {
    if (handle.activity === label) return;
    handle.activity = label;
    delete handle.activeTool;
    const activityLog = handle.activityLog ?? [];
    const latest = activityLog[activityLog.length - 1];
    if (latest?.kind !== kind || latest.label !== label) {
      activityLog.push({ timestamp: Date.now(), kind, label });
    }
    handle.activityLog = activityLog.slice(-80);
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
