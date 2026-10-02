// One background job: status, phase steps, download progress, result and log.
import { useState } from 'react';
import { api } from '../../api.js';
import { formatBytes, formatDuration, formatTime } from '../../lib/format.js';
import { Badge, Button, LinkButton, useToast } from '../ui/index.js';

const STATUS_TONE = { running: 'info', done: 'accent', error: 'danger', cancelled: 'neutral' };
// Server-side phases in order. 'done' is terminal and has no step of its own.
const PHASES = ['resolve', 'download', 'verify', 'extract', 'configure', 'done'];
const PHASE_LABEL = { resolve: 'Resolve', download: 'Download', verify: 'Verify', extract: 'Install', configure: 'Configure', done: 'Done' };

export default function JobCard({ job }) {
  const showToast = useToast();
  const isRunning = job.status === 'running';

  const request = async (path, method) => {
    try {
      await api(path, { method });
    } catch (err) {
      showToast('error', err.message);
    }
  };

  return (
    <article className={`job job-${job.status}`}>
      <div className="job-head">
        <div>
          <div className="job-title">{job.title}</div>
          <div className="muted small">
            Started {formatTime(job.createdAt)}
            {job.finishedAt && ` · finished ${formatTime(job.finishedAt)}`}
          </div>
        </div>
        <div className="job-actions">
          <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
          {isRunning ? (
            <Button size="sm" variant="ghost" onClick={() => request(`/api/jobs/${job.id}/cancel`, 'POST')}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => request(`/api/jobs/${job.id}`, 'DELETE')}>
              Dismiss
            </Button>
          )}
        </div>
      </div>

      <PhaseSteps phase={job.phase} status={job.status} />

      {job.detail && isRunning && <div className="small">{job.detail}</div>}
      {isRunning && job.phase === 'download' && job.progress && <DownloadProgress progress={job.progress} />}

      {job.status === 'error' && <div className="error-text small">{job.error}</div>}
      {job.status === 'done' && job.result?.root && (
        <div className="small">
          Installed to <span className="mono break">{job.result.root}</span>
        </div>
      )}

      {job.logs.length > 0 && <JobLog logs={job.logs} />}
    </article>
  );
}

/** Steps before the current phase are done; the current one is in progress, or failed if the job stopped there. */
function stepState(stepIndex, currentIndex, status) {
  if (status === 'done' || stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return status === 'running' ? 'current' : 'failed';
  return 'todo';
}

function PhaseSteps({ phase, status }) {
  const currentIndex = PHASES.indexOf(phase);
  return (
    <ol className="steps" aria-label="Progress">
      {PHASES.slice(0, -1).map((stepPhase, stepIndex) => (
        <li key={stepPhase} className={`step step-${stepState(stepIndex, currentIndex, status)}`}>
          {PHASE_LABEL[stepPhase]}
        </li>
      ))}
    </ol>
  );
}

function DownloadProgress({ progress }) {
  const { downloaded, total, speed, external } = progress;
  // Without a known total the bar is indeterminate and there is no ETA.
  const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
  const etaSeconds = total && speed > 0 ? (total - downloaded) / speed : null;

  return (
    <div className="progress-block">
      <div className={`progress${percent == null ? ' is-indeterminate' : ''}`}>
        <div className="progress-bar" style={{ width: percent == null ? undefined : `${percent}%` }} />
      </div>
      <div className="progress-meta mono small">
        {/* XDM downloads in its own window; we only see the file growing on disk. */}
        {external === 'xdm' ? (
          <span>{downloaded ? `XDM writing file: ${formatBytes(downloaded)}` : 'Downloading in XDM (see the XDM window for progress)'}</span>
        ) : (
          <>
            <span>
              {percent != null && `${percent.toFixed(1)}% · `}
              {formatBytes(downloaded)} / {formatBytes(total)}
            </span>
            <span>
              {formatBytes(speed)}/s · ETA {formatDuration(etaSeconds)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function JobLog({ logs }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="job-log">
      <LinkButton className="small" onClick={() => setIsOpen((open) => !open)}>
        {isOpen ? 'Hide' : 'Show'} log ({logs.length})
      </LinkButton>
      {isOpen && <pre className="log">{logs.map((line) => `${formatTime(line.at)}  ${line.msg}`).join('\n')}</pre>}
    </div>
  );
}
