import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root folder for config, cache and (by default) installed versions. */
export function lovsHome() {
  return path.resolve(process.env.LOVS_HOME || path.join(os.homedir(), '.lovs'));
}

export const configFile = () => path.join(lovsHome(), 'config.json');
export const cacheDir = () => path.join(lovsHome(), 'cache');

/**
 * Every config key with its type, default and a short description.
 * The CLI (`lovs config`) and the web Settings page are both driven by this.
 */
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

export function defaultConfig() {
  return Object.fromEntries(Object.entries(CONFIG_SCHEMA).map(([k, s]) => [k, s.default()]));
}

export function loadConfig() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    // missing or unreadable config -> defaults
  }
  const cfg = defaultConfig();
  for (const key of Object.keys(CONFIG_SCHEMA)) {
    if (stored[key] !== undefined && stored[key] !== null) {
      try {
        cfg[key] = coerceValue(key, stored[key]);
      } catch {
        // ignore invalid stored values
      }
    }
  }
  return cfg;
}

/** Validate and convert a raw value (string from the CLI, or JSON from the UI). */
export function coerceValue(key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) throw new Error(`Unknown config key "${key}". Known keys: ${Object.keys(CONFIG_SCHEMA).join(', ')}`);
  switch (schema.type) {
    case 'path':
      return value === '' || value == null ? '' : path.resolve(String(value));
    case 'paths': {
      const list = Array.isArray(value) ? value : String(value).split(path.delimiter);
      return [...new Set(list.map((v) => String(v).trim()).filter(Boolean).map((v) => path.resolve(v)))];
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (/^(true|1|yes|on)$/i.test(String(value))) return true;
      if (/^(false|0|no|off)$/i.test(String(value))) return false;
      throw new Error(`${key} must be true or false`);
    case 'number': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < schema.min || n > schema.max) {
        throw new Error(`${key} must be an integer between ${schema.min} and ${schema.max}`);
      }
      return n;
    }
    case 'enum':
      if (!schema.values.includes(value)) throw new Error(`${key} must be one of: ${schema.values.join(', ')}`);
      return value;
    default:
      return value;
  }
}

/** Merge `changes` into the stored config and return the full result. */
export function saveConfig(changes) {
  const cfg = loadConfig();
  for (const [key, value] of Object.entries(changes)) {
    cfg[key] = coerceValue(key, value);
  }
  // Fill blanks back with defaults so paths are never empty.
  for (const key of ['installDir', 'downloadDir']) {
    if (!cfg[key]) cfg[key] = CONFIG_SCHEMA[key].default();
  }
  fs.mkdirSync(lovsHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}
