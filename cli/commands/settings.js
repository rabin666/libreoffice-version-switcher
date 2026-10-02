// `lovs config ...`: show and change settings (same file as the web UI).

import path from 'node:path';
import pc from 'picocolors';
import { CONFIG_SCHEMA, configFile, loadConfig, saveConfig } from '../../utils/config.js';
import { samePath } from '../../utils/pathenv.js';
import { ok, table } from '../output.js';

function formatValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(path.delimiter) : pc.dim('(none)');
  return value === '' ? pc.dim('(auto)') : String(value);
}

export function showSettings() {
  const config = loadConfig();
  const rows = Object.entries(CONFIG_SCHEMA).map(([key, schema]) => [pc.bold(key), formatValue(config[key]), pc.dim(schema.description)]);
  console.log(table(['KEY', 'VALUE', 'DESCRIPTION'], rows));
  console.log(pc.dim(`\nConfig file: ${configFile()}`));
}

export function printSetting(key) {
  if (!(key in CONFIG_SCHEMA)) throw new Error(`Unknown key "${key}"`);
  const value = loadConfig()[key];
  console.log(Array.isArray(value) ? value.join('\n') : String(value));
}

export function changeSetting(key, value) {
  const config = saveConfig({ [key]: value });
  const saved = config[key];
  ok(`${key} = ${Array.isArray(saved) ? saved.join(path.delimiter) : saved}`);
}

export function addScanDir(dir) {
  const config = saveConfig({ scanDirs: [...loadConfig().scanDirs, dir] });
  ok(`Scan folders: ${config.scanDirs.join(', ')}`);
}

export function removeScanDir(dir) {
  const target = path.resolve(dir);
  const config = saveConfig({ scanDirs: loadConfig().scanDirs.filter((scanDir) => !samePath(scanDir, target)) });
  ok(`Scan folders: ${config.scanDirs.join(', ') || '(none)'}`);
}
