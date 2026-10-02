// Header bar: app branding plus which LibreOffice version `soffice` currently resolves to.
import { findVersionForDir } from '../../lib/installs.js';

export function TopBar({ info, installs, pathStatus }) {
  return (
    <header className="topbar">
      <Brand info={info} />
      <ActiveSummary installs={installs} pathStatus={pathStatus} />
    </header>
  );
}

function Brand({ info }) {
  return (
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
  );
}

/** "none" when nothing is active, "other" when the active soffice isn't one of the known installs. */
function describeActiveVersion(installs, activeEntry, activeDir) {
  if (!activeEntry) return 'none';
  return findVersionForDir(installs, activeDir) ?? 'other';
}

function ActiveSummary({ installs, pathStatus }) {
  const newShells = pathStatus?.newShells;
  const current = pathStatus?.current;

  return (
    <div className="active-summary" aria-label="Active LibreOffice">
      <div className="active-item">
        <span className="active-label">New terminals</span>
        <span className="active-value mono">
          {pathStatus ? describeActiveVersion(installs, newShells, newShells?.programDir) : '…'}
          {newShells && <span className="muted"> · {newShells.scope} PATH</span>}
        </span>
      </div>
      <div className="active-item">
        <span className="active-label">This server's PATH</span>
        <span className="active-value mono">{pathStatus ? describeActiveVersion(installs, current, current?.realPath) : '…'}</span>
      </div>
    </div>
  );
}
