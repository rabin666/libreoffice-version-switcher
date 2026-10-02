// `lovs list` and `lovs uninstall`: versions on this machine.

import readline from 'node:readline/promises';
import pc from 'picocolors';
import { loadConfig } from '../../utils/config.js';
import { uninstall } from '../../utils/install.js';
import { resolveInstall, scanLocalInstalls } from '../../utils/local.js';
import { getPathStatus, pathFlagsFor } from '../../utils/pathenv.js';
import { info, ok, printJson, printWarnings, table } from '../output.js';

function describePathFlags(flags) {
  const labels = [];
  if (flags.current) labels.push(pc.green('current shell'));
  if (flags.newShells) labels.push(pc.cyan('new shells'));
  if (flags.user) labels.push('user PATH');
  if (flags.machine) labels.push('machine PATH');
  return labels.join(', ');
}

function activeMarker(flags) {
  if (flags.current) return pc.green('*');
  return flags.newShells ? pc.cyan('>') : ' ';
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} [y/N] `);
  prompt.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function listInstalled(options) {
  const config = loadConfig();
  const [installs, status] = await Promise.all([scanLocalInstalls(config, { probe: options.probe }), getPathStatus()]);
  if (options.json) return printJson(installs.map((install) => ({ ...install, path: pathFlagsFor(install, status) })));

  if (!installs.length) {
    info('No LibreOffice installs found.');
    console.log(`  Install one with ${pc.bold('lovs install <version>')}, or add a folder to scan with`);
    console.log(`  ${pc.bold('lovs config add-scan-dir <dir>')}`);
    return;
  }
  const rows = installs.map((install) => {
    const flags = pathFlagsFor(install, status);
    const location = install.portableRoot ?? install.root;
    return [activeMarker(flags), pc.bold(install.version ?? '?'), install.kind, install.source, describePathFlags(flags), pc.dim(location)];
  });
  console.log(table(['', 'VERSION', 'KIND', 'SOURCE', 'ACTIVE / PATH', 'LOCATION'], rows));
  console.log(pc.dim(`\n${pc.green('*')} soffice in this shell   ${pc.cyan('>')} soffice in new shells`));
}

export async function uninstallVersion(spec, options) {
  const config = loadConfig();
  const install = await resolveInstall(config, spec);
  const location = install.portableRoot ?? install.root;
  if (!options.yes && !(await confirm(`Delete LibreOffice ${install.version} at ${location}?`))) {
    info('Nothing deleted (pass --yes to skip this question).');
    return;
  }
  const result = await uninstall(install, config);
  ok(`Removed ${result.removed}`);
  printWarnings(result.warnings);
}
