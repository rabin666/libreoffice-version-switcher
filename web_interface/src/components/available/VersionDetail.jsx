// Side panel for one build: its packages for this platform (GET /api/remote/:version) and install buttons.
import { useState } from 'react';
import { api } from '../../api.js';
import { useApiGet } from '../../hooks/useApiGet.js';
import { installLocation } from '../../lib/installs.js';
import { Spinner, useToast } from '../ui/index.js';
import ArtifactCard from './ArtifactCard.jsx';

export default function VersionDetail({ version, info, installs, jobs, goTo }) {
  const showToast = useToast();
  const { data: release, error } = useApiGet(`/api/remote/${encodeURIComponent(version)}`);
  // '' means "use the configured default", which the server picks when the field is omitted.
  const [downloader, setDownloader] = useState('');
  const [startingMethod, setStartingMethod] = useState(null);

  const installsOfVersion = (installs ?? []).filter((install) => install.version === version);
  const managedMethods = installsOfVersion.filter((install) => install.source === 'managed').map((install) => install.kind);
  const otherCopies = installsOfVersion.filter((install) => install.source !== 'managed');

  const startInstall = async (method, { force = false } = {}) => {
    setStartingMethod(method);
    try {
      await api('/api/install', { method: 'POST', body: { version, method, downloader: downloader || undefined, force } });
      showToast('info', `Installing ${version} (${method}). Follow progress in Activity.`);
      goTo('activity');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setStartingMethod(null);
    }
  };

  const findRunningJob = (method) =>
    jobs.find((job) => job.status === 'running' && job.meta?.version === version && job.meta?.method === method);

  return (
    <div className="detail-card">
      <div className="detail-head">
        <div className="version-lg mono">{version}</div>
        <div className="muted small">
          {info?.platform.os}/{info?.platform.archDir}
        </div>
      </div>

      {otherCopies.length > 0 && (
        <p className="small callout-inline">Already on this machine: {otherCopies.map(installLocation).join(', ')}</p>
      )}

      <DownloaderSelect info={info} value={downloader} onChange={setDownloader} />

      {error && <p className="error-text">{error}</p>}
      {!release && !error && <Spinner label="Checking packages…" />}
      {release && !release.artifacts.length && <p className="muted">No packages for this platform in the archive (some old builds were pruned).</p>}
      {release?.artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.method}
          artifact={artifact}
          isDefault={artifact.method === info?.defaultMethod}
          isInstalled={managedMethods.includes(artifact.method)}
          isRunning={Boolean(findRunningJob(artifact.method))}
          isStarting={startingMethod === artifact.method}
          onInstall={() => startInstall(artifact.method)}
          onReinstall={() => startInstall(artifact.method, { force: true })}
          onViewProgress={() => goTo('activity')}
        />
      ))}
    </div>
  );
}

function DownloaderSelect({ info, value, onChange }) {
  const xdm = info?.tools.xdm;
  const xdmAvailable = xdm?.found || xdm?.running;

  return (
    <label className="field-inline">
      <span className="small muted">Downloader</span>
      <select className="input input-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default ({info?.tools.downloader === 'xdm' ? 'XDM' : 'built-in'})</option>
        <option value="builtin">Built-in ({info?.config.connections} connections)</option>
        <option value="xdm" disabled={!xdmAvailable}>
          XDM {xdmAvailable ? '' : '(not found)'}
        </option>
      </select>
    </label>
  );
}
