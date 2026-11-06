import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

export const API_PROXY_TARGET = 'http://localhost:4000';

/**
 * Relative `base` is only for the production bundle (Capacitor loads it from
 * the filesystem). In dev it must stay `/`: Vite 8 does not apply `server.proxy`
 * under a relative base, so `/api/*` would be answered with index.html (BUGS.md #1).
 */
export function buildConfig({ command }: Pick<ConfigEnv, 'command'>): UserConfig {
  return {
    base: command === 'build' ? './' : '/',
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': API_PROXY_TARGET,
      },
    },
  };
}

export default defineConfig(buildConfig);
