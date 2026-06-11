// Symbiote Dual-LLM Orchestrator
// Cloud planner + local specialist execution with DAG parallelism
// Ported from Sirius B (Victus) — adapted for AVA's Mach6 provider ecosystem

import type { Message, ToolDef, StreamEvent, Provider, ProviderConfig, ToolCall } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';

export interface DAGNode {
  id: string;
  task: string;
  model: string; // Any model key from localModels config (generalized from Sirius B's fixed set)
  tools?: string[]; // List of tool names this node can use
  dependencies: string[];
  context?: Record<string, unknown>;
  expectedOutput?: string;
}

export interface DAG {
  nodes: DAGNode[];
  metadata?: {
    estimatedTokens: number;
    complexity: 'low' | 'medium' | 'high';
  };
}

/** Token usage tracking per node and aggregate */
export interface NodeUsage {
  nodeId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolIterations: number;
  durationMs: number;
}

export interface DAGUsageReport {
  totalInputTokens: number;
  totalOutputTokens: number;
  planningTokens: { input: number; output: number };
  synthesisTokens: { input: number; output: number };
  nodeUsage: NodeUsage[];
  totalDurationMs: number;
  nodesExecuted: number;
  nodesFailed: number;
}

export interface OrchestratorConfig {
  enabled: boolean;
  cloudProvider: string; // Name of the cloud provider (openrouter, github-copilot, gemini, etc.)
  cloudModel: string; // e.g., 'stepfun/step-3.5-flash:free' or 'claude-opus-4.6'
  localModels: Record<string, string>; // Generalized: any key → model name (e.g., 'llama3.3' → 'llama3.3:70b')
  maxParallel: number;
  taskTimeoutMs: number;
  decompositionPrompt?: string;
  synthesisPrompt?: string;
}

export class DualLLMOrchestrator implements Provider {
  readonly name = 'orchestrator';
  private cloudProvider: Provider;
  private localProviders: Map<string, Provider>;
  private config: OrchestratorConfig;
  private semaphore: AsyncSemaphore;
  private toolRegistry: ToolRegistry;
  private lastUsageReport: DAGUsageReport | null = null;

  constructor(
    cloudProvider: Provider,
    localProviders: Map<string, Provider>,
    config: OrchestratorConfig,
    toolRegistry: ToolRegistry,
  ) {
    this.cloudProvider = cloudProvider;
    this.localProviders = localProviders;
    this.config = config;
    this.semaphore = new AsyncSemaphore(config.maxParallel);
    this.toolRegistry = toolRegistry;

    if (!config.enabled) {
      throw new Error('DualLLMOrchestrator created with enabled=false');
    }
  }

  /** Get the usage report from the last DAG execution */
  getLastUsageReport(): DAGUsageReport | null {
    return this.lastUsageReport;
  }

  async *stream(
    messages: Message[],
    tools: ToolDef[],
    providerConfig: ProviderConfig
  ): AsyncIterable<StreamEvent> {
    const lastUserMsg = this.extractLastUserContent(messages);
    
    // Heuristic: only decompose complex tasks
    if (!this.shouldDecompose(lastUserMsg)) {
      yield* this.cloudProvider.stream(messages, tools, providerConfig);
      return;
    }

    const dagStartTime = Date.now();
    const usageReport: DAGUsageReport = {
      totalInputTokens: 0, totalOutputTokens: 0,
      planningTokens: { input: 0, output: 0 },
      synthesisTokens: { input: 0, output: 0 },
      nodeUsage: [], totalDurationMs: 0,
      nodesExecuted: 0, nodesFailed: 0,
    };

    // Step 1: Plan — ask cloud to create DAG (internal, no streaming to user)
    const { dag, usage: planUsage } = await this.planWithCloud(messages, tools, providerConfig);
    usageReport.planningTokens = planUsage;
    usageReport.totalInputTokens += planUsage.input;
    usageReport.totalOutputTokens += planUsage.output;
    
    if (dag.nodes.length === 0) {
      yield* this.cloudProvider.stream(messages, tools, providerConfig);
      return;
    }

    // Step 2: Execute DAG in parallel (internal) — with context sharing
    const { results, nodeUsages } = await this.executeDAG(dag, messages, tools, providerConfig);
    usageReport.nodeUsage = nodeUsages;
    usageReport.nodesExecuted = results.size;
    usageReport.nodesFailed = Array.from(results.values()).filter(r => r.startsWith('[ERROR:')).length;
    for (const nu of nodeUsages) {
      usageReport.totalInputTokens += nu.inputTokens;
      usageReport.totalOutputTokens += nu.outputTokens;
    }

    // Step 3: Synthesize final response (stream to user)
    const synthUsage = { input: 0, output: 0 };
    for await (const event of this.synthesizeWithCloud(messages, results, dag, tools, providerConfig)) {
      if (event.type === 'usage') {
        synthUsage.input += event.usage.inputTokens;
        synthUsage.output += event.usage.outputTokens;
      }
      yield event;
    }
    usageReport.synthesisTokens = synthUsage;
    usageReport.totalInputTokens += synthUsage.input;
    usageReport.totalOutputTokens += synthUsage.output;
    usageReport.totalDurationMs = Date.now() - dagStartTime;

    this.lastUsageReport = usageReport;

    // Log usage summary
    console.log(`[Orchestrator] DAG complete: ${usageReport.nodesExecuted} nodes, ` +
      `${usageReport.nodesFailed} failed, ${usageReport.totalInputTokens + usageReport.totalOutputTokens} total tokens, ` +
      `${usageReport.totalDurationMs}ms`);
    
    // Emit orchestrator usage as a final usage event
    yield {
      type: 'usage',
      usage: {
        inputTokens: usageReport.totalInputTokens,
        outputTokens: usageReport.totalOutputTokens,
      },
    };
  }

  private extractLastUserContent(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          const textPart = content.find(c => c.type === 'text');
          return textPart?.text ?? '';
        }
      }
    }
    return '';
  }

  private shouldDecompose(content: string): boolean {
    const lower = content.toLowerCase();
    const words = content.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    // Never decompose very short messages
    if (wordCount < 15) return false;

    // Complexity signals — each adds a score
    let score = 0;

    // Multi-step action verbs (strong signals)
    const actionTriggers = [
      'build', 'create', 'generate', 'implement', 'develop',
      'debug', 'fix', 'refactor', 'test', 'deploy',
      'train', 'optimize', 'evaluate', 'migrate', 'integrate'
    ];
    const actionCount = actionTriggers.filter(t => lower.includes(t)).length;
    score += actionCount * 2;

    // Multi-part indicators
    const multiPartTriggers = [
      'multiple', 'several', 'various', 'and then', 'followed by',
      'step 1', 'step 2', 'first,', 'second,', 'third,', 'finally,',
      'also', 'additionally', 'plus', 'as well as'
    ];
    score += multiPartTriggers.filter(t => lower.includes(t)).length * 2;

    // Structural complexity
    const structureTriggers = [
      'project', 'module', 'package', 'architecture', 'system',
      'pipeline', 'workflow', 'framework', 'stack', 'infrastructure'
    ];
    score += structureTriggers.filter(t => lower.includes(t)).length;

    // Length-based complexity (long messages are more likely complex)
    if (wordCount > 100) score += 3;
    else if (wordCount > 50) score += 1;

    // Sentence count (multiple sentences suggest multi-part request)
    const sentenceCount = content.split(/[.!?]+/).filter(s => s.trim().length > 10).length;
    if (sentenceCount >= 4) score += 2;
    else if (sentenceCount >= 2) score += 1;

    // Code/technical indicators
    if (content.includes('```') || content.includes('function ') || content.includes('class ')) score += 1;

    // Threshold: score >= 4 triggers decomposition
    // This means: short simple "create a file" (score ~2) won't trigger
    // but "build a REST API with authentication, database, and tests" (score ~8) will
    return score >= 4;
  }

  private async planWithCloud(
    messages: Message[],
    tools: ToolDef[],
    providerConfig: ProviderConfig
  ): Promise<{ dag: DAG; usage: { input: number; output: number } }> {
    const planningPrompt = this.config.decompositionPrompt ?? this.defaultDecompositionPrompt();
    
    const lastUserMsg = this.extractLastUserContent(messages);
    const planningMessages: Message[] = [
      {
        role: 'system',
        content: planningPrompt,
      },
      {
        role: 'user',
        content: lastUserMsg,
      },
    ];

    let fullResponse = '';
    const usage = { input: 0, output: 0 };
    try {
      for await (const event of this.cloudProvider.stream(planningMessages, tools, providerConfig)) {
        if (event.type === 'text_delta') {
          fullResponse += event.text;
        } else if (event.type === 'usage') {
          usage.input += event.usage.inputTokens;
          usage.output += event.usage.outputTokens;
        } else if (event.type === 'done') {
          break;
        }
      }
    } catch (err) {
      console.error('[Orchestrator] Planning failed:', err);
      const fallbackModel = this.getDefaultLocalModel();
      return {
        dag: {
          nodes: [{
            id: 'main',
            task: this.extractLastUserContent(messages),
            model: fallbackModel,
            dependencies: [],
          }],
        },
        usage,
      };
    }

    try {
      return { dag: this.parseDAGFromResponse(fullResponse), usage };
    } catch (err) {
      console.error('[Orchestrator] Failed to parse DAG:', err);
      const fallbackModel = this.getDefaultLocalModel();
      return {
        dag: {
          nodes: [{
            id: 'main',
            task: this.extractLastUserContent(messages),
            model: fallbackModel,
            dependencies: [],
          }],
        },
        usage,
      };
    }
  }

  /** Get the first available local model key as default fallback */
  private getDefaultLocalModel(): string {
    const keys = Object.keys(this.config.localModels);
    return keys[0] ?? 'default';
  }

  private defaultDecompositionPrompt(): string {
    const modelKeys = Object.keys(this.config.localModels);
    const modelList = modelKeys.map(k => `   - ${k}`).join('\n');
    
    return `You are a task decomposition engine. Analyze the user's request and break it into a DAG of sub-tasks.

Rules:
1. Each sub-task must be atomic and executable by a single LLM with specific tools.
2. Assign each task to the most appropriate local model from:
${modelList}
3. Specify dependencies between tasks. Dependent tasks receive the full output of their parent tasks automatically — use this for data flow between steps.
4. Keep tasks self-contained with all necessary context.

Output format: EXACTLY this JSON structure (no markdown, no extra text):
{
  "nodes": [
    {
      "id": "unique_task_id",
      "task": "Clear description of what to do, including what to produce for downstream tasks",
      "model": "${modelKeys[0] ?? 'default'}",
      "tools": ["tool1", "tool2"],
      "dependencies": ["id_of_parent_task"]
    }
  ]
}

Important:
- If the request is simple and can be done in one step, output {"nodes": []} and the system will route directly to you.
- Do not include any explanatory text outside the JSON.
- Ensure all task IDs are unique within this DAG.
- Data flows through dependencies: if task B depends on task A, B will receive A's full output as context. Use this for file creation → file consumption, research → synthesis, etc.
- Independent tasks (no dependency overlap) will run in parallel automatically.
`;
  }

  private parseDAGFromResponse(response: string): DAG {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!Array.isArray(parsed.nodes)) {
      throw new Error('Invalid DAG: missing nodes array');
    }

    const allowedModels = Object.keys(this.config.localModels);
    for (const node of parsed.nodes) {
      if (!node.id || !node.task || !node.model) {
        throw new Error(`Invalid node: missing required fields (id, task, model)`);
      }
      if (!allowedModels.includes(node.model)) {
        // Graceful: remap unknown model to first available
        console.warn(`[Orchestrator] Unknown model '${node.model}', remapping to '${allowedModels[0]}'`);
        node.model = allowedModels[0];
      }
      if (!Array.isArray(node.dependencies)) {
        node.dependencies = [];
      }
    }

    return parsed;
  }

  private async executeDAG(
    dag: DAG,
    originalMessages: Message[],
    tools: ToolDef[],
    providerConfig: ProviderConfig
  ): Promise<{ results: Map<string, string>; nodeUsages: NodeUsage[] }> {
    const nodeMap = new Map(dag.nodes.map(n => [n.id, n]));
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const node of dag.nodes) {
      inDegree.set(node.id, node.dependencies.length);
      for (const dep of node.dependencies) {
        if (!children.has(dep)) children.set(dep, []);
        children.get(dep)!.push(node.id);
      }
    }

    const ready: string[] = [];
    for (const [nodeId, deg] of inDegree.entries()) {
      if (deg === 0) ready.push(nodeId);
    }

    const results = new Map<string, string>();
    const nodeUsages: NodeUsage[] = [];
    const executing = new Set<string>();

    while (ready.length > 0 || executing.size > 0) {
      while (ready.length > 0 && executing.size < this.config.maxParallel) {
        const nodeId = ready.shift()!;
        const node = nodeMap.get(nodeId)!;
        
        // Context sharing: collect outputs from all dependency (parent) nodes
        const parentContext: Record<string, string> = {};
        for (const depId of node.dependencies) {
          if (results.has(depId)) {
            parentContext[depId] = results.get(depId)!;
          }
        }
        
        const taskPromise = this.executeNode(node, originalMessages, tools, providerConfig, parentContext)
          .then(({ result, usage }) => {
            results.set(nodeId, result);
            nodeUsages.push(usage);
            executing.delete(nodeId);
            for (const child of children.get(nodeId) || []) {
              const newDeg = inDegree.get(child)! - 1;
              inDegree.set(child, newDeg);
              if (newDeg === 0) ready.push(child);
            }
          })
          .catch(err => {
            console.error(`[Orchestrator] Task ${nodeId} failed:`, err);
            results.set(nodeId, `[ERROR: ${err instanceof Error ? err.message : String(err)}]`);
            nodeUsages.push({
              nodeId, model: node.model,
              inputTokens: 0, outputTokens: 0,
              toolIterations: 0, durationMs: 0,
            });
            executing.delete(nodeId);
            for (const child of children.get(nodeId) || []) {
              const newDeg = inDegree.get(child)! - 1;
              inDegree.set(child, newDeg);
              if (newDeg === 0) ready.push(child);
            }
          });
        
        executing.add(nodeId);
      }

      if (executing.size > 0) {
        await this.waitForAnyNodeCompletion(results, executing);
      }
    }

    return { results, nodeUsages };
  }

  private async waitForAnyNodeCompletion(
    results: Map<string, string>,
    executing: Set<string>
  ): Promise<void> {
    const startSize = results.size;
    while (results.size === startSize && executing.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async executeNode(
    node: DAGNode,
    originalMessages: Message[],
    tools: ToolDef[],
    providerConfig: ProviderConfig,
    parentContext: Record<string, string> = {},
  ): Promise<{ result: string; usage: NodeUsage }> {
    const provider = this.localProviders.get(node.model);
    if (!provider) {
      throw new Error(`No local provider configured for model: ${node.model}`);
    }

    // Build context section including parent node outputs
    let contextSection = '';
    if (node.context && Object.keys(node.context).length > 0) {
      contextSection += `\nNode context: ${JSON.stringify(node.context, null, 2)}`;
    }
    if (Object.keys(parentContext).length > 0) {
      contextSection += '\n\nResults from prerequisite tasks:';
      for (const [depId, depOutput] of Object.entries(parentContext)) {
        // Truncate very long outputs to prevent context window overflow
        const truncated = depOutput.length > 4000
          ? depOutput.slice(0, 4000) + '\n[...truncated]'
          : depOutput;
        contextSection += `\n\n--- Task "${depId}" output ---\n${truncated}`;
      }
    }

    const taskMessages: Message[] = [
      {
        role: 'system',
        content: `You are a specialized agent performing a specific task as part of a larger workflow. Follow instructions precisely and use tools when needed. If prerequisite task results are provided, use them as input for your work.`,
      },
      {
        role: 'user',
        content: `Task: ${node.task}${contextSection}`,
      },
    ];

    const nodeStartTime = Date.now();
    const nodeUsage: NodeUsage = {
      nodeId: node.id, model: node.model,
      inputTokens: 0, outputTokens: 0,
      toolIterations: 0, durationMs: 0,
    };

    const release = await this.semaphore.acquire();
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Task ${node.id} timed out after ${this.config.taskTimeoutMs}ms`)), this.config.taskTimeoutMs);
      });

      let textAccum = '';
      const pendingToolCalls: ToolCall[] = [];
      const toolInputBuffers = new Map<string, string>();
      let iterations = 0;
      const maxIterations = 10;

      const resultPromise = (async () => {
        while (iterations < maxIterations) {
          iterations++;

          for await (const event of provider.stream(taskMessages, tools, providerConfig)) {
            switch (event.type) {
              case 'text_delta':
                textAccum += event.text;
                break;
              case 'tool_use_start':
                toolInputBuffers.set(event.id, '');
                pendingToolCalls.push({ id: event.id, name: event.name, input: {}, extra: event.extra });
                break;
              case 'tool_use_delta':
                const existing = toolInputBuffers.get(event.id) ?? '';
                toolInputBuffers.set(event.id, existing + event.input);
                break;
              case 'tool_use_end': {
                const rawInput = toolInputBuffers.get(event.id) ?? '{}';
                const tc = pendingToolCalls.find(t => t.id === event.id);
                if (tc) {
                  try { tc.input = JSON.parse(rawInput); } catch { tc.input = {}; }
                }
                break;
              }
              case 'usage':
                nodeUsage.inputTokens += event.usage.inputTokens;
                nodeUsage.outputTokens += event.usage.outputTokens;
                break;
              case 'done':
                break;
            }
          }

          // If no tool calls and we have text, we're done
          if (pendingToolCalls.length === 0) {
            nodeUsage.toolIterations = iterations - 1;
            nodeUsage.durationMs = Date.now() - nodeStartTime;
            return textAccum;
          }

          // Execute tool calls via the real registry
          const toolResults = await Promise.allSettled(
            pendingToolCalls.map(async (tc) => {
              try {
                const result = await this.toolRegistry.execute(tc.name, tc.input);
                return { tc, result, isError: false };
              } catch (err) {
                return { tc, result: JSON.stringify({ error: err instanceof Error ? err.message : String(err), is_error: true }), isError: true };
              }
            })
          );

          // Append tool results to messages
          for (const settled of toolResults) {
            const { tc, result, isError } = settled.status === 'fulfilled'
              ? settled.value
              : { tc: pendingToolCalls[0], result: JSON.stringify({ error: 'Tool execution failed', is_error: true }), isError: true };

            taskMessages.push({
              role: 'assistant',
              content: '',
              tool_calls: [{ id: tc.id, name: tc.name, input: tc.input }],
            });

            taskMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof result === 'string' ? result : JSON.stringify(result),
              ...(isError ? { name: '__error' } : {}),
            });
          }

          // Reset for next iteration
          pendingToolCalls.length = 0;
          toolInputBuffers.clear();
          textAccum = '';
        }

        nodeUsage.toolIterations = maxIterations;
        nodeUsage.durationMs = Date.now() - nodeStartTime;
        throw new Error(`Task ${node.id} exceeded max iterations (${maxIterations})`);
      })();

      const result = await Promise.race([resultPromise, timeoutPromise]);
      return { result, usage: nodeUsage };
    } finally {
      release();
    }
  }

  private async *synthesizeWithCloud(
    originalMessages: Message[],
    results: Map<string, string>,
    dag: DAG,
    tools: ToolDef[],
    providerConfig: ProviderConfig
  ): AsyncIterable<StreamEvent> {
    const synthesisPrompt = this.config.synthesisPrompt ?? this.defaultSynthesisPrompt();
    
    const resultsText = Array.from(results.entries())
      .map(([id, output]) => `Task ${id}:\n${output.slice(0, 8000)}${output.length > 8000 ? '\n[...truncated]' : ''}`)
      .join('\n\n---\n\n');

    const lastUserMsg = this.extractLastUserContent(originalMessages);

    const synthesisMessages: Message[] = [
      {
        role: 'user',
        content: `Original request: ${lastUserMsg}\n\nHere are the results from the decomposed tasks:\n\n${resultsText}`,
      },
      {
        role: 'system',
        content: synthesisPrompt,
      },
    ];

    yield* this.cloudProvider.stream(synthesisMessages, tools, providerConfig);
  }

  private defaultSynthesisPrompt(): string {
    return `You are synthesizing results from multiple sub-tasks into a final coherent response.

Instructions:
1. Review the original user request and all sub-task results.
2. Integrate the results into a single, comprehensive answer.
3. Maintain consistency in tone and formatting.
4. If any sub-task failed or produced incomplete results, acknowledge limitations.
5. Do not repeat the task decomposition process; just provide the final answer.

Output the final response now.`;
  }
}

// Simple async semaphore implementation
class AsyncSemaphore {
  private current = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.current--;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.current++;
      next();
    }
  }
}
