import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { APP_VERSION } from '../utils/appinfo.js';
import { CONFIG_SCHEMA, configFile, loadConfig, lovsHome, saveConfig } from '../utils/config.js';
import { SHELLS, detectShell, envCommand, envCommands, evalHint } from '../utils/envcmd.js';
import { defaultMethod, findSevenZip, installVersion, resolveDownloader, uninstallInstall } from '../utils/install.js';
import { resolveInstall, scanLocalInstalls } from '../utils/local.js';
import { SCOPES, addToPath, getPathStatus, pathFlagsFor, removeFromPath, samePath } from '../utils/pathenv.js';
import { detectPlatform, installMethods, isWindows } from '../utils/platform.js';
import { findOnPath } from '../utils/proc.js';
import { getVersionArtifacts, listRemoteVersions } from '../utils/remote.js';
import { matchesSpec, resolveSpec, shortVersion } from '../utils/versions.js';
import { xdmStatus } from '../utils/xdm.js';
import { formatBytes, info, ok, progressBar, table, warn } from './output.js';


function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function pathTags(flags) {
  const tags = [];
  if (flags.current) tags.push(pc.green('current shell'));
  if (flags.newShells) tags.push(pc.cyan('new shells'));
  if (flags.user) tags.push('user PATH');
  if (flags.machine) tags.push('machine PATH');
  return tags.join(', ');
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Remote spec ("7.6", "25.2.7", "latest") -> exact archive version. */
async function resolveRemote(spec, { refresh } = {}) {
  const versions = (await listRemoteVersions({ refresh })).map((v) => v.version);
  const version = resolveSpec(versions, spec);
  if (!version) throw new Error(`No version in the archive matches "${spec}"`);
  return version;
}

function printWarnings(list) {
  for (const w of list ?? []) warn(w);
}

// ---------------------------------------------------------------- commands

async function cmdList(opts) {
  const config = loadConfig();
  const [installs, status] = await Promise.all([scanLocalInstalls(config, { probe: opts.probe }), getPathStatus()]);
  if (opts.json) return printJson(installs.map((i) => ({ ...i, path: pathFlagsFor(i, status) })));
  if (!installs.length) {
    info('No LibreOffice installs found.');
    console.log(`  Install one with ${pc.bold('lovs install <version>')}, or add a folder to scan with`);
    console.log(`  ${pc.bold('lovs config add-scan-dir <dir>')}`);
    return;
  }
  const rows = installs.map((i) => {
    const flags = pathFlagsFor(i, status);
    const mark = flags.current ? pc.green('*') : flags.newShells ? pc.cyan('>') : ' ';
    return [mark, pc.bold(i.version ?? '?'), i.kind, i.source, pathTags(flags), pc.dim(i.portableRoot ?? i.root)];
  });
  console.log(table(['', 'VERSION', 'KIND', 'SOURCE', 'ACTIVE / PATH', 'LOCATION'], rows));
  console.log(pc.dim(`\n${pc.green('*')} soffice in this shell   ${pc.cyan('>')} soffice in new shells`));
}

async function cmdRemote(spec, opts) {
  const config = loadConfig();
  const includePre = opts.pre ?? config.includePrereleases;
  const [versions, installs] = await Promise.all([
    listRemoteVersions({ refresh: opts.refresh }),
    scanLocalInstalls(config, { probe: false }).catch(() => []),
  ]);
  let list = versions.filter((v) => includePre || !v.prerelease);
  if (spec) list = list.filter((v) => matchesSpec(v.version, spec) || v.version.startsWith(spec));
  if (opts.json) return printJson(list);

  const installed = installs.map((i) => i.version).filter(Boolean);
  const isInstalled = (v) => installed.some((iv) => iv === v || (iv.split('.').length < 4 && shortVersion(v) === iv));

  const bySeries = new Map();
  for (const v of list) {
    if (!bySeries.has(v.series)) bySeries.set(v.series, []);
    bySeries.get(v.series).push(v);
  }
  let series = [...bySeries.keys()];
  const limit = spec || opts.all ? series.length : 12;
  const hidden = series.length - limit;
  series = series.slice(0, limit);

  for (const s of series) {
    const builds = bySeries.get(s);
    const date = builds[0].date ? builds[0].date.slice(0, 10) : '';
    const cells = builds.map((b) => {
      const text = b.prerelease ? pc.yellow(b.version) : b.version;
      return isInstalled(b.version) ? pc.green(pc.bold(`${b.version}✓`)) : text;
    });
    console.log(`${pc.bold(s.padEnd(6))} ${pc.dim(date)}  ${cells.join('  ')}`);
  }
  if (hidden > 0) console.log(pc.dim(`\n… ${hidden} older series hidden (use --all, or e.g. "lovs remote 6.4")`));
  console.log(pc.dim(`\n${pc.green('✓')} installed locally.  Install with: lovs install <version|series>  (e.g. lovs install 7.6)`));
}

async function cmdInfo(spec, opts) {
  const version = await resolveRemote(spec, opts);
  const { artifacts } = await getVersionArtifacts(version, { refresh: opts.refresh });
  if (opts.json) return printJson({ version, artifacts });
  const platform = detectPlatform();
  console.log(`${pc.bold(`LibreOffice ${version}`)} for ${platform.os}/${platform.archDir}\n`);
  if (!artifacts.length) return warn('No packages for this platform in the archive.');
  console.log(table(['METHOD', 'SIZE', 'FILE'], artifacts.map((a) => [a.method, formatBytes(a.size), pc.dim(a.url)])));
}

async function cmdInstall(spec, opts) {
  const config = loadConfig();
  if (opts.keepDownload) config.keepDownloads = true;
  const version = await resolveRemote(spec, opts);
  const method = opts.method || defaultMethod(config);
  const via = await resolveDownloader(config, opts.downloader);
  info(`Installing LibreOffice ${pc.bold(version)} (${method}, downloader: ${via}) into ${config.installDir}`);

  const controller = new AbortController();
  const onSigint = () => {
    controller.abort();
    warn('Cancelling…');
  };
  process.once('SIGINT', onSigint);
  const bar = progressBar('download');
  try {
    const inst = await installVersion({
      version,
      method,
      config,
      downloader: opts.downloader,
      force: opts.force,
      signal: controller.signal,
      onPhase: (phase, detail) => {
        if (phase === 'download') return info(detail);
        if (phase !== 'resolve' && phase !== 'done') {
          bar.done();
          info(detail);
        }
      },
      onProgress: (p) => bar.update(p),
      onLog: (msg) => {
        bar.done();
        console.log(pc.dim(`  ${msg}`));
      },
    });
    bar.done();
    ok(`Installed ${pc.bold(version)} at ${inst.portableRoot ?? inst.root}`);
    console.log(`\n  Use it in this shell:   ${pc.bold(evalHint(detectShell(), version))}`);
    console.log(`  Run one command:        ${pc.bold(`lovs exec ${version} -- soffice --version`)}`);
    console.log(`  Add to PATH:            ${pc.bold(`lovs path add ${version}`)}`);
  } finally {
    bar.done();
    process.removeListener('SIGINT', onSigint);
  }
}

async function cmdUninstall(spec, opts) {
  const config = loadConfig();
  const inst = await resolveInstall(config, spec);
  const dir = inst.portableRoot ?? inst.root;
  if (!opts.yes && !(await confirm(`Delete LibreOffice ${inst.version} at ${dir}?`))) {
    return info('Nothing deleted (pass --yes to skip this question).');
  }
  const res = await uninstallInstall(inst, config);
  ok(`Removed ${res.removed}`);
  printWarnings(res.warnings);
}

async function cmdPathStatus(opts) {
  const config = loadConfig();
  const [status, installs] = await Promise.all([getPathStatus(), scanLocalInstalls(config, { probe: false })]);
  if (opts.json) return printJson(status);
  const versionOf = (dir) => installs.find((i) => samePath(i.programDir, dir))?.version;
  for (const scope of SCOPES) {
    const lo = status.scopes[scope].entries.filter((e) => e.libreoffice || !isWindows);
    console.log(`${pc.bold(`${scope} PATH`)} ${pc.dim(status.scopes[scope].location)}`);
    if (!lo.length) console.log(pc.dim('  (no LibreOffice entries)'));
    for (const e of lo) console.log(`  ${e.expanded}${versionOf(e.expanded) ? pc.green(`  [${versionOf(e.expanded)}]`) : ''}`);
  }
  const ns = status.newShells;
  console.log(`\n${pc.bold('New shells use:')}   ${ns ? `${ns.programDir} ${pc.dim(`(${ns.scope} PATH)`)}` : pc.dim('no LibreOffice on the persistent PATH')}`);
  const cur = status.current;
  console.log(`${pc.bold('This shell uses:')}  ${cur ? cur.realPath : pc.dim('soffice not found on PATH')}`);
  if (isWindows && ns?.scope === 'machine' && status.scopes.user.entries.some((e) => e.libreoffice)) {
    warn('The machine PATH entry hides the user PATH entry (Windows searches machine PATH first).');
  }
}

async function cmdPathAdd(spec, opts) {
  const config = loadConfig();
  const inst = await resolveInstall(config, spec);
  const res = await addToPath(inst, { scope: opts.scope, replace: !opts.keepOthers });
  ok(`Added ${res.added} to the ${res.scope} PATH`);
  for (const r of res.removed) console.log(pc.dim(`  removed ${r}`));
  for (const h of res.hooks) console.log(pc.dim(`  hooked into ${h}`));
  printWarnings(res.warnings);
  console.log(pc.dim(`\nOpen a new terminal for the change to apply. For this shell: ${evalHint(detectShell(), inst.version ?? spec)}`));
}

async function cmdPathRemove(spec, opts) {
  const config = loadConfig();
  const inst = spec ? await resolveInstall(config, spec) : null;
  const res = await removeFromPath({ scope: opts.scope, install: inst });
  if (!res.removed.length) return info(`Nothing to remove from the ${res.scope} PATH`);
  for (const r of res.removed) ok(`Removed ${r} from the ${res.scope} PATH`);
}

async function cmdEnv(spec, opts) {
  const config = loadConfig();
  const inst = await resolveInstall(config, spec);
  if (opts.shell) {
    console.log(envCommand(opts.shell, inst.programDir));
    return;
  }
  if (!process.stdout.isTTY) {
    // Piped (eval / Invoke-Expression): print only the command for this shell.
    console.log(envCommand(detectShell(), inst.programDir));
    return;
  }
  console.log(`${pc.bold(`LibreOffice ${inst.version}`)} for the current shell session only:\n`);
  for (const [shell, cmd] of Object.entries(envCommands(inst.programDir))) {
    console.log(`  ${pc.dim(shell.padEnd(10))} ${cmd}`);
  }
  console.log(`\n  ${pc.dim('one-liner'.padEnd(10))} ${evalHint(detectShell(), spec)}`);
  console.log(`  ${pc.dim('one command'.padEnd(10))} lovs exec ${spec} -- soffice --headless --convert-to pdf file.docx`);
}

function envWith(programDir, version) {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${programDir}${path.delimiter}${env[key] ?? ''}`;
  env.LOVS_ACTIVE = version ?? '';
  return env;
}

async function cmdExec(spec, command, args) {
  // passThroughOptions keeps a literal "--" separator; drop it.
  if (command === '--') [command, ...args] = args;
  if (!command) throw new Error('Specify the command to run, e.g. lovs exec 7.6 -- soffice --version');
  const config = loadConfig();
  const inst = await resolveInstall(config, spec);
  const env = envWith(inst.programDir, inst.version);
  // On Windows "soffice" resolves to soffice.com, the console-friendly launcher.
  const child = spawn(command, args, { stdio: 'inherit', env });
  child.on('error', (err) => {
    console.error(pc.red(err.message));
    process.exit(127);
  });
  child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
}

async function cmdShell(spec, opts) {
  const config = loadConfig();
  const inst = await resolveInstall(config, spec);
  const shell = opts.shell ?? detectShell();
  const env = envWith(inst.programDir, inst.version);
  const exe =
    shell === 'powershell' ? 'powershell.exe' : shell === 'cmd' ? process.env.ComSpec || 'cmd.exe' : shell === 'fish' ? 'fish' : process.env.SHELL || 'bash';
  info(`Starting ${shell} with LibreOffice ${pc.bold(inst.version)} first on PATH. Type ${pc.bold('exit')} to leave.`);
  const child = spawn(exe, shell === 'powershell' ? ['-NoLogo'] : [], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdWhich() {
  const status = await getPathStatus();
  console.log(status.current ? status.current.realPath : 'soffice is not on PATH');
  if (!status.current) process.exitCode = 1;
}

function showConfig(config) {
  const rows = Object.entries(CONFIG_SCHEMA).map(([key, s]) => {
    const v = config[key];
    const shown = Array.isArray(v) ? (v.length ? v.join(path.delimiter) : pc.dim('(none)')) : v === '' ? pc.dim('(auto)') : String(v);
    return [pc.bold(key), shown, pc.dim(s.description)];
  });
  console.log(table(['KEY', 'VALUE', 'DESCRIPTION'], rows));
  console.log(pc.dim(`\nConfig file: ${configFile()}`));
}

async function cmdDoctor() {
  const config = loadConfig();
  const platform = detectPlatform();
  const [xdm, status, via] = await Promise.all([
    xdmStatus(config.xdmPath),
    getPathStatus().catch((e) => ({ error: e.message })),
    resolveDownloader(config).catch((e) => `error: ${e.message}`),
  ]);
  const line = (k, v) => console.log(`  ${pc.dim(k.padEnd(18))} ${v}`);
  console.log(pc.bold('System'));
  line('platform', `${platform.pretty} (${platform.arch})`);
  line('install methods', installMethods(platform).join(', ') || pc.red('unsupported'));
  line('default method', defaultMethod(config, platform));
  line('lovs home', lovsHome());
  line('install folder', config.installDir);
  console.log(pc.bold('\nDownloads'));
  line('downloader', `${via} (config: ${config.downloader})`);
  line('XDM', xdm.found ? `${xdm.path}${xdm.running ? pc.green(' (running)') : ''}` : xdm.running ? pc.green('running') : pc.dim('not found'));
  if (platform.os === 'windows') {
    console.log(pc.bold('\nWindows tools'));
    line('7-Zip', findSevenZip(config.sevenZipPath) ?? pc.yellow('not found (portable installs open the GUI installer)'));
  } else if (platform.os === 'linux') {
    console.log(pc.bold('\nLinux tools'));
    for (const tool of ['dpkg-deb', 'tar', 'rpm2cpio', 'cpio']) line(tool, findOnPath(tool) ?? pc.yellow('not found'));
  }
  console.log(pc.bold('\nPATH'));
  if (status.error) line('error', pc.red(status.error));
  else {
    line('admin/root', status.admin ? 'yes' : 'no');
    line('new shells', status.newShells?.programDir ?? pc.dim('no LibreOffice'));
    line('this shell', status.current?.realPath ?? pc.dim('soffice not found'));
  }
}

// ---------------------------------------------------------------- program

function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err.name === 'AbortError') console.error(pc.yellow(err.message || 'Cancelled'));
      else console.error(pc.red(`Error: ${err.message}`));
      if (process.env.LOVS_DEBUG) console.error(err.stack);
      process.exitCode = 1;
    }
  };
}

export function buildProgram() {
  const program = new Command('lovs')
    .description('LibreOffice version switcher: download, install and switch between LibreOffice versions')
    .version(APP_VERSION)
    .enablePositionalOptions()
    .showHelpAfterError();

  program
    .command('list')
    .alias('ls')
    .description('List LibreOffice versions installed locally')
    .option('--json', 'machine readable output')
    .option('--no-probe', 'do not run soffice --version for installs without version info')
    .action(wrap(cmdList));

  const remote = program
    .command('remote')
    .argument('[filter]', 'series or version prefix, e.g. 7.6')
    .description('List versions available in the LibreOffice archive')
    .option('-a, --all', 'show every series, not just the newest 12')
    .option('--pre', 'include alpha/beta builds')
    .option('--refresh', 'ignore the cached listing')
    .option('--json', 'machine readable output')
    .action(wrap(cmdRemote));
  remote
    .command('info')
    .argument('<version>', 'version or series (e.g. 7.6 = newest 7.6 build)')
    .description('Show downloadable packages of a version for this platform')
    .option('--refresh', 'ignore cached data')
    .option('--json', 'machine readable output')
    .action(wrap(cmdInfo));

  const methods = installMethods();
  program
    .command('install')
    .argument('<version>', 'exact version, or series/prefix (7.6 = newest 7.6.x), or "latest"')
    .description('Download and install a version side by side with the others')
    .addOption(new Option('-m, --method <method>', 'install method').choices(methods.length ? methods : ['msi', 'portable', 'deb', 'rpm']))
    .addOption(new Option('-d, --downloader <name>', 'downloader to use').choices(['builtin', 'xdm']))
    .option('-f, --force', 'reinstall if already installed')
    .option('--keep-download', 'keep the downloaded installer file')
    .option('--refresh', 'refresh the remote version list first')
    .action(wrap(cmdInstall));

  program
    .command('uninstall')
    .alias('rm')
    .argument('<version>', 'installed version, id or folder')
    .description('Delete a version installed by lovs')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(wrap(cmdUninstall));

  const scopeOption = () =>
    new Option('-s, --scope <scope>', isWindows ? 'user (HKCU) or machine (HKLM, asks for admin)' : 'user (~/.config/lovs/path.sh) or machine (/etc/profile.d, needs sudo)')
      .choices(SCOPES)
      .default('user');

  const pathCmd = program.command('path').description('Manage LibreOffice on the persistent PATH');
  pathCmd.command('status', { isDefault: true }).description('Show LibreOffice entries on PATH and which soffice wins').option('--json', 'machine readable output').action(wrap(cmdPathStatus));
  pathCmd
    .command('add')
    .argument('<version>', 'installed version, id or folder')
    .description('Put a version on the persistent PATH (other LibreOffice entries in that scope are removed)')
    .addOption(scopeOption())
    .option('-k, --keep-others', 'keep other LibreOffice entries in this scope')
    .action(wrap(cmdPathAdd));
  pathCmd
    .command('remove')
    .argument('[version]', 'installed version, id or folder (default: all LibreOffice entries)')
    .description('Remove LibreOffice from the persistent PATH')
    .addOption(scopeOption())
    .action(wrap(cmdPathRemove));

  program
    .command('env')
    .argument('<version>', 'installed version, id or folder')
    .description('Print the command that activates a version in the current shell only')
    .addOption(new Option('--shell <shell>', 'print only the command for this shell').choices(SHELLS))
    .action(wrap(cmdEnv));

  program
    .command('exec')
    .argument('<version>', 'installed version, id or folder')
    .argument('<command>', 'command to run, e.g. soffice')
    .argument('[args...]', 'arguments for the command')
    .description('Run one command with a version first on PATH, e.g. lovs exec 7.6 -- soffice --version')
    .passThroughOptions()
    .action(wrap(cmdExec));

  program
    .command('shell')
    .argument('<version>', 'installed version, id or folder')
    .description('Open a sub-shell with a version first on PATH')
    .addOption(new Option('--shell <shell>', 'shell to start').choices(SHELLS))
    .action(wrap(cmdShell));

  program.command('which').description('Print the soffice that the current shell resolves').action(wrap(cmdWhich));

  const config = program.command('config').description('Show or change settings');
  config.command('list', { isDefault: true }).description('Show all settings').action(wrap(async () => showConfig(loadConfig())));
  config
    .command('get')
    .argument('<key>')
    .description('Print one setting')
    .action(
      wrap(async (key) => {
        if (!(key in CONFIG_SCHEMA)) throw new Error(`Unknown key "${key}"`);
        const v = loadConfig()[key];
        console.log(Array.isArray(v) ? v.join('\n') : String(v));
      }),
    );
  config
    .command('set')
    .argument('<key>')
    .argument('<value>', 'new value ("" resets paths to auto/default)')
    .description('Change one setting')
    .action(
      wrap(async (key, value) => {
        const cfg = saveConfig({ [key]: value });
        ok(`${key} = ${Array.isArray(cfg[key]) ? cfg[key].join(path.delimiter) : cfg[key]}`);
      }),
    );
  config
    .command('add-scan-dir')
    .argument('<dir>')
    .description('Scan a folder for existing installs (e.g. D:\\LibreOfficePortable)')
    .action(
      wrap(async (dir) => {
        const cfg = saveConfig({ scanDirs: [...loadConfig().scanDirs, dir] });
        ok(`Scan folders: ${cfg.scanDirs.join(', ')}`);
      }),
    );
  config
    .command('remove-scan-dir')
    .argument('<dir>')
    .description('Stop scanning a folder')
    .action(
      wrap(async (dir) => {
        const target = path.resolve(dir);
        const cfg = saveConfig({ scanDirs: loadConfig().scanDirs.filter((d) => !samePath(d, target)) });
        ok(`Scan folders: ${cfg.scanDirs.join(', ') || '(none)'}`);
      }),
    );

  program.command('doctor').description('Check platform support, tools, downloader and PATH').action(wrap(cmdDoctor));

  program
    .command('ui')
    .description('Start the web interface')
    .option('-p, --port <port>', 'port (default from config, 5178)')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--no-open', 'do not open the browser')
    .action(
      wrap(async (opts) => {
        const { startServer } = await import('../api/server.js');
        const port = Number(opts.port ?? loadConfig().port);
        await startServer({ port, host: opts.host, open: opts.open });
      }),
    );

  return program;
}
