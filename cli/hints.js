// Ready-to-paste follow-up commands ("use it in this shell", "run one command").

import { scanLocalInstalls, selectorFor } from '../utils/local.js';
import { activationOneLiner, detectShell, quoteArg } from '../utils/shell.js';

export const UNQUOTABLE_HINT = `(this folder can't be passed literally in ${detectShell()}; use another shell)`;

/**
 * Commands that select exactly `install` again, quoted for `shell`. Uses the
 * same scan (with version probing) the commands will run, so a version or id
 * is only suggested when it resolves back to this install. null when the
 * selector can't be written for this shell (e.g. a % in the path, for cmd).
 */
export async function hintsFor(install, config, shell = detectShell()) {
  const selector = selectorFor(install, await scanLocalInstalls(config));
  try {
    const arg = quoteArg(shell, selector);
    return {
      activate: activationOneLiner(shell, selector),
      exec: (commandLine) => `lovs exec ${arg} -- ${commandLine}`,
      pathAdd: `lovs path add ${arg}`,
    };
  } catch {
    return null;
  }
}
