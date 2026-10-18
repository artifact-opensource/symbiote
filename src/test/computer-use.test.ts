import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerUseTool, type ComputerUseRuntimeState } from '../tools/builtin/computer-use.js';
import { omitEphemeralImages } from '../agent/runner.js';
import { ToolRegistry } from '../tools/registry.js';
import { configureSandbox, SandboxedToolRegistry } from '../tools/sandbox.js';

test('computer use routes an action through the native driver and returns screenshot bytes separately', async () => {
  const signal = new AbortController().signal;
  let received: { name: string; args: string; signal?: AbortSignal } | undefined;
  const runtime: ComputerUseRuntimeState = {
    driver: {
      isAvailable: () => true,
      callTool: async (name, args, options) => {
        received = { name, args, signal: options?.signal };
        return {
          text: 'Desktop state captured.',
          images: [{ mimeType: 'image/png', dataBase64: Buffer.from('pixels').toString('base64') }],
          isError: false,
          degraded: false,
          rawJson: '{}',
        };
      },
    },
    actions: new Set(['get_desktop_state']),
    error: null,
  };
  const tool = createComputerUseTool(() => runtime);
  const result = await tool.executeWithImages!({ action: 'get_desktop_state', arguments: { session: 'test' } }, { signal });

  assert.equal(received?.name, 'get_desktop_state');
  assert.equal(received?.args, '{"session":"test"}');
  assert.equal(received?.signal, signal);
  assert.deepEqual(result, {
    text: 'Desktop state captured.',
    images: [{ mimeType: 'image/png', dataBase64: Buffer.from('pixels').toString('base64') }],
    isError: false,
  });
});

test('computer use reports unavailable status and rejects non-catalog actions', async () => {
  const tool = createComputerUseTool(() => ({ driver: null, actions: new Set(), error: 'Runtime unavailable.' }));
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'status', arguments: {} })), {
    available: false,
    actions: 0,
    error: 'Runtime unavailable.',
  });

  const available = createComputerUseTool(() => ({
    driver: { isAvailable: () => true, callTool: async () => { throw new Error('should not run'); } },
    actions: new Set(['click']),
    error: null,
  }));
  const rejected = await available.execute({ action: 'run_script', arguments: {} });
  assert.match(rejected, /Unsupported native desktop action/);
});

test('non-admin sandbox sessions cannot discover or invoke native desktop control', async () => {
  configureSandbox({ enabled: true });
  try {
    const registry = new ToolRegistry();
    registry.register(createComputerUseTool(() => ({
      driver: { isAvailable: () => true, callTool: async () => { throw new Error('should not run'); } },
      actions: new Set(['click']),
      error: null,
    })));
    const sandbox = new SandboxedToolRegistry(registry, {
      sessionId: 'internal-agent',
      adapterId: 'subagent',
      channelType: 'internal',
      chatType: 'direct',
      senderId: 'agent',
      isOwner: false,
    });

    assert.equal(sandbox.list().some(tool => tool.name === 'computer_use'), false);
    const result = await sandbox.executeWithImages('computer_use', { action: 'click', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.text, /only available in admin sessions/);
  } finally {
    configureSandbox({ enabled: false });
  }
});

test('screenshots are removed from saved checkpoints but remain in the live tool result', () => {
  const image = {
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png', data: 'private-screen-bytes' },
  };
  const messages = [
    { role: 'tool' as const, tool_call_id: 'tool-1', name: 'computer_use', content: [{ type: 'text' as const, text: 'Captured.' }, image] },
    { role: 'user' as const, content: [{ type: 'image' as const, source: image.source }] },
  ];
  const persisted = omitEphemeralImages(messages);

  assert.equal(messages[0].content[1], image);
  assert.deepEqual(persisted[0].content, [
    { type: 'text', text: 'Captured.' },
    { type: 'text', text: '[Desktop screenshot omitted from saved conversation history.]' },
  ]);
  assert.deepEqual(persisted[1], messages[1]);
  assert.equal(JSON.stringify(persisted[0]).includes('private-screen-bytes'), false);
  assert.equal(JSON.stringify(persisted[1]).includes('private-screen-bytes'), true);
});
