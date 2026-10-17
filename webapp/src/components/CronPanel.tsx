import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Bell, CalendarClock, Check, Clock3, LoaderCircle, Pause, Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

type CronSchedule = { type: 'cron'; expression: string } | { type: 'once'; runAt: number };
type CronJob = {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  runCount: number;
};
type CronAlert = {
  id: string;
  jobId: string;
  jobName: string;
  prompt: string;
  scheduledAt: number;
  createdAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
};
type CronState = { jobs: CronJob[]; alerts: CronAlert[]; systemPrompt: string };
type CronRequest = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

const localDateTime = (time: number) => {
  const date = new Date(time - new Date(time).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
};

function formatTime(time: number): string {
  return new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function scheduleLabel(schedule: CronSchedule): string {
  return schedule.type === 'cron' ? schedule.expression : `Once · ${formatTime(schedule.runAt)}`;
}

export default function CronPanel({ request }: { request: CronRequest }) {
  const [state, setState] = useState<CronState>({ jobs: [], alerts: [], systemPrompt: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'cron' | 'once'>('cron');
  const [expression, setExpression] = useState('0 9 * * 1-5');
  const [runAt, setRunAt] = useState(() => localDateTime(Date.now() + 60 * 60_000));
  const [defaultPrompt, setDefaultPrompt] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const result = await request<CronState>('/api/cron');
      setState(result);
      setDefaultPrompt(result.systemPrompt);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Cron scheduler could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { void refresh(); }, [refresh]);

  const resetForm = () => {
    setEditingId('');
    setName('');
    setPrompt('');
    setKind('cron');
    setExpression('0 9 * * 1-5');
    setRunAt(localDateTime(Date.now() + 60 * 60_000));
  };

  const submitJob = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    const schedule: CronSchedule = kind === 'cron'
      ? { type: 'cron', expression }
      : { type: 'once', runAt: new Date(runAt).getTime() };
    try {
      const endpoint = editingId ? `/api/cron/jobs/${encodeURIComponent(editingId)}` : '/api/cron/jobs';
      const job = await request<CronJob>(endpoint, {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({ name, prompt, schedule }),
      });
      setState(current => ({
        ...current,
        jobs: editingId ? current.jobs.map(item => item.id === job.id ? job : item) : [...current.jobs, job],
      }));
      resetForm();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Cron job could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const editJob = (job: CronJob) => {
    setEditingId(job.id);
    setName(job.name);
    setPrompt(job.prompt);
    setKind(job.schedule.type);
    if (job.schedule.type === 'cron') setExpression(job.schedule.expression);
    else setRunAt(localDateTime(job.schedule.runAt));
    setError('');
  };

  const updateJob = async (job: CronJob, patch: Partial<Pick<CronJob, 'enabled'>>) => {
    setError('');
    try {
      const updated = await request<CronJob>(`/api/cron/jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setState(current => ({ ...current, jobs: current.jobs.map(item => item.id === updated.id ? updated : item) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Cron job could not be updated.');
    }
  };

  const deleteJob = async (job: CronJob) => {
    setError('');
    try {
      await request<{ deleted: boolean }>(`/api/cron/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      setState(current => ({ ...current, jobs: current.jobs.filter(item => item.id !== job.id) }));
      if (editingId === job.id) resetForm();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Cron job could not be deleted.');
    }
  };

  const retryAlert = async (alert: CronAlert) => {
    setError('');
    try {
      const updated = await request<CronAlert>(`/api/cron/alerts/${encodeURIComponent(alert.id)}/retry`, { method: 'POST' });
      setState(current => ({ ...current, alerts: current.alerts.map(item => item.id === updated.id ? updated : item) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Cron alert could not be retried.');
    }
  };

  const saveDefaultPrompt = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await request<{ systemPrompt: string }>('/api/cron/default-prompt', {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: defaultPrompt }),
      });
      setDefaultPrompt(result.systemPrompt);
      setState(current => ({ ...current, systemPrompt: result.systemPrompt }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Autonomous agent instructions could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cron-panel">
      <div className="cron-panel-toolbar">
        <p>Scheduled work runs through the configured agent and sandbox. Times use this machine’s local timezone.</p>
        <button className="icon-button small" type="button" onClick={() => void refresh()} aria-label="Refresh cron data" title="Refresh"><RefreshCw size={14} /></button>
      </div>
      {error && <div className="notice notice-error cron-error" role="alert">{error}</div>}
      {loading ? <div className="loading-state"><LoaderCircle size={18} className="spin" />Loading scheduled jobs…</div> : (
        <>
          <section className="cron-section">
            <header className="cron-section-heading"><span><CalendarClock size={15} />Jobs</span><small>{state.jobs.length}</small></header>
            {state.jobs.length === 0 && <p className="drawer-empty">No scheduled work. Add a reminder or a recurring job below.</p>}
            <div className="cron-job-list">
              {state.jobs.map(job => <article className="cron-job" key={job.id}>
                <div className="cron-job-heading">
                  <span className={`cron-job-state${job.enabled ? ' is-enabled' : ''}`} aria-hidden="true" />
                  <div><strong>{job.name}</strong><small>{scheduleLabel(job.schedule)}</small></div>
                </div>
                <p>{job.prompt}</p>
                <div className="cron-job-next">{job.enabled ? `Next · ${formatTime(job.nextRunAt)}` : `Paused · ${job.runCount} run${job.runCount === 1 ? '' : 's'}`}</div>
                <div className="cron-job-actions">
                  <button className="button button-secondary" type="button" onClick={() => editJob(job)}>Edit</button>
                  <button className="icon-button small" type="button" onClick={() => void updateJob(job, { enabled: !job.enabled })} aria-label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`} title={job.enabled ? 'Pause' : 'Resume'}>{job.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
                  <button className="icon-button small cron-delete" type="button" onClick={() => void deleteJob(job)} aria-label={`Delete ${job.name}`} title="Delete"><Trash2 size={13} /></button>
                </div>
              </article>)}
            </div>
            <form className="cron-form" onSubmit={event => void submitJob(event)}>
              <header className="cron-section-heading"><span><Plus size={15} />{editingId ? 'Edit job' : 'Add scheduled work'}</span></header>
              <label className="cron-field"><span>Name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required placeholder="Check download progress" /></label>
              <label className="cron-field"><span>Task instructions</span><textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={20_000} rows={4} required placeholder="Check whether the download completed, verify the output, then report or continue." /></label>
              <label className="cron-field"><span>Schedule type</span><select value={kind} onChange={event => setKind(event.target.value as 'cron' | 'once')}><option value="cron">Recurring (cron)</option><option value="once">One-time reminder</option></select></label>
              {kind === 'cron'
                ? <label className="cron-field"><span>Cron expression · local time</span><input value={expression} onChange={event => setExpression(event.target.value)} required aria-describedby="cron-expression-help" /><small id="cron-expression-help">Minute hour day-of-month month day-of-week · e.g. 0 9 * * 1-5</small></label>
                : <label className="cron-field"><span>Run at · local time</span><input type="datetime-local" value={runAt} onChange={event => setRunAt(event.target.value)} required /></label>}
              <div className="cron-form-actions">
                {editingId && <button className="button button-secondary" type="button" onClick={resetForm}>Cancel edit</button>}
                <button className="button button-primary" type="submit" disabled={saving || !name.trim() || !prompt.trim()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{editingId ? 'Save changes' : 'Create job'}</button>
              </div>
            </form>
          </section>
          <section className="cron-section cron-alerts">
            <header className="cron-section-heading"><span><Bell size={15} />Alerts &amp; runs</span><small>{state.alerts.length}</small></header>
            {state.alerts.slice(0, 30).map(alert => <article className="cron-alert" key={alert.id}>
              <div><strong>{alert.jobName}</strong><small>{formatTime(alert.scheduledAt)} · {alert.status} · {alert.attempts} attempt{alert.attempts === 1 ? '' : 's'}</small></div>
              {alert.status === 'failed' && <button className="button button-secondary" type="button" onClick={() => void retryAlert(alert)}>Retry</button>}
              {alert.lastError && <p role="alert">{alert.lastError}</p>}
            </article>)}
            {state.alerts.length === 0 && <p className="drawer-empty">Completed and failed autonomous runs will appear here.</p>}
          </section>
          <form className="cron-form cron-agent-prompt" onSubmit={event => void saveDefaultPrompt(event)}>
            <header className="cron-section-heading"><span><Clock3 size={15} />Default agent instructions</span></header>
            <p>Dedicated system prompt applied to scheduled runs. Tool and sandbox restrictions still apply.</p>
            <textarea value={defaultPrompt} onChange={event => setDefaultPrompt(event.target.value)} maxLength={30_000} rows={7} required aria-label="Autonomous default agent system prompt" />
            <button className="button button-secondary" type="submit" disabled={saving || defaultPrompt === state.systemPrompt}><Save size={14} />Save instructions</button>
          </form>
        </>
      )}
    </div>
  );
}
