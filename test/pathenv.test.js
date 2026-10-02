import { describe, expect, it } from 'vitest';
import { parseLinuxPathFile, renderLinuxPathFile, withEntriesRemoved, withEntryAdded } from '../utils/pathenv.js';

describe('PATH entry helpers', () => {
  const isLo = (e) => e.includes('LibreOffice');

  it('puts the new dir first and drops other LibreOffice dirs', () => {
    const res = withEntryAdded(['C:\\bin', 'D:\\LibreOffice_7\\program', 'C:\\tools'], 'D:\\LibreOffice_25\\program', { isLo });
    expect(res.entries).toEqual(['D:\\LibreOffice_25\\program', 'C:\\bin', 'C:\\tools']);
    expect(res.removed).toEqual(['D:\\LibreOffice_7\\program']);
  });

  it('can keep other LibreOffice dirs', () => {
    const res = withEntryAdded(['D:\\LibreOffice_7\\program'], 'D:\\LibreOffice_25\\program', { isLo, replaceLibreOffice: false });
    expect(res.entries).toEqual(['D:\\LibreOffice_25\\program', 'D:\\LibreOffice_7\\program']);
  });

  it('does not duplicate an existing entry', () => {
    const res = withEntryAdded(['C:\\bin', 'D:\\LO\\program'], 'D:\\LO\\program', { isLo: () => false });
    expect(res.entries).toEqual(['D:\\LO\\program', 'C:\\bin']);
  });

  it('removes matching entries', () => {
    expect(withEntriesRemoved(['a', 'LibreOffice', 'b'], isLo)).toEqual({ entries: ['a', 'b'], removed: ['LibreOffice'] });
  });

  it('round-trips the Linux path file, keeping order and quotes', () => {
    const entries = ['/opt/lo 25/program', "/home/u/it's/program"];
    expect(parseLinuxPathFile(renderLinuxPathFile(entries))).toEqual(entries);
  });
});
