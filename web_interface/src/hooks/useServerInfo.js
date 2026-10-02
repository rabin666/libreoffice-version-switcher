// Loads GET /api/info (platform, config, schema, tools) and tracks whether the server is reachable.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export function useServerInfo() {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const reloadInfo = useCallback(async () => {
    try {
      setInfo(await api('/api/info'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    reloadInfo();
  }, [reloadInfo]);

  return { info, loadError, reloadInfo };
}
