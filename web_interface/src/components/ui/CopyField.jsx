// Read-only code value with a copy-to-clipboard button.
import { useState } from 'react';
import { copyText } from '../../lib/clipboard.js';

const COPIED_FEEDBACK_MS = 1400;

export function CopyField({ value, label }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <div className="copy-field">
      {label && <div className="copy-label">{label}</div>}
      <div className="copy-row">
        <code>{value}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
