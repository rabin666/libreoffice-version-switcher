// Unsaved edits to the server config, compared against the last loaded values.
import { useEffect, useState } from 'react';

const isSameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Returns { draft, changedKeys, setValue, discard } for `savedConfig`; the draft resets when it changes. */
export function useConfigDraft(savedConfig) {
  const [draft, setDraft] = useState(savedConfig ?? null);

  useEffect(() => {
    if (savedConfig) setDraft(savedConfig);
  }, [savedConfig]);

  const changedKeys = draft ? Object.keys(draft).filter((key) => !isSameValue(draft[key], savedConfig?.[key])) : [];
  const setValue = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const discard = () => setDraft(savedConfig);

  return { draft, changedKeys, setValue, discard };
}
