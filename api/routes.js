// JSON API used by the web UI. Each handler gets {params, query, body} and
// returns the response body; throw HttpError for client errors.

import { spawn } from 'node:child_process';
import { CONFIG_SCHEMA, loadConfig, lovsHome, saveConfig } from '../utils/config.js';
import { defaultMethod, installVersion, resolveDownloader, uninstall } from '../utils/install.js';
import { scanLocalInstalls } from '../utils/local.js';
import { addToPath, getPathStatus, pathFlagsFor, removeFromPath } from '../utils/pathenv.js';
import { detectPlatform, installMethods, isWindows } from '../utils/platform.js';
import { getVersionArtifacts, listRemoteVersions } from '../utils/remote.js';
import { activationCommands, activationOneLiner, quoteArg, shellsForPlatform } from '../utils/shell.js';
import { findSevenZip } from '../utils/unpack.js';
import { isVersionString } from '../utils/versions.js';
import { xdmStatus } from '../utils/xdm.js';
import { HttpError } from './router.js';

/** Installs are addressed by id; the scan is the source of truth. */
async function findInstallById(id) {
  const installs = await scanLocalInstalls(loadConfig());
  const install = installs.find((candidate) => candidate.id === id);
  if (!install) throw new HttpError(404, 'Install not found (rescan and try again)');
  return install;
}

function requireScope(scope = 'user') {
  if (scope !== 'user' && scope !== 'machine') throw new HttpError(400, 'scope must be "user" or "machine"');
  return scope;
}

function requireVersion(version) {
  if (!isVersionString(version ?? '')) throw new HttpError(400, 'Invalid version');
  return version;
}

function openInFileManager(dir) {
  const [command, args] = isWindows ? ['explorer.exe', [dir]] : ['xdg-open', [dir]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function getInfo(appVersion) {
  const config = loadConfig();
  const platform = detectPlatform();
  const [xdm, downloader] = await Promise.all([xdmStatus(config.xdmPath), resolveDownloader(config).catch(() => 'builtin')]);
  return {
    appVersion,
    platform,
    methods: installMethods(platform),
    defaultMethod: platform.supported ? defaultMethod(config, platform) : null,
    shells: shellsForPlatform(),
    home: lovsHome(),
    config,
    schema: Object.entries(CONFIG_SCHEMA).map(([key, schema]) => ({
      key,
      type: schema.type,
      values: schema.values,
      min: schema.min,
      max: schema.max,
      description: schema.description,
    })),
    tools: { xdm, downloader, sevenZip: platform.os === 'windows' ? (findSevenZip(config.sevenZipPath) ?? null) : undefined },
  };
}

async function getLocalInstalls() {
  const [installs, status] = await Promise.all([scanLocalInstalls(loadConfig()), getPathStatus()]);
  return { installs: installs.map((install) => ({ ...install, path: pathFlagsFor(install, status) })), status };
}

/** Starts a background job; a second request for the same install returns the running one. */
function startInstall(jobs, body) {
  const { version, method, downloader, force } = body ?? {};
  requireVersion(version);
  const config = loadConfig();
  const chosenMethod = method || defaultMethod(config);
  const key = `install:${version}:${chosenMethod}`;
  const running = jobs.findActive(key);
  if (running) return running;

  const job = { type: 'install', title: `Install LibreOffice ${version} (${chosenMethod})`, key, meta: { version, method: chosenMethod } };
  return jobs.start(job, async (context) => {
    const install = await installVersion({
      version,
      method: chosenMethod,
      config,
      downloader: downloader || undefined,
      force: Boolean(force),
      signal: context.signal,
      onPhase: context.phase,
      onProgress: context.progress,
      onLog: context.log,
    });
    return { id: install?.id, root: install?.portableRoot ?? install?.root };
  });
}

/** Copy-paste commands for one install. The id always selects exactly it and never needs quoting. */
async function getActivationCommands(id) {
  const install = await findInstallById(id);
  const selector = install.id;
  return {
    version: install.version,
    programDir: install.programDir,
    commands: activationCommands(install.programDir),
    evalHints: Object.fromEntries(shellsForPlatform().map((shell) => [shell, activationOneLiner(shell, selector)])),
    exec: `lovs exec ${selector} -- soffice --headless --convert-to pdf document.docx`,
    shell: `lovs shell ${selector}`,
    // root has its own lovs config, so pass the folder rather than the id.
    sudoPathAdd: isWindows ? null : `sudo lovs path add ${quoteArg('bash', install.root)} --scope machine`,
  };
}

function saveSettings(body) {
  try {
    return { config: saveConfig(body ?? {}) };
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

export function createRoutes({ jobs, appVersion }) {
  return [
    ['GET', '/api/info', () => getInfo(appVersion)],
    ['GET', '/api/local', getLocalInstalls],
    ['GET', '/api/remote', async ({ query }) => ({ versions: await listRemoteVersions({ refresh: query.refresh === '1' }) })],
    ['GET', '/api/remote/:version', ({ params, query }) => getVersionArtifacts(requireVersion(params.version), { refresh: query.refresh === '1' })],

    ['POST', '/api/install', ({ body }) => startInstall(jobs, body)],
    ['POST', '/api/uninstall', async ({ body }) => uninstall(await findInstallById(body?.id), loadConfig())],

    ['GET', '/api/jobs', () => ({ jobs: jobs.list() })],
    [
      'POST',
      '/api/jobs/:id/cancel',
      ({ params }) => {
        if (!jobs.cancel(params.id)) throw new HttpError(404, 'No running job with that id');
        return { ok: true };
      },
    ],
    [
      'DELETE',
      '/api/jobs/:id',
      ({ params }) => {
        if (!jobs.dismiss(params.id)) throw new HttpError(404, 'No finished job with that id');
        return { ok: true };
      },
    ],

    ['GET', '/api/path', getPathStatus],
    [
      'POST',
      '/api/path/add',
      async ({ body }) => addToPath(await findInstallById(body?.id), { scope: requireScope(body?.scope), replace: body?.replace !== false }),
    ],
    [
      'POST',
      '/api/path/remove',
      async ({ body }) => removeFromPath({ scope: requireScope(body?.scope), install: body?.id ? await findInstallById(body.id) : null }),
    ],

    ['GET', '/api/env/:id', ({ params }) => getActivationCommands(params.id)],
    ['PUT', '/api/config', ({ body }) => saveSettings(body)],
    [
      'POST',
      '/api/reveal',
      async ({ body }) => {
        const install = await findInstallById(body?.id);
        openInFileManager(install.portableRoot ?? install.root);
        return { ok: true };
      },
    ],
  ];
}
