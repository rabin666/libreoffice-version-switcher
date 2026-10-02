// Fetches one GET endpoint when the component mounts (or the path changes).
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** Returns { data, error }; both are null while the request is in flight. */
export function useApiGet(path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    api(path)
      .then((result) => isCurrent && setData(result))
      .catch((err) => isCurrent && setError(err.message));
    // Ignore a late response for a path we no longer show.
    return () => {
      isCurrent = false;
    };
  }, [path]);

  return { data, error };
}
