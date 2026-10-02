import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, normalizePath } from '../utils/fsutil.js';
import { isWindows } from '../utils/platform.js';

describe('normalizePath / isInside', () => {
  const root = path.parse(process.cwd()).root; // "/" or "C:\"
  const below = path.join(root, 'opt', 'lo');

  it('keeps a filesystem root intact and strips trailing separators elsewhere', () => {
    expect(normalizePath(root)).toBe(isWindows ? root.toLowerCase() : root);
    expect(normalizePath(below + path.sep)).toBe(normalizePath(below));
  });

  it('treats everything as inside the root, and siblings as outside', () => {
    expect(isInside(below, root)).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(path.join(root, 'opt', 'lo2'), below)).toBe(false);
    expect(isInside(path.join(below, 'program'), below)).toBe(true);
  });
});
