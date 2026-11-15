import { describe, expect, it } from 'vitest';
import conf from '../../src-tauri/tauri.conf.json';

// Google Play takes each Android version code once and only ever upwards. 1.6.4's first
// bundle used Tauri's own number (1006004) and had to be built again, so since then the code
// is that number with one more digit for the build: 1.6.4 again is 10060041, 1.6.5 is 10060050.
describe('the Android version code', () => {
  it('follows the app version, with a build digit', () => {
    const [major = 0, minor = 0, patch = 0] = conf.version.split('.').map(Number);
    const code = conf.bundle.android.versionCode;
    expect(Math.floor(code / 10)).toBe(major * 1_000_000 + minor * 1_000 + patch);
  });

  it('is above every code Play has already taken', () => {
    expect(conf.bundle.android.versionCode).toBeGreaterThan(1_006_004);
  });
});
