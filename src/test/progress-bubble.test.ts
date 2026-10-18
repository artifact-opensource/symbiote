import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_EMOJI, ToolProgressBubble } from '../channels/progress-bubble.js';

test('every registered built-in tool has a distinct progress icon', () => {
  const registeredTools = [
    'read', 'write', 'edit', 'exec', 'image', 'image_gen', 'process_start', 'process_poll',
    'process_kill', 'process_list', 'tts', 'stt', 'web_fetch', 'memory_search', 'comb_recall',
    'comb_stage', 'memory_offload', 'memory_recall', 'memory_ingest', 'memory_stats',
    'google_workspace', 'azure_cloud', 'oci_cloud', 'n8n_cloud', 'kaggle_cloud',
    'kaggle_kernel_push', 'web_browse', 'web_click', 'web_type', 'web_screenshot',
    'web_extract', 'web_scroll', 'web_wait', 'web_session', 'web_tab_open', 'web_tab_switch',
    'web_tab_close', 'web_tabs', 'web_download', 'web_upload', 'cua_screenshot', 'cua_click',
    'cua_move', 'cua_type', 'cua_press', 'cua_scroll', 'computer_use', 'persona_digest', 'fs',
    'hardware', 'todo', 'cron_manage', 'threads_manage', 'message', 'typing', 'presence',
    'delete_message', 'mark_read', 'spawn', 'subagent_status', 'workspace_tasks', 'workspace_manage',
  ];
  assert.deepEqual(Object.keys(TOOL_EMOJI).sort(), registeredTools.sort());
  assert.equal(new Set(Object.values(TOOL_EMOJI)).size, registeredTools.length);
});

test('progress bubble appends tool starts without per-tool completion marks, redacts secrets, and ends with a one-line count', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  await bubble.toolLine('exec', {
    command: 'curl -H "Authorization: Bearer discord-secret-value" https://example.test',
  });
  assert.match(sent[0], /Working/);
  assert.match(sent[0], /exec/);
  assert.match(sent[0], /⚡ \*\*exec\*\*/);
  assert.ok(!sent[0].includes('discord-secret-value'));

  for (let i = 0; i < 100; i++) {
    await bubble.toolLine('exec', { command: `echo operational-check-${i}` });
  }
  await bubble.finalize();

  const messages = [...sent, ...edits];
  assert.ok(messages.length > 0);
  assert.ok(messages.every(message => message.length <= 2000));
  assert.ok(messages.every(message => !message.includes('discord-secret-value')));
  assert.ok(messages.some(message => message.includes('⚡ **exec**')));
  assert.equal(edits.at(-1), '✅ **Done — 101 tool calls**');
});

test('assistant text is not accepted or shown in the operational progress bubble', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  await bubble.toolLine('web_fetch', { url: 'https://example.test' });
  await bubble.finalize();

  assert.ok([...sent, ...edits].every(message => !message.includes('answer text')));
  assert.equal(edits.at(-1), '✅ **Done — 1 tool call**');
});

test('todo completion progress is appended to the editable bubble in the requested format', async () => {
  const sent: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async () => undefined,
  }, 'discord-main', 'channel');

  await bubble.todoLine('Progress update: completed "First task" (1/2 checklist tasks complete). Continuing with "Second task".');

  assert.equal(sent.length, 1);
  assert.match(sent[0], /✅ todo \[completed\]: "Progress update: completed \\"First task\\"/);
  assert.ok(!sent[0].includes('⚙️ **todo**'));
  await bubble.finalize();
});

test('concurrent tool events create one message and finalization leaves one summary line', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  let releaseSend!: (result: { messageId: string }) => void;
  const firstSend = new Promise<{ messageId: string }>(resolve => { releaseSend = resolve; });
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return firstSend;
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  const firstTool = bubble.toolLine('read', { path: 'README.md' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  const finalization = bubble.finalize();
  releaseSend({ messageId: 'progress-message' });
  await firstTool;
  await finalization;

  assert.equal(sent.length, 1);
  assert.equal(edits.at(-1), '✅ **Done — 1 tool call**');
});

test('tool completion does not trigger an additional progress-message edit', async () => {
  const sent: string[] = [];
  const edits: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async (_adapterId, _chatId, _messageId, content) => {
      edits.push(content);
    },
  }, 'discord-main', 'channel');

  await bubble.toolLine('read', { path: 'README.md' });
  await bubble.toolLine('exec', { command: 'npm test' });
  assert.equal(edits.length, 0);
  assert.match(sent[0], /📖 \*\*read\*\*/);
  await bubble.finalize();
  assert.equal(edits.length, 1);
  assert.equal(edits[0], '✅ **Done — 2 tool calls**');
});

test('tool-less turns do not create a progress message', async () => {
  const sent: string[] = [];
  const bubble = new ToolProgressBubble({
    enabled: true,
    send: async (_adapterId, _chatId, content) => {
      sent.push(content);
      return { messageId: 'progress-message' };
    },
    edit: async () => undefined,
  }, 'discord-main', 'channel');

  await bubble.finalize();
  assert.deepEqual(sent, []);
});
