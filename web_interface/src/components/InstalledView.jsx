import { useState } from 'react';
import { api } from '../api.js';
import ShellModal from './ShellModal.jsx';
import { Badge, Button, Empty, Menu, Modal, Spinner, useToast } from './ui.jsx';

const KIND_LABEL = { msi: 'MSI extract', portable: 'portable', deb: 'deb extract', rpm: 'rpm extract', system: 'system', extracted: 'folder' };

export default function InstalledView({ info, local, loading, reload, goTo }) {
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [shellFor, setShellFor] = useState(null);
  const [toUninstall, setToUninstall] = useState(null);
  const isWin = info?.platform.os === 'windows';

  const act = async (key, fn, success) => {
    setBusy(key);
    try {
      const res = await fn();
      if (success) toast('success', typeof success === 'function' ? success(res) : success);
      res?.warnings?.forEach((w) => toast('warning', w, 12000));
      await reload();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setBusy(null);
    }
  };

  const addToPath = (inst, scope) =>
    act(`${inst.id}:path`, () => api('/api/path/add', { method: 'POST', body: { id: inst.id, scope } }), (r) =>
      r.removed.length ? `${inst.version} added to ${scope} PATH (replaced ${r.removed.length} other entr${r.removed.length === 1 ? 'y' : 'ies'})` : `${inst.version} added to ${scope} PATH`,
    );

  const removeFromPath = (inst, scope) =>
    act(`${inst.id}:path`, () => api('/api/path/remove', { method: 'POST', body: { id: inst?.id, scope } }), `Removed from ${scope} PATH`);

  if (!local) {
    return (
      <div className="panel center">
        <Spinner label="Scanning for LibreOffice installs…" />
      </div>
    );
  }

  const { installs, status } = local;
  const q = filter.trim().toLowerCase();
  const shown = q ? installs.filter((i) => `${i.version} ${i.root} ${i.kind} ${i.source}`.toLowerCase().includes(q)) : installs;
  const userHasLo = status.scopes.user.entries.some((e) => e.libreoffice);
  const shadowed = isWin && status.newShells?.scope === 'machine' && userHasLo;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Installed versions</h1>
          <p className="muted">
            Found in the install folder, your scan folders and standard system locations.
          </p>
        </div>
        <div className="view-actions">
          <input className="input" type="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter installs" />
          <Button onClick={reload} busy={loading}>
            Rescan
          </Button>
        </div>
      </div>

      {shadowed && (
        <div className="callout callout-warning">
          <div>
            <strong>Your user PATH entry is hidden.</strong> Windows looks at the machine PATH first, so new terminals use{' '}
            <code>{status.newShells.programDir}</code>.
          </div>
          <Button size="sm" variant="warning" busy={busy === 'machine-clear'} onClick={() => act('machine-clear', () => api('/api/path/remove', { method: 'POST', body: { scope: 'machine' } }), 'Removed LibreOffice from the machine PATH')}>
            Remove from machine PATH (admin)
          </Button>
        </div>
      )}

      {!installs.length ? (
        <Empty title="No LibreOffice installs found">
          Install one from <button type="button" className="link" onClick={() => goTo('available')}>Available</button>, or add a folder
          you already keep versions in (like <code>D:\LibreOfficePortable</code>) under{' '}
          <button type="button" className="link" onClick={() => goTo('settings')}>Settings → Scan folders</button>.
        </Empty>
      ) : (
        <div className="install-list">
          {shown.map((inst) => {
            const f = inst.path;
            const pathBusy = busy === `${inst.id}:path`;
            return (
              <article key={inst.id} className={`install${f.newShells ? ' is-active' : ''}`}>
                <div className="install-main">
                  <div className="install-title">
                    <span className="version mono">{inst.version ?? 'unknown'}</span>
                    <Badge>{KIND_LABEL[inst.kind] ?? inst.kind}</Badge>
                    <Badge tone={inst.source === 'managed' ? 'accent-soft' : 'neutral'} title={inst.source === 'managed' ? 'Installed by lovs' : inst.source === 'scanned' ? 'Found in a scan folder' : 'System install'}>
                      {inst.source}
                    </Badge>
                    {inst.isolatedProfile && inst.kind !== 'portable' && <Badge title="Uses its own user profile">own profile</Badge>}
                  </div>
                  <div className="install-path mono" title={inst.portableRoot ?? inst.root}>
                    {inst.portableRoot ?? inst.root}
                  </div>
                  <div className="install-flags">
                    {f.newShells && <Badge tone="accent">active in new terminals</Badge>}
                    {f.current && <Badge tone="info">on server PATH</Badge>}
                    {f.user && <Badge tone="outline">user PATH</Badge>}
                    {f.machine && <Badge tone="outline">machine PATH</Badge>}
                  </div>
                </div>
                <div className="install-actions">
                  <Button size="sm" onClick={() => setShellFor(inst)}>
                    Use in a terminal
                  </Button>
                  <Menu
                    label={pathBusy ? 'Updating…' : 'PATH ▾'}
                    variant="default"
                    items={[
                      !f.user && { label: 'Add to user PATH', hint: 'recommended', onClick: () => addToPath(inst, 'user') },
                      !f.machine && { label: 'Add to machine PATH', hint: isWin ? 'asks for admin' : 'needs sudo', onClick: () => addToPath(inst, 'machine') },
                      f.user && { label: 'Remove from user PATH', onClick: () => removeFromPath(inst, 'user') },
                      f.machine && { label: 'Remove from machine PATH', hint: isWin ? 'asks for admin' : 'needs sudo', onClick: () => removeFromPath(inst, 'machine') },
                    ]}
                  />
                  <Menu
                    label="⋯"
                    items={[
                      { label: 'Open folder', onClick: () => act(`${inst.id}:reveal`, () => api('/api/reveal', { method: 'POST', body: { id: inst.id } })) },
                      { label: 'Uninstall…', danger: true, disabled: !inst.managed, hint: inst.managed ? '' : 'not installed by lovs', onClick: () => setToUninstall(inst) },
                    ]}
                  />
                </div>
              </article>
            );
          })}
          {!shown.length && <Empty title={`Nothing matches “${filter}”`} />}
        </div>
      )}

      <PathSummary status={status} />

      {shellFor && <ShellModal install={shellFor} onClose={() => setShellFor(null)} />}
      {toUninstall && (
        <Modal
          title={`Uninstall ${toUninstall.version}?`}
          onClose={() => setToUninstall(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setToUninstall(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                busy={busy === 'uninstall'}
                onClick={async () => {
                  const inst = toUninstall;
                  await act('uninstall', () => api('/api/uninstall', { method: 'POST', body: { id: inst.id } }), `Uninstalled ${inst.version}`);
                  setToUninstall(null);
                }}
              >
                Delete folder
              </Button>
            </>
          }
        >
          <p>This permanently deletes:</p>
          <p className="mono break">{toUninstall.portableRoot ?? toUninstall.root}</p>
          <p className="muted">It is removed from your user PATH first if it is there.</p>
        </Modal>
      )}
    </section>
  );
}

function PathSummary({ status }) {
  return (
    <details className="path-summary">
      <summary>PATH details</summary>
      <div className="path-grid">
        {['user', 'machine'].map((scope) => {
          const lo = status.scopes[scope].entries.filter((e) => e.libreoffice);
          return (
            <div key={scope}>
              <div className="path-scope">
                {scope} PATH <span className="muted mono">{status.scopes[scope].location}</span>
              </div>
              {lo.length ? lo.map((e) => <div key={e.entry} className="mono small break">{e.expanded}</div>) : <div className="muted small">No LibreOffice entries</div>}
            </div>
          );
        })}
        <div>
          <div className="path-scope">soffice on this server's PATH</div>
          <div className="mono small break">{status.current?.realPath ?? 'not found'}</div>
        </div>
      </div>
      <p className="muted small">
        PATH changes apply to terminals opened afterwards. To switch the current terminal only, use “Use in a terminal”.
      </p>
    </details>
  );
}
