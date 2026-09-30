#!/usr/bin/env node
/**
 * Symbiote Agent Pipeline Smoke Test
 * Tests: config loading → provider auth → LLM call → tool execution → response
 * Does NOT touch any channels (Discord/WhatsApp).
 */

import { loadConfig } from '../config/config.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/builtin/read.js';
import { writeTool } from '../tools/builtin/write.js';
import { execTool } from '../tools/builtin/exec.js';
import { runAgent } from '../agent/runner.js';
import { githubCopilotProvider } from '../providers/github-copilot.js';
import type { ProviderConfig, Message } from '../providers/types.js';
import os from 'node:os';
import path from 'node:path';

const PASS = '✅';
const FAIL = '❌';
let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) { console.log(`  ${PASS} ${label}`); passed++; }
  else { console.log(`  ${FAIL} ${label}${detail ? ': ' + detail : ''}`); failed++; }
}

async function main() {
  console.log('\n⚡ Symbiote Agent Pipeline Smoke Test\n');

  // 1. Config
  console.log('── Config ──');
  const config = loadConfig('mach6.json');
  assert(!!config.defaultProvider, 'Config loads');
  assert(config.defaultProvider === 'github-copilot', `Provider: ${config.defaultProvider}`);
  assert(config.defaultModel === 'claude-sonnet-4', `Model: ${config.defaultModel}`);

  // 2. Tool Registry
  console.log('\n── Tools ──');
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(execTool);
  assert(registry.list().length === 3, `${registry.list().length} tools registered`);
  
  const providerTools = registry.toProviderFormat();
  assert(providerTools.length === 3, 'Provider format conversion');
  assert(providerTools[0].parameters?.properties !== undefined, 'Tool params have schema');

  // 3. Tool Execution (direct)
  console.log('\n── Tool Execution ──');
  const readResult = await registry.execute('read', { path: 'mach6.json' });
  assert(readResult.includes('github-copilot'), 'read tool executes');

  const execResult = await registry.execute('exec', { command: 'echo MACH6_ALIVE' });
  assert(execResult.includes('MACH6_ALIVE'), 'exec tool executes');

  const writeResult = await registry.execute('write', { path: path.join(os.tmpdir(), 'symbiote-test.txt'), content: 'smoke test' });
  assert(writeResult.includes('success') || writeResult.includes('wrote') || !writeResult.includes('error'), 'write tool executes');

  // 4. Provider Authentication (GitHub Copilot token exchange)
  console.log('\n── Provider Auth ──');
  let tokenOk = false;
  try {
    // Test by making a minimal streaming call
    const testMessages: Message[] = [
      { role: 'system', content: 'You are a test. Respond with exactly: MACH6_OK' },
      { role: 'user', content: 'Respond with exactly: MACH6_OK' },
    ];
    const provConfig: ProviderConfig = {
      model: config.defaultModel,
      maxTokens: 50,
      temperature: 0,
    };
    
    let responseText = '';
    const stream = githubCopilotProvider.stream(testMessages, [], provConfig);
    for await (const event of stream) {
      if (event.type === 'text_delta') responseText += event.text;
      if (event.type === 'done') break;
    }
    tokenOk = responseText.length > 0;
    assert(tokenOk, `Provider responds (got ${responseText.length} chars): "${responseText.trim().slice(0, 50)}"`);
  } catch (err) {
    assert(false, 'Provider auth', (err as Error).message);
  }

  if (!tokenOk) {
    console.log('\n⚠️  Provider auth failed — skipping agent loop test\n');
    printSummary();
    return;
  }

  // 5. Full Agent Loop (with tool use)
  console.log('\n── Agent Loop (tool use) ──');
  try {
    const messages: Message[] = [
      { role: 'system', content: 'You are Symbiote smoke test. Use the read tool to read mach6.json, then respond with the defaultModel value. Be brief.' },
      { role: 'user', content: 'Read mach6.json and tell me the defaultModel.' },
    ];
    const provConfig: ProviderConfig = {
      model: config.defaultModel,
      maxTokens: 500,
      temperature: 0,
    };

    const result = await runAgent(messages, {
      provider: githubCopilotProvider,
      providerConfig: provConfig,
      toolRegistry: registry,
      maxIterations: 5,
      onToolStart: (name) => console.log(`    ⚡ Tool: ${name}`),
      onToolEnd: (name, res) => console.log(`    ✓ ${name}: ${res.slice(0, 60).split('\n')[0]}...`),
    });

    assert(result.toolCalls.length > 0, `Tool calls made: ${result.toolCalls.length}`);
    assert(result.toolCalls.some(tc => tc.name === 'read'), 'Used read tool');
    assert(result.text.includes('claude-sonnet-4') || result.text.includes('sonnet'), `Response mentions model: "${result.text.slice(0, 100)}"`);
    assert(result.iterations <= 5, `Completed in ${result.iterations} iteration(s)`);
  } catch (err) {
    assert(false, 'Agent loop', (err as Error).message);
  }

  // 6. Cleanup
  try { (await import('node:fs')).unlinkSync(path.join(os.tmpdir(), 'symbiote-test.txt')); } catch {}

  printSummary();
}

function printSummary() {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
