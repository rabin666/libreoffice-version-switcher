// Small presentational controls shared by every view: buttons, badges, spinners and toggles.
import { classNames } from '../../lib/classNames.js';

/** A busy button shows a spinner and is never clickable, even when `disabled={false}` is passed. */
export function Button({ variant = 'default', size, busy, disabled, children, className = '', ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={classNames('btn', `btn-${variant}`, size && `btn-${size}`, busy && 'is-busy', className)}
      disabled={busy || disabled}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A button styled as an inline text link. */
export function LinkButton({ className, children, ...props }) {
  return (
    <button type="button" className={classNames('link', className)} {...props}>
      {children}
    </button>
  );
}

/** The "×" icon button used to close modals, dismiss toasts and remove list items. */
export function CloseButton({ label, onClick }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} onClick={onClick}>
      ×
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

/** Segmented button group; `options` is a list of { value, label }. `asTabs` adds tab semantics. */
export function SegmentedControl({ options, value, onChange, asTabs = false }) {
  return (
    <div className="seg" role={asTabs ? 'tablist' : undefined}>
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={asTabs ? 'tab' : undefined}
            aria-selected={asTabs ? isActive : undefined}
            className={classNames('seg-btn', isActive && 'is-active')}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
