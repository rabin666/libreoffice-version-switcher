import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatBytes } from '../api.js';
import { Badge, Button, Empty, Spinner, Toggle, useToast } from './ui.jsx';

const METHOD_INFO = {
  msi: { title: 'MSI (extracted)', text: 'Official Windows installer, unpacked silently with msiexec /a. No registry entries, no admin rights.' },
  portable: { title: 'Portable', text: 'PortableApps build, unpacked silently with 7-Zip (without 7-Zip its installer window opens).' },
  deb: { title: '.deb (extracted)', text: 'Official Debian/Ubuntu packages unpacked into one folder. No root needed.' },
  rpm: { title: '.rpm (extracted)', text: 'Official RHEL/Oracle Linux packages unpacked into one folder. Needs rpm2cpio and cpio.' },
};

const numeric = (v) => v.split('.').filter((p) => /^\d+$/.test(p)).map(Number);
const matches = (version, q) => {
  const qp = numeric(q);
  const vp = numeric(version);
  return version.startsWith(q) || (qp.length > 0 && qp.every((n, i) => vp[i] === n));
};

export default function AvailableView({ info, installs, jobs, goTo }) {
  const toast = useToast();
  const [versions, setVersions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [showPre, setShowPre] = useState(Boolean(info?.config.includePrereleases));
  const [expanded, setExpanded] = useState(() => new Set());
  const [selected, setSelected] = useState(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const { versions: list } = await api(`/api/remote${refresh ? '?refresh=1' : ''}`);
      setVersions(list);
      setExpanded((cur) => (cur.size ? cur : new Set(list.filter((v) => !v.prerelease).slice(0, 1).map((v) => v.series))));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const installedSet = useMemo(() => new Set((installs ?? []).map((i) => i.version).filter(Boolean)), [installs]);

  const groups = useMemo(() => {
    if (!versions) return [];
    const q = filter.trim();
    const map = new Map();
    for (const v of versions) {
      if (!showPre && v.prerelease) continue;
      if (q && !matches(v.version, q)) continue;
      if (!map.has(v.series)) map.set(v.series, []);
      map.get(v.series).push(v);
    }
    return [...map.entries()].map(([series, builds]) => ({ series, builds }));
  }, [versions, filter, showPre]);

  const toggle = (series) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(series)) next.delete(series);
      else next.add(series);
      return next;
    });

  const filtering = filter.trim().length > 0;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Available versions</h1>
          <p className="muted">
            From the official archive (downloadarchive.documentfoundation.org). Pick a build to see its packages.
          </p>
        </div>
        <div className="view-actions">
          <input className="input" type="search" placeholder="e.g. 7.6 or 24.8.7" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter versions" />
          <Toggle id="pre" checked={showPre} onChange={setShowPre} label="Pre-releases" />
          <Button onClick={() => load(true)} busy={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="callout callout-error">
          <div>Couldn't load the archive listing: {error}</div>
          <Button size="sm" onClick={() => load(true)}>
            Retry
          </Button>
        </div>
      )}

      {!versions && !error && (
        <div className="panel center">
          <Spinner label="Fetching the archive listing…" />
        </div>
      )}

      {versions && (
        <div className="available-layout">
          <div className="series-list">
            {!groups.length && <Empty title="No versions match">Try a shorter filter such as “7” or “24.8”.</Empty>}
            {groups.map(({ series, builds }) => {
              const open = filtering || expanded.has(series);
              const installedCount = builds.filter((b) => installedSet.has(b.version)).length;
              return (
                <div key={series} className={`series${open ? ' is-open' : ''}`}>
                  <button type="button" className="series-head" onClick={() => toggle(series)} aria-expanded={open}>
                    <span className="series-caret" aria-hidden="true">
                      ▸
                    </span>
                    <span className="series-name mono">{series}</span>
                    <span className="muted small">
                      {builds.length} build{builds.length === 1 ? '' : 's'} · latest <span className="mono">{builds[0].version}</span>
                      {builds[0].date && ` · ${builds[0].date.slice(0, 10)}`}
                    </span>
                    {installedCount > 0 && <Badge tone="accent-soft">{installedCount} installed</Badge>}
                  </button>
                  {open && (
                    <div className="chips">
                      {builds.map((b) => {
                        const isInstalled = installedSet.has(b.version);
                        return (
                          <button
                            key={b.version}
                            type="button"
                            className={`chip mono${selected === b.version ? ' is-selected' : ''}${isInstalled ? ' is-installed' : ''}${b.prerelease ? ' is-pre' : ''}`}
                            onClick={() => setSelected(b.version)}
                            title={isInstalled ? 'Installed' : b.date ? `Published ${b.date.slice(0, 10)}` : undefined}
                          >
                            {b.version}
                            {isInstalled && <span aria-label="installed"> ✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <aside className="detail">
            {selected ? (
              <VersionDetail key={selected} version={selected} info={info} installs={installs} jobs={jobs} toast={toast} goTo={goTo} />
            ) : (
              <div className="detail-empty">
                <div className="detail-empty-title">Select a build</div>
                <p className="muted small">
                  Each series lists every build; the first is the newest. The last build of a series (e.g. <span className="mono">7.6.7.2</span>) is
                  usually the one to test against.
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function VersionDetail({ version, info, installs, jobs, toast, goTo }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [downloader, setDownloader] = useState('');
  const [starting, setStarting] = useState(null);

  useEffect(() => {
    api(`/api/remote/${encodeURIComponent(version)}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [version]);

  const installedMethods = (installs ?? []).filter((i) => i.version === version && i.source === 'managed').map((i) => i.kind);
  const otherCopies = (installs ?? []).filter((i) => i.version === version && i.source !== 'managed');
  const xdm = info?.tools.xdm;

  const install = async (method, force = false) => {
    setStarting(method);
    try {
      await api('/api/install', { method: 'POST', body: { version, method, downloader: downloader || undefined, force } });
      toast('info', `Installing ${version} (${method}). Follow progress in Activity.`);
      goTo('activity');
    } catch (err) {
      toast('error', err.message);
    } finally {
      setStarting(null);
    }
  };

  return (
    <div className="detail-card">
      <div className="detail-head">
        <div className="version-lg mono">{version}</div>
        <div className="muted small">
          {info?.platform.os}/{info?.platform.archDir}
        </div>
      </div>

      {otherCopies.length > 0 && (
        <p className="small callout-inline">Already on this machine: {otherCopies.map((o) => o.portableRoot ?? o.root).join(', ')}</p>
      )}

      <label className="field-inline">
        <span className="small muted">Downloader</span>
        <select className="input input-sm" value={downloader} onChange={(e) => setDownloader(e.target.value)}>
          <option value="">Default ({info?.tools.downloader === 'xdm' ? 'XDM' : 'built-in'})</option>
          <option value="builtin">Built-in ({info?.config.connections} connections)</option>
          <option value="xdm" disabled={!xdm?.found && !xdm?.running}>
            XDM {xdm?.found || xdm?.running ? '' : '(not found)'}
          </option>
        </select>
      </label>

      {error && <p className="error-text">{error}</p>}
      {!data && !error && <Spinner label="Checking packages…" />}
      {data && !data.artifacts.length && <p className="muted">No packages for this platform in the archive (some old builds were pruned).</p>}
      {data?.artifacts.map((a) => {
        const running = jobs.find((j) => j.status === 'running' && j.meta?.version === version && j.meta?.method === a.method);
        const installed = installedMethods.includes(a.method);
        const meta = METHOD_INFO[a.method];
        return (
          <div key={a.method} className="artifact">
            <div className="artifact-head">
              <strong>{meta?.title ?? a.method}</strong>
              {a.method === info?.defaultMethod && <Badge tone="accent-soft">default</Badge>}
              <span className="muted small mono">{formatBytes(a.size)}</span>
            </div>
            <p className="small muted">{meta?.text}</p>
            <div className="artifact-actions">
              {running ? (
                <Button size="sm" onClick={() => goTo('activity')}>
                  Installing… view progress
                </Button>
              ) : installed ? (
                <>
                  <Badge tone="accent">installed</Badge>
                  <Button size="sm" variant="ghost" busy={starting === a.method} onClick={() => install(a.method, true)}>
                    Reinstall
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" busy={starting === a.method} onClick={() => install(a.method)}>
                  Install
                </Button>
              )}
              <a className="small link" href={a.url} target="_blank" rel="noreferrer">
                {a.fileName}
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
