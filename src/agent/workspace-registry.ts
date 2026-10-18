import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface WorkspaceProject {
  id: string;
  name: string;
  workspace: string;
  scope?: string;
  createdAt: number;
  archivedAt?: number;
}

export interface WorkspaceFile {
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

export type ProjectTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  assignedAgentId?: string;
  status: ProjectTaskStatus;
  createdAt: number;
  updatedAt: number;
}

export type ProjectTaskPatch = Omit<Partial<Pick<ProjectTask, 'title' | 'description' | 'assignedAgentId' | 'status'>>, 'assignedAgentId'>
  & { assignedAgentId?: string | null };

export interface WorkspaceAgentProfile {
  id: string;
  projectId: string;
  name: string;
  emoji: string;
  instructions: string;
  workspace: string;
  createdAt: number;
}

const MAX_PROJECT_FILES = 10_000;
const BLOCKED_PROJECT_PATH_SEGMENTS = new Set(['.agents', '.git', '.session', 'node_modules']);
const AGENT_ICON_IDS = new Set([
  'bot', 'brain', 'compass', 'leaf', 'sparkles', 'terminal', 'globe', 'database', 'shield',
  'wrench', 'network', 'cpu', 'server', 'message', 'users', 'workflow', 'gauge', 'hard-drive',
  'cloud', 'activity', 'folder', 'layout', 'code', 'search', 'eye',
  '\u{1F916}', '\u{1F9E0}', '\u{1F9ED}', '\u{1F33F}', '\u{2728}',
]);

export function isSupportedAgentIcon(value: string): boolean {
  return AGENT_ICON_IDS.has(value);
}

interface RegistryData {
  version: 1;
  projects: WorkspaceProject[];
  agents: WorkspaceAgentProfile[];
}

function safeName(value: string, field: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${field} must contain 1–80 printable characters.`);
  }
  return name;
}

function readRegistry(filePath: string): RegistryData {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as RegistryData).version !== 1
      || !Array.isArray((parsed as RegistryData).projects) || !Array.isArray((parsed as RegistryData).agents)) {
      throw new Error('Unsupported or malformed agent registry.');
    }
    return parsed as RegistryData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: [], agents: [] };
    throw error;
  }
}

export class WorkspaceRegistry {
  private readonly root: string;
  private readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.root = path.join(path.resolve(workspaceRoot), '.agents');
    this.filePath = path.join(this.root, 'registry.json');
  }

  listProjects(includeArchived = false): WorkspaceProject[] {
    return readRegistry(this.filePath).projects
      .filter(project => includeArchived || !project.archivedAt)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getProject(id: string): WorkspaceProject | undefined {
    return readRegistry(this.filePath).projects.find(project => project.id === id);
  }

  getProjectWorkspacePath(projectId: string): string {
    return this.projectRoot(projectId);
  }

  archiveProject(id: string): WorkspaceProject {
    const data = readRegistry(this.filePath);
    const project = data.projects.find(item => item.id === id);
    if (!project) throw new Error('Project was not found.');
    if (!project.archivedAt) project.archivedAt = Date.now();
    this.write(data);
    return project;
  }

  restoreProject(id: string): WorkspaceProject {
    const data = readRegistry(this.filePath);
    const project = data.projects.find(item => item.id === id);
    if (!project) throw new Error('Project was not found.');
    delete project.archivedAt;
    this.write(data);
    return project;
  }

  listProjectFiles(projectId: string): WorkspaceFile[] {
    const root = this.projectRoot(projectId);
    const files: WorkspaceFile[] = [];
    const visit = (directory: string, depth: number): void => {
      if (depth > 16 || files.length >= MAX_PROJECT_FILES) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (BLOCKED_PROJECT_PATH_SEGMENTS.has(entry.name.toLowerCase()) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
        const absolutePath = path.join(directory, entry.name);
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) continue;
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        if (stat.isDirectory()) {
          files.push({ path: relativePath, type: 'directory', size: 0, modifiedAt: stat.mtimeMs });
          visit(absolutePath, depth + 1);
        } else if (stat.isFile()) {
          files.push({ path: relativePath, type: 'file', size: stat.size, modifiedAt: stat.mtimeMs });
        }
        if (files.length >= MAX_PROJECT_FILES) break;
      }
    };
    visit(root, 0);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  getProjectStorage(projectId: string): { fileCount: number; directoryCount: number; bytes: number } {
    const entries = this.listProjectFiles(projectId);
    return {
      fileCount: entries.filter(entry => entry.type === 'file').length,
      directoryCount: entries.filter(entry => entry.type === 'directory').length,
      bytes: entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.size : 0), 0),
    };
  }

  createProjectDirectory(projectId: string, relativePath: string): { path: string; modifiedAt: number } {
    const { root, absolutePath, parts } = this.resolveProjectPath(projectId, relativePath);
    this.ensureProjectParent(root, parts);
    fs.mkdirSync(absolutePath);
    const stat = fs.statSync(absolutePath);
    return { path: parts.join('/'), modifiedAt: stat.mtimeMs };
  }

  moveProjectEntry(projectId: string, sourcePath: string, destinationPath: string): { path: string } {
    const source = this.resolveProjectPath(projectId, sourcePath);
    const destination = this.resolveProjectPath(projectId, destinationPath);
    this.assertNoSymlink(source.root, sourcePath);
    const sourceStat = fs.lstatSync(source.absolutePath);
    if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) {
      throw new Error('Only regular files and directories can be moved.');
    }
    const sourcePrefix = `${source.absolutePath}${path.sep}`;
    if (sourceStat.isDirectory() && destination.absolutePath.startsWith(sourcePrefix)) {
      throw new Error('A directory cannot be moved inside itself.');
    }
    const destinationParent = this.ensureProjectParent(destination.root, destination.parts);
    const finalPath = path.join(destinationParent, destination.parts.at(-1)!);
    try {
      fs.lstatSync(finalPath);
      throw new Error('A file or folder already exists at the destination.');
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    fs.renameSync(source.absolutePath, finalPath);
    return { path: destination.parts.join('/') };
  }

  deleteProjectEntry(projectId: string, relativePath: string): boolean {
    const { root, absolutePath } = this.resolveProjectPath(projectId, relativePath);
    this.assertNoSymlink(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only regular files and folders can be deleted.');
    fs.rmSync(absolutePath, { recursive: stat.isDirectory(), force: false });
    return true;
  }

  readProjectFile(projectId: string, relativePath: string): { path: string; content: string; size: number } {
    const { root, absolutePath } = this.resolveProjectPath(projectId, relativePath);
    this.assertNoSymlink(root, relativePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error('Only regular project files can be opened.');
    return { path: relativePath.replace(/\\/g, '/'), content: fs.readFileSync(absolutePath, 'utf8'), size: stat.size };
  }

  writeProjectFile(projectId: string, relativePath: string, content: string): { path: string; size: number; modifiedAt: number } {
    const { root, absolutePath, parts } = this.resolveProjectPath(projectId, relativePath);
    const size = Buffer.byteLength(content, 'utf8');
    const parent = this.ensureProjectParent(root, parts);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Only regular project files can be edited.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(parent, `.${parts.at(-1)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, absolutePath);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original write failure. */ }
      throw error;
    }
    const stat = fs.statSync(absolutePath);
    return { path: parts.join('/'), size: stat.size, modifiedAt: stat.mtimeMs };
  }

  createProjectFile(projectId: string, relativePath: string, content = ''): { path: string; size: number; modifiedAt: number } {
    const { root, absolutePath, parts } = this.resolveProjectPath(projectId, relativePath);
    const size = Buffer.byteLength(content, 'utf8');
    this.ensureProjectParent(root, parts);
    const fd = fs.openSync(absolutePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      try { fs.unlinkSync(absolutePath); } catch { /* Preserve the original create failure. */ }
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    const stat = fs.statSync(absolutePath);
    return { path: parts.join('/'), size: stat.size, modifiedAt: stat.mtimeMs };
  }

  deleteProjectFile(projectId: string, relativePath: string): boolean {
    const { root, absolutePath } = this.resolveProjectPath(projectId, relativePath);
    this.assertNoSymlink(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular project files can be deleted.');
    fs.unlinkSync(absolutePath);
    return true;
  }

  listProjectTasks(projectId: string): ProjectTask[] {
    const filePath = this.projectTaskPath(projectId);
    try {
      const tasks: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== 'object'
        || typeof task.id !== 'string' || typeof task.title !== 'string'
        || typeof task.description !== 'string'
        || !['pending', 'in_progress', 'completed', 'blocked'].includes(task.status))) {
        throw new Error('Project task storage is malformed.');
      }
      return (tasks as ProjectTask[]).sort((left, right) => left.createdAt - right.createdAt);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw failure;
    }
  }

  addProjectTask(projectId: string, titleValue: string, descriptionValue = '', assignedAgentId?: string): ProjectTask {
    const title = titleValue.trim();
    const description = descriptionValue.trim();
    if (!title || title.length > 160) throw new Error('Task title must contain 1–160 characters.');
    if (description.length > 4_000) throw new Error('Task description must be 4,000 characters or fewer.');
    if (assignedAgentId !== undefined && !this.listAgents(projectId).some(agent => agent.id === assignedAgentId)) {
      throw new Error('Assigned agent must belong to this project.');
    }
    const tasks = this.listProjectTasks(projectId);
    const timestamp = Date.now();
    const task: ProjectTask = {
      id: randomUUID(),
      title,
      description,
      ...(assignedAgentId ? { assignedAgentId } : {}),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.writeProjectTasks(projectId, [...tasks, task]);
    return task;
  }

  updateProjectTask(projectId: string, id: string, patch: ProjectTaskPatch): ProjectTask {
    const tasks = this.listProjectTasks(projectId);
    const task = tasks.find(item => item.id === id);
    if (!task) throw new Error('Project task was not found.');
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 160) throw new Error('Task title must contain 1–160 characters.');
      task.title = title;
    }
    if (patch.description !== undefined) {
      const description = patch.description.trim();
      if (description.length > 4_000) throw new Error('Task description must be 4,000 characters or fewer.');
      task.description = description;
    }
    if (patch.assignedAgentId !== undefined) {
      if (patch.assignedAgentId !== null && !this.listAgents(projectId).some(agent => agent.id === patch.assignedAgentId)) {
        throw new Error('Assigned agent must belong to this project.');
      }
      if (patch.assignedAgentId) task.assignedAgentId = patch.assignedAgentId;
      else delete task.assignedAgentId;
    }
    if (patch.status !== undefined) {
      if (!['pending', 'in_progress', 'completed', 'blocked'].includes(patch.status)) throw new Error('Choose a valid project task status.');
      task.status = patch.status;
    }
    task.updatedAt = Date.now();
    this.writeProjectTasks(projectId, tasks);
    return task;
  }

  deleteProjectTask(projectId: string, id: string): boolean {
    const tasks = this.listProjectTasks(projectId);
    const next = tasks.filter(task => task.id !== id);
    if (next.length === tasks.length) return false;
    this.writeProjectTasks(projectId, next);
    return true;
  }

  listAgents(projectId?: string): WorkspaceAgentProfile[] {
    const data = readRegistry(this.filePath);
    const activeProjects = new Set(data.projects.filter(project => !project.archivedAt).map(project => project.id));
    return data.agents
      .filter(agent => activeProjects.has(agent.projectId) && (!projectId || agent.projectId === projectId))
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getAgent(id: string): WorkspaceAgentProfile | undefined {
    return readRegistry(this.filePath).agents.find(agent => agent.id === id);
  }

  createProject(nameValue: string, scopeValue = ''): WorkspaceProject {
    const name = safeName(nameValue, 'Project name');
    const scope = scopeValue.trim();
    if (scope.length > 4_000) throw new Error('Project work scope must be 4,000 characters or fewer.');
    const data = readRegistry(this.filePath);
    if (data.projects.some(project => project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error(`A project named "${name}" already exists.`);
    }
    const id = randomUUID();
    const workspace = path.join(this.root, 'projects', id, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(this.root, 'projects', id, '.session'), { recursive: true });
    const project = { id, name, workspace, scope, createdAt: Date.now() };
    data.projects.push(project);
    this.write(data);
    return project;
  }

  updateProject(id: string, patch: Partial<Pick<WorkspaceProject, 'name' | 'scope'>>): WorkspaceProject {
    const data = readRegistry(this.filePath);
    const project = data.projects.find(item => item.id === id && !item.archivedAt);
    if (!project) throw new Error('Active project was not found.');
    if (patch.name !== undefined) {
      const name = safeName(patch.name, 'Project name');
      if (data.projects.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error(`A project named "${name}" already exists.`);
      }
      project.name = name;
    }
    if (patch.scope !== undefined) {
      const scope = patch.scope.trim();
      if (scope.length > 4_000) throw new Error('Project work scope must be 4,000 characters or fewer.');
      project.scope = scope;
    }
    this.write(data);
    return project;
  }

  deleteArchivedProject(id: string): boolean {
    const data = readRegistry(this.filePath);
    const project = data.projects.find(item => item.id === id);
    if (!project) return false;
    if (!project.archivedAt) throw new Error('Archive the project before permanently deleting it.');

    const projectDirectory = path.resolve(this.root, 'projects', project.id);
    const projectsRoot = path.resolve(this.root, 'projects');
    if (!projectDirectory.startsWith(`${projectsRoot}${path.sep}`)) throw new Error('Project storage path is invalid.');
    const rootStat = fs.lstatSync(this.root);
    if (rootStat.isSymbolicLink()) throw new Error('Project registry cannot be a symbolic link.');
    const projectsStat = fs.lstatSync(projectsRoot);
    if (projectsStat.isSymbolicLink()) throw new Error('Project storage cannot be a symbolic link.');
    const directoryStat = fs.lstatSync(projectDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Project storage is not a regular directory.');

    const tombstone = path.join(this.root, `.deleted-${project.id}-${randomUUID()}`);
    fs.renameSync(projectDirectory, tombstone);
    const next = {
      ...data,
      projects: data.projects.filter(item => item.id !== id),
      agents: data.agents.filter(agent => agent.projectId !== id),
    };
    try {
      this.write(next);
    } catch (failure) {
      try {
        fs.renameSync(tombstone, projectDirectory);
      } catch (rollbackFailure) {
        throw new Error(`Project deletion could not be recorded and storage rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`);
      }
      throw failure;
    }
    fs.rmSync(tombstone, { recursive: true, force: false });
    return true;
  }

  createAgent(input: { projectId: string; name: string; emoji: string; instructions: string }): WorkspaceAgentProfile {
    const data = readRegistry(this.filePath);
    const project = data.projects.find(item => item.id === input.projectId);
    if (!project || project.archivedAt) throw new Error('Select an active project before creating an agent.');
    const name = safeName(input.name, 'Agent name');
    const instructions = input.instructions.trim();
    if (instructions.length > 20_000) throw new Error('Agent instructions must be 20,000 characters or fewer.');
    if (!isSupportedAgentIcon(input.emoji)) throw new Error('Choose a supported agent icon.');
    if (data.agents.some(agent => agent.projectId === project.id && agent.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error(`An agent named "${name}" already exists in this project.`);
    }
    const id = randomUUID();
    const workspace = path.join(this.root, 'projects', project.id, 'agents', id);
    fs.mkdirSync(path.join(workspace, '.session'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'AGENT_INSTRUCTIONS.md'), instructions, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const agent = { id, projectId: project.id, name, emoji: input.emoji, instructions, workspace, createdAt: Date.now() };
    data.agents.push(agent);
    this.write(data);
    return agent;
  }

  private write(data: RegistryData): void {
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the registry write error. */ }
      throw error;
    }
  }

  private projectRoot(projectId: string): string {
    const project = this.getProject(projectId);
    if (!project) throw new Error('Project was not found.');
    if (project.archivedAt) throw new Error('Archived project workspaces are unavailable in the active IDE.');
    const expected = path.resolve(this.root, 'projects', project.id, 'workspace');
    if (path.resolve(project.workspace) !== expected) throw new Error('Project workspace metadata is invalid.');
    const root = path.resolve(this.root);
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Project registry cannot be a symbolic link.');
    let current = root;
    for (const part of ['projects', project.id, 'workspace']) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Project workspaces cannot traverse symbolic links.');
    }
    const realRoot = fs.realpathSync(expected);
    if (path.relative(expected, realRoot) !== '') throw new Error('Project workspace resolves outside its registered location.');
    return realRoot;
  }

  private projectTaskPath(projectId: string): string {
    this.projectRoot(projectId);
    const projectDirectory = path.join(this.root, 'projects', projectId);
    const sessionDirectory = path.join(projectDirectory, '.session');
    for (const directory of [projectDirectory, sessionDirectory]) {
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Project task storage cannot traverse symbolic links.');
    }
    return path.join(sessionDirectory, 'project-tasks.json');
  }

  private writeProjectTasks(projectId: string, tasks: ProjectTask[]): void {
    const filePath = this.projectTaskPath(projectId);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } catch (failure) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the original storage error. */ }
      throw failure;
    }
  }

  private resolveProjectPath(projectId: string, value: string): { root: string; absolutePath: string; parts: string[] } {
    const root = this.projectRoot(projectId);
    const normalized = value.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (!normalized || normalized.length > 500 || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part)
        || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)
        || BLOCKED_PROJECT_PATH_SEGMENTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) {
      throw new Error('Project file path is invalid or reserved.');
    }
    const absolutePath = path.resolve(root, ...parts);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Project file path escapes the workspace.');
    return { root, absolutePath, parts };
  }

  private ensureProjectParent(root: string, parts: string[]): string {
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      try {
        const stat = fs.lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Project paths cannot traverse symbolic links or non-directories.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fs.mkdirSync(parent);
      }
    }
    return parent;
  }

  private assertNoSymlink(root: string, relativePath: string): void {
    const parts = relativePath.replace(/\\/g, '/').split('/');
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Project file paths cannot follow symbolic links.');
    }
  }
}
