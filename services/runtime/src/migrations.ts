import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { database } from '@hivemagnus/embermend-store';

const rowSchema = z.object({ migration_name: z.string(), checksum: z.string(), finished_at: z.date().nullable(), rolled_back_at: z.date().nullable() });
export async function verifyMigrations(url: string): Promise<void> {
  const db = database(url);
  try {
    const directory = new URL('../../../packages/store/prisma/migrations/', import.meta.url);
    const expected = new Map<string, string>();
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) expected.set(entry.name, createHash('sha256').update(await readFile(new URL(entry.name + '/migration.sql', directory))).digest('hex'));
    const raw: unknown = await db.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`;
    const rows = z.array(rowSchema).parse(raw).filter(row => row.rolled_back_at === null);
    if (!expected.size || rows.length !== expected.size || rows.some(row => !row.finished_at || expected.get(row.migration_name) !== row.checksum)) throw new Error('EXACT_MIGRATION_HISTORY_REQUIRED');
    await db.$queryRaw`SELECT id FROM "Job" LIMIT 1`;
  } finally { await db.$disconnect(); }
}
export async function migrate(url: string): Promise<void> {
  const command = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
  const config = fileURLToPath(new URL('../../../packages/store/prisma.config.ts', import.meta.url));
  await promisify(execFile)(process.execPath, [command, 'migrate', 'deploy', '--config', config], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', DATABASE_URL: url, ...(process.env['NODE_EXTRA_CA_CERTS'] ? { NODE_EXTRA_CA_CERTS: process.env['NODE_EXTRA_CA_CERTS'] } : {}) }, timeout: 180000, maxBuffer: 1024 * 1024 });
  await verifyMigrations(url);
}
