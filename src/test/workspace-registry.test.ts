import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceRegistry } from '../agent/workspace-registry.js';
import { SessionManager } from '../sessions/manager.js';

test('workspace registry persists isolated project and agent workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-agent-registry-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Research');
    const agent = registry.createAgent({
      projectId: project.id,
      name: 'Analyst',
      emoji: '🧠',
      instructions: 'Analyze datasets and report reproducible findings.',
    });

    assert.equal(fs.existsSync(project.workspace), true);
    assert.equal(fs.existsSync(path.join(agent.workspace, 'AGENT_INSTRUCTIONS.md')), true);
    assert.equal(registry.getAgent(agent.id)?.instructions, 'Analyze datasets and report reproducible findings.');
    assert.deepEqual(registry.listProjects().map(item => item.id), [project.id]);
    assert.deepEqual(registry.listAgents(project.id).map(item => item.id), [agent.id]);
    assert.throws(() => registry.createAgent({
      projectId: 'missing-project',
      name: 'Unscoped',
      emoji: '🤖',
      instructions: 'No cross-project placement.',
    }), /active project/);
    assert.throws(() => registry.createProject('Research'), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project file access is project-scoped, bounded, and excludes reserved paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-files-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Editor');
    const created = registry.createProjectFile(project.id, 'src/index.ts');
    const saved = registry.writeProjectFile(project.id, 'src/index.ts', 'export const answer = 42;\n');

    assert.equal(created.path, 'src/index.ts');
    assert.equal(saved.path, created.path);
    assert.equal(registry.readProjectFile(project.id, 'src/index.ts').content, 'export const answer = 42;\n');
    assert.throws(() => registry.createProjectFile(project.id, 'src/index.ts'), /EEXIST/);
    assert.deepEqual(registry.listProjectFiles(project.id).map(file => [file.path, file.type]), [
      ['src', 'directory'],
      ['src/index.ts', 'file'],
    ]);
    assert.equal(registry.deleteProjectFile(project.id, 'src/index.ts'), true);
    assert.equal(registry.createProjectDirectory(project.id, 'assets').path, 'assets');
    registry.createProjectFile(project.id, 'assets/icon.svg', '<svg />');
    assert.deepEqual(registry.getProjectStorage(project.id), { fileCount: 1, directoryCount: 2, bytes: 7 });
    assert.equal(registry.moveProjectEntry(project.id, 'assets/icon.svg', 'assets/mark.svg').path, 'assets/mark.svg');
    assert.equal(registry.deleteProjectEntry(project.id, 'assets'), true);
    assert.deepEqual(registry.getProjectStorage(project.id), { fileCount: 0, directoryCount: 1, bytes: 0 });
    assert.throws(() => registry.readProjectFile(project.id, 'src/index.ts'), /ENOENT/);
    assert.throws(() => registry.writeProjectFile(project.id, '../outside.txt', 'no'), /invalid|escapes/i);
    assert.throws(() => registry.writeProjectFile(project.id, '.env', 'secret'), /reserved/i);
    assert.throws(() => registry.writeProjectFile(project.id, '.git/config', 'no'), /reserved/i);
    assert.throws(() => registry.writeProjectFile(project.id, 'C:/outside.txt', 'no'), /invalid|escapes/i);
    assert.throws(() => registry.listProjectFiles('missing-project'), /not found/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project plans persist and support status updates and deletion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-tasks-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Plan');
    const task = registry.addProjectTask(project.id, 'Build the editor', 'Add file operations.');
    assert.equal(task.status, 'pending');
    const updated = registry.updateProjectTask(project.id, task.id, { status: 'in_progress', title: 'Build the IDE' });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.title, 'Build the IDE');
    assert.equal(new WorkspaceRegistry(root).listProjectTasks(project.id)[0].description, 'Add file operations.');
    assert.equal(registry.deleteProjectTask(project.id, task.id), true);
    assert.equal(registry.deleteProjectTask(project.id, task.id), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project scope and task assignments persist and remain project-scoped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-management-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Delivery', 'Ship a secure, documented release.');
    const otherProject = registry.createProject('Other');
    const agent = registry.createAgent({
      projectId: project.id,
      name: 'Builder',
      emoji: '🧭',
      instructions: 'Deliver project tasks.',
    });
    const otherAgent = registry.createAgent({
      projectId: otherProject.id,
      name: 'Reviewer',
      emoji: '🧠',
      instructions: 'Review another project.',
    });

    const renamed = registry.updateProject(project.id, { name: 'Delivery platform', scope: 'Acceptance criteria are met.' });
    assert.equal(renamed.name, 'Delivery platform');
    assert.equal(new WorkspaceRegistry(root).getProject(project.id)?.scope, 'Acceptance criteria are met.');
    assert.throws(() => registry.updateProject(project.id, { name: otherProject.name }), /already exists/);

    const task = registry.addProjectTask(project.id, 'Build release', '', agent.id);
    assert.equal(task.assignedAgentId, agent.id);
    assert.throws(() => registry.addProjectTask(project.id, 'Invalid assignment', '', otherAgent.id), /belong to this project/);
    const unassigned = registry.updateProjectTask(project.id, task.id, { assignedAgentId: null });
    assert.equal(unassigned.assignedAgentId, undefined);
    assert.throws(() => registry.updateProjectTask(project.id, task.id, { assignedAgentId: otherAgent.id }), /belong to this project/);
    assert.equal(new WorkspaceRegistry(root).listProjectTasks(project.id)[0].assignedAgentId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('permanent project deletion is limited to archived projects and removes project storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-permanent-delete-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Temporary');
    const agent = registry.createAgent({
      projectId: project.id,
      name: 'Builder',
      emoji: '🧭',
      instructions: 'Work only in this project.',
    });
    registry.createProjectFile(project.id, 'README.md', 'Project data');

    assert.throws(() => registry.deleteArchivedProject(project.id), /archive the project/i);
    assert.equal(registry.archiveProject(project.id).archivedAt !== undefined, true);
    assert.equal(registry.deleteArchivedProject(project.id), true);
    assert.equal(registry.deleteArchivedProject(project.id), false);
    assert.equal(registry.getProject(project.id), undefined);
    assert.equal(registry.getAgent(agent.id), undefined);
    assert.equal(fs.existsSync(path.dirname(project.workspace)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archiving a project removes it and its agents from active workspaces without deleting files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-project-archive-'));
  try {
    const registry = new WorkspaceRegistry(root);
    const project = registry.createProject('Archived');
    const agent = registry.createAgent({
      projectId: project.id,
      name: 'Builder',
      emoji: '🧭',
      instructions: 'Work only in this project.',
    });
    registry.createProjectFile(project.id, 'README.md', 'Retained');

    const archived = registry.archiveProject(project.id);
    assert.ok(archived.archivedAt);
    assert.deepEqual(registry.listProjects(), []);
    assert.deepEqual(registry.listProjects(true).map(item => item.id), [project.id]);
    assert.deepEqual(registry.listAgents(), []);
    assert.equal(fs.existsSync(path.join(project.workspace, 'README.md')), true);
    assert.equal(fs.existsSync(path.join(agent.workspace, 'AGENT_INSTRUCTIONS.md')), true);
    assert.throws(() => registry.listProjectFiles(project.id), /archived/i);
    const restored = registry.restoreProject(project.id);
    assert.equal(restored.archivedAt, undefined);
    assert.deepEqual(registry.listProjects().map(item => item.id), [project.id]);
    assert.deepEqual(registry.listAgents().map(item => item.id), [agent.id]);
    assert.equal(registry.readProjectFile(project.id, 'README.md').content, 'Retained');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project and agent associations persist with session summaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-agent-session-'));
  try {
    const sessions = new SessionManager(root);
    const session = sessions.create('web-profile-chat', {
      label: 'Agent session',
      projectId: 'project-a',
      agentId: 'agent-a',
      sessionKind: 'conversation',
    });

    test('agent and subagent transcripts persist in their project-owned session roots', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-scoped-sessions-'));
      try {
        const registry = new WorkspaceRegistry(root);
        const project = registry.createProject('Scoped');
        const agent = registry.createAgent({
          projectId: project.id,
          name: 'Builder',
          emoji: '🧭',
          instructions: 'Build within this project.',
        });
        const sessions = new SessionManager(path.join(root, '.session'));
        const agentSession = sessions.create(`agent-${project.id}-${agent.id}-thread`, {
          projectId: project.id,
          agentId: agent.id,
          sessionKind: 'conversation',
        });
        const childSession = sessions.create(`agent-${project.id}-${agent.id}-child`, {
          projectId: project.id,
          agentId: agent.id,
          parentSessionId: agentSession.id,
          sessionKind: 'subagent',
          depth: 1,
        });
        const expectedDirectory = path.join(agent.workspace, '.session');

        assert.equal(fs.existsSync(path.join(expectedDirectory, `${agentSession.id}.json`)), true);
        assert.equal(fs.existsSync(path.join(expectedDirectory, `${childSession.id}.json`)), true);
        assert.deepEqual(new SessionManager(path.join(root, '.session')).list().map(item => item.id).sort(), [agentSession.id, childSession.id].sort());
        assert.equal(sessions.archiveSession(agentSession.id), true);
        assert.equal(sessions.archiveSession(childSession.id), true);
        assert.equal(fs.existsSync(path.join(expectedDirectory, 'archive', `${childSession.id}.json`)), true);
        assert.equal(sessions.restoreProjectSessions(project.id), 2);
        assert.deepEqual(sessions.list().map(item => item.id).sort(), [agentSession.id, childSession.id].sort());
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const restored = new SessionManager(root).list()[0];

    assert.equal(restored.id, session.id);
    assert.equal(restored.projectId, 'project-a');
    assert.equal(restored.agentId, 'agent-a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
