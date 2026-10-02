import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Spinner, Toggle, useToast } from './ui.jsx';

const GROUPS = [
  { title: 'Folders', keys: ['installDir', 'scanDirs', 'downloadDir', 'keepDownloads'] },
  { title: 'Downloads', keys: ['downloader', 'xdmPath', 'connections'] },
  { title: 'Installing', keys: ['windowsMethod', 'linuxMethod', 'sevenZipPath', 'isolateProfile'] },
  { title: 'Interface', keys: ['includePrereleases', 'port'] },
];

const LABELS = {
  installDir: 'Install folder',
  scanDirs: 'Scan folders',
  downloadDir: 'Download folder',
  keepDownloads: 'Keep installer files',
  downloader: 'Downloader',
  xdmPath: 'XDM location',
  connections: 'Parallel connections',
  windowsMethod: 'Windows install method',
  linuxMethod: 'Linux package type',
  sevenZipPath: '7-Zip location',
  isolateProfile: 'Separate profile per version',
  includePrereleases: 'Show pre-releases',
  port: 'Web UI port',
};

const WINDOWS_ONLY = new Set(['windowsMethod', 'sevenZipPath']);
const LINUX_ONLY = new Set(['linuxMethod']);

export default function SettingsView({ info, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(info?.config ?? null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (info) setDraft(info.config);
  }, [info]);

  const schema = useMemo(() => Object.fromEntries((info?.schema ?? []).map((s) => [s.key, s])), [info]);

  if (!info || !draft) {
    return (
      <div className="panel center">
        <Spinner label="Loading settings…" />
      </div>
    );
  }

  const os = info.platform.os;
  const changed = Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(info.config[k]));
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/config', { method: 'PUT', body: Object.fromEntries(changed.map((k) => [k, draft[k]])) });
      toast('success', 'Settings saved');
      onSaved();
    } catch (err) {
      toast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Stored in <span className="mono">{info.home}</span>. The CLI (<span className="mono">lovs config</span>) uses the same file.
          </p>
        </div>
        <div className="view-actions">
          <Button variant="ghost" disabled={!changed.length || saving} onClick={() => setDraft(info.config)}>
            Discard
          </Button>
          <Button variant="primary" disabled={!changed.length} busy={saving} onClick={save}>
            Save{changed.length ? ` (${changed.length})` : ''}
          </Button>
        </div>
      </div>

      <ToolsCard info={info} />

      {GROUPS.map((g) => {
        const keys = g.keys.filter((k) => schema[k] && !(WINDOWS_ONLY.has(k) && os !== 'windows') && !(LINUX_ONLY.has(k) && os !== 'linux'));
        if (!keys.length) return null;
        return (
          <fieldset key={g.title} className="settings-group">
            <legend>{g.title}</legend>
            {keys.map((k) => (
              <div key={k} className={`setting${changed.includes(k) ? ' is-changed' : ''}`}>
                <div className="setting-label">
                  <label htmlFor={`cfg-${k}`}>{LABELS[k] ?? k}</label>
                  <div className="muted small">{schema[k].description}</div>
                </div>
                <div className="setting-control">
                  <Field id={`cfg-${k}`} s={schema[k]} value={draft[k]} onChange={(v) => set(k, v)} />
                </div>
              </div>
            ))}
          </fieldset>
        );
      })}
    </section>
  );
}

function Field({ id, s, value, onChange }) {
  switch (s.type) {
    case 'boolean':
      return <Toggle id={id} checked={Boolean(value)} onChange={onChange} />;
    case 'enum':
      return (
        <div className="seg">
          {s.values.map((v) => (
            <button key={v} type="button" className={`seg-btn${value === v ? ' is-active' : ''}`} onClick={() => onChange(v)}>
              {v}
            </button>
          ))}
        </div>
      );
    case 'number':
      return <input id={id} className="input input-num" type="number" min={s.min} max={s.max} value={value} onChange={(e) => onChange(Number(e.target.value))} />;
    case 'paths':
      return <PathList id={id} value={value} onChange={onChange} />;
    default:
      return <input id={id} className="input mono" type="text" value={value} placeholder="(auto)" onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
}

function PathList({ id, value, onChange }) {
  const [entry, setEntry] = useState('');
  const add = () => {
    const v = entry.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setEntry('');
  };
  return (
    <div className="path-list">
      {value.map((p) => (
        <div key={p} className="path-list-item">
          <span className="mono break">{p}</span>
          <button type="button" className="icon-btn" aria-label={`Remove ${p}`} onClick={() => onChange(value.filter((x) => x !== p))}>
            ×
          </button>
        </div>
      ))}
      <div className="path-list-add">
        <input
          id={id}
          className="input mono"
          type="text"
          placeholder="D:\LibreOfficePortable"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          spellCheck={false}
        />
        <Button size="sm" onClick={add} disabled={!entry.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function ToolsCard({ info }) {
  const { xdm, downloader, sevenZip } = info.tools;
  return (
    <div className="tools">
      <div className="tool">
        <div className="tool-name">Downloads use</div>
        <div>
          <Badge tone="accent-soft">{downloader === 'xdm' ? 'XDM' : `built-in · ${info.config.connections} connections`}</Badge>
        </div>
      </div>
      <div className="tool">
        <div className="tool-name">XDM</div>
        <div className="small">
          {xdm.found ? <span className="mono break">{xdm.path}</span> : <span className="muted">not found</span>}{' '}
          {xdm.running && <Badge tone="info">running</Badge>}
        </div>
      </div>
      {sevenZip !== undefined && (
        <div className="tool">
          <div className="tool-name">7-Zip</div>
          <div className="small">{sevenZip ? <span className="mono break">{sevenZip}</span> : <span className="muted">not found: portable installs open the GUI installer</span>}</div>
        </div>
      )}
    </div>
  );
}
