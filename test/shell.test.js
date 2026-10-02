import { describe, expect, it } from 'vitest';
import { activationCommand, toMsysPath } from '../utils/shell.js';

describe('activationCommand', () => {
  const win = "D:\\LO\\it's\\program";

  it('quotes for each Windows shell', () => {
    expect(activationCommand('powershell', win, { windows: true })).toBe("$env:Path = 'D:\\LO\\it''s\\program;' + $env:Path");
    expect(activationCommand('cmd', win, { windows: true })).toBe(`set "PATH=D:\\LO\\it's\\program;%PATH%"`);
    expect(activationCommand('bash', 'D:\\LO\\program', { windows: true })).toBe(`export PATH='/d/LO/program':"$PATH"`);
  });

  it('uses POSIX paths on Linux', () => {
    expect(activationCommand('bash', '/opt/lo/program', { windows: false })).toBe(`export PATH='/opt/lo/program':"$PATH"`);
    expect(activationCommand('fish', '/opt/lo/program', { windows: false })).toBe(`set -gx PATH '/opt/lo/program' $PATH`);
  });

  it('converts drive paths for Git Bash', () => {
    expect(toMsysPath('C:\\Program Files\\LO')).toBe('/c/Program Files/LO');
  });
});
