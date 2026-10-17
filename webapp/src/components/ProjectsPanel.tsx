import { useEffect, useState, type FormEvent } from 'react';
import { Archive, CircleAlert, CircleCheck, Clock3, LoaderCircle, Pencil, Plus, Save, TerminalSquare, Users, X } from 'lucide-react';
import type { AgentProfile, ProjectTask, WorkspaceAgent, WorkspaceProject } from '../types';

type Request = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

export default function ProjectsPanel({ project, profiles, agents, request, onArchive, onOpenIDE, onProjectUpdated }: {
  project: WorkspaceProject;
  profiles: AgentProfile[];
  agents: WorkspaceAgent[];
  request: Request;
  onArchive: (projectId: string) => Promise<boolean>;
  onOpenIDE: () => void;
  onProjectUpdated: (project: WorkspaceProject) => void;
}) {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [scope, setScope] = useState(project.scope ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedAgentId, setAssignedAgentId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeAgents = agents.filter(agent => agent.projectId === project.id);
  const runningAgents = activeAgents.filter(agent => agent.status === 'running');
  const completedTasks = tasks.filter(task => task.status === 'completed').length;
  const remainingTasks = tasks.length - completedTasks;
  const progress = tasks.length ? Math.round(completedTasks / tasks.length * 100) : 0;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextTasks = await request<ProjectTask[]>(`/api/projects/${encodeURIComponent(project.id)}/tasks`);
        if (!cancelled) {
          setTasks(nextTasks);
          setError('');
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Project tasks could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [project.id, request]);

  useEffect(() => {
    setName(project.name);
    setScope(project.scope ?? '');
    setEditing(false);
  }, [project.id, project.name, project.scope]);

  const saveProject = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const updated = await request<WorkspaceProject>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, scope }),
      });
      onProjectUpdated(updated);
      setEditing(false);
      setNotice('Project details saved.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project details could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const createTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const task = await request<ProjectTask>(`/api/projects/${encodeURIComponent(project.id)}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          ...(assignedAgentId ? { assignedAgentId } : {}),
        }),
      });
      setTasks(current => [...current, task]);
      setTitle('');
      setDescription('');
      setAssignedAgentId('');
      setNotice('Task added to the project.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project task could not be created.');
    } finally {
      setSaving(false);
    }
  };

  const updateTask = async (task: ProjectTask, patch: { status?: ProjectTask['status']; assignedAgentId?: string | null }) => {
    setError('');
    try {
      const updated = await request<ProjectTask>(`/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setTasks(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Project task could not be updated.');
    }
  };

  const archive = async () => {
    if (await onArchive(project.id)) setNotice('Project archived with its workspace and conversations retained.');
  };

  return (
    <section className="project-management" aria-label={`${project.name} project management`}>
      <header className="project-management-heading">
        <button type="button" className="icon-button small" onClick={onOpenIDE} aria-label="Open project in the Agent IDE" title="Open project in the IDE"><TerminalSquare size={14} /></button>
        <div><span className="eyebrow">PROJECT CONTROL</span><h3>{project.name}</h3></div>
        <button type="button" className="icon-button small" onClick={() => setEditing(value => !value)} aria-label={editing ? 'Cancel editing project' : 'Edit project details'} title={editing ? 'Cancel edit' : 'Edit project'}>{editing ? <X size={14} /> : <Pencil size={14} />}</button>
      </header>

      {error && <p className="project-management-message project-management-error" role="alert"><CircleAlert size={13} />{error}</p>}
      {notice && <p className="project-management-message" role="status"><CircleCheck size={13} />{notice}</p>}

      {editing ? <form className="project-management-edit" onSubmit={event => void saveProject(event)}>
        <label><span>Project name</span><input value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label>
        <label><span>Work scope and success criteria</span><textarea value={scope} onChange={event => setScope(event.target.value)} rows={4} maxLength={4_000} placeholder="Define outcomes, constraints, and what done means." /></label>
        <button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}Save project</button>
      </form> : <div className="project-management-scope"><span className="eyebrow">WORK SCOPE</span><p>{project.scope || 'No scope defined yet. Edit the project to set its goals and definition of done.'}</p></div>}

      <div className="project-management-metrics">
        <div><Users size={14} /><strong>{profiles.length}</strong><span>Agents</span></div>
        <div><Clock3 size={14} /><strong>{runningAgents.length}</strong><span>Running</span></div>
        <div><CircleCheck size={14} /><strong>{completedTasks}/{tasks.length}</strong><span>Tasks done</span></div>
      </div>
      <div className="project-management-progress" role="progressbar" aria-label="Project task completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="project-management-progress-caption"><span>{progress}% complete</span><span>{remainingTasks} remaining</span></div>

      <section className="project-management-section" aria-labelledby="project-agents-heading">
        <header><h4 id="project-agents-heading">Assigned agents</h4><span>{profiles.length}</span></header>
        {profiles.length ? <div className="project-management-agent-list">{profiles.map(profile => {
          const work = activeAgents.filter(agent => agent.agentId === profile.id);
          return <div key={profile.id} className="project-management-agent">
            <span className="project-management-agent-avatar">{profile.emoji}</span>
            <span><strong>{profile.name}</strong><small>{work.length ? `${work.filter(agent => agent.status === 'running').length} active · ${work.length} runs` : 'Available'}</small></span>
          </div>;
        })}</div> : <p className="project-management-empty">No agents are assigned to this project yet.</p>}
      </section>

      <section className="project-management-section" aria-labelledby="project-tasks-heading">
        <header><h4 id="project-tasks-heading">Project tasks</h4><span>{loading ? '…' : tasks.length}</span></header>
        <form className="project-management-task-add" onSubmit={event => void createTask(event)}>
          <input aria-label="Task title" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} placeholder="Add a task…" required />
          <textarea aria-label="Task details" value={description} onChange={event => setDescription(event.target.value)} maxLength={4_000} rows={2} placeholder="Outcome or acceptance criteria (optional)" />
          {profiles.length > 0 && <select aria-label="Assign task to agent" value={assignedAgentId} onChange={event => setAssignedAgentId(event.target.value)}>
            <option value="">Unassigned</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.emoji} {profile.name}</option>)}
          </select>}
          <button className="button button-secondary" type="submit" disabled={saving || !title.trim()}><Plus size={14} />Add task</button>
        </form>
        <div className="project-management-task-list">
          {tasks.map(task => <article key={task.id} className={`project-management-task project-management-task-${task.status}`}>
            <select aria-label={`Status for ${task.title}`} value={task.status} onChange={event => void updateTask(task, { status: event.target.value as ProjectTask['status'] })}>
              <option value="pending">To do</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="completed">Done</option>
            </select>
            <div><strong>{task.title}</strong>{task.description && <p>{task.description}</p>}
              <select aria-label={`Assignment for ${task.title}`} value={task.assignedAgentId ?? ''} onChange={event => void updateTask(task, { assignedAgentId: event.target.value || null })}>
                <option value="">Unassigned</option>
                {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.emoji} {profile.name}</option>)}
              </select>
            </div>
          </article>)}
          {!loading && tasks.length === 0 && <p className="project-management-empty">Nothing planned yet. Add work items and assign them to project agents.</p>}
        </div>
      </section>

      <footer className="project-management-footer">
        <span>Created {new Date(project.createdAt).toLocaleDateString()}</span>
        <button type="button" className="button button-secondary" onClick={() => void archive()}><Archive size={13} />Archive project</button>
      </footer>
    </section>
  );
}
