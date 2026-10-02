import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, StreamEvent } from '../providers/types.js';
import { runAgent } from '../agent/runner.js';
import { PulseBudgetManager } from '../agent/pulse.js';
import { BaseAdapter } from '../channels/adapter.js';
import type { ChannelCapabilities, ChannelConfig, OutboundMessage, SendResult } from '../channels/types.js';

test('runner reviews completion, bounds tool fan-out, throttles sends, and persists PULSE', async () => {
  const originalCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-reliability-'));

  try {
    process.chdir(workspace);

    const budget = new PulseBudgetManager(join(workspace, 'pulse'));
    budget.recordSession(18);
    assert.equal(new PulseBudgetManager(join(workspace, 'pulse')).getEffectiveCap(), 100);

    class TestAdapter extends BaseAdapter {
      readonly id = 'test';
      readonly channelType = 'test';
      readonly capabilities = {
        rateLimits: { messagesPerSecond: 5, burstSize: 2 },
      } as ChannelCapabilities;
      readonly sendTimes: number[] = [];

      protected async platformConnect(_config: ChannelConfig): Promise<void> {}
      protected async platformDisconnect(): Promise<void> {}
      protected async platformReconnect(): Promise<void> {}
      protected async platformSend(_chatId: string, _message: OutboundMessage): Promise<SendResult> {
        this.sendTimes.push(Date.now());
        return { success: true };
      }
    }

    const adapter = new TestAdapter();
    await adapter.connect({});
    const sends = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      adapter.send('chat', { content: String(index) }),
    ));
    assert.ok(sends.every(result => result.success));
    assert.ok(adapter.sendTimes[4] - adapter.sendTimes[0] >= 500);
    await adapter.disconnect();

    let reviewCalls = 0;
    const reviewProvider: Provider = {
      name: 'mock-review',
      async *stream(): AsyncGenerator<StreamEvent> {
        reviewCalls++;
        if (reviewCalls === 1) {
          yield { type: 'tool_use_start', id: 'review-tool', name: 'probe' };
          yield { type: 'tool_use_delta', id: 'review-tool', input: '{}' };
          yield { type: 'tool_use_end', id: 'review-tool' };
        } else {
          yield { type: 'text_delta', text: reviewCalls === 3 ? 'final answer' : 'draft answer' };
        }
      },
    };
    let reviewToolCalls = 0;
    const reviewResult = await runAgent([{ role: 'user', content: 'Complete a task' }], {
      provider: reviewProvider,
      providerConfig: { model: 'mock' },
      toolRegistry: {
        toProviderFormat: () => [],
        list: () => [],
        execute: async () => {
          reviewToolCalls++;
          return 'done';
        },
      },
      maxIterations: 10,
    });
    assert.equal(reviewCalls, 3);
    assert.equal(reviewToolCalls, 1);
    assert.equal(reviewResult.text, 'final answer');

    // A pure conversational reply (no tool calls at all) must not trigger a
    // review round-trip — that's the latency this mechanism used to add to
    // every single turn, including plain greetings.
    let noToolCalls = 0;
    const noToolProvider: Provider = {
      name: 'mock-no-tools',
      async *stream(): AsyncGenerator<StreamEvent> {
        noToolCalls++;
        yield { type: 'text_delta', text: 'hey' };
      },
    };
    const noToolResult = await runAgent([{ role: 'user', content: 'Hi' }], {
      provider: noToolProvider,
      providerConfig: { model: 'mock' },
      toolRegistry: { toProviderFormat: () => [], list: () => [], execute: async () => 'done' },
      maxIterations: 10,
    });
    assert.equal(noToolCalls, 1);
    assert.equal(noToolResult.text, 'hey');

    let fanoutCalls = 0;
    let activeTools = 0;
    let peakTools = 0;
    const fanoutProvider: Provider = {
      name: 'mock-fanout',
      async *stream(): AsyncGenerator<StreamEvent> {
        fanoutCalls++;
        if (fanoutCalls === 1) {
          for (let index = 0; index < 7; index++) {
            const id = `tool-${index}`;
            yield { type: 'tool_use_start', id, name: `tool-${index}` };
            yield { type: 'tool_use_delta', id, input: '{}' };
            yield { type: 'tool_use_end', id };
          }
        } else {
          yield { type: 'text_delta', text: 'complete' };
        }
      },
    };
    const fanoutResult = await runAgent([{ role: 'user', content: 'Run tools' }], {
      provider: fanoutProvider,
      providerConfig: { model: 'mock' },
      toolRegistry: {
        toProviderFormat: () => [],
        list: () => [],
        execute: async () => {
          activeTools++;
          peakTools = Math.max(peakTools, activeTools);
          await new Promise(resolve => setTimeout(resolve, 10));
          activeTools--;
          return 'done';
        },
      },
      maxIterations: 10,
    });
    assert.equal(fanoutResult.toolCalls.length, 7);
    assert.ok(peakTools <= 5);
    assert.equal(readdirSync(join(workspace, '.symbiote', 'todos')).length, 3);
  } finally {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runner propagates a live interrupt to the active provider stream', async () => {
  const controller = new AbortController();
  let providerSawSignal = false;
  const provider: Provider = {
    name: 'mock-abort',
    async *stream(_messages, _tools, config) {
      providerSawSignal = config.signal instanceof AbortSignal;
      await new Promise<never>((_resolve, reject) => {
        config.signal?.addEventListener('abort', () => reject(config.signal?.reason), { once: true });
      });
    },
  };
  const run = runAgent([{ role: 'user', content: 'long task' }], {
    provider,
    providerConfig: { model: 'mock' },
    toolRegistry: { toProviderFormat: () => [], list: () => [], execute: async () => '' },
    abortSignal: controller.signal,
    maxIterations: 5,
  });
  setTimeout(() => controller.abort('user_interrupt'), 10);

  const result = await run;
  assert.equal(providerSawSignal, true);
  assert.equal(result.aborted, true);
});