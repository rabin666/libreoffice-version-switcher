import { useState } from 'react';
import { api, formatBytes, formatDuration } from '../api.js';
import { Badge, Button, Empty, useToast } from './ui.jsx';

const STATUS_TONE = { running: 'info', done: 'accent', error: 'danger', cancelled: 'neutral' };
const PHASES = ['resolve', 'download', 'verify', 'extract', 'configure', 'done'];
const PHASE_LABEL = { resolve: 'Resolve', download: 'Download', verify: 'Verify', extract: 'Install', configure: 'Configure', done: 'Done' };

export default function ActivityView({ jobs, goTo }) {
  if (!jobs.length) {
    return (
      <section className="view">
        <div className="view-head">
          <div>
            <h1>Activity</h1>
            <p className="muted">Downloads and installs started from this window.</p>
          </div>
        </div>
        <Empty title="Nothing running">
          Start an install from <button type="button" className="link" onClick={() => goTo('available')}>Available</button>.
        </Empty>
      </section>
    );
  }
  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Downloads and installs started from this window. They keep running if you close the page.</p>
        </div>
      </div>
      <div className="job-list">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} />
        ))}
      </div>
    </section>
  );
}

function JobCard({ job }) {
  const toast = useToast();
  const [showLog, setShowLog] = useState(false);
  const p = job.progress;
  const pct = p?.total ? Math.min(100, (p.downloaded / p.total) * 100) : null;
  const eta = p?.total && p.speed > 0 ? (p.total - p.downloaded) / p.speed : null;
  const phaseIdx = PHASES.indexOf(job.phase);

  const call = async (path, method) => {
    try {
      await api(path, { method });
    } catch (err) {
      toast('error', err.message);
    }
  };

  return (
    <article className={`job job-${job.status}`}>
      <div className="job-head">
        <div>
          <div className="job-title">{job.title}</div>
          <div className="muted small">
            Started {new Date(job.createdAt).toLocaleTimeString()}
            {job.finishedAt && ` · finished ${new Date(job.finishedAt).toLocaleTimeString()}`}
          </div>
        </div>
        <div className="job-actions">
          <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
          {job.status === 'running' ? (
            <Button size="sm" variant="ghost" onClick={() => call(`/api/jobs/${job.id}/cancel`, 'POST')}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => call(`/api/jobs/${job.id}`, 'DELETE')}>
              Dismiss
            </Button>
          )}
        </div>
      </div>

      <ol className="steps" aria-label="Progress">
        {PHASES.slice(0, -1).map((ph, i) => {
          const state = job.status === 'done' || i < phaseIdx ? 'done' : i === phaseIdx ? (job.status === 'running' ? 'current' : 'failed') : 'todo';
          return (
            <li key={ph} className={`step step-${state}`}>
              {PHASE_LABEL[ph]}
            </li>
          );
        })}
      </ol>

      {job.detail && job.status === 'running' && <div className="small">{job.detail}</div>}

      {job.status === 'running' && job.phase === 'download' && p && (
        <div className="progress-block">
          <div className={`progress${pct == null ? ' is-indeterminate' : ''}`}>
            <div className="progress-bar" style={{ width: pct == null ? undefined : `${pct}%` }} />
          </div>
          <div className="progress-meta mono small">
            {p.external === 'xdm' ? (
              <span>{p.downloaded ? `XDM writing file: ${formatBytes(p.downloaded)}` : 'Downloading in XDM (see the XDM window for progress)'}</span>
            ) : (
              <>
                <span>
                  {pct != null && `${pct.toFixed(1)}% · `}
                  {formatBytes(p.downloaded)} / {formatBytes(p.total)}
                </span>
                <span>
                  {formatBytes(p.speed)}/s · ETA {formatDuration(eta)}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {job.status === 'error' && <div className="error-text small">{job.error}</div>}
      {job.status === 'done' && job.result?.root && (
        <div className="small">
          Installed to <span className="mono break">{job.result.root}</span>
        </div>
      )}

      {job.logs.length > 0 && (
        <div className="job-log">
          <button type="button" className="link small" onClick={() => setShowLog((s) => !s)}>
            {showLog ? 'Hide' : 'Show'} log ({job.logs.length})
          </button>
          {showLog && (
            <pre className="log">
              {job.logs.map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.msg}`).join('\n')}
            </pre>
          )}
        </div>
      )}
    </article>
  );
}
