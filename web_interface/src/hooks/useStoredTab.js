// The selected top-level tab, remembered across reloads in localStorage.
import { useState } from 'react';

const STORAGE_KEY = 'lovs.tab';

// localStorage can throw (private mode, blocked storage); the tab is only a convenience.
function readStoredTab(tabIds, fallback) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return tabIds.includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function storeTab(tabId) {
  try {
    localStorage.setItem(STORAGE_KEY, tabId);
  } catch {
    // Not persisting is fine.
  }
}

export function useStoredTab(tabIds, fallback) {
  const [tab, setTabState] = useState(() => readStoredTab(tabIds, fallback));

  const setTab = (tabId) => {
    setTabState(tabId);
    storeTab(tabId);
  };

  return [tab, setTab];
}
