import { describe, expect, it } from 'vitest';
import { parseListing } from '../utils/remote.js';

const html = `
<tr><td valign="top">&nbsp;</td><td><a href="/libreoffice/old/25.2.7.2/">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td></tr>
<tr><td valign="top">&nbsp;</td><td><a href="25.2.7.2/">25.2.7.2/</a></td><td align="right">11-Dec-2025 11:02  </td><td align="right">  - </td><td>&nbsp;</td></tr>
<tr><td valign="top">&nbsp;</td><td><a href="LibreOffice_25.2.7.2_Win_x86-64.msi">LibreOffice_25.2.7.2_Win_x86-64.msi</a></td><td align="right">28-Oct-2025 13:25  </td><td align="right">348M </td><td><a href="x.mirrorlist">Details</a></td></tr>
<tr><td><a href="?C=N;O=D">Name</a></td><td>x</td><td>y</td></tr>`;

describe('parseListing', () => {
  it('extracts directories and files with dates and sizes', () => {
    const rows = parseListing(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: '25.2.7.2', isDir: true, date: '2025-12-11T11:02:00.000Z', size: null });
    expect(rows[1].name).toBe('LibreOffice_25.2.7.2_Win_x86-64.msi');
    expect(rows[1].size).toBe(348 * 1024 * 1024);
  });
});
