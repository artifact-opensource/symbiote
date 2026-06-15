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
  aborted: boolean;
  temperatureHistory?: Array<{ iteration: number; category: TaskCategory; temperature: number }>;
}

function compressConsumedToolResults(messages: Message[]): void {
  let lastToolCallingAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      lastToolCallingAssistantIdx = i;
      break;
    }
  }
  
  if (lastToolCallingAssistantIdx <= 0) return;
  const COMPRESS_THRESHOLD = 500;
  
  for (let i = 0; i < lastToolCallingAssistantIdx; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length <= COMPRESS_THRESHOLD) continue;
    
    let toolName = 'tool';
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'assistant' && messages[j].tool_calls) {
        const tc = messages[j].tool_calls?.find((tc: any) => tc.id === msg.tool_call_id);
        if (tc) {
          toolName = tc.name;
          break;
        }
      }
    }
    
    messages[i] = { ...msg, content: compressToolResult(toolName, content) };
  }
}

function compressToolResult(toolName: string, content: string): string {
  const bytes = content.length;
  const lines = content.split('\n').length;
  
  switch (toolName) {
    case 'read':
    case 'web_fetch':
      return `[${toolName === 'read' ? 'Read' : 'Web fetch'} result: ${bytes} bytes, ${lines} lines — consumed]`;
    case 'exec': {
      const execLines = content.split('\n');
      if (execLines.length <= 10) return content;
      return `[Exec result: ${lines} lines]\n${execLines.slice(0, 3).join('\n')}\n...[${lines - 6} lines omitted]...\n${execLines.slice(-3).join('\n')}`;
    }
    case 'memory_search':
      return content.length > 1000 ? content.slice(0, 1000) + `\n...[truncated from ${bytes} bytes]` : content;
    case 'comb_recall':
      return content;
    default:
      return bytes > 2000 ? content.slice(0, 500) + `\n...[${toolName} result: ${bytes} bytes — compressed]` : content;
  }
}

export async function runAgent(messages: Message[], config: RunnerConfig): Promise<RunResult> {
  const initialMaxIter = config.maxIterations ?? 25;
  const PULSE_EXPAND_THRESHOLD = 18;
  const PULSE_EXPANDED_CAP = 100;
  const MAX_CONCURRENT_JOBS = 5; // Concurrency throttle limit
  const MAX_RESULT_SIZE = 50 * 1024; // 50KB limit
  
  let maxIter = initialMaxIter;
  const maxCtx = config.maxContextTokens ?? 100_000;
  const allToolCalls: RunResult['toolCalls'] = [];
  const temperatureHistory: NonNullable<RunResult['temperatureHistory']> = [];
  let recentToolNames: string[] = [];
  
  // Isolate and retain base reference pointer
  let currentMessages = [...messages];
  let iterations = 0;

  while (iterations < maxIter) {
    iterations++;

    // ── PULSE Budget Adjustment ──────────────────────────────────────────
    if (iterations >= PULSE_EXPAND_THRESHOLD && maxIter === initialMaxIter && initialMaxIter < PULSE_EXPANDED_CAP) {
      const oldCap = maxIter;
      maxIter = PULSE_EXPANDED_CAP;
      config.blinkController?.notifyCapExpanded(oldCap, maxIter);
    }

    if (config.abortSignal?.aborted) {
      return { text: '', messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: true, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
    }

    // Context Evaluation Gate
    if (config.contextMonitor) {
      const managed = await config.contextMonitor.manage(currentMessages);
      currentMessages = [...managed];
    }

    // ── BLINK Hooks ──────────────────────────────────────────────────────
    if (config.blinkController) {
      const remaining = maxIter - iterations;
      if (config.blinkController.shouldPrepare(remaining)) {
        currentMessages.push({ role: 'user', content: config.blinkController.getPrepareMessage() });
      } else if (config.blinkController.shouldCheckpoint(iterations)) {
        currentMessages.push({ role: 'user', content: config.blinkController.getCheckpointMessage(iterations) });
      }
    }

    // Policy and Iteration Guard Rules
    if (config.policyEngine && config.sessionId) {
      const iterCheck = config.policyEngine.checkIteration(config.sessionId, iterations);
      if (iterCheck.warning) {
        currentMessages.push({
          role: 'user',
          content: `⚠️ SYSTEM WARNING: ${iterCheck.warning}. Wrap up NOW — provide your best result immediately.`,
        });
      }
      if (!iterCheck.ok) {
        return { text: `[${iterCheck.warning}]`, messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: true, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
      }
    }

    const truncated = truncateContext(currentMessages, maxCtx);

    // ATM Engine Calculation
    let effectiveProviderConfig = config.providerConfig;
    if (config.temperatureConfig?.enabled) {
      const category = classifyTask(truncated, recentToolNames);
      const temp = getTemperature(category, config.temperatureConfig);
      temperatureHistory.push({ iteration: iterations, category, temperature: temp });
      effectiveProviderConfig = { ...config.providerConfig, temperature: temp };
    }

    // Stream Setup Execution
    const tools = config.toolRegistry.toProviderFormat();
    let stream;
    try {
      stream = config.provider.stream(truncated, tools, effectiveProviderConfig);
    } catch (err) {
      if (config.abortSignal?.aborted) {
        return { text: '', messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: true, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
      }
      throw err;
    }

    // Streaming Event Consumption Block
    let textAccum = '';
    const pendingToolCalls: ToolCall[] = [];
    const toolInputBuffers = new Map<string, string>();

    try {
      for await (const event of stream) {
        if (config.abortSignal?.aborted) throw new Error('AbortSignal triggered');
        config.onEvent?.(event);

        switch (event.type) {
          case 'text_delta':
            textAccum += event.text;
            break;
          case 'tool_use_start':
            toolInputBuffers.set(event.id, '');
            pendingToolCalls.push({ id: event.id, name: event.name, input: {}, extra: event.extra });
            break;
          case 'tool_use_delta':
            const buf = toolInputBuffers.get(event.id);
            if (buf !== undefined) toolInputBuffers.set(event.id, buf + event.input);
            break;
        }
      }
    } catch (err) {
      if (config.abortSignal?.aborted) {
        return { text: textAccum, messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: true, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
      }
      throw err;
    }

    if (pendingToolCalls.length === 0) {
      return { text: textAccum, messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
    }

    // Clean Parameter Payload Assembly Fast Extraction Pass
    for (let idx = 0; idx < pendingToolCalls.length; idx++) {
      const tc = pendingToolCalls[idx];
      const rawInput = toolInputBuffers.get(tc.id);
      if (rawInput) {
        try {
          tc.input = JSON.parse(rawInput);
        } catch {
          // Fault Recovery: Force close malformed parameter blocks securely
          tc.input = rawInput.endsWith('}') ? {} : JSON.parse(rawInput + '}');
        }
      }
    }

    currentMessages.push({ role: 'assistant', content: textAccum, tool_calls: pendingToolCalls });

    // ── Concurrency Throttled Execution Execution Pool ─────────────────
    const toolResults: Array<{ name: string; input: any; result: string; id: string; isError: boolean }> = [];
    
    // Process tool executions in micro-chunks to preserve pool resources
    for (let i = 0; i < pendingToolCalls.length; i += MAX_CONCURRENT_JOBS) {
      const chunk = pendingToolCalls.slice(i, i + MAX_CONCURRENT_JOBS);
      
      const chunkOutputs = await Promise.all(
        chunk.map(async (tc) => {
          config.onToolStart?.(tc.name, tc.input);
          try {
            let result = await config.toolRegistry.execute(tc.name, tc.input);
            if (result.length > MAX_RESULT_SIZE) {
              result = result.slice(0, MAX_RESULT_SIZE) + `\n\n[Truncated: execution output limit breached]`;
            }
            const sanitized = sanitizeToolResult(tc.name, result);
            if (sanitized.injectionDetected) logInjectionAttempt(tc.name, sanitized.patterns, result);
            
            config.onToolEnd?.(tc.name, sanitized.text);
            return { name: tc.name, input: tc.input, result: sanitized.text, id: tc.id, isError: false };
          } catch (err) {
            const errMsg = JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true });
            config.onToolEnd?.(tc.name, errMsg);
            return { name: tc.name, input: tc.input, result: errMsg, id: tc.id, isError: true };
          }
        })
      );
      toolResults.push(...chunkOutputs);
    }

    // Commit results to loop memory arrays
    for (let idx = 0; idx < toolResults.length; idx++) {
      const res = toolResults[idx];
      allToolCalls.push({ name: res.name, input: res.input, result: res.result });
      currentMessages.push({
        role: 'tool',
        tool_call_id: res.id,
        content: res.result,
        ...(res.isError ? { name: '__error' } : {})
      });
    }

    recentToolNames = pendingToolCalls.map(tc => tc.name);

    if (config.abortSignal?.aborted) {
      return { text: '', messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: false, aborted: true, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
    }

    // Run Layer 2 sweeps over old indexes
    if (iterations > 1) {
      compressConsumedToolResults(currentMessages);
    }
  }

  return { text: '[Max iterations reached]', messages: currentMessages, toolCalls: allToolCalls, iterations, maxIterationsHit: true, aborted: false, temperatureHistory: temperatureHistory.length > 0 ? temperatureHistory : undefined };
}