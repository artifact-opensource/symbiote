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
import { randomUUID } from 'node:crypto';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

/** Minimal interface for tool registries (satisfied by both ToolRegistry and SandboxedToolRegistry) */
export interface ToolExecutor {
  toProviderFormat(): ToolDef[];
  execute(name: string, input: Record<string, unknown>): Promise<string>;
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
  blinkController?: BlinkController;
  onProgress?: (event: RunnerProgressEvent) => void;
  onEvent?: (event: StreamEvent) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
}

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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(limit)));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await map(items[index], index);
    }
  }));

  return results;
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
  const todoManager = new TodoManager({ scope: config.todoScope ?? `run-${randomUUID()}`, workspace: process.cwd() });

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
      return {
        text: '',
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

    let stream;
    try {
      stream = config.provider.stream(truncated, tools, effectiveProviderConfig);
    } catch (err) {
      // If stream creation fails (e.g., abort during setup), return partial
      if (config.abortSignal?.aborted) {
        console.log(`[runner] Aborted during stream setup at iteration ${iterations}. Returning partial result.`);
        return {
          text: '',
          messages: currentMessages,
          toolCalls: allToolCalls,
          iterations,
          maxIterationsHit: false,
          aborted: true,
          temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
        };
      }
      markTodoBlocked(err instanceof Error ? err.message : String(err));
      throw err;
    }

    // Collect response
    const pendingToolCalls: ToolCall[] = [];
    const toolInputBuffers = new Map<string, string>(); // id → accumulated JSON string
    let currentToolId = '';

    try {
      for await (const event of stream) {
        config.onEvent?.(event);

        switch (event.type) {
          case 'text_delta':
            textAccum += event.text;
            break;

          case 'tool_use_start':
            currentToolId = event.id;
            toolInputBuffers.set(event.id, '');
            break;

          case 'tool_use_delta':
            // Accumulate tool input JSON fragments
            const existing = toolInputBuffers.get(event.id) ?? '';
            toolInputBuffers.set(event.id, existing + event.input);
            break;

          case 'tool_use_end': {
            const rawInput = toolInputBuffers.get(event.id) ?? '{}';
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(rawInput); } catch { /* empty */ }

            // Find the tool name from the start event
            const startEvent = pendingToolCalls.find(tc => tc.id === event.id);
            if (!startEvent) {
              // This end corresponds to a start we haven't pushed yet — shouldn't happen
              // but handle gracefully
            }
            break;
          }

          case 'done':
            break;
        }

        // On tool_use_start, record the pending call
        if (event.type === 'tool_use_start') {
          pendingToolCalls.push({ id: event.id, name: event.name, input: {}, extra: event.extra });
        }
      }
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
      markTodoBlocked(err instanceof Error ? err.message : String(err));
      throw err;
    }

    const streamElapsed = Date.now() - streamStartTime;
    if (config.onProgress) config.onProgress({ type: 'response', elapsedMs: streamElapsed });
    else console.log(`[runner] Response ready (${streamElapsed}ms)`);

    // Finalize tool call inputs
    for (const tc of pendingToolCalls) {
      const rawInput = toolInputBuffers.get(tc.id) ?? '{}';
      try { tc.input = JSON.parse(rawInput); } catch { tc.input = {}; }
    }

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) {
      if (!completionReviewPending) {
        const candidate = textAccum.trim();
        if (candidate) currentMessages.push({ role: 'assistant', content: candidate });
        currentMessages.push({
          role: 'user',
          content: 'Internal completion review: compare the original request with the work completed so far. If any requested work remains, continue it now using tools. If it is complete, provide the final user-facing response. If genuinely blocked, state the blocker and what remains. Do not mention this review.',
        });
        textAccum = '';
        completionReviewPending = true;
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

    // Execute tool calls concurrently and append results
    const MAX_RESULT_SIZE = 50 * 1024; // 50KB
    const toolResults = await mapWithConcurrency(pendingToolCalls, 5, async (tc) => {
      try {
        try { config.onToolStart?.(tc.name, tc.input); } catch { /* progress reporting is non-critical */ }
        try {
          let result = await config.toolRegistry.execute(tc.name, tc.input);
          if (result.length > MAX_RESULT_SIZE) {
            result = result.slice(0, MAX_RESULT_SIZE) + `\n\n[Truncated: result was ${result.length} bytes, limit is ${MAX_RESULT_SIZE}]`;
          }
          // Sanitize tool result before it enters the LLM context
          const sanitized = sanitizeToolResult(tc.name, result);
          if (sanitized.injectionDetected) {
            logInjectionAttempt(tc.name, sanitized.patterns, result);
          }
          result = sanitized.text;
          try { config.onToolEnd?.(tc.name, result); } catch { /* progress reporting is non-critical */ }
          return { tc, result, isError: false };
        } catch (err) {
          const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
          try { config.onToolEnd?.(tc.name, errMsg); } catch { /* progress reporting is non-critical */ }
          return { tc, result: errMsg, isError: true };
        }
      } catch (err) {
        const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
        return { tc, result: errMsg, isError: true };
      }
    });

    for (const { tc, result, isError } of toolResults) {
      allToolCalls.push({ name: tc.name, input: tc.input, result });

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

    // Check abort after tool execution before next LLM call
    if (config.abortSignal?.aborted) {
      const reason = config.abortSignal.reason ?? 'aborted';
      console.log(`[runner] Aborted after tool execution at iteration ${iterations}: ${reason}. Returning partial result.`);
      return {
        text: '',
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
