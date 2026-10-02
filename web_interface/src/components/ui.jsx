import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { copyText } from '../api.js';

export function Button({ variant = 'default', size, busy, children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${size ? ` btn-${size}` : ''}${busy ? ' is-busy' : ''} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ label }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Toggle({ checked, onChange, label, id }) {
  return (
    <label className="toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function CopyField({ value, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label && <div className="copy-label">{label}</div>}
      <div className="copy-row">
        <code>{value}</code>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Small dropdown menu anchored to a button. items: [{label, onClick, danger, disabled, hint}] */
export function Menu({ label, items, variant = 'ghost', size = 'sm', align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <Button variant={variant} size={size} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}
      </Button>
      {open && (
        <div className={`menu-list menu-${align}`} role="menu">
          {items.filter(Boolean).map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item${it.danger ? ' is-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ toasts

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((tone, message, timeout = tone === 'error' ? 9000 : 5000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), timeout);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
