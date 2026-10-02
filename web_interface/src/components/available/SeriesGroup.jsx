// One collapsible release series (e.g. 24.8) with a chip per build.
import { classNames } from '../../lib/classNames.js';
import { formatDate, pluralize } from '../../lib/format.js';
import { Badge } from '../ui/index.js';

export default function SeriesGroup({ series, builds, isOpen, onToggle, installedVersions, selectedVersion, onSelect }) {
  const newestBuild = builds[0];
  const installedCount = builds.filter((build) => installedVersions.has(build.version)).length;

  return (
    <div className={classNames('series', isOpen && 'is-open')}>
      <button type="button" className="series-head" onClick={onToggle} aria-expanded={isOpen}>
        <span className="series-caret" aria-hidden="true">
          ▸
        </span>
        <span className="series-name mono">{series}</span>
        <span className="muted small">
          {builds.length} {pluralize(builds.length, 'build', 'builds')} · latest <span className="mono">{newestBuild.version}</span>
          {newestBuild.date && ` · ${formatDate(newestBuild.date)}`}
        </span>
        {installedCount > 0 && <Badge tone="accent-soft">{installedCount} installed</Badge>}
      </button>
      {isOpen && (
        <div className="chips">
          {builds.map((build) => (
            <BuildChip
              key={build.version}
              build={build}
              isInstalled={installedVersions.has(build.version)}
              isSelected={selectedVersion === build.version}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function chipTooltip(build, isInstalled) {
  if (isInstalled) return 'Installed';
  return build.date ? `Published ${formatDate(build.date)}` : undefined;
}

function BuildChip({ build, isInstalled, isSelected, onSelect }) {
  return (
    <button
      type="button"
      className={classNames('chip mono', isSelected && 'is-selected', isInstalled && 'is-installed', build.prerelease && 'is-pre')}
      onClick={() => onSelect(build.version)}
      title={chipTooltip(build, isInstalled)}
    >
      {build.version}
      {isInstalled && <span aria-label="installed"> ✓</span>}
    </button>
  );
}
