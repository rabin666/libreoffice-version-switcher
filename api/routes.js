import { spawn } from 'node:child_process';
import { CONFIG_SCHEMA, loadConfig, lovsHome, saveConfig } from '../utils/config.js';
import { envCommands, evalHint, shellsForPlatform } from '../utils/envcmd.js';
import { defaultMethod, findSevenZip, installVersion, resolveDownloader, uninstallInstall } from '../utils/install.js';
import { scanLocalInstalls } from '../utils/local.js';
import { addToPath, getPathStatus, pathFlagsFor, removeFromPath } from '../utils/pathenv.js';
import { detectPlatform, installMethods, isWindows } from '../utils/platform.js';
import { getVersionArtifacts, listRemoteVersions } from '../utils/remote.js';
import { isVersionString } from '../utils/versions.js';
import { xdmStatus } from '../utils/xdm.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function findInstall(id) {
  const installs = await scanLocalInstalls(loadConfig());
  const inst = installs.find((i) => i.id === id);
  if (!inst) throw new HttpError(404, 'Install not found (rescan and try again)');
  return inst;
}

function requireScope(scope) {
  if (scope !== 'user' && scope !== 'machine') throw new HttpError(400, 'scope must be "user" or "machine"');
  return scope;
}

function revealFolder(dir) {
  const [cmd, args] = isWindows ? ['explorer.exe', [dir]] : ['xdg-open', [dir]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Route table: [method, pattern, handler(ctx)] where ctx = {params, query, body}. */
export function createRoutes({ jobs, appVersion }) {
  return [
    [
      'GET',
      '/api/info',
      async () => {
        const config = loadConfig();
        const platform = detectPlatform();
        const [xdm, downloader] = await Promise.all([
          xdmStatus(config.xdmPath),
          resolveDownloader(config).catch(() => 'builtin'),
        ]);
        return {
          appVersion,
          platform,
          methods: installMethods(platform),
          defaultMethod: platform.supported ? defaultMethod(config, platform) : null,
          shells: shellsForPlatform(),
          home: lovsHome(),
          config,
          schema: Object.entries(CONFIG_SCHEMA).map(([key, s]) => ({ key, type: s.type, values: s.values, min: s.min, max: s.max, description: s.description })),
          tools: { xdm, downloader, sevenZip: platform.os === 'windows' ? (findSevenZip(config.sevenZipPath) ?? null) : undefined },
        };
      },
    ],

    [
      'GET',
      '/api/local',
      async () => {
        const [installs, status] = await Promise.all([scanLocalInstalls(loadConfig()), getPathStatus()]);
        return { installs: installs.map((i) => ({ ...i, path: pathFlagsFor(i, status) })), status };
      },
    ],

    ['GET', '/api/remote', async ({ query }) => ({ versions: await listRemoteVersions({ refresh: query.refresh === '1' }) })],

    [
      'GET',
      '/api/remote/:version',
      async ({ params, query }) => {
        if (!isVersionString(params.version)) throw new HttpError(400, 'Invalid version');
        return getVersionArtifacts(params.version, { refresh: query.refresh === '1' });
      },
    ],

    [
      'POST',
      '/api/install',
      async ({ body }) => {
        const { version, method, downloader, force } = body ?? {};
        if (!isVersionString(version ?? '')) throw new HttpError(400, 'Invalid version');
        const config = loadConfig();
        const m = method || defaultMethod(config);
        const key = `install:${version}:${m}`;
        const active = jobs.findActive(key);
        if (active) return active;
        return jobs.start({ type: 'install', title: `Install LibreOffice ${version} (${m})`, key, meta: { version, method: m } }, (ctx) =>
          installVersion({
            version,
            method: m,
            config,
            downloader: downloader || undefined,
            force: Boolean(force),
            signal: ctx.signal,
            onPhase: ctx.phase,
            onProgress: ctx.progress,
            onLog: ctx.log,
          }).then((inst) => ({ id: inst?.id, root: inst?.portableRoot ?? inst?.root })),
        );
      },
    ],

    ['POST', '/api/uninstall', async ({ body }) => uninstallInstall(await findInstall(body?.id), loadConfig())],

    ['GET', '/api/jobs', async () => ({ jobs: jobs.list() })],
    [
      'POST',
      '/api/jobs/:id/cancel',
      async ({ params }) => {
        if (!jobs.cancel(params.id)) throw new HttpError(404, 'No running job with that id');
        return { ok: true };
      },
    ],
    [
      'DELETE',
      '/api/jobs/:id',
      async ({ params }) => {
        if (!jobs.dismiss(params.id)) throw new HttpError(404, 'No finished job with that id');
        return { ok: true };
      },
    ],

    ['GET', '/api/path', async () => getPathStatus()],
    [
      'POST',
      '/api/path/add',
      async ({ body }) => addToPath(await findInstall(body?.id), { scope: requireScope(body?.scope ?? 'user'), replace: body?.replace !== false }),
    ],
    [
      'POST',
      '/api/path/remove',
      async ({ body }) => removeFromPath({ scope: requireScope(body?.scope ?? 'user'), install: body?.id ? await findInstall(body.id) : null }),
    ],

    [
      'GET',
      '/api/env/:id',
      async ({ params }) => {
        const inst = await findInstall(params.id);
        const spec = inst.version ?? inst.root;
        const shells = shellsForPlatform();
        return {
          version: inst.version,
          programDir: inst.programDir,
          commands: envCommands(inst.programDir),
          evalHints: Object.fromEntries(shells.map((s) => [s, evalHint(s, spec)])),
          exec: `lovs exec ${spec} -- soffice --headless --convert-to pdf document.docx`,
          shell: `lovs shell ${spec}`,
          sudoPathAdd: isWindows ? null : `sudo lovs path add "${inst.root}" --scope machine`,
        };
      },
    ],

    [
      'PUT',
      '/api/config',
      async ({ body }) => {
        try {
          return { config: saveConfig(body ?? {}) };
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      },
    ],

    [
      'POST',
      '/api/reveal',
      async ({ body }) => {
        const inst = await findInstall(body?.id);
        revealFolder(inst.portableRoot ?? inst.root);
        return { ok: true };
      },
    ],
  ];
}

/** Match "/api/jobs/:id/cancel" style patterns. */
export function matchRoute(routes, method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pp = pattern.split('/');
    const sp = pathname.split('/');
    if (pp.length !== sp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}
