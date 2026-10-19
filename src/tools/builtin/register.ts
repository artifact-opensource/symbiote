import type { Provider, ProviderConfig } from '../../providers/types.js';
import type { ChannelRegistry } from '../../channels/registry.js';
import type { CronManager } from '../../cron/manager.js';
import type { ThreadActor, ThreadManager } from '../../threads/manager.js';
import type { SubAgentManager } from '../../sessions/sub-agent.js';
import type { CredentialVault } from '../../security/credential-vault.js';
import { ToolRegistry } from '../registry.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { execTool } from './exec.js';
import { imageTool } from './image.js';
import { imageGenTool } from './image_gen.js';
import { processStartTool, processPollTool, processKillTool, processListTool } from './process.js';
import { ttsTool } from './tts.js';
import { sttTool } from './stt.js';
import { webFetchTool } from './web-fetch.js';
import { memorySearchTool } from './memory.js';
import { combRecallTool, combStageTool, memoryOffloadTool } from './comb.js';
import { vdbSearchTool, vdbIngestTool, vdbStatsTool } from './memory-vdb.js';
import { googleWorkspaceTool } from './google-workspace.js';
import { createCloudIntegrationTools } from './cloud-integrations.js';
import { webBrowseTool, webClickTool, webTypeTool, webScreenshotTool, webExtractTool, webScrollTool, webWaitTool, webSessionTool, webTabOpenTool, webTabSwitchTool, webTabCloseTool, webTabsTool, webDownloadTool, webUploadTool, cuaTools } from './web-browser.js';
import { computerUseTool } from './computer-use.js';
import { personaDigestTool } from './consolidate.js';
import { adminTools } from './system.js';
import { todoTool } from '../shared-todo.js';
import { createCronManageTool } from './cron.js';
import { createThreadsTool } from './threads.js';
import { createMessageTool, createTypingTool, createPresenceTool, createDeleteMessageTool, createMarkReadTool } from './message.js';
import { createSpawnTool, createSubAgentStatusTool } from './spawn.js';
import { createWorkspaceTaskTool } from './workspace-tasks.js';
import { createWorkspaceManagementTool } from './workspace-management.js';

type WorkspaceTaskHandlers = Parameters<typeof createWorkspaceTaskTool>[0];
type WorkspaceManagementHandlers = Parameters<typeof createWorkspaceManagementTool>[0];

export interface BuiltinToolDependencies {
  credentialVault: CredentialVault;
  cronManager: CronManager;
  threadManager: ThreadManager;
  resolveThreadActor: (sessionId?: string) => ThreadActor;
  channelRegistry: ChannelRegistry;
  subAgentManager: SubAgentManager;
  provider: Provider;
  providerConfig: ProviderConfig;
  getSpawnWorkspace: (parentSessionId: string) => { path: string; projectId?: string; agentId?: string };
  workspaceTasks: WorkspaceTaskHandlers;
  workspaceManagement: WorkspaceManagementHandlers;
}

export function registerBuiltinTools(
  registry: ToolRegistry,
  dependencies: BuiltinToolDependencies,
): void {
  for (const tool of [
    readTool, writeTool, editTool, execTool, imageTool, imageGenTool,
    processStartTool, processPollTool, processKillTool, processListTool,
    ttsTool, sttTool, webFetchTool, memorySearchTool, combRecallTool, combStageTool, memoryOffloadTool,
    vdbSearchTool, vdbIngestTool, vdbStatsTool, googleWorkspaceTool,
    ...createCloudIntegrationTools(dependencies.credentialVault),
    webBrowseTool, webClickTool, webTypeTool, webScreenshotTool, webExtractTool,
    webScrollTool, webWaitTool, webSessionTool, webTabOpenTool, webTabSwitchTool,
    webTabCloseTool, webTabsTool, webDownloadTool, webUploadTool, ...cuaTools,
    computerUseTool, personaDigestTool, ...adminTools, todoTool,
    createCronManageTool(dependencies.cronManager),
    createThreadsTool(dependencies.threadManager, dependencies.resolveThreadActor),
    createMessageTool(dependencies.channelRegistry),
    createTypingTool(dependencies.channelRegistry),
    createPresenceTool(dependencies.channelRegistry),
    createDeleteMessageTool(dependencies.channelRegistry),
    createMarkReadTool(dependencies.channelRegistry),
    createSpawnTool(
      dependencies.subAgentManager,
      dependencies.provider,
      dependencies.providerConfig,
      registry,
      dependencies.getSpawnWorkspace,
    ),
    createSubAgentStatusTool(dependencies.subAgentManager),
    createWorkspaceTaskTool(dependencies.workspaceTasks),
    createWorkspaceManagementTool(dependencies.workspaceManagement),
  ]) {
    registry.register(tool);
  }
}

export function createBuiltinToolRegistry(dependencies: BuiltinToolDependencies): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, dependencies);
  return registry;
}
