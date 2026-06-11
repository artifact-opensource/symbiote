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
import { githubCopilotProvider } from './providers/github-copilot.js';
import { gladiusProvider } from './providers/gladius.js';
import { groqProvider } from './providers/groq.js';
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
import { combRecallTool, combStageTool } from './tools/builtin/comb.js';
import { SessionManager } from './sessions/manager.js';
import { SubAgentManager } from './sessions/sub-agent.js';
import { buildSystemPrompt } from './agent/system-prompt.js';
import { runAgent } from './agent/runner.js';
import type { Message } from './providers/types.js';
import type { Session } from './sessions/types.js';
import {
  palette, gradient, multiGradient, banner, logo, tagline,
  sectionHeader, ok, warn, info, kvLine, divider, thickDivider,
  versionBanner, box,
} from './cli/brand.js';

// ─── Provider registry ───
const providers = new Map<string, Provider>([
  ['anthropic', anthropicProvider],
  ['openai', openaiProvider],
  ['github-copilot', githubCopilotProvider],
  ['gladius', gladiusProvider],
  ['groq', groqProvider],
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
      ...providerCfg,
    };
  };

  // Setup tools
  const registry = new ToolRegistry();
  for (const tool of [readTool, writeTool, editTool, execTool, imageTool, processStartTool, processPollTool, processKillTool, processListTool, ttsTool, webFetchTool, memorySearchTool, combRecallTool, combStageTool]) {
    registry.register(tool);
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
  });

  if (session.messages.length === 0 || session.messages[0].role !== 'system') {
    session.messages.unshift({ role: 'system', content: systemPrompt });
  }

  // ── Branded CLI Header ──────────────────────────────────────

  console.log(versionBanner('1.0.0'));

  const providerDisplay = `${palette.cyan}${currentProvider!.name}${palette.reset}${palette.dim}/${palette.reset}${palette.white}${currentModel}${palette.reset}`;
  const toolCount = `${palette.gold}${registry.list().length}${palette.reset}`;
  const sessionDisplay = `${palette.violet}${sessionId}${palette.reset}`;

  console.log(kvLine('Provider', providerDisplay));
  console.log(kvLine('Tools', `${toolCount} ${palette.dim}registered${palette.reset}`));
  console.log(kvLine('Session', sessionDisplay));
  console.log();
  console.log(`  ${palette.dim}Type ${palette.reset}${palette.cyan}/help${palette.reset}${palette.dim} for commands${palette.reset}`);
  console.log();
  console.log(divider());
  console.log();

  const runWithCallbacks = async (msgs: Message[], provConfig: ProviderConfig) => {
    return runAgent(msgs, {
      provider: currentProvider!,
      providerConfig: { ...provConfig, systemPrompt },
      toolRegistry: registry,
      sessionId,
      onEvent(ev) {
        if (ev.type === 'text_delta') process.stdout.write(ev.text);
        if (ev.type === 'usage') {
          sessionMgr.trackUsage(session, ev.usage.inputTokens, ev.usage.outputTokens);
        }
      },
      onToolStart(name) {
        sessionMgr.trackToolCall(session, name);
        console.log(`\n${palette.violet}  ⚡ ${name}${palette.reset}`);
      },
      onToolEnd(name, result) {
        const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
        console.log(`${palette.green}  ✓ ${name}${palette.reset} ${palette.dim}${preview.split('\n')[0]}${palette.reset}`);
      },
    });
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

  const promptStr = `${palette.violet}❯${palette.reset} `;

  const prompt = () => {
    rl.question(promptStr, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }

      if (trimmed.startsWith('/')) {
        const handled = await handleCommand(trimmed);
        if (trimmed === '/quit' || trimmed === '/exit') return;
        if (handled) { prompt(); return; }
      }

      session.messages.push({ role: 'user', content: trimmed });

      try {
        const result = await runWithCallbacks(session.messages, makeProviderConfig());
        console.log('\n');
        session.messages = result.messages;
        if (result.text) session.messages.push({ role: 'assistant', content: result.text });
        sessionMgr.save(session);
      } catch (err) {
        console.error(`\n${palette.red}  ✗ Error:${palette.reset} ${err instanceof Error ? err.message : err}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
