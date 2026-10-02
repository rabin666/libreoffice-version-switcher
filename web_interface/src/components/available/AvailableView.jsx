// "Available" tab: browse the official archive by series and pick a build to install.
import { useCallback, useMemo, useState } from 'react';
import { useRemoteVersions } from '../../hooks/useRemoteVersions.js';
import { groupBySeries, newestStableSeries } from '../../lib/versions.js';
import { Button, Empty, LoadingPanel, Toggle, ViewHeader } from '../ui/index.js';
import SeriesGroup from './SeriesGroup.jsx';
import VersionDetail from './VersionDetail.jsx';

export default function AvailableView({ info, installs, jobs, goTo }) {
  const [filter, setFilter] = useState('');
  const [showPrereleases, setShowPrereleases] = useState(Boolean(info?.config.includePrereleases));
  const [expandedSeries, setExpandedSeries] = useState(() => new Set());
  const [selectedVersion, setSelectedVersion] = useState(null);

  // Open the newest stable series on first load, but never override what the user expanded.
  const expandDefaultSeries = useCallback(
    (versions) => setExpandedSeries((current) => (current.size ? current : new Set(newestStableSeries(versions)))),
    [],
  );
  const { versions, loading, error, refresh } = useRemoteVersions({ onLoaded: expandDefaultSeries });

  const installedVersions = useMemo(
    () => new Set((installs ?? []).map((install) => install.version).filter(Boolean)),
    [installs],
  );

  const query = filter.trim();
  // While filtering, every series is open so no match hides inside a collapsed one.
  const isFiltering = query.length > 0;
  const seriesGroups = useMemo(
    () => (versions ? groupBySeries(versions, { query, includePrereleases: showPrereleases }) : []),
    [versions, query, showPrereleases],
  );

  const toggleSeries = (series) =>
    setExpandedSeries((current) => {
      const next = new Set(current);
      if (next.has(series)) next.delete(series);
      else next.add(series);
      return next;
    });

  return (
    <section className="view">
      <ViewHeader
        title="Available versions"
        description="From the official archive (downloadarchive.documentfoundation.org). Pick a build to see its packages."
        actions={
          <>
            <input className="input" type="search" placeholder="e.g. 7.6 or 24.8.7" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter versions" />
            <Toggle id="pre" checked={showPrereleases} onChange={setShowPrereleases} label="Pre-releases" />
            <Button onClick={refresh} busy={loading}>
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <div className="callout callout-error">
          <div>Couldn't load the archive listing: {error}</div>
          <Button size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {!versions && !error && <LoadingPanel label="Fetching the archive listing…" />}

      {versions && (
        <div className="available-layout">
          <div className="series-list">
            {!seriesGroups.length && <Empty title="No versions match">Try a shorter filter such as “7” or “24.8”.</Empty>}
            {seriesGroups.map(({ series, builds }) => (
              <SeriesGroup
                key={series}
                series={series}
                builds={builds}
                isOpen={isFiltering || expandedSeries.has(series)}
                onToggle={() => toggleSeries(series)}
                installedVersions={installedVersions}
                selectedVersion={selectedVersion}
                onSelect={setSelectedVersion}
              />
            ))}
          </div>

          <aside className="detail">
            {selectedVersion ? (
              <VersionDetail key={selectedVersion} version={selectedVersion} info={info} installs={installs} jobs={jobs} goTo={goTo} />
            ) : (
              <NoBuildSelected />
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function NoBuildSelected() {
  return (
    <div className="detail-empty">
      <div className="detail-empty-title">Select a build</div>
      <p className="muted small">
        Each series lists every build; the first is the newest. The last build of a series (e.g. <span className="mono">7.6.7.2</span>) is
        usually the one to test against.
      </p>
    </div>
  );
}
