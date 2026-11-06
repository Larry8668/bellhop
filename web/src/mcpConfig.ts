const LOCAL_SERVER_ORIGIN = 'http://localhost:4000';

/**
 * Origin MCP clients should call. In Vite dev, `/api` is proxied but `/mcp` is not,
 * so the snippet points at the API server (same host as `API_PROXY_TARGET`).
 */
export function serverOrigin(): string {
  const fromEnv = import.meta.env.VITE_SERVER_ORIGIN;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.replace(/\/$/, '');
  }
  if (import.meta.env.DEV) return LOCAL_SERVER_ORIGIN;
  return window.location.origin;
}

export function mcpConfigSnippet(apiKey: string): string {
  return JSON.stringify({
    mcpServers: {
      bellhop: {
        url: `${serverOrigin()}/mcp`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  });
}
