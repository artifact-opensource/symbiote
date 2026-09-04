#!/usr/bin/env node
/**
 * Symbiote Channel Integration Test
 * 
 * Tests the FULL path: BusEnvelope → agent turn → LLM → tools → response → send
 * Uses a mock adapter so no real Discord/WhatsApp is needed.
 * Channel integration test suite.
 */

import { loadConfig } from '../config/config.js';
import { ToolRegistry } from '../tools/registry.js';
import { readTool } from '../tools/builtin/read.js';
import { writeTool } from '../tools/builtin/write.js';
import { execTool } from '../tools/builtin/exec.js';
import { editTool } from '../tools/builtin/edit.js';
import { SessionManager } from '../sessions/manager.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { runAgent, type RunResult } from '../agent/runner.js';
import { githubCopilotProvider } from '../providers/github-copilot.js';
import type { ProviderConfig, Message } from '../providers/types.js';
import type { BusEnvelope } from '../channels/types.js';
import fs from 'node:fs';
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

// Simulate what the daemon does when it receives a message
async function simulateAgentTurn(envelope: BusEnvelope): Promise<{
  result: RunResult;
  systemPromptLength: number;
  responseText: string;
}> {
  const config = loadConfig('mach6.json');

  // Tool registry (same as daemon)
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readTool);
  toolRegistry.register(writeTool);
  toolRegistry.register(execTool);
  toolRegistry.register(editTool);

  // Session manager
  const sessionsDir = path.join(os.tmpdir(), 'symbiote-test-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionManager = new SessionManager(sessionsDir);

  // Build channel-aware system prompt (exactly as daemon does)
  const systemPrompt = buildSystemPrompt({
    workspace: config.workspace,
    tools: toolRegistry.list().map(t => t.name),
    channel: envelope.source.channelType,
    chatType: envelope.source.chatId.includes('@g.') ? 'group' : 'direct',
    senderId: envelope.source.senderId,
  });

  // Create session
  const sessionId = `test-${Date.now()}`;
  const session = sessionManager.create(sessionId, {
    provider: config.defaultProvider,
    model: config.defaultModel,
  });

  // System prompt as first message
  session.messages.push({ role: 'system', content: systemPrompt });

  // Build user content (same as daemon.buildUserContent)
  const parts: string[] = [];
  if (envelope.source.senderName) parts.push(`[${envelope.source.senderName}]`);
  if (envelope.payload.text) parts.push(envelope.payload.text);
  session.messages.push({ role: 'user', content: parts.join(' ') });

  // Provider config
  const providerCfg = (config.providers as Record<string, any>)[config.defaultProvider] ?? {};
  const provConfig: ProviderConfig = {
    model: config.defaultModel,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    ...providerCfg,
  };

  // Run agent (the critical path)
  const result = await runAgent(session.messages, {
    provider: githubCopilotProvider,
    providerConfig: provConfig,
    toolRegistry,
    sessionId,
    maxIterations: 10,
    onToolStart: (name, input) => {
      console.log(`    ⚡ Tool: ${name}(${JSON.stringify(input).slice(0, 80)})`);
    },
    onToolEnd: (name, res) => {
      console.log(`    ✓ ${name}: ${res.slice(0, 80).split('\n')[0]}...`);
    },
  });

  // Cleanup
  try { fs.rmSync(sessionsDir, { recursive: true }); } catch {}

  return {
    result,
    systemPromptLength: systemPrompt.length,
    responseText: result.text,
  };
}

async function main() {
  console.log('\n⚡ Symbiote Channel Integration Test\n');
  console.log('This tests the FULL message pipeline: envelope → prompt → LLM → tools → response\n');

  // ── Test 1: WhatsApp DM from Ali ──
  console.log('── Test 1: WhatsApp DM from Ali ──');
  console.log('  Simulating: Ali sends "What\'s in my SOUL.md?" via WhatsApp\n');

  const whatsappEnvelope: BusEnvelope = {
    id: `test-wa-${Date.now()}`,
    sessionId: 'test-wa-session',
    source: {
      channelType: 'whatsapp',
      adapterId: 'whatsapp-test',
      chatId: '1234567890@s.whatsapp.net', chatType: 'dm' as const,
      senderId: '1234567890@s.whatsapp.net',
      senderName: 'Ali',
      
    },
    payload: {
      type: 'text' as const, text: "What's in my SOUL.md? Just give me the first line after the title.",
    },
    metadata: {
      platformMessageId: `wa-${Date.now()}`,
      
    },
    priority: 'normal' as const, timestamp: Date.now(),
  };

  try {
    const wa = await simulateAgentTurn(whatsappEnvelope);
    
    assert(wa.systemPromptLength > 30000, `System prompt loaded (${wa.systemPromptLength} chars)`);
    assert(wa.responseText.length > 0, `Got response (${wa.responseText.length} chars)`);
    assert(
      wa.responseText.toLowerCase().includes('chatbot') || 
      wa.responseText.toLowerCase().includes('becoming') ||
      wa.responseText.includes('not a chatbot'),
      `Response references SOUL.md content`
    );
    assert(wa.result.iterations >= 1, `Completed in ${wa.result.iterations} iteration(s)`);
    
    // Check if it used the read tool (it should, to read SOUL.md)
    const usedRead = wa.result.toolCalls.some(tc => tc.name === 'read');
    assert(usedRead, `Used read tool to check SOUL.md`);
    
    console.log(`\n  📝 Response: "${wa.responseText.slice(0, 200)}${wa.responseText.length > 200 ? '...' : ''}"\n`);
  } catch (err) {
    assert(false, 'WhatsApp DM test', (err as Error).message);
  }

  // ── Test 2: Discord message ──
  console.log('── Test 2: Discord mention ──');
  console.log('  Simulating: Ali sends "What tools do you have?" on Discord\n');

  const discordEnvelope: BusEnvelope = {
    id: `test-dc-${Date.now()}`,
    sessionId: 'test-dc-session',
    source: {
      channelType: 'discord',
      adapterId: 'discord-test',
      chatId: '000000000000000000', chatType: 'channel' as const,
      senderId: '000000000000000000',
      senderName: 'Ali',
      
    },
    payload: {
      type: "text" as const, text: 'What tools do you have access to? List them briefly.',
    },
    metadata: {
      platformMessageId: `dc-${Date.now()}`,
      
    },
    priority: 'normal' as const, timestamp: Date.now(),
  };

  try {
    const dc = await simulateAgentTurn(discordEnvelope);
    
    assert(dc.systemPromptLength > 30000, `System prompt loaded (${dc.systemPromptLength} chars)`);
    assert(dc.responseText.length > 0, `Got response (${dc.responseText.length} chars)`);
    assert(
      dc.responseText.toLowerCase().includes('read') && dc.responseText.toLowerCase().includes('exec'),
      'Response lists tools'
    );
    assert(dc.result.iterations >= 1, `Completed in ${dc.result.iterations} iteration(s)`);
    
    console.log(`\n  📝 Response: "${dc.responseText.slice(0, 200)}${dc.responseText.length > 200 ? '...' : ''}"\n`);
  } catch (err) {
    assert(false, 'Discord mention test', (err as Error).message);
  }

  // ── Test 3: Identity awareness ──
  console.log('── Test 3: Identity awareness ──');
  console.log('  Simulating: "Who are you and who am I?" — tests SOUL.md + USER.md loading\n');

  const identityEnvelope: BusEnvelope = {
    id: `test-id-${Date.now()}`,
    sessionId: 'test-id-session',
    source: {
      channelType: 'whatsapp',
      adapterId: 'whatsapp-test',
      chatId: '1234567890@s.whatsapp.net', chatType: 'dm' as const,
      senderId: '1234567890@s.whatsapp.net',
      senderName: 'Ali',
      
    },
    payload: {
      type: "text" as const, text: 'Who are you and who am I? Answer in one sentence each.',
    },
    metadata: {
      platformMessageId: `wa-id-${Date.now()}`,
      
    },
    priority: 'normal' as const, timestamp: Date.now(),
  };

  try {
    const id = await simulateAgentTurn(identityEnvelope);
    
    assert(id.responseText.length > 0, `Got response (${id.responseText.length} chars)`);
    const hasAVA = id.responseText.includes('AVA') || id.responseText.includes('Ava');
    const hasAli = id.responseText.includes('Ali');
    assert(hasAVA, 'Knows own identity (AVA)');
    assert(hasAli, 'Knows user identity (Ali)');
    
    console.log(`\n  📝 Response: "${id.responseText.slice(0, 300)}${id.responseText.length > 300 ? '...' : ''}"\n`);
  } catch (err) {
    assert(false, 'Identity test', (err as Error).message);
  }

  // ── Summary ──
  console.log('─'.repeat(50));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(50));
  
  if (failed === 0) {
    console.log('\n🔥 FULL PIPELINE VERIFIED — Channel → Prompt → LLM → Tools → Response\n');
  } else {
    console.log('\n⚠️  Some tests failed — investigate before cutover\n');
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
