// `lovs env`, `lovs exec` and `lovs shell`: use a version in one terminal only.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../../utils/config.js';
import { resolveInstall } from '../../utils/local.js';
import { activationCommand, activationCommands, detectShell, subshellLaunchPlan } from '../../utils/shell.js';
import { UNQUOTABLE_HINT, hintsFor } from '../hints.js';
import { info } from '../output.js';

/** process.env with `programDir` first on PATH and LOVS_ACTIVE set. */
function envWithVersion(programDir, version) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'; // "Path" on Windows
  env[pathKey] = `${programDir}${path.delimiter}${env[pathKey] ?? ''}`;
  env.LOVS_ACTIVE = version ?? '';
  return env;
}

export async function printActivation(spec, options) {
  const config = loadConfig();
  const install = await resolveInstall(config, spec);
  // Piped (eval / Invoke-Expression / for /f): print just the one command.
  if (options.shell || !process.stdout.isTTY) {
    console.log(activationCommand(options.shell ?? detectShell(), install.programDir));
    return;
  }

  console.log(`${pc.bold(`LibreOffice ${install.version}`)} for the current shell session only:\n`);
  for (const [shell, command] of Object.entries(activationCommands(install.programDir))) {
    console.log(`  ${pc.dim(shell.padEnd(10))} ${command}`);
  }
  const hints = await hintsFor(install, config);
  console.log(`\n  ${pc.dim('one-liner'.padEnd(10))} ${hints?.activate ?? UNQUOTABLE_HINT}`);
  if (hints) console.log(`  ${pc.dim('one command'.padEnd(10))} ${hints.exec('soffice --headless --convert-to pdf file.docx')}`);
}

export async function execWithVersion(spec, command, args) {
  // passThroughOptions keeps a literal "--" separator; drop it.
  if (command === '--') [command, ...args] = args;
  if (!command) throw new Error('Specify the command to run, e.g. lovs exec 7.6 -- soffice --version');
  const install = await resolveInstall(loadConfig(), spec);
  // On Windows "soffice" resolves to soffice.com, the console-friendly launcher.
  const child = spawn(command, args, { stdio: 'inherit', env: envWithVersion(install.programDir, install.version) });
  child.on('error', (err) => {
    console.error(pc.red(err.message));
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

export async function openShellWithVersion(spec, options) {
  const install = await resolveInstall(loadConfig(), spec);
  const shell = options.shell ?? detectShell();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovs-shell-'));
  const removeTmpDir = () => fs.rmSync(tmpDir, { recursive: true, force: true });

  let plan;
  try {
    plan = subshellLaunchPlan(shell, install.programDir, { tmpDir });
    for (const [file, content] of Object.entries(plan.files)) fs.writeFileSync(file, content);
  } catch (err) {
    removeTmpDir();
    throw err;
  }

  // Also prepended up front, for anything the shell runs before its start-up
  // files; the plan re-applies it afterwards so it stays first.
  const env = { ...envWithVersion(install.programDir, install.version), ...plan.env };
  info(`Starting ${shell} with LibreOffice ${pc.bold(install.version)} first on PATH. Type ${pc.bold('exit')} to leave.`);
  const child = spawn(plan.command, plan.args, { stdio: 'inherit', env, windowsVerbatimArguments: plan.verbatim });
  child.on('error', (err) => {
    removeTmpDir();
    console.error(pc.red(`Could not start ${plan.command}: ${err.message}`));
    process.exit(127);
  });
  child.on('exit', (code) => {
    removeTmpDir();
    process.exit(code ?? 0);
  });
}
