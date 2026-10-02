// User settings in <LOVS_HOME>/config.json. CONFIG_SCHEMA drives validation,
// `lovs config` and the web Settings page.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root folder for config, cache and (by default) installed versions. */
export function lovsHome() {
  return path.resolve(process.env.LOVS_HOME || path.join(os.homedir(), '.lovs'));
}

export const configFile = () => path.join(lovsHome(), 'config.json');
export const cacheDir = () => path.join(lovsHome(), 'cache');

export const CONFIG_SCHEMA = {
  installDir: {
    type: 'path',
    default: () => path.join(lovsHome(), 'versions'),
    description: 'Folder new versions are installed into',
  },
  scanDirs: {
    type: 'paths',
    default: () => [],
    description: 'Extra folders scanned for existing LibreOffice installs (e.g. D:\\LibreOfficePortable)',
  },
  downloadDir: {
    type: 'path',
    default: () => path.join(lovsHome(), 'downloads'),
    description: 'Folder used for downloaded installers',
  },
  keepDownloads: {
    type: 'boolean',
    default: () => false,
    description: 'Keep the installer file after a successful install',
  },
  downloader: {
    type: 'enum',
    values: ['auto', 'builtin', 'xdm'],
    default: () => 'auto',
    description: "'auto' uses XDM when it is found, otherwise the built-in downloader",
  },
  xdmPath: {
    type: 'path',
    default: () => '',
    description: 'XDM install folder, xdman.jar or launcher (blank = auto-detect)',
  },
  sevenZipPath: {
    type: 'path',
    default: () => '',
    description: 'Windows: 7z.exe used to unpack portable .paf.exe silently (blank = auto-detect)',
  },
  connections: {
    type: 'number',
    min: 1,
    max: 16,
    default: () => 6,
    description: 'Parallel connections used by the built-in downloader',
  },
  isolateProfile: {
    type: 'boolean',
    default: () => true,
    description: 'Give each installed version its own user profile (not shared in %APPDATA% / ~/.config)',
  },
  windowsMethod: {
    type: 'enum',
    values: ['msi', 'portable'],
    default: () => 'msi',
    description: "Default Windows install method: 'msi' (silent admin extract) or 'portable' (.paf.exe installer)",
  },
  linuxMethod: {
    type: 'enum',
    values: ['auto', 'deb', 'rpm'],
    default: () => 'auto',
    description: "Default Linux package type ('auto' = match the distro)",
  },
  includePrereleases: {
    type: 'boolean',
    default: () => false,
    description: 'Show alpha/beta builds in remote listings',
  },
  port: {
    type: 'number',
    min: 1,
    max: 65535,
    default: () => 5178,
    description: 'Port for the web UI',
  },
};

/** Keys whose blank value means "use the default" rather than "auto-detect". */
const REQUIRED_PATH_KEYS = ['installDir', 'downloadDir'];

export function defaultConfig() {
  return Object.fromEntries(Object.entries(CONFIG_SCHEMA).map(([key, schema]) => [key, schema.default()]));
}

/** Stored settings over the defaults; invalid stored values are ignored. */
export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    // missing or unreadable file: defaults only
  }
  const config = defaultConfig();
  for (const key of Object.keys(CONFIG_SCHEMA)) {
    if (stored[key] === undefined || stored[key] === null) continue;
    try {
      config[key] = coerceValue(key, stored[key]);
    } catch {
      // keep the default
    }
  }
  return config;
}

/** Validate and convert a raw value (a string from the CLI, or JSON from the UI). */
export function coerceValue(key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) throw new Error(`Unknown config key "${key}". Known keys: ${Object.keys(CONFIG_SCHEMA).join(', ')}`);
  switch (schema.type) {
    case 'path':
      return value === '' || value == null ? '' : path.resolve(String(value));
    case 'paths': {
      const list = Array.isArray(value) ? value : String(value).split(path.delimiter);
      const cleaned = list.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => path.resolve(entry));
      return [...new Set(cleaned)];
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(true|1|yes|on)$/i.test(String(value))) return true;
      if (/^(false|0|no|off)$/i.test(String(value))) return false;
      throw new Error(`${key} must be true or false`);
    case 'number': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < schema.min || number > schema.max) {
        throw new Error(`${key} must be an integer between ${schema.min} and ${schema.max}`);
      }
      return number;
    }
    case 'enum':
      if (!schema.values.includes(value)) throw new Error(`${key} must be one of: ${schema.values.join(', ')}`);
      return value;
    default:
      return value;
  }
}

/** Validate `changes`, merge them into the stored settings and return the result. */
export function saveConfig(changes) {
  const config = loadConfig();
  for (const [key, value] of Object.entries(changes)) {
    config[key] = coerceValue(key, value);
  }
  for (const key of REQUIRED_PATH_KEYS) {
    if (!config[key]) config[key] = CONFIG_SCHEMA[key].default();
  }
  fs.mkdirSync(lovsHome(), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
