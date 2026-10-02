import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CopyField, Modal, Spinner } from './ui.jsx';

const SHELL_LABEL = { powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'bash / zsh', fish: 'fish' };

export default function ShellModal({ install, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [shell, setShell] = useState(null);

  useEffect(() => {
    api(`/api/env/${install.id}`)
      .then((d) => {
        setData(d);
        setShell(Object.keys(d.commands)[0]);
      })
      .catch((e) => setError(e.message));
  }, [install.id]);

  return (
    <Modal title={`Use ${install.version} in a terminal`} onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!data && !error && <Spinner label="Loading…" />}
      {data && (
        <>
          <p className="muted">
            Paste into a terminal to make <code>soffice</code> run {install.version} <strong>in that terminal only</strong>. Nothing else changes and
            closing the terminal undoes it.
          </p>
          <div className="seg" role="tablist">
            {Object.keys(data.commands).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={shell === s} className={`seg-btn${shell === s ? ' is-active' : ''}`} onClick={() => setShell(s)}>
                {SHELL_LABEL[s] ?? s}
              </button>
            ))}
          </div>
          <CopyField label="Set PATH for this session" value={data.commands[shell]} />
          <CopyField label="Same thing via lovs" value={data.evalHints[shell]} />
          <h3 className="subhead">Other options</h3>
          <CopyField label="Run a single command with this version" value={data.exec} />
          <CopyField label="Open a new sub-shell with this version" value={data.shell} />
          {data.sudoPathAdd && <CopyField label="Add to the machine PATH (run in a terminal, needs sudo)" value={data.sudoPathAdd} />}
          <p className="muted small">
            Program folder: <span className="mono break">{data.programDir}</span>
          </p>
        </>
      )}
    </Modal>
  );
}
