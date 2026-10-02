// Read-only summary of the external tools lovs detected (downloader, XDM, 7-Zip).
import { Badge } from '../ui/index.js';

export default function ToolsCard({ info }) {
  const { xdm, downloader, sevenZip } = info.tools;
  return (
    <div className="tools">
      <Tool name="Downloads use">
        <div>
          <Badge tone="accent-soft">{downloader === 'xdm' ? 'XDM' : `built-in · ${info.config.connections} connections`}</Badge>
        </div>
      </Tool>
      <Tool name="XDM">
        <div className="small">
          {xdm.found ? <span className="mono break">{xdm.path}</span> : <span className="muted">not found</span>}{' '}
          {xdm.running && <Badge tone="info">running</Badge>}
        </div>
      </Tool>
      {/* The server only reports 7-Zip on Windows, where portable installs need it. */}
      {sevenZip !== undefined && (
        <Tool name="7-Zip">
          <div className="small">
            {sevenZip ? <span className="mono break">{sevenZip}</span> : <span className="muted">not found: portable installs open the GUI installer</span>}
          </div>
        </Tool>
      )}
    </div>
  );
}

function Tool({ name, children }) {
  return (
    <div className="tool">
      <div className="tool-name">{name}</div>
      {children}
    </div>
  );
}
