// Collapsible breakdown of the LibreOffice entries in the user and machine PATH.

const PATH_SCOPES = ['user', 'machine'];

export default function PathSummary({ status }) {
  return (
    <details className="path-summary">
      <summary>PATH details</summary>
      <div className="path-grid">
        {PATH_SCOPES.map((scope) => (
          <PathScope key={scope} scope={scope} scopeStatus={status.scopes[scope]} />
        ))}
        <div>
          <div className="path-scope">soffice on this server's PATH</div>
          <div className="mono small break">{status.current?.realPath ?? 'not found'}</div>
        </div>
      </div>
      <p className="muted small">
        PATH changes apply to terminals opened afterwards. To switch the current terminal only, use “Use in a terminal”.
      </p>
    </details>
  );
}

function PathScope({ scope, scopeStatus }) {
  const libreOfficeEntries = scopeStatus.entries.filter((entry) => entry.libreoffice);
  return (
    <div>
      <div className="path-scope">
        {scope} PATH <span className="muted mono">{scopeStatus.location}</span>
      </div>
      {libreOfficeEntries.length ? (
        libreOfficeEntries.map((entry) => (
          <div key={entry.entry} className="mono small break">
            {entry.expanded}
          </div>
        ))
      ) : (
        <div className="muted small">No LibreOffice entries</div>
      )}
    </div>
  );
}
