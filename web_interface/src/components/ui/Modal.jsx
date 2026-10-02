// Modal dialog that closes on Escape, on a backdrop click and via its close button.
import { useEffect, useRef } from 'react';
import { CloseButton } from './controls.jsx';

export function Modal({ title, onClose, children, footer }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const closeOnEscape = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', closeOnEscape);
    // Move focus into the dialog so Escape and Tab work straight away.
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  // Only a press on the backdrop itself closes; presses inside the dialog bubble up here too.
  const closeOnBackdrop = (e) => e.target === e.currentTarget && onClose();

  return (
    <div className="modal-backdrop" onMouseDown={closeOnBackdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <h2>{title}</h2>
          <CloseButton label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
