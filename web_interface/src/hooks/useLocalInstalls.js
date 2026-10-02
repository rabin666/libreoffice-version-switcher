// Loads GET /api/local: the installs found on this machine plus the current PATH status.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/ui/index.js';

export function useLocalInstalls() {
  const showToast = useToast();
  const [local, setLocal] = useState(null);
  const [loading, setLoading] = useState(false);

  const reloadLocal = useCallback(async () => {
    setLoading(true);
    try {
      setLocal(await api('/api/local'));
    } catch (err) {
      showToast('error', `Could not scan local installs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    reloadLocal();
  }, [reloadLocal]);

  return { local, loading, reloadLocal };
}
