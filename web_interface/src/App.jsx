import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeJobs } from './api.js';
import ActivityView from './components/ActivityView.jsx';
import AvailableView from './components/AvailableView.jsx';
import InstalledView from './components/InstalledView.jsx';
import SettingsView from './components/SettingsView.jsx';
import { ToastProvider, useToast } from './components/ui.jsx';

const TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'available', label: 'Available' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

function readTab() {
  try {
    const t = localStorage.getItem('lovs.tab');
    return TABS.some((x) => x.id === t) ? t : 'installed';
  } catch {
    return 'installed';
  }
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function versionForDir(installs, dir) {
  if (!dir || !installs) return null;
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  return installs.find((i) => norm(i.programDir) === norm(dir) || norm(dir).startsWith(norm(i.root)))?.version ?? null;
}

function Shell() {
  const toast = useToast();
  const [tab, setTabState] = useState(readTab);
  const [info, setInfo] = useState(null);
  const [local, setLocal] = useState(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [connected, setConnected] = useState(true);
  const [fatal, setFatal] = useState(null);
  const statuses = useRef(new Map());

  const setTab = (t) => {
    setTabState(t);
    try {
      localStorage.setItem('lovs.tab', t);
    } catch {
      // ignore
    }
  };

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api('/api/info'));
      setFatal(null);
    } catch (err) {
      setFatal(err.message);
    }
  }, []);

  const loadLocal = useCallback(async () => {
    setLocalLoading(true);
    try {
      setLocal(await api('/api/local'));
    } catch (err) {
      toast('error', `Could not scan local installs: ${err.message}`);
    } finally {
      setLocalLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadInfo();
    loadLocal();
  }, [loadInfo, loadLocal]);

  useEffect(
    () =>
      subscribeJobs({
        onConnection: setConnected,
        onSnapshot: (list) => {
          list.forEach((j) => statuses.current.set(j.id, j.status));
          setJobs(list);
        },
        onUpdate: (job) => {
          const prev = statuses.current.get(job.id);
          statuses.current.set(job.id, job.status);
          if (prev === 'running' && job.status !== 'running') {
            if (job.status === 'done') {
              toast('success', `${job.title}: finished`);
              loadLocal();
            } else if (job.status === 'error') toast('error', `${job.title}: ${job.error}`);
            else toast('info', `${job.title}: cancelled`);
          }
          setJobs((all) => {
            const i = all.findIndex((j) => j.id === job.id);
            if (i === -1) return [job, ...all];
            const next = all.slice();
            next[i] = job;
            return next;
          });
        },
        onRemoved: (id) => setJobs((all) => all.filter((j) => j.id !== id)),
      }),
    [toast, loadLocal],
  );

  const running = jobs.filter((j) => j.status === 'running').length;
  const installs = local?.installs;
  const status = local?.status;
  const activeNew = status?.newShells ? versionForDir(installs, status.newShells.programDir) : null;
  const activeNow = status?.current ? versionForDir(installs, status.current.realPath) : null;

  const counts = useMemo(() => ({ installed: installs?.length, activity: running || null }), [installs, running]);

  if (fatal && !info) {
    return (
      <div className="fatal">
        <h1>Can't reach the lovs server</h1>
        <p>{fatal}</p>
        <p className="muted">
          Start it with <code>lovs ui</code> and reload this page.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <div>
            <div className="brand-name">LibreOffice Version Switcher</div>
            <div className="brand-sub">
              {info ? `${info.platform.pretty} · ${info.platform.arch}` : 'Loading…'}
              {info && <span className="muted"> · v{info.appVersion}</span>}
            </div>
          </div>
        </div>
        <div className="active-summary" aria-label="Active LibreOffice">
          <div className="active-item">
            <span className="active-label">New terminals</span>
            <span className="active-value mono">
              {status ? (status.newShells ? activeNew ?? 'other' : 'none') : '…'}
              {status?.newShells && <span className="muted"> · {status.newShells.scope} PATH</span>}
            </span>
          </div>
          <div className="active-item">
            <span className="active-label">This server's PATH</span>
            <span className="active-value mono">{status ? (status.current ? activeNow ?? 'other' : 'none') : '…'}</span>
          </div>
        </div>
      </header>

      {!connected && <div className="conn-lost">Connection to the lovs server lost. Retrying…</div>}

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {counts[t.id] ? <span className={`tab-count${t.id === 'activity' ? ' is-live' : ''}`}>{counts[t.id]}</span> : null}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'installed' && <InstalledView info={info} local={local} loading={localLoading} reload={loadLocal} goTo={setTab} />}
        {tab === 'available' && <AvailableView info={info} installs={installs} jobs={jobs} goTo={setTab} />}
        {tab === 'activity' && <ActivityView jobs={jobs} goTo={setTab} />}
        {tab === 'settings' && (
          <SettingsView
            info={info}
            onSaved={() => {
              loadInfo();
              loadLocal();
            }}
          />
        )}
      </main>
    </div>
  );
}
