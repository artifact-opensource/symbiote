import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a silent provider stream is aborted before bounded retries', async () => {
  const previousIdleTimeout = process.env.SYMBIOTE_STREAM_IDLE_MS;
  const originalCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-runner-idle-'));
  process.env.SYMBIOTE_STREAM_IDLE_MS = '25';
  const streamSignals: AbortSignal[] = [];
  const provider = {
    name: 'silent',
    async *stream(_messages: unknown, _tools: unknown, config: { signal?: AbortSignal }) {
      const signal = config.signal!;
      streamSignals.push(signal);
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };

  try {
    process.chdir(workspace);
    await assert.rejects(
      runAgent([{ role: 'user', content: 'wait for a response' }], {
        ...base,
        provider: provider as any,
        toolRegistry: registry(async () => 'ok'),
        todoScope: 'idle-timeout-test',
      }),
      /stream idle: timed out/,
    );
    assert.equal(streamSignals.length, 4);
    assert.ok(streamSignals.every(signal => signal.aborted));
  } finally {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
    if (previousIdleTimeout === undefined) delete process.env.SYMBIOTE_STREAM_IDLE_MS;
    else process.env.SYMBIOTE_STREAM_IDLE_MS = previousIdleTimeout;
  }
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

test('unchanged unfinished todos stop instead of repeating the checklist indefinitely', async () => {
  const originalCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-runner-checklist-'));
  let providerCalls = 0;
  const provider = {
    name: 'unfinished-checklist',
    async *stream() {
      providerCalls++;
      if (providerCalls === 1) {
        yield { type: 'tool_use_start', id: 'todo-add', name: 'todo' };
        yield { type: 'tool_use_delta', id: 'todo-add', input: '{"action":"add","title":"Finish the work"}' };
        yield { type: 'tool_use_end', id: 'todo-add' };
        return;
      }
      yield { type: 'text_delta', text: 'The checklist is still unfinished.' };
    },
  };

  try {
    process.chdir(workspace);
    const result = await runAgent([{ role: 'user', content: 'Finish the work' }], {
      ...base,
      provider: provider as any,
      toolRegistry: registry(async () => JSON.stringify({ ok: true })),
      todoScope: 'unfinished-checklist-test',
    });

    assert.equal(providerCalls, 4);
    assert.equal(result.iterations, 4);
    assert.match(result.text, /Unresolved checklist items:[\s\S]*Finish the work/);
    assert.equal(
      result.messages.filter(message => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith('Checklist verification found unfinished tasks.')).length,
      1,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
  }
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
  let toolSignal: AbortSignal | undefined;
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
    ...base,
    provider,
    toolRegistry: {
      toProviderFormat: () => [],
      list: () => [],
      execute: (_name: string, _input: unknown, options?: { signal?: AbortSignal }) => {
        toolSignal = options?.signal;
        return new Promise<string>(() => { /* never settles */ });
      },
    } as any,
  });
  delete process.env.SYMBIOTE_TOOL_TIMEOUT_MS;
  assert.match(seen[1].find(m => m.role === 'tool').content, /timed out/);
  assert.equal(toolSignal?.aborted, true);
  assert.match(result.text, /moved on/);
});

test('unscoped todo calls use the runner checklist and returned tool errors are marked', async () => {
  const originalCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-runner-todo-'));
  const seen: any[][] = [];
  const provider = fakeProvider([
    async function* () {
      yield { type: 'tool_use_start', id: 'todo-1', name: 'todo' };
      yield { type: 'tool_use_delta', id: 'todo-1', input: '{"action":"add","title":"Inspect and verify"}' };
      yield { type: 'tool_use_end', id: 'todo-1' };
    },
    async function* () {
      yield { type: 'tool_use_start', id: 'read-1', name: 'read' };
      yield { type: 'tool_use_delta', id: 'read-1', input: '{"path":"missing.txt"}' };
      yield { type: 'tool_use_end', id: 'read-1' };
    },
    say('The requested work is complete.'),
  ], seen);

  try {
    process.chdir(workspace);
    const result = await runAgent([{ role: 'user', content: 'Do a multi-step task' }], {
      ...base,
      provider,
      todoScope: 'test-turn-scope',
      toolRegistry: registry(async (name, input) => {
        if (name === 'todo') {
          assert.equal(input.scope, 'test-turn-scope');
          return JSON.stringify({ ok: true });
        }
        return 'Error: File not found: missing.txt';
      }),
    });
    assert.equal(result.toolCalls[0].input.scope, 'test-turn-scope');
    const failedRead = seen[2].find(message => message.role === 'tool' && message.name === 'read');
    assert.equal(failedRead?.is_error, true);
  } finally {
    process.chdir(originalCwd);
    rmSync(workspace, { recursive: true, force: true });
  }
});
