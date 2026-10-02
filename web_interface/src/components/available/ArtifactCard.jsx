// One downloadable package of a build (MSI, portable, deb, rpm) with its install state and action.
import { formatBytes } from '../../lib/format.js';
import { Badge, Button } from '../ui/index.js';

const METHOD_INFO = {
  msi: { title: 'MSI (extracted)', text: 'Official Windows installer, unpacked silently with msiexec /a. No registry entries, no admin rights.' },
  portable: { title: 'Portable', text: 'PortableApps build, unpacked silently with 7-Zip (without 7-Zip its installer window opens).' },
  deb: { title: '.deb (extracted)', text: 'Official Debian/Ubuntu packages unpacked into one folder. No root needed.' },
  rpm: { title: '.rpm (extracted)', text: 'Official RHEL/Oracle Linux packages unpacked into one folder. Needs rpm2cpio and cpio.' },
};

export default function ArtifactCard({ artifact, isDefault, isInstalled, isRunning, isStarting, onInstall, onReinstall, onViewProgress }) {
  const methodInfo = METHOD_INFO[artifact.method];

  return (
    <div className="artifact">
      <div className="artifact-head">
        <strong>{methodInfo?.title ?? artifact.method}</strong>
        {isDefault && <Badge tone="accent-soft">default</Badge>}
        <span className="muted small mono">{formatBytes(artifact.size)}</span>
      </div>
      <p className="small muted">{methodInfo?.text}</p>
      <div className="artifact-actions">
        <InstallAction
          isRunning={isRunning}
          isInstalled={isInstalled}
          isStarting={isStarting}
          onInstall={onInstall}
          onReinstall={onReinstall}
          onViewProgress={onViewProgress}
        />
        <a className="small link" href={artifact.url} target="_blank" rel="noreferrer">
          {artifact.fileName}
        </a>
      </div>
    </div>
  );
}

function InstallAction({ isRunning, isInstalled, isStarting, onInstall, onReinstall, onViewProgress }) {
  if (isRunning) {
    return (
      <Button size="sm" onClick={onViewProgress}>
        Installing… view progress
      </Button>
    );
  }
  if (isInstalled) {
    return (
      <>
        <Badge tone="accent">installed</Badge>
        <Button size="sm" variant="ghost" busy={isStarting} onClick={onReinstall}>
          Reinstall
        </Button>
      </>
    );
  }
  return (
    <Button size="sm" variant="primary" busy={isStarting} onClick={onInstall}>
      Install
    </Button>
  );
}
