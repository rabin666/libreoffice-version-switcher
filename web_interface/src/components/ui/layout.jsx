// Page-level building blocks shared by the views: header, loading panel and empty state.
import { Spinner } from './controls.jsx';

/** Title, one-line description and optional right-hand actions at the top of a view. */
export function ViewHeader({ title, description, actions }) {
  return (
    <div className="view-head">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </div>
  );
}

/** Centered spinner shown while a view's first data is loading. */
export function LoadingPanel({ label }) {
  return (
    <div className="panel center">
      <Spinner label={label} />
    </div>
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
