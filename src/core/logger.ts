export function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) {
  // Callers pass only a fixed set of safe fields. Never pass request objects, headers, bodies or query strings.
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields }));
}
