// Loads the archive's version list (GET /api/remote), optionally bypassing the server cache.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Returns { versions, loading, error, refresh }. `onLoaded(versions)` runs after each
 * successful load; pass a stable callback, or every render triggers a new fetch.
 */
export function useRemoteVersions({ onLoaded }) {
  const [versions, setVersions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async ({ bypassCache = false } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const { versions: list } = await api(`/api/remote${bypassCache ? '?refresh=1' : ''}`);
        setVersions(list);
        onLoaded?.(list);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [onLoaded],
  );

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => load({ bypassCache: true }), [load]);

  return { versions, loading, error, refresh };
}
