// Full-page error shown when the very first /api/info request fails.

export function FatalScreen({ message }) {
  return (
    <div className="fatal">
      <h1>Can't reach the lovs server</h1>
      <p>{message}</p>
      <p className="muted">
        Start it with <code>lovs ui</code> and reload this page.
      </p>
    </div>
  );
}
