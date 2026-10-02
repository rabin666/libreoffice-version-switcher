// Confirmation dialog before lovs deletes one of its own install folders.
import { installLocation } from '../../lib/installs.js';
import { Button, Modal } from '../ui/index.js';

export default function UninstallModal({ install, busy, onConfirm, onClose }) {
  return (
    <Modal
      title={`Uninstall ${install.version}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={onConfirm}>
            Delete folder
          </Button>
        </>
      }
    >
      <p>This permanently deletes:</p>
      <p className="mono break">{installLocation(install)}</p>
      <p className="muted">It is removed from your user PATH first if it is there.</p>
    </Modal>
  );
}
