// `lovs path status|add|remove` and `lovs which`: the persistent PATH.

import pc from 'picocolors';
import { loadConfig } from '../../utils/config.js';
import { resolveInstall, scanLocalInstalls } from '../../utils/local.js';
import { SCOPES, addToPath, getPathStatus, removeFromPath, samePath } from '../../utils/pathenv.js';
import { isWindows } from '../../utils/platform.js';
import { UNQUOTABLE_HINT, hintsFor } from '../hints.js';
import { info, ok, printJson, printWarnings, warn } from '../output.js';

export async function showPathStatus(options) {
  const config = loadConfig();
  const [status, installs] = await Promise.all([getPathStatus(), scanLocalInstalls(config, { probe: false })]);
  if (options.json) return printJson(status);

  const versionAt = (dir) => installs.find((install) => samePath(install.programDir, dir))?.version;
  for (const scope of SCOPES) {
    const { entries, location } = status.scopes[scope];
    // On Linux every entry in lovs' own file is LibreOffice's, even a deleted one.
    const libreOfficeEntries = entries.filter((item) => item.libreoffice || !isWindows);
    console.log(`${pc.bold(`${scope} PATH`)} ${pc.dim(location)}`);
    if (!libreOfficeEntries.length) console.log(pc.dim('  (no LibreOffice entries)'));
    for (const item of libreOfficeEntries) {
      const version = versionAt(item.expanded);
      console.log(`  ${item.expanded}${version ? pc.green(`  [${version}]`) : ''}`);
    }
  }

  const { newShells, current } = status;
  const newShellsText = newShells ? `${newShells.programDir} ${pc.dim(`(${newShells.scope} PATH)`)}` : pc.dim('no LibreOffice on the persistent PATH');
  console.log(`\n${pc.bold('New shells use:')}   ${newShellsText}`);
  console.log(`${pc.bold('This shell uses:')}  ${current ? current.realPath : pc.dim('soffice not found on PATH')}`);
  const userEntryHidden = isWindows && newShells?.scope === 'machine' && status.scopes.user.entries.some((item) => item.libreoffice);
  if (userEntryHidden) warn('The machine PATH entry hides the user PATH entry (Windows searches machine PATH first).');
}

export async function addVersionToPath(spec, options) {
  const config = loadConfig();
  const install = await resolveInstall(config, spec);
  const result = await addToPath(install, { scope: options.scope, replace: !options.keepOthers });
  ok(`Added ${result.added} to the ${result.scope} PATH`);
  for (const entry of result.removed) console.log(pc.dim(`  removed ${entry}`));
  for (const rcFile of result.hooks) console.log(pc.dim(`  hooked into ${rcFile}`));
  printWarnings(result.warnings);
  const hints = await hintsFor(install, config);
  console.log(pc.dim(`\nOpen a new terminal for the change to apply. For this shell: ${hints?.activate ?? UNQUOTABLE_HINT}`));
}

export async function removeVersionFromPath(spec, options) {
  const config = loadConfig();
  const install = spec ? await resolveInstall(config, spec) : null;
  const result = await removeFromPath({ scope: options.scope, install });
  if (!result.removed.length) return info(`Nothing to remove from the ${result.scope} PATH`);
  for (const entry of result.removed) ok(`Removed ${entry} from the ${result.scope} PATH`);
}

export async function printWhich() {
  const { current } = await getPathStatus();
  console.log(current ? current.realPath : 'soffice is not on PATH');
  if (!current) process.exitCode = 1;
}
