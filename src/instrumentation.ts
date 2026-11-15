export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
      const { setGlobalProxyFromEnv } = await import('node:http');
      setGlobalProxyFromEnv();
    }
    if (process.env.RADAR_SYNC_ENABLED === 'false') return;
    const { startNewsScheduler } = await import('./server/news-pipeline');
    startNewsScheduler();
  }
}
