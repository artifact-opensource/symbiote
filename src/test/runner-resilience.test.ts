import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../agent/runner.js';

type Script = Array<() => AsyncGenerator<any>>;

function fakeProvider(script: Script, seen: any[][] = []): any {
  let call = 0;
  return {
    name: 'fake',
    stream(messages: any[]) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const step = script[Math.min(call++, script.length - 1)];
      return step();
    },
  };
}

const registry = (execute: (name: string, input: any) => Promise<string>): any => ({
  toProviderFormat: () => [],
  list: () => [],
  execute,
});

const base = { providerConfig: { model: 'm', maxTokens: 100 } as any, maxIterations: 8 };
const say = (text: string) => async function* () { yield { type: 'text_delta', text }; yield { type: 'done', stopReason: 'end_turn' }; };

test('runner retries a stream that drops mid-response', async () => {
  let calls = 0;
  const provider = fakeProvider([
    async function* () { calls++; yield { type: 'text_delta', text: 'partial' }; throw new TypeError('terminated'); },
    async function* () { calls++; yield { type: 'text_delta', text: 'recovered' }; yield { type: 'done', stopReason: 'end_turn' }; },
  ]);
  const result = await runAgent([{ role: 'user', content: 'hi' }], { ...base, provider, toolRegistry: registry(async () => 'ok') });
  assert.equal(calls, 2);
  assert.equal(result.text, 'recovered');
});

test('runner reports cut-off tool arguments instead of running the tool with {}', async () => {
  let executed = 0;
  const seen: any[][] = [];
  const provider = fakeProvider([
    async function* () {
      yield { type: 'tool_use_start', id: 't1', name: 'write' };
      yield { type: 'tool_use_delta', id: 't1', input: '{"path": "a.txt", "content": "unfini' };
      yield { type: 'tool_use_end', id: 't1' };
      yield { type: 'done', stopReason: 'max_tokens' };
    },
    say('done'),
  ], seen);
  const result = await runAgent([{ role: 'user', content: 'write it' }], {
    ...base, provider, toolRegistry: registry(async () => { executed++; return 'wrote'; }),
  });
  assert.equal(executed, 0);
  const toolMsg = seen[1].find(m => m.role === 'tool');
  assert.match(toolMsg.content, /not valid JSON/);
  assert.equal(result.text.includes('done'), true);
});

test('runner keeps the tail of oversized tool output', async () => {
  const seen: any[][] = [];
  const big = `${'x'.repeat(80_000)}FINAL_ERROR_LINE`;
  const provider = fakeProvider([
    async function* () {
      yield { type: 'tool_use_start', id: 't1', name: 'exec' };
      yield { type: 'tool_use_delta', id: 't1', input: '{"command":"build"}' };
      yield { type: 'tool_use_end', id: 't1' };
      yield { type: 'done', stopReason: 'tool_use' };
    },
    say('ok'),
  ], seen);
  await runAgent([{ role: 'user', content: 'build' }], { ...base, provider, toolRegistry: registry(async () => big) });
  const toolMsg = seen[1].find(m => m.role === 'tool');
  assert.match(toolMsg.content, /FINAL_ERROR_LINE/);
  assert.match(toolMsg.content, /bytes omitted/);
});

test('a hung tool is cut off by the timeout instead of stalling the loop', async () => {
  process.env.SYMBIOTE_TOOL_TIMEOUT_MS = '150';
  const seen: any[][] = [];
  const provider = fakeProvider([
    async function* () {
      yield { type: 'tool_use_start', id: 't1', name: 'exec' };
      yield { type: 'tool_use_delta', id: 't1', input: '{"command":"sleep"}' };
      yield { type: 'tool_use_end', id: 't1' };
      yield { type: 'done', stopReason: 'tool_use' };
    },
    say('moved on'),
  ], seen);
  const result = await runAgent([{ role: 'user', content: 'go' }], {
    ...base, provider, toolRegistry: registry(() => new Promise<string>(() => { /* never settles */ })),
  });
  delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
  assert.match(seen[1].find(m => m.role === 'tool').content, /timed out/);
  assert.match(result.text, /moved on/);
});
