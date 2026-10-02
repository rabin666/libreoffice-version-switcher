// "Use in a terminal" dialog: per-shell commands (GET /api/env/:id) that switch soffice for one session.
import { useState } from 'react';
import { useApiGet } from '../../hooks/useApiGet.js';
import { CopyField, Modal, SegmentedControl, Spinner } from '../ui/index.js';

const SHELL_LABEL = { powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'bash / zsh', fish: 'fish' };

export default function ShellModal({ install, onClose }) {
  const { data: env, error } = useApiGet(`/api/env/${install.id}`);

  return (
    <Modal title={`Use ${install.version} in a terminal`} onClose={onClose}>
      {error && <p className="error-text">{error}</p>}
      {!env && !error && <Spinner label="Loading…" />}
      {env && <ShellCommands version={install.version} env={env} />}
    </Modal>
  );
}

function ShellCommands({ version, env }) {
  // The server lists the shells for this OS; the first one is the default.
  const shells = Object.keys(env.commands);
  const [shell, setShell] = useState(shells[0]);
  const shellOptions = shells.map((name) => ({ value: name, label: SHELL_LABEL[name] ?? name }));

  return (
    <>
      <p className="muted">
        Paste into a terminal to make <code>soffice</code> run {version} <strong>in that terminal only</strong>. Nothing else changes and
        closing the terminal undoes it.
      </p>
      <SegmentedControl asTabs options={shellOptions} value={shell} onChange={setShell} />
      <CopyField label="Set PATH for this session" value={env.commands[shell]} />
      <CopyField label="Same thing via lovs" value={env.evalHints[shell]} />
      <h3 className="subhead">Other options</h3>
      <CopyField label="Run a single command with this version" value={env.exec} />
      <CopyField label="Open a new sub-shell with this version" value={env.shell} />
      {env.sudoPathAdd && <CopyField label="Add to the machine PATH (run in a terminal, needs sudo)" value={env.sudoPathAdd} />}
      <p className="muted small">
        Program folder: <span className="mono break">{env.programDir}</span>
      </p>
    </>
  );
}
