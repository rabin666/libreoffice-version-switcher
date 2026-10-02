// Root component: loads shared server state and switches between the four top-level views.
import { useMemo } from 'react';
import ActivityView from './components/activity/ActivityView.jsx';
import AvailableView from './components/available/AvailableView.jsx';
import InstalledView from './components/installed/InstalledView.jsx';
import { FatalScreen } from './components/layout/FatalScreen.jsx';
import { TabBar } from './components/layout/TabBar.jsx';
import { TopBar } from './components/layout/TopBar.jsx';
import SettingsView from './components/settings/SettingsView.jsx';
import { ToastProvider, useToast } from './components/ui/index.js';
import { useJobs } from './hooks/useJobs.js';
import { useLocalInstalls } from './hooks/useLocalInstalls.js';
import { useServerInfo } from './hooks/useServerInfo.js';
import { useStoredTab } from './hooks/useStoredTab.js';

const TABS = [
  { id: 'installed', label: 'Installed' },
  { id: 'available', label: 'Available' },
  { id: 'activity', label: 'Activity', live: true },
  { id: 'settings', label: 'Settings' },
];
const TAB_IDS = TABS.map((tab) => tab.id);

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell() {
  const showToast = useToast();
  const [tab, setTab] = useStoredTab(TAB_IDS, 'installed');
  const { info, loadError, reloadInfo } = useServerInfo();
  const { local, loading: localLoading, reloadLocal } = useLocalInstalls();

  const announceFinishedJob = (job) => {
    if (job.status === 'done') {
      showToast('success', `${job.title}: finished`);
      // A finished install changes what is on disk.
      reloadLocal();
    } else if (job.status === 'error') {
      showToast('error', `${job.title}: ${job.error}`);
    } else {
      showToast('info', `${job.title}: cancelled`);
    }
  };
  const { jobs, connected } = useJobs({ onJobFinished: announceFinishedJob });

  const installs = local?.installs;
  const runningJobCount = jobs.filter((job) => job.status === 'running').length;
  const tabCounts = useMemo(
    () => ({ installed: installs?.length, activity: runningJobCount || null }),
    [installs, runningJobCount],
  );

  // Only fatal before the first successful load; later failures keep the last known state on screen.
  if (loadError && !info) return <FatalScreen message={loadError} />;

  const reloadAfterSettingsSaved = () => {
    reloadInfo();
    reloadLocal();
  };

  return (
    <div className="app">
      <TopBar info={info} installs={installs} pathStatus={local?.status} />

      {!connected && <div className="conn-lost">Connection to the lovs server lost. Retrying…</div>}

      <TabBar tabs={TABS} activeTab={tab} counts={tabCounts} onSelect={setTab} />

      <main className="content">
        {tab === 'installed' && <InstalledView info={info} local={local} loading={localLoading} reload={reloadLocal} goTo={setTab} />}
        {tab === 'available' && <AvailableView info={info} installs={installs} jobs={jobs} goTo={setTab} />}
        {tab === 'activity' && <ActivityView jobs={jobs} goTo={setTab} />}
        {tab === 'settings' && <SettingsView info={info} onSaved={reloadAfterSettingsSaved} />}
      </main>
    </div>
  );
}
