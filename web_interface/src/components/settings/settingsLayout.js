// How the config keys from /api/info's schema are grouped, labelled and filtered per OS.

export const SETTING_GROUPS = [
  { title: 'Folders', keys: ['installDir', 'scanDirs', 'downloadDir', 'keepDownloads'] },
  { title: 'Downloads', keys: ['downloader', 'xdmPath', 'connections'] },
  { title: 'Installing', keys: ['windowsMethod', 'linuxMethod', 'sevenZipPath', 'isolateProfile'] },
  { title: 'Interface', keys: ['includePrereleases', 'port'] },
];

const SETTING_LABELS = {
  installDir: 'Install folder',
  scanDirs: 'Scan folders',
  downloadDir: 'Download folder',
  keepDownloads: 'Keep installer files',
  downloader: 'Downloader',
  xdmPath: 'XDM location',
  connections: 'Parallel connections',
  windowsMethod: 'Windows install method',
  linuxMethod: 'Linux package type',
  sevenZipPath: '7-Zip location',
  isolateProfile: 'Separate profile per version',
  includePrereleases: 'Show pre-releases',
  port: 'Web UI port',
};

const ONLY_ON_OS = {
  windowsMethod: 'windows',
  sevenZipPath: 'windows',
  linuxMethod: 'linux',
};

export const settingLabel = (key) => SETTING_LABELS[key] ?? key;

/** Keys of a group that the server knows about and that apply to this OS. */
export function visibleSettingKeys(group, schemaByKey, os) {
  return group.keys.filter((key) => schemaByKey[key] && (!ONLY_ON_OS[key] || ONLY_ON_OS[key] === os));
}
