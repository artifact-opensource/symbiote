import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Editor from '@monaco-editor/react';
import { Archive, ChevronDown, File, FilePlus2, Folder, FolderPlus, GitBranch, HardDrive, ListTodo, Pencil, Play, Plus, RefreshCw, Save, Terminal, Trash2, X } from 'lucide-react';
import type { AgentProfile, WorkspaceFile, WorkspaceProject } from '../types';
import ActivityOrb from './ActivityOrb';

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;
type ProjectFileContent = { path: string; content: string; size: number };
type ProjectPlanTask = { id: string; title: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked'; createdAt: number; updatedAt: number };
type TerminalTab = { id: string; name: string; output: string; command: string; busy: boolean; terminalId?: string; running?: boolean };
type EntryDialog = { kind: 'file' | 'directory' | 'move'; value: string };
type Confirmation = { message: string; onConfirm: () => void };

let terminalSequence = 0;

function createTerminalTab(name: string): TerminalTab {
  terminalSequence++;
  return { id: `terminal-${Date.now()}-${terminalSequence}`, name, output: '', command: '', busy: false };
}

function formatStorage(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function languageForPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    c: 'c', cc: 'cpp', cjs: 'javascript', cpp: 'cpp', cs: 'csharp', css: 'css', dart: 'dart', dockerfile: 'dockerfile',
    go: 'go', graphql: 'graphql', h: 'cpp', hpp: 'cpp', html: 'html', java: 'java', js: 'javascript', json: 'json',
    jsx: 'javascript', kt: 'kotlin', less: 'less', lua: 'lua', md: 'markdown', mjs: 'javascript', php: 'php',
    pl: 'perl', py: 'python', r: 'r', rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'shell', sql: 'sql', swift: 'swift',
    ts: 'typescript', tsx: 'typescript', txt: 'plaintext', xml: 'xml', yaml: 'yaml', yml: 'yaml',
  };
  return extension ? languages[extension] ?? 'plaintext' : 'plaintext';
}

export default function ProjectIDE({ projects, profiles, onArchiveProject, onRunTask, request, dark }: {
  projects: WorkspaceProject[];
  profiles: AgentProfile[];
  onArchiveProject: (projectId: string) => Promise<boolean>;
  onRunTask: (projectId: string, prompt: string, agentId?: string) => Promise<boolean>;
  request: Request;
  dark: boolean;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [storage, setStorage] = useState({ fileCount: 0, directoryCount: 0, bytes: 0 });
  const [selectedPath, setSelectedPath] = useState('');
  const [selectedEntryPath, setSelectedEntryPath] = useState('');
  const [collapsedDirectories, setCollapsedDirectories] = useState<string[]>([]);
  const [idePanel, setIdePanel] = useState<'files' | 'plan'>('files');
  const [projectTasks, setProjectTasks] = useState<ProjectPlanTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('Inspect the project, identify its test command, run the relevant tests, and report failures with actionable fixes.');
  const [taskAgentId, setTaskAgentId] = useState('');
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningTask, setRunningTask] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>(() => [createTerminalTab('Terminal 1')]);
  const [activeTerminalId, setActiveTerminalId] = useState(() => terminalTabs[0].id);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [entryDialog, setEntryDialog] = useState<EntryDialog | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const terminalTabsRef = useRef(terminalTabs);
  const selectedProjectIdRef = useRef(selectedProjectId);
  terminalTabsRef.current = terminalTabs;
  selectedProjectIdRef.current = selectedProjectId;
  const dirty = content !== savedContent;
  const selectedProject = projects.find(project => project.id === selectedProjectId);
  const projectProfiles = useMemo(
    () => profiles.filter(profile => profile.projectId === selectedProjectId),
    [profiles, selectedProjectId],
  );
  const refreshFiles = useCallback(async (projectId: string) => {
    setLoadingFiles(true);
    setError('');
    try {
      const [nextFiles, nextStorage] = await Promise.all([
        request<WorkspaceFile[]>(`/api/projects/${encodeURIComponent(projectId)}/files`),
        request<typeof storage>(`/api/projects/${encodeURIComponent(projectId)}/storage`),
      ]);
      setFiles(nextFiles);
      setStorage(nextStorage);
      setSelectedPath(current => nextFiles.some(file => file.path === current && file.type === 'file')
        ? current
        : nextFiles.find(file => file.type === 'file')?.path ?? '');
    } catch (failure) {
      setFiles([]);
      setStorage({ fileCount: 0, directoryCount: 0, bytes: 0 });
      setSelectedPath('');
      setError(failure instanceof Error ? failure.message : 'Project files could not be loaded.');
    } finally {
      setLoadingFiles(false);
    }
  }, [request]);

  const refreshTasks = useCallback(async (projectId: string) => {
    try {
      setProjectTasks(await request<ProjectPlanTask[]>(`/api/projects/${encodeURIComponent(projectId)}/tasks`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project plan could not be refreshed.');
    }
  }, [request]);

  useEffect(() => {
    setContent('');
    setSavedContent('');
    setSelectedPath('');
    setSelectedEntryPath('');
    setCollapsedDirectories([]);
    setProjectTasks([]);
    setTaskAgentId('');
    const firstTerminal = createTerminalTab('Terminal 1');
    setTerminalTabs([firstTerminal]);
    setActiveTerminalId(firstTerminal.id);
    if (selectedProjectId) void refreshFiles(selectedProjectId);
    else setFiles([]);
  }, [selectedProjectId, refreshFiles]);

  useEffect(() => {
    if (!selectedProjectId) return;
    void refreshTasks(selectedProjectId);
    const timer = window.setInterval(() => void refreshTasks(selectedProjectId), 3000);
    return () => window.clearInterval(timer);
  }, [refreshTasks, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) return;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const tabs = terminalTabsRef.current.filter(tab => tab.terminalId && tab.running !== false);
        await Promise.all(tabs.map(async tab => {
          const result = await request<{ output: string; running: boolean; exitCode: number | null; truncated: boolean }>(
            `/api/projects/${encodeURIComponent(selectedProjectId)}/terminal?${new URLSearchParams({ terminalId: tab.terminalId! })}`,
          );
          setTerminalTabs(current => current.map(item => item.id === tab.id
            ? {
              ...item,
              output: `${item.output}${result.truncated ? '\n[Earlier terminal output was truncated.]\n' : ''}${result.output}`,
              running: result.running,
              busy: result.running ? item.busy : false,
            }
            : item));
        }));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Project terminal output could not be read.');
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 500);
    void poll();
    return () => window.clearInterval(timer);
  }, [request, selectedProjectId]);

  useEffect(() => () => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return;
    for (const tab of terminalTabsRef.current) {
      if (tab.terminalId) {
        void request(`/api/projects/${encodeURIComponent(projectId)}/terminal?${new URLSearchParams({ terminalId: tab.terminalId })}`, { method: 'DELETE' })
          .catch(failure => console.error('Project terminal cleanup failed:', failure));
      }
    }
  }, [request]);

  useEffect(() => {
    if (!selectedProjectId || !selectedPath) {
      setContent('');
      setSavedContent('');
      return;
    }
    let cancelled = false;
    setLoadingFile(true);
    setError('');
    request<ProjectFileContent>(`/api/projects/${encodeURIComponent(selectedProjectId)}/file?${new URLSearchParams({ path: selectedPath })}`)
      .then(file => {
        if (cancelled) return;
        setContent(file.content);
        setSavedContent(file.content);
      })
      .catch(failure => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Project file could not be opened.');
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    return () => { cancelled = true; };
  }, [request, selectedPath, selectedProjectId]);

  const openFile = (filePath: string) => {
    if (filePath === selectedPath) {
      setSelectedEntryPath(filePath);
      return;
    }
    const open = () => {
      setSelectedEntryPath(filePath);
      setSelectedPath(filePath);
    };
    if (dirty) setConfirmation({ message: 'Discard the unsaved changes in the current file?', onConfirm: open });
    else open();
  };

  const saveFile = async () => {
    if (!selectedProjectId || !selectedPath) return false;
    if (!dirty) return true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: selectedPath, content }),
      });
      setSavedContent(content);
      setNotice('Saved');
      void refreshFiles(selectedProjectId);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project file could not be saved.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createFile = async (filePath: string) => {
    if (!selectedProjectId) return;
    const normalizedPath = filePath.trim().replace(/\\/g, '/');
    if (!normalizedPath) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/file`, {
        method: 'POST',
        body: JSON.stringify({ path: normalizedPath, content: '' }),
      });
      await refreshFiles(selectedProjectId);
      setSelectedPath(normalizedPath);
      setSelectedEntryPath(normalizedPath);
      setNotice('File created');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project file could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const createDirectory = async (folderPath: string) => {
    if (!selectedProjectId) return;
    const normalizedPath = folderPath.trim().replace(/\\/g, '/');
    if (!normalizedPath) return;
    setSaving(true);
    setError('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/directories`, {
        method: 'POST',
        body: JSON.stringify({ path: normalizedPath }),
      });
      await refreshFiles(selectedProjectId);
      setNotice('Folder created');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Folder could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const moveEntry = async (destination: string) => {
    if (!selectedProjectId || !selectedEntryPath) return;
    const normalizedDestination = destination.trim().replace(/\\/g, '/');
    if (!normalizedDestination || normalizedDestination === selectedEntryPath) return;
    setSaving(true);
    setError('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/entries`, {
        method: 'PATCH',
        body: JSON.stringify({ path: selectedEntryPath, destination: normalizedDestination }),
      });
      if (selectedPath === selectedEntryPath) setSelectedPath(normalizedDestination);
      setSelectedEntryPath(normalizedDestination);
      await refreshFiles(selectedProjectId);
      setNotice('File or folder moved');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'File or folder could not be moved.');
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async () => {
    if (!selectedProjectId || !selectedEntryPath) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/entries`, {
        method: 'DELETE',
        body: JSON.stringify({ path: selectedEntryPath }),
      });
      if (selectedPath === selectedEntryPath || selectedPath.startsWith(`${selectedEntryPath}/`)) {
        setContent('');
        setSavedContent('');
        setSelectedPath('');
      }
      setSelectedEntryPath('');
      await refreshFiles(selectedProjectId);
      setNotice('File or folder deleted');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'File or folder could not be deleted.');
    } finally {
      setSaving(false);
    }
  };

  const addPlanTask = async (event: FormEvent) => {
    event.preventDefault();
    const title = newTaskTitle.trim();
    if (!selectedProjectId || !title) return;
    setError('');
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setNewTaskTitle('');
      await refreshTasks(selectedProjectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Plan item could not be created.');
    }
  };

  const updatePlanTask = async (task: ProjectPlanTask, status: ProjectPlanTask['status']) => {
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await refreshTasks(selectedProjectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Plan item could not be updated.');
    }
  };

  const deletePlanTask = async (task: ProjectPlanTask) => {
    try {
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      await refreshTasks(selectedProjectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Plan item could not be deleted.');
    }
  };

  const submitTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId || !taskPrompt.trim()) return;
    setRunningTask(true);
    setError('');
    setNotice('');
    if (dirty && !(await saveFile())) {
      setRunningTask(false);
      return;
    }
    try {
      const started = await onRunTask(selectedProjectId, taskPrompt.trim(), taskAgentId || undefined);
      if (started) setNotice('Agent task started. Follow its progress in Tasks.');
      else setError('The agent task could not be started.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent task could not be started.');
    } finally {
      setRunningTask(false);
    }
  };

  const archiveProject = async () => {
    const archived = await onArchiveProject(selectedProjectId);
    if (archived) {
      setNotice('Project and its sessions were archived.');
      setSelectedProjectId('');
    }
  };

  const submitEntryDialog = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!entryDialog?.value.trim()) return;
    const dialog = entryDialog;
    setEntryDialog(null);
    if (dialog.kind === 'file') void createFile(dialog.value);
    else if (dialog.kind === 'directory') void createDirectory(dialog.value);
    else void moveEntry(dialog.value);
  };

  const openEntryDialog = (kind: EntryDialog['kind'], value = '') => {
    const open = () => setEntryDialog({ kind, value });
    if (kind === 'file' && dirty) {
      setConfirmation({ message: 'Discard the unsaved changes in the current file?', onConfirm: open });
    } else if (kind === 'move' && dirty) {
      setConfirmation({ message: 'Discard unsaved changes before moving this entry?', onConfirm: open });
    } else {
      open();
    }
  };

  const activeTerminal = terminalTabs.find(tab => tab.id === activeTerminalId);
  const stopProjectTerminals = () => {
    const projectId = selectedProjectId;
    if (!projectId) return;
    for (const tab of terminalTabs) {
      if (tab.terminalId) {
        void request(`/api/projects/${encodeURIComponent(projectId)}/terminal?${new URLSearchParams({ terminalId: tab.terminalId })}`, { method: 'DELETE' })
          .catch(failure => console.error('Project terminal cleanup failed:', failure));
      }
    }
  };
  const runTerminalCommand = async (command = activeTerminal?.command ?? '') => {
    const trimmed = command.trim();
    if (!trimmed || activeTerminal?.busy) return;
    setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId ? { ...tab, busy: true } : tab));
    setError('');
    if (dirty && !(await saveFile())) {
      setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId ? { ...tab, busy: false } : tab));
      return;
    }
    try {
      let terminalId = activeTerminal?.terminalId;
      if (!terminalId) {
        const started = await request<{ terminalId: string }>(`/api/projects/${encodeURIComponent(selectedProjectId)}/terminal`, {
          method: 'POST',
          body: JSON.stringify({ action: 'start' }),
        });
        terminalId = started.terminalId;
        setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId ? { ...tab, terminalId, running: true } : tab));
      }
      await request(`/api/projects/${encodeURIComponent(selectedProjectId)}/terminal`, {
        method: 'POST',
        body: JSON.stringify({ action: 'input', terminalId, input: `${trimmed}\n` }),
      });
      setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId
        ? { ...tab, command: '', output: `${tab.output}${tab.output ? '\n' : ''}$ ${trimmed}\n` }
        : tab));
    } catch (failure) {
      setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId
        ? { ...tab, output: `${tab.output}${tab.output ? '\n\n' : ''}$ ${trimmed}\n${failure instanceof Error ? failure.message : 'Command failed.'}` }
        : tab));
    } finally {
      setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId ? { ...tab, busy: false } : tab));
    }
  };

  const addTerminal = () => {
    const number = terminalTabs.length + 1;
    const tab = createTerminalTab(`Terminal ${number}`);
    setTerminalTabs(current => [...current, tab]);
    setActiveTerminalId(tab.id);
  };

  const closeTerminal = (id: string) => {
    const closing = terminalTabs.find(tab => tab.id === id);
    if (closing?.terminalId) {
      void request(`/api/projects/${encodeURIComponent(selectedProjectId)}/terminal?${new URLSearchParams({ terminalId: closing.terminalId })}`, { method: 'DELETE' })
        .catch(failure => setError(failure instanceof Error ? failure.message : 'Project terminal could not be stopped.'));
    }
    if (terminalTabs.length === 1) {
      const replacement = createTerminalTab('Terminal 1');
      setTerminalTabs([replacement]);
      setActiveTerminalId(replacement.id);
      return;
    }
    const next = terminalTabs.filter(tab => tab.id !== id);
    setTerminalTabs(next);
    if (activeTerminalId === id) setActiveTerminalId(next.at(-1)?.id ?? '');
  };

  const visibleEntries = useMemo(() => files.filter(entry => {
    const parts = entry.path.split('/');
    return !parts.slice(0, -1).some((_part, index) => collapsedDirectories.includes(parts.slice(0, index + 1).join('/')));
  }), [collapsedDirectories, files]);

  if (!selectedProject) {
    return (
      <section className="project-ide-project-picker" aria-labelledby="project-ide-picker-title">
        <header><span className="eyebrow">PROJECT WORKSPACES</span><h1 id="project-ide-picker-title">Choose a project to work in</h1><p>Open an isolated workspace here. This does not change the project used by Conversations or Agents.</p></header>
        {projects.length ? <div className="project-ide-project-grid">{projects.map(project => (
          <button key={project.id} type="button" className="project-ide-project-card" onClick={() => setSelectedProjectId(project.id)}>
            <span className="project-ide-project-icon"><Folder size={17} /></span>
            <strong>{project.name}</strong>
            <span>{project.scope || 'No work scope defined'}</span>
            <small>{project.workspace}</small>
          </button>
        ))}</div> : <div className="project-ide-empty surface-card"><Folder size={28} /><h2>No active projects</h2><p>Create a project from the Projects panel to give agents an isolated workspace.</p></div>}
      </section>
    );
  }

  return (
    <section className="project-ide" aria-label={`${selectedProject.name} project IDE`}>
      <header className="project-ide-header">
        <div className="project-ide-title">
          <span className="eyebrow">PROJECT WORKSPACE</span>
          <h1>{selectedProject.name}</h1>
        </div>
        <button type="button" className="button button-secondary project-ide-back" onClick={() => {
          const leave = () => { stopProjectTerminals(); setSelectedProjectId(''); };
          if (dirty) setConfirmation({ message: 'Discard the unsaved changes in the current file and leave the project?', onConfirm: leave });
          else leave();
        }}><Folder size={14} /><span>Projects</span></button>
        <span className="project-ide-storage" title={`${storage.fileCount} files · ${storage.directoryCount} folders`}>
          <HardDrive size={13} />{formatStorage(storage.bytes)}
        </span>
        <button type="button" className="button button-secondary project-ide-archive" onClick={() => {
          if (dirty) setConfirmation({ message: 'Archive this project and discard unsaved file changes?', onConfirm: () => void archiveProject() });
          else void archiveProject();
        }} aria-label="Archive project" title="Archive project and its agents"><Archive size={14} /><span>Archive</span></button>
      </header>

      {error && <div className="project-ide-feedback project-ide-error" role="alert">{error}</div>}
      {notice && <div className="project-ide-feedback" role="status">{notice}</div>}
      <form className="project-ide-task" onSubmit={event => void submitTask(event)}>
        <div className="project-ide-task-heading">
          <label htmlFor="project-ide-task"><Play size={13} /> Agent task</label>
          <small>Run a project-scoped task. Unsaved editor changes are saved first.</small>
        </div>
        <textarea id="project-ide-task" value={taskPrompt} onChange={event => setTaskPrompt(event.target.value)} rows={2} />
        <div className="project-ide-task-controls">
          <label className="sr-only" htmlFor="project-ide-agent">Run as</label>
          <select id="project-ide-agent" value={taskAgentId} onChange={event => setTaskAgentId(event.target.value)}>
            <option value="">Symbiant · Main agent</option>
            {projectProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <button className="button button-primary" type="submit" disabled={runningTask || !taskPrompt.trim()}>
            {runningTask ? <ActivityOrb label="Starting project task" compact loading /> : <Play size={14} />}
            <span>{runningTask ? 'Starting…' : 'Run'}</span>
          </button>
        </div>
      </form>
      {entryDialog && <div className="project-ide-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEntryDialog(null); }}>
        <section className="project-ide-dialog" role="dialog" aria-modal="true" aria-labelledby="project-ide-entry-dialog-title">
          <header><h2 id="project-ide-entry-dialog-title">{entryDialog.kind === 'file' ? 'Create file' : entryDialog.kind === 'directory' ? 'Create folder' : 'Move or rename entry'}</h2><button type="button" className="icon-button small" onClick={() => setEntryDialog(null)} aria-label="Close dialog"><X size={15} /></button></header>
          <form onSubmit={submitEntryDialog}>
            <label htmlFor="project-ide-entry-path">Project-relative path</label>
            <input id="project-ide-entry-path" autoFocus value={entryDialog.value} onChange={event => setEntryDialog(current => current ? { ...current, value: event.target.value } : current)} placeholder={entryDialog.kind === 'file' ? 'src/index.ts' : entryDialog.kind === 'directory' ? 'src/components' : 'new/path'} />
            <div className="project-ide-dialog-actions">
              <button type="button" className="button button-secondary" onClick={() => setEntryDialog(null)}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={!entryDialog.value.trim()}>{entryDialog.kind === 'file' ? 'Create file' : entryDialog.kind === 'directory' ? 'Create folder' : 'Move'}</button>
            </div>
          </form>
        </section>
      </div>}
      {confirmation && <div className="project-ide-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmation(null); }}>
        <section className="project-ide-dialog" role="dialog" aria-modal="true" aria-labelledby="project-ide-confirm-title">
          <header><h2 id="project-ide-confirm-title">Confirm action</h2><button type="button" className="icon-button small" onClick={() => setConfirmation(null)} aria-label="Close dialog"><X size={15} /></button></header>
          <p>{confirmation.message}</p>
          <div className="project-ide-dialog-actions">
            <button type="button" className="button button-secondary" onClick={() => setConfirmation(null)}>Cancel</button>
            <button type="button" className="button button-primary" onClick={() => { const action = confirmation.onConfirm; setConfirmation(null); action(); }}>Continue</button>
          </div>
        </section>
      </div>}

      <div className="project-ide-workbench">
        <aside className="project-ide-explorer" aria-label="Project files">
          <div className="project-ide-explorer-header">
            <div className="project-ide-explorer-tabs">
              <button type="button" className={idePanel === 'files' ? 'project-ide-explorer-tab project-ide-explorer-tab-active' : 'project-ide-explorer-tab'} onClick={() => setIdePanel('files')}><Folder size={13} />Files</button>
              <button type="button" className={idePanel === 'plan' ? 'project-ide-explorer-tab project-ide-explorer-tab-active' : 'project-ide-explorer-tab'} onClick={() => setIdePanel('plan')}><ListTodo size={13} />Plan <span>{projectTasks.filter(task => task.status !== 'completed').length}</span></button>
            </div>
            <div>
              {idePanel === 'files' ? <>
                <button type="button" className="icon-button small" onClick={() => openEntryDialog('file')} disabled={saving} aria-label="Create project file" title="New file"><FilePlus2 size={15} /></button>
                <button type="button" className="icon-button small" onClick={() => openEntryDialog('directory')} disabled={saving} aria-label="Create project folder" title="New folder"><FolderPlus size={15} /></button>
                <button type="button" className="icon-button small" onClick={() => void refreshFiles(selectedProjectId)} disabled={loadingFiles} aria-label="Refresh project files" title="Refresh"><RefreshCw size={14} /></button>
              </> : <button type="button" className="icon-button small" onClick={() => void refreshTasks(selectedProjectId)} aria-label="Refresh project plan" title="Refresh plan"><RefreshCw size={14} /></button>}
            </div>
          </div>
          {idePanel === 'files' ? <div className="project-ide-file-list">
            {loadingFiles && <span className="project-ide-muted"><ActivityOrb label="Loading files" compact loading /> Loading files</span>}
            {!loadingFiles && visibleEntries.map(entry => {
              const depth = entry.path.split('/').length - 1;
              const isDirectory = entry.type === 'directory';
              const active = selectedEntryPath === entry.path;
              return (
                <button
                  type="button"
                  key={entry.path}
                  className={`project-ide-file${active ? ' project-ide-file-active' : ''}`}
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={() => {
                    if (isDirectory) {
                      setSelectedEntryPath(entry.path);
                      setCollapsedDirectories(current => current.includes(entry.path) ? current.filter(path => path !== entry.path) : [...current, entry.path]);
                    } else openFile(entry.path);
                  }}
                  title={`${entry.path}${isDirectory ? ' · folder' : ` · ${formatStorage(entry.size)}`}`}
                >
                  <span className="project-ide-file-chevron">{isDirectory ? (collapsedDirectories.includes(entry.path) ? '›' : '⌄') : ''}</span>
                  {isDirectory ? <Folder size={14} /> : <File size={13} />}
                  <span>{entry.path.split('/').at(-1)}</span>
                </button>
              );
            })}
            {!loadingFiles && files.length === 0 && <p className="project-ide-muted">No files yet. Create a file or folder to begin.</p>}
          </div> : <div className="project-ide-plan">
            <form className="project-ide-plan-add" onSubmit={event => void addPlanTask(event)}>
              <input aria-label="New plan item" placeholder="Add a task to this project…" value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} maxLength={160} />
              <button type="submit" className="icon-button small" disabled={!newTaskTitle.trim()} aria-label="Add plan item"><Plus size={15} /></button>
            </form>
            <div className="project-ide-plan-list" aria-live="polite">
              {projectTasks.map(task => <article key={task.id} className={`project-ide-plan-task project-ide-plan-${task.status}`}>
                <label><span className="sr-only">Task status</span><select aria-label={`Status for ${task.title}`} value={task.status} onChange={event => void updatePlanTask(task, event.target.value as ProjectPlanTask['status'])}>
                  <option value="pending">To do</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="completed">Done</option>
                </select></label>
                <span><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}</span>
                <button type="button" className="icon-button small" onClick={() => void deletePlanTask(task)} aria-label={`Delete ${task.title}`} title="Delete plan item"><X size={13} /></button>
              </article>)}
              {!projectTasks.length && <p className="project-ide-muted">Project plans stay here and update live as agents work.</p>}
            </div>
          </div>}
        </aside>

        <div className="project-ide-editor-pane">
          <div className="project-ide-toolbar">
            <div className="project-ide-breadcrumb">{selectedPath || 'No file selected'}{dirty && <span aria-label="Unsaved changes"> •</span>}</div>
            <div className="project-ide-actions">
              {notice && <span className="project-ide-muted">{notice}</span>}
              <button type="button" className="icon-button small" onClick={() => void saveFile()} disabled={!dirty || saving} aria-label="Save file" title="Save (Ctrl/Cmd+S)">
                {saving ? <ActivityOrb label="Saving file" compact loading /> : <Save size={15} />}
              </button>
              <button type="button" className="icon-button small" onClick={() => openEntryDialog('move', selectedEntryPath.split('/').at(-1) ?? selectedEntryPath)} disabled={!selectedEntryPath || saving} aria-label="Rename or move selected entry" title="Rename or move"><Pencil size={14} /></button>
              <button type="button" className="icon-button small" onClick={() => setConfirmation({ message: `Delete ${selectedEntryPath}? Folder contents will also be removed.`, onConfirm: () => void deleteEntry() })} disabled={!selectedEntryPath || saving} aria-label="Delete selected entry" title="Delete file or folder"><Trash2 size={15} /></button>
            </div>
          </div>
          <div className="project-ide-editor">
            {loadingFile ? <div className="project-ide-editor-loading"><ActivityOrb label="Opening file" loading /> Opening file…</div>
              : selectedPath ? <Editor
                height="100%"
                path={selectedPath}
                language={languageForPath(selectedPath)}
                theme={dark ? 'vs-dark' : 'light'}
                value={content}
                onChange={value => setContent(value ?? '')}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  scrollbar: { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false },
                  fontSize: 13,
                  lineHeight: 21,
                  tabSize: 2,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  padding: { top: 16 },
                }}
              /> : <div className="project-ide-editor-loading">Choose a file or create a new one.</div>}
          </div>
          <section className={`project-ide-terminal${terminalOpen ? ' project-ide-terminal-open' : ''}`} aria-label="Project terminal">
            <header className="project-ide-terminal-header">
              <button type="button" className="project-ide-terminal-toggle" onClick={() => setTerminalOpen(open => !open)} aria-expanded={terminalOpen}>
                <Terminal size={14} /><span>TERMINAL</span><ChevronDown size={13} />
              </button>
              <div className="project-ide-terminal-tabs" role="tablist" aria-label="Terminal sessions">
                {terminalTabs.map(tab => <div key={tab.id} className={`project-ide-terminal-tab${tab.id === activeTerminalId ? ' project-ide-terminal-tab-active' : ''}`}>
                  <button type="button" role="tab" aria-selected={tab.id === activeTerminalId} onClick={() => setActiveTerminalId(tab.id)}>{tab.name}{tab.terminalId && tab.running === false ? ' · exited' : ''}</button>
                  <button type="button" aria-label={`Close ${tab.name}`} title={`Close ${tab.name}`} onClick={() => closeTerminal(tab.id)}><X size={11} /></button>
                </div>)}
                <button type="button" className="icon-button small" onClick={addTerminal} aria-label="New terminal" title="New terminal"><Plus size={14} /></button>
                <button type="button" className="icon-button small" onClick={() => void runTerminalCommand('git status --short --branch')} disabled={activeTerminal?.busy} aria-label="Run Git status" title="Git status"><GitBranch size={14} /></button>
              </div>
            </header>
            {terminalOpen && (
              <>
                <form className="project-ide-terminal-form" onSubmit={event => { event.preventDefault(); void runTerminalCommand(); }}>
                  <span aria-hidden="true">$</span>
                  <textarea
                    aria-label="Terminal command"
                    placeholder="Run a shell or Git command in this project…"
                    value={activeTerminal?.command ?? ''}
                    onChange={event => setTerminalTabs(current => current.map(tab => tab.id === activeTerminalId ? { ...tab, command: event.target.value } : tab))}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void runTerminalCommand();
                      }
                    }}
                    rows={1}
                    maxLength={20_000}
                  />
                  <button type="submit" className="icon-button small" disabled={activeTerminal?.busy || !activeTerminal?.command.trim()} aria-label="Run command" title="Run (Ctrl/Cmd+Enter)">
                    {activeTerminal?.busy ? <ActivityOrb label="Running terminal command" compact loading /> : <Play size={13} />}
                  </button>
                </form>
                <pre className="project-ide-terminal-output" aria-live="polite">{terminalTabs.find(tab => tab.id === activeTerminalId)?.output || 'Run shell commands in the project workspace. Commands use the configured shell and sandbox.'}</pre>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
