import { describe, expect, it } from 'vitest';
import { compareVersions, isPrerelease, isVersionString, matchesSpec, resolveSpec, seriesOf, shortVersion } from '../utils/versions.js';

describe('versions', () => {
  it('recognises archive version strings', () => {
    expect(isVersionString('25.2.7.2')).toBe(true);
    expect(isVersionString('26.8.0.0.beta1')).toBe(true);
    expect(isVersionString('7.6')).toBe(true);
    expect(isVersionString('sdremote-2.3.0')).toBe(false);
    expect(isPrerelease('26.8.0.0.alpha1')).toBe(true);
    expect(isPrerelease('26.8.0.1')).toBe(false);
  });

  it('sorts numerically with pre-releases before finals', () => {
    const list = ['7.6.10.1', '7.6.7.2', '24.8.0.1', '26.2.0.0.beta1', '26.2.0.0.alpha1', '26.2.0.1'];
    expect(list.sort(compareVersions)).toEqual(['7.6.7.2', '7.6.10.1', '24.8.0.1', '26.2.0.0.alpha1', '26.2.0.0.beta1', '26.2.0.1']);
  });

  it('matches specs by numeric prefix', () => {
    expect(matchesSpec('7.6.5.2', '7.6')).toBe(true);
    expect(matchesSpec('7.6.5.2', '7.6.5')).toBe(true);
    expect(matchesSpec('7.60.1.1', '7.6')).toBe(false);
    expect(matchesSpec('26.8.0.0.beta1', '26.8.0.0.beta1')).toBe(true);
  });

  it('resolves a spec to the newest final build', () => {
    const v = ['7.6.7.2', '7.6.7.1', '7.6.5.2', '26.8.0.0.beta1', '26.2.6.3'];
    expect(resolveSpec(v, '7.6')).toBe('7.6.7.2');
    expect(resolveSpec(v, '7.6.5')).toBe('7.6.5.2');
    expect(resolveSpec(v, 'latest')).toBe('26.2.6.3');
    expect(resolveSpec(v, '26.8.0.0.beta1')).toBe('26.8.0.0.beta1');
    expect(resolveSpec(v, '9.9')).toBeNull();
  });

  it('derives series and short versions', () => {
    expect(seriesOf('25.2.7.2')).toBe('25.2');
    expect(shortVersion('25.2.7.2')).toBe('25.2.7');
  });
});
