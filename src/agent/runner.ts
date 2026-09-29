// Symbiote — Core Agent Runner
// The heart: prompt → LLM → tool calls → loop → response

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Message, ToolCall, StreamEvent, Provider, ProviderConfig, ToolDef } from '../providers/types.js';
import { truncateContext } from './context.js';
import { ContextMonitor } from './context-monitor.js';
import type { PolicyEngine } from '../tools/policy.js';
import { sanitizeToolResult, logInjectionAttempt } from '../security/sanitizer.js';
import { classifyTask, getTemperature } from './temperature.js';
import type { TemperatureConfig, TaskCategory } from './temperature.js';
import type { BlinkController } from './blink.js';

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
  blinkController?: BlinkController;
  onEvent?: (event: StreamEvent) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string) => void;
}

export interface RunResult {
  text: string;
  messages: Message[];
  toolCalls: { name: string; input: Record<string, unknown>; result: string }[];
  iterations: number;
  maxIterationsHit: boolean;
  aborted: boolean;  // True if agent was interrupted externally (SIGTERM, new message, etc.)
  temperatureHistory?: Array<{ iteration: number; category: TaskCategory; temperature: number }>;
}

function getTodoPath(): string {
  const candidates = [
    join(process.cwd(), '.sessions', 'todos.json'),
    join(process.cwd(), '.sessions', 'workspace', 'todos', 'todos.json'),
    join(process.cwd(), 'workspace', 'todos', 'todos.json'),
    join(process.cwd(), 'todos.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (candidate && readFileSync(candidate, 'utf8')) {
        return candidate;
      }
    } catch {
      // Keep trying the next candidate.
    }
  }

  return candidates[0];
}

function updateTodoState(iterations: number): void {
  try {
    const todoPath = getTodoPath();
    mkdirSync(dirname(todoPath), { recursive: true });

    let todoData: { active?: Array<Record<string, unknown>>; completed?: Array<Record<string, unknown>> } = { active: [], completed: [] };
    try {
      const raw = readFileSync(todoPath, 'utf8');
      todoData = raw.trim() ? JSON.parse(raw) : { active: [], completed: [] };
    } catch {
      // initialize an empty state when the file is missing or malformed
    }

    if (!Array.isArray(todoData.active)) todoData.active = [];
    if (!Array.isArray(todoData.completed)) todoData.completed = [];

    const active = todoData.active as Array<Record<string, unknown>>;
    if (active.length === 0) {
      active.push({
        id: 't' + Date.now(),
        task: 'Agent loop iteration',
        status: 'in_progress',
        created: new Date().toISOString(),
        loop_iteration: iterations,
      });
    } else {
      active[0] = {
        ...active[0],
        status: 'in_progress',
        updated: new Date().toISOString(),
        loop_iteration: iterations,
      };
    }

    writeFileSync(todoPath, JSON.stringify({ ...todoData, active }, null, 2));
  } catch {
    // Best effort only; do not fail the agent loop on stale or missing todo state.
  }
}

function maybeProceedWithBlinkContinuation(
  messages: Message[],
  iterations: number,
  toolCalls: RunResult['toolCalls'],
  blinkController?: BlinkController,
): Message[] {
  if (!blinkController) return messages;
  if (!blinkController.needsBlink(true)) return messages;

  blinkController.recordBlink(iterations, toolCalls.length);

  const nextMessages = [...messages];
  const last = nextMessages[nextMessages.length - 1];
  if (last && last.role === 'assistant' && last.content === '[Max iterations reached]') {
    nextMessages.pop();
  }

  nextMessages.push({ role: 'user', content: blinkController.getResumeMessage() });
  return nextMessages;
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
  const initialMaxIter = config.maxIterations ?? 999999;
  const PULSE_EXPAND_THRESHOLD = 18;
  const PULSE_EXPANDED_CAP = 100;
  let maxIter = initialMaxIter;
  const maxCtx = config.maxContextTokens ?? 100_000;
  const allToolCalls: RunResult['toolCalls'] = [];
  const temperatureHistory: Array<{ iteration: number; category: TaskCategory; temperature: number }> = [];
  let recentToolNames: string[] = [];
  let currentMessages = [...messages];
  let iterations = 0;
  let textAccum = '';

  while (iterations < maxIter) {

    // SMART TODO + AUTO-CONTINUE + RETRY ROUTING
    const isComplex = (currentMessages.length > 3) || (allToolCalls.length > 0); // multi-iter likely
    const todoActive = isComplex; // only use todo for complex / multi-iter tasks
    const retryCount = allToolCalls.filter(r => r.result && r.result.includes('error')).length;
    // Auto-continue if todo incomplete: loop doesn't break early; completes via final textAccum
    if (todoActive && iterations > 1) {
      console.log(`[SMART] Complex task — todo active, auto-continue enabled, retries=${retryCount}`);
      updateTodoState(iterations);
    } else if (!todoActive && iterations === 1) {
      console.log(`[SMART] Simple task — direct route, no todo overhead`);
    }

    iterations++;

    // Persistent loop: best-effort curator notification without failing the turn.
    try {
      await import('../curator/index.js').then(({ reviewAsync }) => {
        reviewAsync({
          id: `i-${iterations}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          taskType: 'agent',
          provider: 'symbiote',
          model: '4.0',
          tokensUsed: 0,
          latencyMs: 0,
          toolSuccess: true,
          userSatisfied: true,
          toolCallCount: allToolCalls.length,
          delivered: true,
          channel: 'discord',
          routingWasOptimal: true,
        });
      }).catch(() => undefined);
    } catch {
      // Best effort only; a missing curator implementation must never stop an agent run.
    }

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
        const budgetMessages = maybeProceedWithBlinkContinuation(currentMessages, iterations, allToolCalls, config.blinkController);
        return {
          text: `[${iterCheck.warning}]`,
          messages: budgetMessages,
          toolCalls: allToolCalls,
          iterations,
          maxIterationsHit: true,
          aborted: false,
          temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
        };
      }
    }

    // Truncate context if needed
    const truncated = truncateContext(currentMessages, maxCtx);

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
    console.log(`[runner] Iteration ${iterations}/${maxIter}: ${truncated.length} messages, calling LLM...`);
    const streamStartTime = Date.now();

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
            pendingToolCalls.push({ id: event.id, name: event.name, input: {}, extra: event.extra });
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

            // Update the pending tool call with parsed input
            const tc = pendingToolCalls.find(t => t.id === event.id);
            if (tc) {
              tc.input = parsedInput;
            }
            break;
          }

          case 'done':
            break;
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
      throw err;
    }

    const streamElapsed = Date.now() - streamStartTime;
    console.log(`[runner] Stream complete (${streamElapsed}ms): ${pendingToolCalls.length} tool calls, ${textAccum.length} chars text`);

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) {
      console.log(`[runner] Agent complete after ${iterations} iterations, ${allToolCalls.length} total tool calls`);
      return { text: textAccum, messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
    }

    // Safety: if we've accumulated too many tool calls without progress, break
    if (allToolCalls.length > 50) {
      console.warn(`[runner] Too many tool calls (${allToolCalls.length}), breaking to prevent infinite loop`);
      const budgetMessages = maybeProceedWithBlinkContinuation(currentMessages, iterations, allToolCalls, config.blinkController);
      return { text: textAccum + '\n\n[Stopped: too many tool calls]', messages: budgetMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: true, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
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
    const toolResults = await Promise.allSettled(
      pendingToolCalls.map(async (tc) => {
        config.onToolStart?.(tc.name, tc.input);
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
          config.onToolEnd?.(tc.name, result);
          return { tc, result, isError: false };
        } catch (err) {
          const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
          config.onToolEnd?.(tc.name, errMsg);
          return { tc, result: errMsg, isError: true };
        }
      }),
    );

    for (const settled of toolResults) {
      const { tc, result, isError } = settled.status === 'fulfilled'
        ? settled.value
        : { tc: pendingToolCalls[0], result: JSON.stringify({ error: 'Tool execution failed', is_error: true }), isError: true };

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
  const budgetMessages = maybeProceedWithBlinkContinuation(currentMessages, iterations, allToolCalls, config.blinkController);
  return {
    text: textAccum.trim() || '[Max iterations reached]',
    messages: budgetMessages,
    toolCalls: allToolCalls,
    iterations,
    maxIterationsHit: true,
    aborted: false,
    temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
  };
}
