// Actions on local installs (PATH changes, reveal, uninstall) with busy tracking and toasts.
import { useState } from 'react';
import { api } from '../api.js';
import { pluralize } from '../lib/format.js';
import { useToast } from '../components/ui/index.js';

const post = (path, body) => api(path, { method: 'POST', body });

/** Busy key shared by every PATH change on one install, so its PATH menu shows "Updating…". */
export const pathBusyKey = (install) => `${install.id}:path`;
export const MACHINE_CLEAR_BUSY_KEY = 'machine-clear';
export const UNINSTALL_BUSY_KEY = 'uninstall';

function describePathAdd(install, scope, { removed }) {
  const message = `${install.version} added to ${scope} PATH`;
  if (!removed.length) return message;
  return `${message} (replaced ${removed.length} other ${pluralize(removed.length, 'entry', 'entries')})`;
}

/**
 * Returns { busyKey, addToPath, removeFromPath, clearMachinePath, reveal, uninstall }.
 * Only one action runs at a time; `busyKey` names it. Every action reloads the installs afterwards.
 */
export function useInstallActions({ reload }) {
  const showToast = useToast();
  const [busyKey, setBusyKey] = useState(null);

  // `successMessage` is a string or a function of the response. Errors become toasts, never throws.
  const runAction = async (key, request, successMessage) => {
    setBusyKey(key);
    try {
      const response = await request();
      if (successMessage) {
        showToast('success', typeof successMessage === 'function' ? successMessage(response) : successMessage);
      }
      response?.warnings?.forEach((warning) => showToast('warning', warning, 12000));
      await reload();
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setBusyKey(null);
    }
  };

  return {
    busyKey,
    addToPath: (install, scope) =>
      runAction(
        pathBusyKey(install),
        () => post('/api/path/add', { id: install.id, scope }),
        (response) => describePathAdd(install, scope, response),
      ),
    removeFromPath: (install, scope) =>
      runAction(pathBusyKey(install), () => post('/api/path/remove', { id: install.id, scope }), `Removed from ${scope} PATH`),
    // No id: removes every LibreOffice entry from the machine PATH.
    clearMachinePath: () =>
      runAction(MACHINE_CLEAR_BUSY_KEY, () => post('/api/path/remove', { scope: 'machine' }), 'Removed LibreOffice from the machine PATH'),
    reveal: (install) => runAction(`${install.id}:reveal`, () => post('/api/reveal', { id: install.id })),
    uninstall: (install) => runAction(UNINSTALL_BUSY_KEY, () => post('/api/uninstall', { id: install.id }), `Uninstalled ${install.version}`),
  };
}
