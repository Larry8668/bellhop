import { describe, expect, it } from 'vitest';
import { API_PROXY_TARGET, buildConfig } from '../../vite.config.js';

// BUGS.md #1 — a relative base in dev silently disables the /api proxy.
describe('vite config', () => {
  it('uses an absolute base in dev so the /api proxy applies', () => {
    const dev = buildConfig({ command: 'serve' });
    expect(dev.base).toBe('/');
    expect(dev.server?.proxy?.['/api']).toBe(API_PROXY_TARGET);
  });

  it('uses a relative base for the production bundle (Capacitor)', () => {
    expect(buildConfig({ command: 'build' }).base).toBe('./');
  });
});
