#!/usr/bin/env node
// Symbiote — CLI Entry Point
// AI agent framework · Artifact Virtual
import 'dotenv/config';

// Route CLI subcommands (init, start, stop, status, configure, install, logs, etc.)
// Falls through to REPL if no recognized subcommand.
import { routeCli } from './cli/cli.js';
const handled = await routeCli();
if (handled) process.exit(0);

import * as readline from 'node:readline';
import { loadConfig } from './config/config.js';
import { anthropicProvider } from './providers/anthropic.js';
import { openaiProvider } from './providers/openai.js';
import { openrouterProvider } from './providers/openrouter.js';
import { selectProviderRoute } from './providers/route.js';
import { githubCopilotProvider } from './providers/github-copilot.js';
import { geminiProvider } from './providers/gemini.js';
import { gladiusProvider } from './providers/gladius.js';
import { groqProvider } from './providers/groq.js';
import { nvidiaProvider } from './providers/nvidia.js';
import { ollamaProvider } from './providers/ollama.js';
import { xaiProvider } from './providers/xai.js';
import type { Provider, ProviderConfig } from './providers/types.js';
import { ToolRegistry } from './tools/registry.js';
import { readTool } from './tools/builtin/read.js';
import { writeTool } from './tools/builtin/write.js';
import { execTool } from './tools/builtin/exec.js';
import { editTool } from './tools/builtin/edit.js';
import { imageTool } from './tools/builtin/image.js';
import { processStartTool, processPollTool, processKillTool, processListTool } from './tools/builtin/process.js';
import { ttsTool } from './tools/builtin/tts.js';
import { webFetchTool } from './tools/builtin/web-fetch.js';
import { memorySearchTool } from './tools/builtin/memory.js';
import { ingestWorkspaceSessions, vdbSearchTool, vdbIngestTool, vdbStatsTool } from './tools/builtin/memory-vdb.js';
import { combRecallTool, combStageTool, setCombVdbHook } from './tools/builtin/comb.js';
import { todoTool } from './tools/shared-todo.js';
import { SessionManager } from './sessions/manager.js';
import { SubAgentManager } from './sessions/sub-agent.js';
import { buildSystemPrompt } from './agent/system-prompt.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, runAgent } from './agent/runner.js';
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS } from './providers/types.js';
import { ContextStore } from './agent/context-store.js';
import { getSharedVectorDB } from './memory/vdb.js';
import { importMemoGraphSnapshots, resolveMemoGraphStorageDir } from './memory/memograph.js';
import type { Message } from './providers/types.js';
import type { Session } from './sessions/types.js';
import {
  palette, gradient, multiGradient, banner, logo, tagline,
  sectionHeader, ok, warn, info, kvLine, divider, thickDivider,
  versionBanner, box, createActivityIndicator,
} from './cli/brand.js';
import { APP_VERSION } from './meta/version.js';
import { classifyTask, routeProvider } from './sarsi/loader.js';

// ─── Provider registry ───
const providers = new Map<string, Provider>([
  ['anthropic', anthropicProvider],
  ['openai', openaiProvider],
  ['openrouter', openrouterProvider],
  ['github-copilot', githubCopilotProvider],
  ['gemini', geminiProvider],
  ['gladius', gladiusProvider],
  ['groq', groqProvider],
  ['nvidia', nvidiaProvider],
  ['ollama', ollamaProvider],
  ['xai', xaiProvider],
]);

// ─── Main ───
async function main() {
  const args = process.argv.slice(2);
  const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];
  const sessionId = args.find(a => a.startsWith('--session='))?.split('=')[1] ?? 'default';
  const providerArg = args.find(a => a.startsWith('--provider='))?.split('=')[1];
  const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];
  const oneShot = args.find(a => !a.startsWith('--'));

  const config = loadConfig(configPath);
  process.env.MACH6_WORKSPACE ??= config.workspace;

  // Mutable provider/model for mid-session switching
  let currentProviderName = providerArg ?? config.defaultProvider;
  let currentProvider = providers.get(currentProviderName);
  if (!currentProvider) {
    console.error(`${palette.red}✗${palette.reset} Unknown provider: ${currentProviderName}. Available: ${[...providers.keys()].join(', ')}`);
    process.exit(1);
  }

  let currentModel = modelArg ?? config.defaultModel;

  const makeProviderConfig = (): ProviderConfig => {
    const providerCfg = config.providers[currentProviderName as keyof typeof config.providers] ?? {};
    return {
      model: currentModel,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeoutMs: config.timeouts?.llmRequestMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      ...providerCfg,
    };
  };

  // Setup tools
  const registry = new ToolRegistry();
  for (const tool of [readTool, writeTool, editTool, execTool, imageTool, processStartTool, processPollTool, processKillTool, processListTool, ttsTool, webFetchTool, memorySearchTool, combRecallTool, combStageTool, todoTool]) {
    registry.register(tool);
  }
  for (const tool of [vdbSearchTool, vdbIngestTool, vdbStatsTool]) registry.register(tool);
  const memoryBootstrap = ingestWorkspaceSessions();
  const memographBootstrap = importMemoGraphSnapshots(
    getSharedVectorDB(config.workspace),
    resolveMemoGraphStorageDir(config.workspace),
  );
  const workspaceVdb = getSharedVectorDB(config.workspace);
  setCombVdbHook(
    (text, source) => {
      workspaceVdb.index({ id: '', text, source, role: 'context', timestamp: Date.now(), sessionId });
    },
    (source, count) => workspaceVdb.recent(source, count),
  );
  if (memoryBootstrap.indexed > 0) {
    console.log(`[vdb] Loaded ${memoryBootstrap.indexed} session memories`);
  }
  if (memographBootstrap.indexed > 0 || memographBootstrap.failures > 0) {
    console.log(`[memograph] Loaded ${memographBootstrap.indexed} shards; ${memographBootstrap.failures} failures`);
  }

  // Setup session manager
  const sessionMgr = new SessionManager(config.sessionsDir);
  let session = sessionMgr.load(sessionId) ?? sessionMgr.create(sessionId, {
    provider: currentProviderName,
    model: currentModel,
  });

  // Sub-agent manager
  const subAgentMgr = new SubAgentManager(sessionMgr, (parentId, handle) => {
    console.log(`\n${palette.violet}  ◎ Sub-agent ${handle.sessionId} ${handle.status}:${palette.reset} ${(handle.result ?? handle.error ?? '').slice(0, 200)}\n`);
  });

  // System prompt
  const systemPrompt = buildSystemPrompt({
    workspace: config.workspace,
    tools: registry.list().map(t => t.name),
    channel: 'cli',
    chatType: 'direct',
  });
  const contextStore = new ContextStore(getSharedVectorDB(config.workspace), { sessionId });

  if (session.messages.length === 0 || session.messages[0].role !== 'system') {
    session.messages.unshift({ role: 'system', content: systemPrompt });
  }

  // ── Branded CLI Header ──────────────────────────────────────

  console.log(versionBanner(APP_VERSION));

  const providerDisplay = `${palette.cyan}${currentProvider!.name}${palette.reset}${palette.dim}/${palette.reset}${palette.white}${currentModel}${palette.reset}`;
   console.log(`  ${palette.violet}●${palette.reset} ${providerDisplay}`);
   console.log(`  ${palette.dim}${registry.list().length} tools${palette.reset}  ${palette.dim}·${palette.reset} ${palette.silver}session ${sessionId}${palette.reset}  ${palette.dim}· /help${palette.reset}`);
  console.log();
   console.log(divider(42));

  const runWithCallbacks = async (msgs: Message[], provConfig: ProviderConfig, abortSignal?: AbortSignal) => {
    const activity = createActivityIndicator();
    const latestUserMessage = [...msgs].reverse().find(message => message.role === 'user');
    const userText = typeof latestUserMessage?.content === 'string' ? latestUserMessage.content : '';
    const contextLength = msgs
      .filter(message => message.role !== 'system')
      .reduce((length, message) => length + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0);
    const taskType = contextLength > 50_000 ? 'long_context' : classifyTask(userText);
    const route = routeProvider(taskType);
    const routeChoice = selectProviderRoute(
      route ?? { provider: currentProviderName, model: currentModel },
      providers,
      config.providers as Record<string, { apiKey?: string } | undefined>,
      { name: currentProviderName, provider: currentProvider!, model: currentModel },
    );
    const routeConfig = routeChoice.routed
      ? {
          ...provConfig,
          ...(config.providers[routeChoice.name] ?? {}),
          model: routeChoice.model,
        }
      : provConfig;
    activity.start();
    try {
      const result = await runAgent(msgs, {
        provider: routeChoice.provider,
        providerConfig: { ...routeConfig, systemPrompt },
        toolRegistry: registry,
        sessionId,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        contextStore,
        abortSignal,
        onProgress() {},
        onEvent(ev) {
          if (ev.type === 'usage') {
            sessionMgr.trackUsage(session, ev.usage.inputTokens, ev.usage.outputTokens);
          }
        },
        onToolStart(name) {
          activity.stop();
          sessionMgr.trackToolCall(session, name);
           console.log(`  ${palette.violet}◈ ${name}${palette.reset}`);
          activity.start(`Running ${name}`);
        },
        onToolEnd(name, result) {
          activity.stop();
           const failed = result.includes('"is_error":true');
           const status = failed ? `${palette.red}failed${palette.reset}` : `${palette.green}done${palette.reset}`;
           console.log(`  ${palette.dim}${name}${palette.reset} ${status}`);
          activity.start();
        },
      });
      activity.stop();
      if (result.text) process.stdout.write(`${palette.green}>${palette.reset} ${result.text}`);
      return result;
    } catch (err) {
      activity.stop();
      throw err;
    }
  };

  // One-shot mode
  if (oneShot) {
    session.messages.push({ role: 'user', content: oneShot });
    const result = await runWithCallbacks(session.messages, makeProviderConfig());
    console.log('\n');
    session.messages = result.messages;
    if (result.text) session.messages.push({ role: 'assistant', content: result.text });
    sessionMgr.save(session);
    return;
  }

  // ── Interactive REPL ────────────────────────────────────────

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const handleCommand = async (trimmed: string): Promise<boolean> => {
    if (trimmed === '/quit' || trimmed === '/exit') { rl.close(); return true; }

    if (trimmed === '/help') {
      console.log();
      const helpTitle = gradient('COMMANDS', [138, 43, 226], [0, 229, 255]);
      console.log(`  ${palette.bold}${helpTitle}${palette.reset}`);
      console.log();
      const commands = [
        ['/tools',           'List available tools'],
        ['/history [N]',     'Show last N messages (default 10)'],
        ['/model <name>',    'Switch model mid-session'],
        ['/provider <name>', 'Switch provider mid-session'],
        ['/spawn <task>',    'Spawn a sub-agent'],
        ['/status',          'Session stats and usage'],
        ['/queue <text>',    'Queue a message during an active turn'],
        ['/steer <text>',    'Interrupt and continue with new guidance'],
        ['/interrupt',       'Stop the active turn and save progress'],
        ['/sessions',        'List all sessions'],
        ['/clear',           'Clear session history'],
        ['/quit',            'Exit Symbiote'],
      ];
      for (const [cmd, desc] of commands) {
        const paddedCmd = cmd.padEnd(20);
        console.log(`  ${palette.cyan}${paddedCmd}${palette.reset}${palette.silver}${desc}${palette.reset}`);
      }
      console.log();
      return true;
    }

    if (trimmed === '/tools') {
      console.log();
      const toolTitle = gradient('TOOLS', [255, 193, 37], [255, 160, 0]);
      console.log(`  ${palette.bold}${toolTitle}${palette.reset} ${palette.dim}(${registry.list().length})${palette.reset}`);
      console.log();
      for (const t of registry.list()) {
        console.log(`  ${palette.cyan}${t.name.padEnd(20)}${palette.reset}${palette.dim}${t.description}${palette.reset}`);
      }
      console.log();
      return true;
    }

    if (trimmed.startsWith('/history')) {
      const n = parseInt(trimmed.split(' ')[1] ?? '10', 10);
      const msgs = session.messages.filter(m => m.role !== 'system').slice(-n);
      console.log();
      for (const m of msgs) {
        const text = typeof m.content === 'string' ? m.content.slice(0, 200) : '[structured]';
        const roleColors: Record<string, string> = {
          'user': palette.cyan,
          'assistant': palette.violet,
          'tool': palette.gold,
        };
        const color = roleColors[m.role] ?? palette.dim;
        console.log(`  ${color}[${m.role}]${palette.reset} ${palette.white}${text}${palette.reset}`);
      }
      console.log();
      return true;
    }

    if (trimmed.startsWith('/model ')) {
      currentModel = trimmed.slice(7).trim();
      session.metadata.model = currentModel;
      console.log(ok(`Model → ${palette.cyan}${currentModel}${palette.reset}`));
      console.log();
      return true;
    }

    if (trimmed.startsWith('/provider ')) {
      const name = trimmed.slice(10).trim();
      const p = providers.get(name);
      if (!p) {
        console.log(warn(`Unknown provider. Available: ${[...providers.keys()].join(', ')}`));
      } else {
        currentProviderName = name;
        currentProvider = p;
        session.metadata.provider = name;
        console.log(ok(`Provider → ${palette.cyan}${name}${palette.reset}`));
      }
      console.log();
      return true;
    }

    if (trimmed.startsWith('/spawn ')) {
      const task = trimmed.slice(7).trim();
      if (!task) { console.log(warn('Usage: /spawn <task>')); return true; }
      const handle = await subAgentMgr.spawn(
        { parentSessionId: sessionId, task, depth: session.metadata.depth + 1 },
        currentProvider!,
        makeProviderConfig(),
        registry,
        config.workspace,
      );
      console.log(ok(`Sub-agent spawned: ${palette.violet}${handle.sessionId}${palette.reset}`));
      console.log();
      return true;
    }

    if (trimmed === '/status') {
      const m = session.metadata;
      console.log();
      const statusTitle = gradient('SESSION STATUS', [138, 43, 226], [0, 229, 255]);
      console.log(`  ${palette.bold}${statusTitle}${palette.reset}`);
      console.log();
      console.log(kvLine('Session', `${palette.violet}${session.id}${palette.reset}${m.label ? ` (${m.label})` : ''}`));
      console.log(kvLine('Provider', `${palette.cyan}${m.provider ?? currentProviderName}${palette.reset}${palette.dim}/${palette.reset}${palette.white}${m.model ?? currentModel}${palette.reset}`));
      console.log(kvLine('Messages', `${palette.white}${m.messageCount}${palette.reset}`));
      console.log(kvLine('Tokens', `${palette.green}${m.tokenUsage.input}${palette.reset} in ${palette.dim}/${palette.reset} ${palette.gold}${m.tokenUsage.output}${palette.reset} out`));
      console.log(kvLine('Tools used', Object.entries(m.toolsUsed).map(([k, v]) => `${palette.cyan}${k}${palette.reset}(${v})`).join(', ') || `${palette.dim}none${palette.reset}`));
      console.log(kvLine('Sub-agents', `${subAgentMgr.listRunning().length} running`));
      console.log(kvLine('Created', new Date(session.createdAt).toLocaleString()));
      console.log();
      return true;
    }

    if (trimmed === '/sessions') {
      const sessions = sessionMgr.list();
      console.log();
      const sessTitle = gradient('SESSIONS', [255, 193, 37], [255, 160, 0]);
      console.log(`  ${palette.bold}${sessTitle}${palette.reset} ${palette.dim}(${sessions.length})${palette.reset}`);
      console.log();
      for (const s of sessions) {
        const label = s.label ? ` ${palette.dim}(${s.label})${palette.reset}` : '';
        const active = s.id === sessionId ? ` ${palette.green}●${palette.reset}` : '';
        console.log(`  ${palette.violet}${s.id}${palette.reset}${label}${active} ${palette.dim}— ${s.messageCount} msgs, ${new Date(s.updatedAt).toLocaleString()}${palette.reset}`);
      }
      console.log();
      return true;
    }

    if (trimmed === '/clear') {
      session = sessionMgr.create(sessionId, { provider: currentProviderName, model: currentModel });
      session.messages.unshift({ role: 'system', content: systemPrompt });
      console.log(ok('Session cleared'));
      console.log();
      return true;
    }

    return false;
  };

  // ── The Prompt ──────────────────────────────────────

  const queuedMessages: string[] = [];
  const steeringMessages: string[] = [];
  let activeAbortController: AbortController | null = null;
  let isBusy = false;
  let isClosed = false;

  const prompt = () => {
    if (isClosed) return;
    const prefix = isBusy ? `${palette.dim}running${palette.reset} ` : '';
    rl.setPrompt(`${prefix}${palette.violet}❯${palette.reset} `);
    rl.prompt();
  };

  const processTurn = async (firstMessage: string): Promise<void> => {
    if (isBusy || isClosed) return;
    isBusy = true;
    let nextMessage: string | undefined = firstMessage;
    prompt();

    while (nextMessage && !isClosed) {
      session.messages.push({ role: 'user', content: nextMessage });
      const controller = new AbortController();
      activeAbortController = controller;

      try {
        process.stdout.write('\n');
        const result = await runWithCallbacks(session.messages, makeProviderConfig(), controller.signal);
        session.messages = result.messages;
        if (result.text) session.messages.push({ role: 'assistant', content: result.text });
        sessionMgr.save(session);

        if (result.aborted) {
          const steering = steeringMessages.shift();
          if (steering) {
            console.log(`\n${palette.violet}↳ Steering applied${palette.reset}`);
            nextMessage = steering;
          } else {
            console.log(`\n${palette.dim}Turn interrupted; partial state saved.${palette.reset}`);
            nextMessage = queuedMessages.shift();
          }
        } else {
          nextMessage = queuedMessages.shift();
        }
      } catch (err) {
        console.error(`\n${palette.red}✗ Error:${palette.reset} ${err instanceof Error ? err.message : err}\n`);
        nextMessage = queuedMessages.shift();
      } finally {
        activeAbortController = null;
      }
    }

    isBusy = false;
    prompt();
  };

  rl.setPrompt(`${palette.violet}❯${palette.reset} `);
  rl.on('line', async input => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    if (isBusy) {
      if (trimmed === '/interrupt') {
        activeAbortController?.abort('user_interrupt');
        console.log(`\n${palette.yellow}Interrupt requested${palette.reset}`);
      } else if (trimmed === '/quit' || trimmed === '/exit') {
        isClosed = true;
        activeAbortController?.abort('user_exit');
        rl.close();
        return;
      } else if (trimmed.startsWith('/steer ')) {
        const steering = trimmed.slice(7).trim();
        if (steering) {
          steeringMessages.push(steering);
          activeAbortController?.abort('user_steer');
          console.log(`\n${palette.violet}Steering queued; current turn will stop at its next cancellation point.${palette.reset}`);
        }
      } else {
        const queued = trimmed.startsWith('/queue ') ? trimmed.slice(7).trim() : trimmed;
        if (queued) {
          queuedMessages.push(queued);
          console.log(`\n${palette.dim}Queued (${queuedMessages.length})${palette.reset}`);
        }
      }
      prompt();
      return;
    }

    if (trimmed === '/interrupt') {
      console.log(`${palette.dim}No active turn to interrupt.${palette.reset}`);
      prompt();
      return;
    }

    if (trimmed.startsWith('/')) {
      const handled = await handleCommand(trimmed);
      if (trimmed === '/quit' || trimmed === '/exit') {
        isClosed = true;
        rl.close();
        return;
      }
      if (handled) {
        prompt();
        return;
      }
    }

    void processTurn(trimmed);
  });

  prompt();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
