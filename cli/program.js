// Command-line interface: commander definitions only. Each action lives in
// cli/commands/<area>.js.

import { Command, Option } from 'commander';
import pc from 'picocolors';
import { APP_VERSION } from '../utils/appinfo.js';
import { loadConfig } from '../utils/config.js';
import { SCOPES } from '../utils/pathenv.js';
import { installMethods, isWindows } from '../utils/platform.js';
import { SHELLS } from '../utils/shell.js';
import { installFromArchive, listArchive, showArchiveVersion } from './commands/archive.js';
import { runDoctor } from './commands/doctor.js';
import { listInstalled, uninstallVersion } from './commands/installed.js';
import { addVersionToPath, printWhich, removeVersionFromPath, showPathStatus } from './commands/path.js';
import { execWithVersion, openShellWithVersion, printActivation } from './commands/session.js';
import { addScanDir, changeSetting, printSetting, removeScanDir, showSettings } from './commands/settings.js';

const ALL_METHODS = ['msi', 'portable', 'deb', 'rpm'];
const INSTALL_SELECTOR = 'installed version, id or folder';

/** Print errors instead of stack traces (LOVS_DEBUG=1 shows them) and set the exit code. */
function action(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      if (err.name === 'AbortError') console.error(pc.yellow(err.message || 'Cancelled'));
      else console.error(pc.red(`Error: ${err.message}`));
      if (process.env.LOVS_DEBUG) console.error(err.stack);
      process.exitCode = 1;
    }
  };
}

const scopeOption = () =>
  new Option('-s, --scope <scope>', isWindows ? 'user (HKCU) or machine (HKLM, asks for admin)' : 'user (~/.config/lovs/path.sh) or machine (/etc/profile.d, needs sudo)')
    .choices(SCOPES)
    .default('user');

function addInstalledCommands(program) {
  program
    .command('list')
    .alias('ls')
    .description('List LibreOffice versions installed locally')
    .option('--json', 'machine readable output')
    .option('--no-probe', 'do not run soffice --version for installs without version info')
    .action(action(listInstalled));

  program
    .command('uninstall')
    .alias('rm')
    .argument('<version>', INSTALL_SELECTOR)
    .description('Delete a version installed by lovs')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(action(uninstallVersion));
}

function addArchiveCommands(program) {
  const remote = program
    .command('remote')
    .argument('[filter]', 'series or version prefix, e.g. 7.6')
    .description('List versions available in the LibreOffice archive')
    .option('-a, --all', 'show every series, not just the newest 12')
    .option('--pre', 'include alpha/beta builds')
    .option('--refresh', 'ignore the cached listing')
    .option('--json', 'machine readable output')
    .action(action(listArchive));
  remote
    .command('info')
    .argument('<version>', 'version or series (e.g. 7.6 = newest 7.6 build)')
    .description('Show downloadable packages of a version for this platform')
    .option('--refresh', 'ignore cached data')
    .option('--json', 'machine readable output')
    .action(action(showArchiveVersion));

  const methods = installMethods();
  program
    .command('install')
    .argument('<version>', 'exact version, or series/prefix (7.6 = newest 7.6.x), or "latest"')
    .description('Download and install a version side by side with the others')
    .addOption(new Option('-m, --method <method>', 'install method').choices(methods.length ? methods : ALL_METHODS))
    .addOption(new Option('-d, --downloader <name>', 'downloader to use').choices(['builtin', 'xdm']))
    .option('-f, --force', 'reinstall if already installed')
    .option('--keep-download', 'keep the downloaded installer file')
    .option('--refresh', 'refresh the remote version list first')
    .action(action(installFromArchive));
}

function addPathCommands(program) {
  const pathCommand = program.command('path').description('Manage LibreOffice on the persistent PATH');
  pathCommand
    .command('status', { isDefault: true })
    .description('Show LibreOffice entries on PATH and which soffice wins')
    .option('--json', 'machine readable output')
    .action(action(showPathStatus));
  pathCommand
    .command('add')
    .argument('<version>', INSTALL_SELECTOR)
    .description('Put a version on the persistent PATH (other LibreOffice entries in that scope are removed)')
    .addOption(scopeOption())
    .option('-k, --keep-others', 'keep other LibreOffice entries in this scope')
    .action(action(addVersionToPath));
  pathCommand
    .command('remove')
    .argument('[version]', `${INSTALL_SELECTOR} (default: all LibreOffice entries)`)
    .description('Remove LibreOffice from the persistent PATH')
    .addOption(scopeOption())
    .action(action(removeVersionFromPath));

  program.command('which').description('Print the soffice that the current shell resolves').action(action(printWhich));
}

function addSessionCommands(program) {
  program
    .command('env')
    .argument('<version>', INSTALL_SELECTOR)
    .description('Print the command that activates a version in the current shell only')
    .addOption(new Option('--shell <shell>', 'print only the command for this shell').choices(SHELLS))
    .action(action(printActivation));

  program
    .command('exec')
    .argument('<version>', INSTALL_SELECTOR)
    .argument('<command>', 'command to run, e.g. soffice')
    .argument('[args...]', 'arguments for the command')
    .description('Run one command with a version first on PATH, e.g. lovs exec 7.6 -- soffice --version')
    .passThroughOptions()
    .action(action(execWithVersion));

  program
    .command('shell')
    .argument('<version>', INSTALL_SELECTOR)
    .description('Open a sub-shell with a version first on PATH')
    .addOption(new Option('--shell <shell>', 'shell to start').choices(SHELLS))
    .action(action(openShellWithVersion));
}

function addSettingsCommands(program) {
  const config = program.command('config').description('Show or change settings');
  config.command('list', { isDefault: true }).description('Show all settings').action(action(showSettings));
  config.command('get').argument('<key>').description('Print one setting').action(action(printSetting));
  config
    .command('set')
    .argument('<key>')
    .argument('<value>', 'new value ("" resets paths to auto/default)')
    .description('Change one setting')
    .action(action(changeSetting));
  config
    .command('add-scan-dir')
    .argument('<dir>')
    .description('Scan a folder for existing installs (e.g. D:\\LibreOfficePortable)')
    .action(action(addScanDir));
  config.command('remove-scan-dir').argument('<dir>').description('Stop scanning a folder').action(action(removeScanDir));
}

function addUiCommands(program) {
  program.command('doctor').description('Check platform support, tools, downloader and PATH').action(action(runDoctor));

  program
    .command('ui')
    .description('Start the web interface')
    .option('-p, --port <port>', 'port (default from config, 5178)')
    .option('--host <host>', 'interface to bind', '127.0.0.1')
    .option('--no-open', 'do not open the browser')
    .action(
      action(async (options) => {
        // Loaded on demand: the server is only needed for this command.
        const { startServer } = await import('../api/server.js');
        await startServer({ port: Number(options.port ?? loadConfig().port), host: options.host, open: options.open });
      }),
    );
}

export function buildProgram() {
  const program = new Command('lovs')
    .description('LibreOffice version switcher: download, install and switch between LibreOffice versions')
    .version(APP_VERSION)
    .enablePositionalOptions() // required by `exec` passing options through to the command
    .showHelpAfterError();
  addInstalledCommands(program);
  addArchiveCommands(program);
  addPathCommands(program);
  addSessionCommands(program);
  addSettingsCommands(program);
  addUiCommands(program);
  return program;
}
