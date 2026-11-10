// A healthcheck observes service availability. Managed readiness has a separate
// authenticated endpoint and never follows merely from a running process.
if (process.argv[2] === 'worker') {
  const { database } = await import('@hivemagnus/embermend-store');
  const db = database(process.env.DATABASE_URL);
  try { process.kill(1, 0); await db.$queryRaw`SELECT 1`; } catch { process.exitCode = 1; } finally { await db.$disconnect(); }
} else {
  try { const response = await fetch('http://127.0.0.1:' + (process.env.EMBERMEND_PORT ?? '4180') + '/health/live', { signal: AbortSignal.timeout(3000), redirect: 'error' }); if (!response.ok) process.exitCode = 1; }
  catch { process.exitCode = 1; }
}
