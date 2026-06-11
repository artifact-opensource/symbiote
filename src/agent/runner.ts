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

/**
 * Compress tool results that the LLM has already consumed (produced a response after seeing them).
 * Keeps the last batch of tool results intact (the LLM hasn't responded to them yet).
 * Replaces large tool results with compact summaries to free context space.
 */
function compressConsumedToolResults(messages: Message[]): void {
  // Find the index of the last assistant message that has NO tool calls
  // (meaning it's a final response, not a tool-calling turn)
  // Everything before the last tool-calling assistant message is "consumed"
  
  let lastToolCallingAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      lastToolCallingAssistantIdx = i;
      break;
    }
  }
  
  if (lastToolCallingAssistantIdx <= 0) return;
  
  // Compress tool results that come BEFORE the last tool-calling assistant
  const COMPRESS_THRESHOLD = 500; // chars — don't bother compressing small results
  
  for (let i = 0; i < lastToolCallingAssistantIdx; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length <= COMPRESS_THRESHOLD) continue;
    
    // Find the tool name from the preceding assistant's tool_calls
    let toolName = 'tool';
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'assistant' && messages[j].tool_calls) {
        const tc = messages[j].tool_calls!.find((tc: any) => tc.id === msg.tool_call_id);
        if (tc) {
          toolName = tc.name;
          break;
        }
      }
    }
    
    // Generate compact summary based on tool type
    const summary = compressToolResult(toolName, content);
    messages[i] = { ...msg, content: summary };
  }
}

/**
 * Generate a compact summary of a tool result based on tool type.
 */
function compressToolResult(toolName: string, content: string): string {
  const bytes = content.length;
  const lines = content.split('\n').length;
  
  switch (toolName) {
    case 'read':
      return `[Read result: ${bytes} bytes, ${lines} lines — content consumed]`;
    case 'exec': {
      // Keep first and last few lines for exec
      const execLines = content.split('\n');
      if (execLines.length <= 10) return content;
      const head = execLines.slice(0, 3).join('\n');
      const tail = execLines.slice(-3).join('\n');
      return `[Exec result: ${lines} lines]\n${head}\n...[${lines - 6} lines omitted]...\n${tail}`;
    }
    case 'web_fetch':
      return `[Web fetch: ${bytes} bytes — content consumed]`;
    case 'memory_search':
      // Keep the search results structure but truncate individual results
      return content.length > 1000 ? content.slice(0, 1000) + `\n...[truncated from ${bytes} bytes]` : content;
    case 'comb_recall':
      // Keep COMB recall intact — it's operational memory
      return content;
    default:
      if (bytes > 2000) {
        return content.slice(0, 500) + `\n...[${toolName} result: ${bytes} bytes, ${lines} lines — compressed]`;
      }
      return content;
  }
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
  const maxCtx = config.maxContextTokens ?? 100_000;
  const allToolCalls: RunResult['toolCalls'] = [];
  const temperatureHistory: Array<{ iteration: number; category: TaskCategory; temperature: number }> = [];
  let recentToolNames: string[] = [];
  let currentMessages = [...messages];
  let iterations = 0;

  while (iterations < maxIter) {
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
    let textAccum = '';
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
      throw err;
    }

    const streamElapsed = Date.now() - streamStartTime;
    console.log(`[runner] Stream complete (${streamElapsed}ms): ${pendingToolCalls.length} tool calls, ${textAccum.length} chars text`);

    // Finalize tool call inputs
    for (const tc of pendingToolCalls) {
      const rawInput = toolInputBuffers.get(tc.id) ?? '{}';
      try { tc.input = JSON.parse(rawInput); } catch { tc.input = {}; }
    }

    // If no tool calls, we're done
    if (pendingToolCalls.length === 0) {
      console.log(`[runner] Agent complete after ${iterations} iterations, ${allToolCalls.length} total tool calls`);
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

    // LAYER 2: Compress consumed tool results from PREVIOUS iterations
    // After the LLM has seen a tool result and produced a response, 
    // the full result is no longer needed — compress to summary
    if (iterations > 1) {
      compressConsumedToolResults(currentMessages);
    }

    // Loop — send updated messages back to LLM
  }

  // Max iterations reached
  console.warn(`[runner] Max iterations (${maxIter}) reached after ${allToolCalls.length} tool calls`);
  return {
    text: '[Max iterations reached]',
    messages: currentMessages,
    toolCalls: allToolCalls,
    iterations,
    maxIterationsHit: true,
    aborted: false,
    temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined,
  };
}
