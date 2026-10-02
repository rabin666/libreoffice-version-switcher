// `lovs remote`, `lovs remote info` and `lovs install`: the official archive.

import pc from 'picocolors';
import { loadConfig } from '../../utils/config.js';
import { defaultMethod, installVersion, resolveDownloader } from '../../utils/install.js';
import { scanLocalInstalls } from '../../utils/local.js';
import { detectPlatform } from '../../utils/platform.js';
import { getVersionArtifacts, listRemoteVersions } from '../../utils/remote.js';
import { bestMatchingVersion, matchesSpec, shortVersion } from '../../utils/versions.js';
import { hintsFor } from '../hints.js';
import { formatBytes, info, ok, printJson, progressBar, table, warn } from '../output.js';

const SERIES_SHOWN_BY_DEFAULT = 12;

/** "7.6", "25.2.7" or "latest" -> exact archive version. */
async function resolveArchiveVersion(spec, { refresh } = {}) {
  const versions = (await listRemoteVersions({ refresh })).map((entry) => entry.version);
  const version = bestMatchingVersion(versions, spec);
  if (!version) throw new Error(`No version in the archive matches "${spec}"`);
  return version;
}

function groupBySeries(versions) {
  const groups = new Map();
  for (const entry of versions) {
    if (!groups.has(entry.series)) groups.set(entry.series, []);
    groups.get(entry.series).push(entry);
  }
  return groups;
}

export async function listArchive(filter, options) {
  const config = loadConfig();
  const includePrereleases = options.pre ?? config.includePrereleases;
  const [versions, installs] = await Promise.all([
    listRemoteVersions({ refresh: options.refresh }),
    scanLocalInstalls(config, { probe: false }).catch(() => []),
  ]);
  let shown = versions.filter((entry) => includePrereleases || !entry.prerelease);
  if (filter) shown = shown.filter((entry) => matchesSpec(entry.version, filter) || entry.version.startsWith(filter));
  if (options.json) return printJson(shown);

  // Scans without probing may only know 3 version parts.
  const installedVersions = installs.map((install) => install.version).filter(Boolean);
  const isInstalled = (version) =>
    installedVersions.some((installed) => installed === version || (installed.split('.').length < 4 && shortVersion(version) === installed));

  const groups = groupBySeries(shown);
  const allSeries = [...groups.keys()];
  const seriesShown = filter || options.all ? allSeries : allSeries.slice(0, SERIES_SHOWN_BY_DEFAULT);
  for (const series of seriesShown) {
    const builds = groups.get(series);
    const published = builds[0].date ? builds[0].date.slice(0, 10) : '';
    const cells = builds.map((build) => {
      if (isInstalled(build.version)) return pc.green(pc.bold(`${build.version}✓`));
      return build.prerelease ? pc.yellow(build.version) : build.version;
    });
    console.log(`${pc.bold(series.padEnd(6))} ${pc.dim(published)}  ${cells.join('  ')}`);
  }
  const hiddenCount = allSeries.length - seriesShown.length;
  if (hiddenCount > 0) console.log(pc.dim(`\n… ${hiddenCount} older series hidden (use --all, or e.g. "lovs remote 6.4")`));
  console.log(pc.dim(`\n${pc.green('✓')} installed locally.  Install with: lovs install <version|series>  (e.g. lovs install 7.6)`));
}

export async function showArchiveVersion(spec, options) {
  const version = await resolveArchiveVersion(spec, options);
  const { artifacts } = await getVersionArtifacts(version, { refresh: options.refresh });
  if (options.json) return printJson({ version, artifacts });

  const platform = detectPlatform();
  console.log(`${pc.bold(`LibreOffice ${version}`)} for ${platform.os}/${platform.archDir}\n`);
  if (!artifacts.length) return warn('No packages for this platform in the archive.');
  console.log(table(['METHOD', 'SIZE', 'FILE'], artifacts.map((artifact) => [artifact.method, formatBytes(artifact.size), pc.dim(artifact.url)])));
}

export async function installFromArchive(spec, options) {
  const config = loadConfig();
  if (options.keepDownload) config.keepDownloads = true;
  const version = await resolveArchiveVersion(spec, options);
  const method = options.method || defaultMethod(config);
  const downloaderName = await resolveDownloader(config, options.downloader);
  info(`Installing LibreOffice ${pc.bold(version)} (${method}, downloader: ${downloaderName}) into ${config.installDir}`);

  const controller = new AbortController();
  const cancelOnCtrlC = () => {
    controller.abort();
    warn('Cancelling…');
  };
  process.once('SIGINT', cancelOnCtrlC);
  const bar = progressBar('download');
  try {
    const install = await installVersion({
      version,
      method,
      config,
      downloader: options.downloader,
      force: options.force,
      signal: controller.signal,
      onPhase: (phase, detail) => {
        if (phase === 'resolve' || phase === 'done') return;
        bar.done();
        info(detail);
      },
      onProgress: (progress) => bar.update(progress),
      onLog: (message) => {
        bar.done();
        console.log(pc.dim(`  ${message}`));
      },
    });
    bar.done();
    ok(`Installed ${pc.bold(version)} at ${install.portableRoot ?? install.root}`);

    const hints = await hintsFor(install, config);
    if (hints) {
      console.log(`\n  Use it in this shell:   ${pc.bold(hints.activate)}`);
      console.log(`  Run one command:        ${pc.bold(hints.exec('soffice --version'))}`);
      console.log(`  Add to PATH:            ${pc.bold(hints.pathAdd)}`);
    }
  } finally {
    bar.done();
    process.removeListener('SIGINT', cancelOnCtrlC);
  }
}
