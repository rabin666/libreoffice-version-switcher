// `lovs doctor`: platform support, tools, downloader and PATH at a glance.

import pc from 'picocolors';
import { loadConfig, lovsHome } from '../../utils/config.js';
import { defaultMethod, resolveDownloader } from '../../utils/install.js';
import { getPathStatus } from '../../utils/pathenv.js';
import { detectPlatform, installMethods } from '../../utils/platform.js';
import { findOnPath } from '../../utils/proc.js';
import { findSevenZip } from '../../utils/unpack.js';
import { xdmStatus } from '../../utils/xdm.js';

const LINUX_TOOLS = ['dpkg-deb', 'tar', 'rpm2cpio', 'cpio'];

const section = (title) => console.log(pc.bold(`\n${title}`));
const row = (label, value) => console.log(`  ${pc.dim(label.padEnd(18))} ${value}`);

function describeXdm(xdm) {
  if (xdm.found) return `${xdm.path}${xdm.running ? pc.green(' (running)') : ''}`;
  return xdm.running ? pc.green('running') : pc.dim('not found');
}

export async function runDoctor() {
  const config = loadConfig();
  const platform = detectPlatform();
  const [xdm, pathStatus, downloaderName] = await Promise.all([
    xdmStatus(config.xdmPath),
    getPathStatus().catch((err) => ({ error: err.message })),
    resolveDownloader(config).catch((err) => `error: ${err.message}`),
  ]);

  console.log(pc.bold('System'));
  row('platform', `${platform.pretty} (${platform.arch})`);
  row('install methods', installMethods(platform).join(', ') || pc.red('unsupported'));
  row('default method', defaultMethod(config, platform));
  row('lovs home', lovsHome());
  row('install folder', config.installDir);

  section('Downloads');
  row('downloader', `${downloaderName} (config: ${config.downloader})`);
  row('XDM', describeXdm(xdm));

  if (platform.os === 'windows') {
    section('Windows tools');
    row('7-Zip', findSevenZip(config.sevenZipPath) ?? pc.yellow('not found (portable installs open the GUI installer)'));
  } else if (platform.os === 'linux') {
    section('Linux tools');
    for (const tool of LINUX_TOOLS) row(tool, findOnPath(tool) ?? pc.yellow('not found'));
  }

  section('PATH');
  if (pathStatus.error) return row('error', pc.red(pathStatus.error));
  row('admin/root', pathStatus.admin ? 'yes' : 'no');
  row('new shells', pathStatus.newShells?.programDir ?? pc.dim('no LibreOffice'));
  row('this shell', pathStatus.current?.realPath ?? pc.dim('soffice not found'));
}
