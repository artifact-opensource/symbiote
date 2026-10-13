// Symbiote — Core Agent Runner
// The heart: prompt → LLM → tool calls → loop → response

import type { Message, ToolCall, StreamEvent, Provider, ProviderConfig, ToolDef } from '../providers/types.js';
import { truncateContext } from './context.js';
import { ContextMonitor } from './context-monitor.js';
import type { PolicyEngine } from '../tools/policy.js';
import { sanitizeToolResult, logInjectionAttempt } from '../security/sanitizer.js';
import { classifyTask, getTemperature } from './temperature.js';
import type { TemperatureConfig, TaskCategory } from './temperature.js';
import type { BlinkController } from './blink.js';
import type { ContextStore } from './context-store.js';
import { TodoManager } from './todo.js';
import type { ToolExecuteOptions } from '../tools/types.js';
import { randomUUID } from 'node:crypto';
import { getSarsiModel } from '../sarsi/index.js';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

/** Minimal interface for tool registries (satisfied by both ToolRegistry and SandboxedToolRegistry) */
export interface ToolExecutor {
  toProviderFormat(): ToolDef[];
  execute(name: string, input: Record<string, unknown>, options?: ToolExecuteOptions): Promise<string>;
  list(): Array<{ name: string; description: string; parameters: any }>;
}

export interface RunnerConfig {
  provider: Provider;
  providerConfig: ProviderConfig;
  toolRegistry: ToolExecutor;
  maxIterations?: number;
  maxContextTokens?: number;
  sessionId?: string;
  contextMonitor?: ContextMonitor;
  policyEngine?: PolicyEngine;
  temperatureConfig?: TemperatureConfig;
  abortSignal?: AbortSignal;
  contextStore?: ContextStore;
  todoScope?: string;
  /** Stable identity for one user turn, shared across BLINK continuations. */
  turnId?: string;
  blinkController?: BlinkController;
  onProgress?: (event: RunnerProgressEvent) => void;
  onEvent?: (event: StreamEvent) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
  /** Called after each iteration's tool results so callers can persist work even if a later LLM call throws. */
  onCheckpoint?: (messages: Message[]) => void;
}

const MAX_STREAM_RETRIES = 3;
const MAX_EMPTY_NUDGES = 2;
const MAX_RESULT_SIZE = 50 * 1024;
const REPEAT_CALL_THRESHOLD = 3;
const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// A hung tool or silent stream must never stall the loop forever.
const toolTimeoutMs = (toolName: string): number => {
  const configured = Number(process.env.SYMBIOTE_TOOL_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const rule = getSarsiModel().toolRules.find(item =>
    item.preferredTool === toolName || item.fallbackTool === toolName,
  );
  return rule && Number.isFinite(rule.timeoutMs) && rule.timeoutMs > 0
    ? rule.timeoutMs
    : 15 * 60_000;
};
const streamIdleMs = (): number => envMs('SYMBIOTE_STREAM_IDLE_MS', 3 * 60_000);

function isTransientStreamError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''}`;
  return /terminated|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR|fetch failed|socket|premature|TimeoutError|network|stream idle/i.test(text);
}

/** Reject if `promise` takes longer than `ms` or `signal` aborts. */
function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`))), ms);
    const onAbort = () => finish(() => reject(new Error(`${label} aborted`)));
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(v => finish(() => resolve(v)), e => finish(() => reject(e)));
  });
}

function executeToolWithTimeout(
  execute: (signal: AbortSignal) => Promise<string>,
  ms: number,
  parentSignal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => {
      controller.abort(parentSignal?.reason);
      finish(() => reject(new Error(`${label} aborted`)));
    };
    const timer = setTimeout(() => {
      controller.abort(`${label} timed out`);
      finish(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)));
    }, ms);

    if (parentSignal?.aborted) {
      onAbort();
      return;
    }
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    execute(controller.signal).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Wrap a stream so that a provider that goes silent fails fast and gets retried. */
async function* withIdleTimeout<T>(source: AsyncIterable<T>, ms: number, signal?: AbortSignal): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await withTimeout(it.next(), ms, signal, 'stream idle:');
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => { /* already closed */ });
  }
}

/** Keep the head and tail of oversized output; errors and summaries usually sit at the end. */
function clipResult(result: string): string {
  if (result.length <= MAX_RESULT_SIZE) return result;
  const head = Math.floor(MAX_RESULT_SIZE * 0.65);
  const tail = MAX_RESULT_SIZE - head;
  return `${result.slice(0, head)}\n\n[... ${result.length - MAX_RESULT_SIZE} bytes omitted ...]\n\n${result.slice(-tail)}`;
}

const looksFailed = (result: string): boolean => /^Error\b|"is_error":\s*true|"error":|Exit code: [1-9]/.test(result);

export type RunnerProgressEvent =
  | { type: 'iteration'; iteration: number; maxIterations: number; messageCount: number }
  | { type: 'response'; elapsedMs: number };

export interface RunResult {
  text: string;
  messages: Message[];
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
  iterations: number;
  maxIterationsHit: boolean;
  aborted: boolean;  // True if agent was interrupted externally (SIGTERM, new message, etc.)
  temperatureHistory?: Array<{ iteration: number; category: TaskCategory; temperature: number }>;
}

/**
 * Run the agent loop: send messages to LLM, process tool calls, repeat until done.
 * 
 * Handles three termination modes:
 * 1. Normal completion — LLM responds without tool calls
 * 2. Budget exhaustion — maxIterations hit → BLINK handles continuation
 * 3. Abort — external signal (SIGTERM, interrupt) → returns partial result with aborted=true
 *    so the daemon can save session state before shutdown
 */
export async function runAgent(
  messages: Message[],
  config: RunnerConfig,
): Promise<RunResult> {
  const initialMaxIter = config.maxIterations ?? 25;
  const PULSE_EXPAND_THRESHOLD = 18;
  const PULSE_EXPANDED_CAP = 100;
  let maxIter = initialMaxIter;
  const maxCtx = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const allToolCalls: RunResult['toolCalls'] = [];
  const temperatureHistory: Array<{ iteration: number; category: TaskCategory; temperature: number }> = [];
  let recentToolNames: string[] = [];
  let currentMessages = [...messages];
  let iterations = 0;
  let textAccum = '';
  let completionReviewPending = false;
  let completionReviewUsed = false;
  let emptyNudges = 0;
  const callCounts = new Map<string, number>();
  const todoScope = config.todoScope ?? `run-${randomUUID()}`;
  const completionReviewId = config.turnId ?? randomUUID();
  const todoManager = new TodoManager({ scope: todoScope, workspace: process.cwd() });

  const ensureTodoPlan = () => {
    const userSummary = [...currentMessages].reverse().find(msg => msg.role === 'user');
    const promptText = typeof userSummary?.content === 'string'
      ? userSummary.content
      : Array.isArray(userSummary?.content)
        ? userSummary.content.map(block => typeof block === 'string' ? block : (block.text ?? '')).join(' ')
        : '';
    const title = promptText.replace(/\s+/g, ' ').trim().slice(0, 180);

    const existing = todoManager.list();
    const openItems = existing.filter(item => item.status !== 'completed' && item.status !== 'blocked');
    if (openItems.length === 0 && title) {
      const item = todoManager.addTask(title, 'Work through the request until the result is validated.');
      return item;
    }

    const active = existing.find(item => item.status === 'in_progress') ?? existing.find(item => item.status === 'pending');
    if (active) {
      todoManager.updateTask(active.id, { status: 'in_progress' });
      return active;
    }

    return existing[0];
  };

  const markTodoBlocked = (reason: string) => {
    const active = todoManager.list().find(item => item.status === 'in_progress' || item.status === 'pending');
    if (active) {
      todoManager.updateTask(active.id, { status: 'blocked', description: `Blocked: ${reason.slice(0, 300)}` });
    }
  };

  while (iterations < maxIter) {
    const todoItems = todoManager.list();
    if (todoItems.length > 0) {
      const active = todoItems.find(item => item.status === 'in_progress') ?? todoItems.find(item => item.status === 'pending');
      if (active) {
        todoManager.updateTask(active.id, { status: 'in_progress' });
      }
    } else {
      ensureTodoPlan();
    }
    iterations++;

    // PULSE dynamic expansion: if approaching cap, expand to full budget
    if (iterations >= PULSE_EXPAND_THRESHOLD && maxIter === initialMaxIter && initialMaxIter < PULSE_EXPANDED_CAP) {
      const oldCap = maxIter;
      maxIter = PULSE_EXPANDED_CAP;
      console.log(`[PULSE] Expanding iteration cap ${initialMaxIter} → ${PULSE_EXPANDED_CAP} at iteration ${iterations}`);

      // Notify BLINK that the wall moved — re-arm prepare for the new cap
      if (config.blinkController) {
        config.blinkController.notifyCapExpanded(oldCap, maxIter);
      }
    }

    // Check if aborted (interrupt from bus or SIGTERM)
    // Return partial result instead of throwing — lets daemon save session state
    if (config.abortSignal?.aborted) {
      const reason = config.abortSignal.reason ?? 'aborted';
      console.log(`[runner] Aborted at iteration ${iterations}: ${reason}. Returning partial result for state preservation.`);
      const lastUserMsg = [...currentMessages].reverse().find(m => m.role === 'user');
      return {
        text: lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '') : '',
        messages: currentMessages,
        toolCalls: allToolCalls,
        iterations,
        maxIterationsHit: false,
        aborted: true,
        temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
      };
    }

    // Check context monitor before each iteration (Pain #3)
    if (config.contextMonitor) {
      currentMessages = await config.contextMonitor.manage(currentMessages);
    }

    // BLINK: inject preparation message when approaching budget wall
    if (config.blinkController) {
      const remaining = maxIter - iterations;
      if (config.blinkController.shouldPrepare(remaining)) {
        const prepMsg = config.blinkController.getPrepareMessage();
        currentMessages.push({ role: 'user', content: prepMsg });
        console.log(`[BLINK] Prepare message injected at iteration ${iterations} (${remaining} remaining)`);
      }
      // BLINK checkpoint: periodic state save for long runs (external kill safety)
      else if (config.blinkController.shouldCheckpoint(iterations)) {
        const cpMsg = config.blinkController.getCheckpointMessage(iterations);
        currentMessages.push({ role: 'user', content: cpMsg });
        console.log(`[BLINK] Checkpoint injected at iteration ${iterations}/${maxIter}`);
      }
    }

    // Check iteration limit with warning (Pain #12)
    if (config.policyEngine && config.sessionId) {
      const iterCheck = config.policyEngine.checkIteration(config.sessionId, iterations);
      if (iterCheck.warning) {
        console.warn(`⚠️  ${iterCheck.warning}`);
        // Inject warning into context so the LLM can react and wrap up gracefully
        currentMessages.push({
          role: 'user',
          content: `⚠️ SYSTEM WARNING: ${iterCheck.warning}. Wrap up NOW — provide your best result immediately. Do not start new work.`,
        });
      }
      if (!iterCheck.ok) {
        return {
          text: `[${iterCheck.warning}]`,
          messages: currentMessages,
          toolCalls: allToolCalls,
          iterations,
          maxIterationsHit: true,
          aborted: false,
          temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
        };
      }
    }

    // Retrieve long-term memories into the request context without persisting them in the transcript.
    const requestMessages = [...currentMessages];
    const retrievedMemory = config.contextStore?.retrieve(currentMessages);
    if (retrievedMemory) requestMessages.push(retrievedMemory);

    // Truncate context if needed and preserve discarded conversation text in the VDB.
    const truncated = truncateContext(requestMessages, maxCtx);
    if (config.contextStore) {
      const retained = new Set(truncated);
      const dropped = requestMessages.filter(message => !retained.has(message));
      if (dropped.length > 0) config.contextStore.absorb(dropped);
    }

    // Adaptive Temperature Modulation (ATM): classify task and adjust temperature
    let effectiveProviderConfig = config.providerConfig;
    if (config.temperatureConfig?.enabled) {
      const category = classifyTask(truncated, recentToolNames);
      const temp = getTemperature(category, config.temperatureConfig);
      temperatureHistory.push({ iteration: iterations, category, temperature: temp });

      if (config.temperatureConfig.logChanges) {
        console.log(`[ATM] Iteration ${iterations}: ${category} → temp=${temp}`);
      }

      effectiveProviderConfig = { ...config.providerConfig, temperature: temp };
    }

    // Stream from LLM
    const tools = config.toolRegistry.toProviderFormat();
    if (config.onProgress) {
      config.onProgress({ type: 'iteration', iteration: iterations, maxIterations: maxIter, messageCount: truncated.length });
    } else {
      console.log(`[runner] Iteration ${iterations}/${maxIter}: ${truncated.length} messages`);
    }
    const streamStartTime = Date.now();
    effectiveProviderConfig = {
      ...effectiveProviderConfig,
      ...(config.abortSignal ? { signal: config.abortSignal } : {}),
    };

    // Collect response (transient mid-stream failures are retried so one dropped connection cannot kill a long run)
    const pendingToolCalls: ToolCall[] = [];
    const toolInputBuffers = new Map<string, string>(); // id → accumulated JSON string

    for (let attempt = 0; ; attempt++) {
    pendingToolCalls.length = 0;
    toolInputBuffers.clear();
    textAccum = '';
    try {
      const stream = config.provider.stream(truncated, tools, effectiveProviderConfig);
      for await (const event of withIdleTimeout(stream, streamIdleMs(), config.abortSignal)) {
        config.onEvent?.(event);

        switch (event.type) {
          case 'text_delta':
            textAccum += event.text;
            break;

          case 'tool_use_start':
            toolInputBuffers.set(event.id, '');
            break;

          case 'tool_use_delta': {
            // Accumulate tool input JSON fragments
            toolInputBuffers.set(event.id, (toolInputBuffers.get(event.id) ?? '') + event.input);
            break;
          }

          case 'tool_use_end':
          case 'done':
            break;
        }

        // On tool_use_start, record the pending call
        if (event.type === 'tool_use_start') {
          pendingToolCalls.push({ id: event.id, name: event.name, input: {}, extra: event.extra });
        }
      }
      break;
    } catch (err) {
      // Stream interrupted (abort, network error, etc.)
      if (config.abortSignal?.aborted) {
        console.log(`[runner] Stream aborted at iteration ${iterations}. Returning partial result.`);
        return {
          text: textAccum || '',
          messages: currentMessages,
          toolCalls: allToolCalls,
          iterations,
          maxIterationsHit: false,
          aborted: true,
          temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
        };
      }
      if (attempt < MAX_STREAM_RETRIES && isTransientStreamError(err)) {
        const waitMs = 1000 * 2 ** attempt;
        console.warn(`[runner] Stream failed at iteration ${iterations} (${err instanceof Error ? err.message : err}); retry ${attempt + 1}/${MAX_STREAM_RETRIES} in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      markTodoBlocked(err instanceof Error ? err.message : String(err));
      throw err;
    }
    }

    const streamElapsed = Date.now() - streamStartTime;
    if (config.onProgress) config.onProgress({ type: 'response', elapsedMs: streamElapsed });
    else console.log(`[runner] Response ready (${streamElapsed}ms)`);

    // Finalize tool call inputs; unparseable JSON (often a response cut off by the token limit) must not run as {}
    const invalidInputs = new Set<string>();
    for (const tc of pendingToolCalls) {
      const rawInput = (toolInputBuffers.get(tc.id) ?? '').trim();
      if (!rawInput) { tc.input = {}; continue; }
      try { tc.input = JSON.parse(rawInput); } catch { tc.input = {}; invalidInputs.add(tc.id); }
    }

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) {
      // Only worth a review when the turn actually did tool-backed work that
      // could be incomplete — skip it for plain conversational replies
      // (greetings, Q&A) and never run it more than once per turn.
      // Persist completionReviewUsed in contextStore to survive restarts
      let completionReviewUsedPersisted = completionReviewUsed;
      if (config.contextStore && config.sessionId) {
        const reviewKey = `completion-review-used:${completionReviewId}`;
        // Check whether this turn's review prompt was already persisted.
        try {
          // Query vdb for our review marker
          const results = config.contextStore['vdb']?.search(reviewKey, 1);
          if (results?.some(result => result.text === reviewKey)) {
            completionReviewUsedPersisted = true;
          }
        } catch (error) {
          console.error('[runner] Could not read persisted completion-review marker:', error);
        }
      }
      const needsReview = !completionReviewPending && !completionReviewUsedPersisted && allToolCalls.length > 0;
      if (needsReview) {
        const candidate = textAccum.trim();
        if (candidate) currentMessages.push({ role: 'assistant', content: candidate });
        currentMessages.push({
          role: 'user',
          content: 'Internal completion review: compare the original request with the work completed so far. If any requested work remains, continue it now using tools. If it is complete, provide the final user-facing response. If genuinely blocked, state the blocker and what remains. Do not mention this review.',
        });
        textAccum = '';
        completionReviewPending = true;
        completionReviewUsed = true;
        // Persist the review flag so it survives restarts
        if (config.contextStore && config.sessionId) {
          const reviewKey = `completion-review-used:${completionReviewId}`;
          const doc = {
            id: '',
            text: reviewKey,
            source: 'session-meta',
            role: 'system',
            timestamp: Date.now(),
            sessionId: config.sessionId,
          };
          try {
            config.contextStore['vdb']?.index(doc);
          } catch (error) {
            console.error('[runner] Could not persist completion-review marker:', error);
          }
        }
        try {
          config.onCheckpoint?.(currentMessages);
        } catch (error) {
          console.error('[runner] Completion-review checkpoint persistence failed:', error);
        }
        continue;
      }

      // An empty reply after tool work means the model stalled, not finished
      if (!textAccum.trim() && allToolCalls.length > 0 && emptyNudges < MAX_EMPTY_NUDGES) {
        emptyNudges++;
        console.warn(`[runner] Empty reply at iteration ${iterations} after ${allToolCalls.length} tool calls — nudging (${emptyNudges}/${MAX_EMPTY_NUDGES})`);
        currentMessages.push({ role: 'user', content: 'Your last reply was empty. If the task is finished, state the result briefly; otherwise continue with the next tool call.' });
        continue;
      }

      for (const task of todoManager.list()) {
        if (task.status === 'in_progress' || task.status === 'pending') {
          todoManager.updateTask(task.id, { status: 'completed' });
        }
      }
      return { text: textAccum, messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
    }

    // Append assistant message with tool calls
    const assistantMsg: Message = {
      role: 'assistant',
      content: textAccum || '',
      tool_calls: pendingToolCalls,
    };
    currentMessages.push(assistantMsg);
    textAccum = '';

    // Run calls in emission order so tools cannot race on shared state.
    const toolResults = [];
    for (const tc of pendingToolCalls) {
      try {
        if (invalidInputs.has(tc.id)) {
          const errMsg = JSON.stringify({ error: `Arguments for ${tc.name} were not valid JSON (the response was probably cut off). Retry with smaller or simpler arguments.`, is_error: true });
          try { config.onToolEnd?.(tc.name, errMsg); } catch { /* progress reporting is non-critical */ }
          toolResults.push({ tc, input: tc.input ?? {}, result: errMsg, isError: true });
          continue;
        }
        const toolInput = tc.name === 'todo' && !(typeof tc.input.scope === 'string' && tc.input.scope.trim())
          ? { ...tc.input, scope: todoScope }
          : tc.input;
        try { config.onToolStart?.(tc.name, toolInput); } catch { /* progress reporting is non-critical */ }
        try {
          const toolOptions: ToolExecuteOptions = {
            sessionId: config.sessionId,
          };
          let result = clipResult(await executeToolWithTimeout(
            (signal) => config.toolRegistry.execute(tc.name, toolInput, { ...toolOptions, signal }),
            toolTimeoutMs(tc.name),
            config.abortSignal,
            `Tool ${tc.name}`,
          ));
          // Sanitize tool result before it enters the LLM context
          const sanitized = sanitizeToolResult(tc.name, result);
          if (sanitized.injectionDetected) {
            logInjectionAttempt(tc.name, sanitized.patterns, result);
          }
          result = sanitized.text || '(no output)';
          const isError = looksFailed(result);
          try { config.onToolEnd?.(tc.name, result); } catch { /* progress reporting is non-critical */ }
          toolResults.push({ tc, input: toolInput, result, isError });
        } catch (err) {
          const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
          try { config.onToolEnd?.(tc.name, errMsg); } catch { /* progress reporting is non-critical */ }
          toolResults.push({ tc, input: toolInput, result: errMsg, isError: true });
        }
      } catch (err) {
        const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
        toolResults.push({ tc, input: tc.input ?? {}, result: errMsg, isError: true });
      }
    }

    for (const entry of toolResults) {
      const { tc, input, isError } = entry;
      let result = entry.result;
      // Break repeat-failure loops: the same call failing again will not succeed on its own
      const key = `${tc.name}:${JSON.stringify(input)}`;
      const seen = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, seen);
      if (seen >= REPEAT_CALL_THRESHOLD && (isError || looksFailed(result))) {
        result += `\n\n[runner: this exact ${tc.name} call has now failed ${seen} times. Change the approach or arguments instead of repeating it, or report the blocker.]`;
      }
      allToolCalls.push({ name: tc.name, input, result });

      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
        ...(isError ? { name: '__error' } : {}),
      });
    }

    // Track recent tool names for ATM classification in next iteration
    recentToolNames = pendingToolCalls.map(tc => tc.name);
    completionReviewPending = false;
    try {
      config.onCheckpoint?.(currentMessages);
    } catch (error) {
      console.error('[runner] Checkpoint persistence failed; continuing the active turn:', error);
    }

    // Check abort after tool execution before next LLM call
    if (config.abortSignal?.aborted) {
      const reason = config.abortSignal.reason ?? 'aborted';
      console.log(`[runner] Aborted after tool execution at iteration ${iterations}: ${reason}. Returning partial result.`);
      const lastUserMsg = [...currentMessages].reverse().find(m => m.role === 'user');
      return {
        text: lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '') : '',
        messages: currentMessages,
        toolCalls: allToolCalls,
        iterations,
        maxIterationsHit: false,
        aborted: true,
        temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
      };
    }

    // Loop — send updated messages back to LLM
  }

  // Max iterations reached
  console.warn(`[runner] Max iterations (${maxIter}) reached after ${allToolCalls.length} tool calls`);
  return {
    text: textAccum.trim() || '[Max iterations reached]',
    messages: currentMessages,
    toolCalls: allToolCalls,
    iterations,
    maxIterationsHit: true,
    aborted: false,
    temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
  };
}
