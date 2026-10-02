// "Installed" tab: the LibreOffice installs found on this machine and their PATH state.
import { useState } from 'react';
import { MACHINE_CLEAR_BUSY_KEY, pathBusyKey, UNINSTALL_BUSY_KEY, useInstallActions } from '../../hooks/useInstallActions.js';
import { matchesInstallFilter } from '../../lib/installs.js';
import { Button, Empty, LinkButton, LoadingPanel, ViewHeader } from '../ui/index.js';
import InstallRow from './InstallRow.jsx';
import PathSummary from './PathSummary.jsx';
import ShellModal from './ShellModal.jsx';
import UninstallModal from './UninstallModal.jsx';

export default function InstalledView({ info, local, loading, reload, goTo }) {
  const [filter, setFilter] = useState('');
  const [shellTarget, setShellTarget] = useState(null);
  const [uninstallTarget, setUninstallTarget] = useState(null);
  const actions = useInstallActions({ reload });
  const isWindows = info?.platform.os === 'windows';

  if (!local) return <LoadingPanel label="Scanning for LibreOffice installs…" />;

  const { installs, status } = local;
  const query = filter.trim().toLowerCase();
  const visibleInstalls = query ? installs.filter((install) => matchesInstallFilter(install, query)) : installs;
  // On Windows the machine PATH is searched before the user PATH, so a machine entry hides any user entry.
  const userPathHasLibreOffice = status.scopes.user.entries.some((entry) => entry.libreoffice);
  const userEntryIsShadowed = isWindows && status.newShells?.scope === 'machine' && userPathHasLibreOffice;

  const confirmUninstall = async () => {
    await actions.uninstall(uninstallTarget);
    setUninstallTarget(null);
  };

  return (
    <section className="view">
      <ViewHeader
        title="Installed versions"
        description="Found in the install folder, your scan folders and standard system locations."
        actions={
          <>
            <input className="input" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter installs" />
            <Button onClick={reload} busy={loading}>
              Rescan
            </Button>
          </>
        }
      />

      {userEntryIsShadowed && (
        <ShadowedPathWarning
          programDir={status.newShells.programDir}
          busy={actions.busyKey === MACHINE_CLEAR_BUSY_KEY}
          onClearMachinePath={actions.clearMachinePath}
        />
      )}

      {installs.length ? (
        <div className="install-list">
          {visibleInstalls.map((install) => (
            <InstallRow
              key={install.id}
              install={install}
              isWindows={isWindows}
              pathBusy={actions.busyKey === pathBusyKey(install)}
              actions={actions}
              onUseInTerminal={setShellTarget}
              onUninstall={setUninstallTarget}
            />
          ))}
          {!visibleInstalls.length && <Empty title={`Nothing matches “${filter}”`} />}
        </div>
      ) : (
        <NoInstalls goTo={goTo} />
      )}

      <PathSummary status={status} />

      {shellTarget && <ShellModal install={shellTarget} onClose={() => setShellTarget(null)} />}
      {uninstallTarget && (
        <UninstallModal
          install={uninstallTarget}
          busy={actions.busyKey === UNINSTALL_BUSY_KEY}
          onConfirm={confirmUninstall}
          onClose={() => setUninstallTarget(null)}
        />
      )}
    </section>
  );
}

function ShadowedPathWarning({ programDir, busy, onClearMachinePath }) {
  return (
    <div className="callout callout-warning">
      <div>
        <strong>Your user PATH entry is hidden.</strong> Windows looks at the machine PATH first, so new terminals use{' '}
        <code>{programDir}</code>.
      </div>
      <Button size="sm" variant="warning" busy={busy} onClick={onClearMachinePath}>
        Remove from machine PATH (admin)
      </Button>
    </div>
  );
}

function NoInstalls({ goTo }) {
  return (
    <Empty title="No LibreOffice installs found">
      Install one from <LinkButton onClick={() => goTo('available')}>Available</LinkButton>, or add a folder
      you already keep versions in (like <code>D:\LibreOfficePortable</code>) under{' '}
      <LinkButton onClick={() => goTo('settings')}>Settings → Scan folders</LinkButton>.
    </Empty>
  );
}
