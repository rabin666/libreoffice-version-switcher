// One install in the Installed list: version, badges, location, PATH flags and its action menus.
import { describeSource, INSTALL_KIND_LABEL, installLocation } from '../../lib/installs.js';
import { classNames } from '../../lib/classNames.js';
import { Badge, Button, Menu } from '../ui/index.js';

export default function InstallRow({ install, isWindows, pathBusy, actions, onUseInTerminal, onUninstall }) {
  const pathFlags = install.path;
  const location = installLocation(install);

  return (
    <article className={classNames('install', pathFlags.newShells && 'is-active')}>
      <div className="install-main">
        <div className="install-title">
          <span className="version mono">{install.version ?? 'unknown'}</span>
          <Badge>{INSTALL_KIND_LABEL[install.kind] ?? install.kind}</Badge>
          <Badge tone={install.source === 'managed' ? 'accent-soft' : 'neutral'} title={describeSource(install.source)}>
            {install.source}
          </Badge>
          {install.isolatedProfile && install.kind !== 'portable' && <Badge title="Uses its own user profile">own profile</Badge>}
        </div>
        <div className="install-path mono" title={location}>
          {location}
        </div>
        <PathFlagBadges pathFlags={pathFlags} />
      </div>
      <div className="install-actions">
        <Button size="sm" onClick={() => onUseInTerminal(install)}>
          Use in a terminal
        </Button>
        <Menu label={pathBusy ? 'Updating…' : 'PATH ▾'} variant="default" items={pathMenuItems(install, isWindows, actions)} />
        <Menu label="⋯" items={moreMenuItems(install, actions, onUninstall)} />
      </div>
    </article>
  );
}

function PathFlagBadges({ pathFlags }) {
  return (
    <div className="install-flags">
      {pathFlags.newShells && <Badge tone="accent">active in new terminals</Badge>}
      {pathFlags.current && <Badge tone="info">on server PATH</Badge>}
      {pathFlags.user && <Badge tone="outline">user PATH</Badge>}
      {pathFlags.machine && <Badge tone="outline">machine PATH</Badge>}
    </div>
  );
}

/** Offers "add" for scopes the install isn't on yet and "remove" for scopes it is on. */
function pathMenuItems(install, isWindows, { addToPath, removeFromPath }) {
  const pathFlags = install.path;
  const machineHint = isWindows ? 'asks for admin' : 'needs sudo';
  return [
    !pathFlags.user && { label: 'Add to user PATH', hint: 'recommended', onClick: () => addToPath(install, 'user') },
    !pathFlags.machine && { label: 'Add to machine PATH', hint: machineHint, onClick: () => addToPath(install, 'machine') },
    pathFlags.user && { label: 'Remove from user PATH', onClick: () => removeFromPath(install, 'user') },
    pathFlags.machine && { label: 'Remove from machine PATH', hint: machineHint, onClick: () => removeFromPath(install, 'machine') },
  ];
}

// Only installs lovs created itself may be deleted from here.
function moreMenuItems(install, { reveal }, onUninstall) {
  return [
    { label: 'Open folder', onClick: () => reveal(install) },
    {
      label: 'Uninstall…',
      danger: true,
      disabled: !install.managed,
      hint: install.managed ? '' : 'not installed by lovs',
      onClick: () => onUninstall(install),
    },
  ];
}
