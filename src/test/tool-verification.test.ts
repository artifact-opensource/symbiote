import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChannelRegistry } from '../channels/registry.js';
import { CronManager } from '../cron/manager.js';
import type { Provider } from '../providers/types.js';
import { CredentialVault } from '../security/credential-vault.js';
import { SessionManager } from '../sessions/manager.js';
import { SubAgentManager } from '../sessions/sub-agent.js';
import { ThreadManager } from '../threads/manager.js';
import { createBuiltinToolRegistry } from '../tools/builtin/register.js';
import { cuaTools } from '../tools/builtin/web-browser.js';

test('every built-in tool is registered with a provider-safe schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-tool-verification-'));
  try {
    const sessionManager = new SessionManager(path.join(root, 'sessions'));
    const subAgents = new SubAgentManager(sessionManager);
    const provider: Provider = {
      name: 'test',
      async *stream() {
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const registry = createBuiltinToolRegistry({
      credentialVault: new CredentialVault({
        adminEnvPath: path.join(root, 'admin.env'),
        vaultPath: path.join(root, 'credentials.enc'),
      }),
      cronManager: new CronManager(root),
      threadManager: new ThreadManager(root),
      resolveThreadActor: () => ({ type: 'agent', id: 'verification-agent' }),
      channelRegistry: new ChannelRegistry(),
      subAgentManager: subAgents,
      provider,
      providerConfig: { model: 'verification-model' },
      getSpawnWorkspace: () => ({ path: root }),
      workspaceTasks: {
        listRuns: () => [],
        stopRun: () => false,
        restartRun: () => null,
        guideRun: () => null,
        getProjectId: () => undefined,
        listProjectTasks: () => [],
        addProjectTask: () => { throw new Error('Not exercised by schema verification.'); },
        updateProjectTask: () => { throw new Error('Not exercised by schema verification.'); },
        deleteProjectTask: () => false,
      },
      workspaceManagement: {
        listProjects: () => [],
        listAgents: () => [],
        createProject: () => { throw new Error('Not exercised by schema verification.'); },
        createAgent: () => { throw new Error('Not exercised by schema verification.'); },
      },
    });
    const definitions = registry.list();
    const names = definitions.map(tool => tool.name);

    assert.equal(definitions.length, 62);
    assert.equal(new Set(names).size, names.length, 'built-in tool names must be unique');
    assert.deepEqual(registry.toProviderFormat().map(tool => tool.name), names);
    for (const tool of definitions) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
      assert.ok(tool.description.trim(), `${tool.name} has a description`);
      assert.equal(tool.parameters.type, 'object', `${tool.name} has an object input schema`);
      assert.ok(tool.parameters.properties && typeof tool.parameters.properties === 'object');
      for (const required of tool.parameters.required ?? []) {
        assert.ok(Object.hasOwn(tool.parameters.properties, required), `${tool.name} requires a declared property: ${required}`);
      }
    }

    const expectedCuaTools = ['cua_screenshot', 'cua_click', 'cua_move', 'cua_type', 'cua_press', 'cua_scroll'];
    assert.deepEqual(cuaTools.map(tool => tool.name), expectedCuaTools);
    assert.ok(names.includes('computer_use'), 'native computer-use is registered independently of the model provider');
    assert.ok(names.includes('image_gen'), 'local SVG image generation is registered');
    assert.ok(names.includes('memory_offload'), 'durable memory offload is registered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
