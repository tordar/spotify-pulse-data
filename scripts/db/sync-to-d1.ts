/**
 * Syncs the local library.db to Cloudflare D1 by clearing all tables and
 * re-inserting everything using multi-row INSERTs + concurrent requests.
 *
 * Usage:  npm run db:sync-d1
 * Requires: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { getD1Client } from './d1-client';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');
const ROWS_PER_INSERT = 200;
const CONCURRENCY = 8;

function escapeSQL(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

function buildMultiRowInsert(
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  orIgnore = false,
): string {
  const colList = columns.join(', ');
  const valuesList = rows.map(row =>
    `(${columns.map(c => escapeSQL(row[c])).join(', ')})`
  ).join(',\n');
  const conflict = orIgnore ? ' OR IGNORE' : '';
  return `INSERT${conflict} INTO ${tableName} (${colList}) VALUES\n${valuesList}`;
}

async function runConcurrent(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const local = new Database(DB_PATH, { readonly: true });
  const d1 = getD1Client();

  console.log('Applying schema to D1…');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  const schemaStatements = schemaSql
    .split(';')
    .map(s =>
      s.split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter(s => s.length > 0 && !s.toUpperCase().startsWith('PRAGMA'));

  for (const stmt of schemaStatements) {
    await d1.execute(stmt);
  }

  const columnMigrations = [
    `ALTER TABLE albums ADD COLUMN queue_status TEXT CHECK(queue_status IN ('queued','skipped')) DEFAULT NULL`,
  ];
  for (const stmt of columnMigrations) {
    try { await d1.execute(stmt); } catch { /* column already exists */ }
  }

  console.log('Schema applied.');
  console.log('Starting full sync from library.db → D1…');

  for (const table of ['listening_events', 'track_artists', 'tracks', 'albums', 'artists', 'import_log']) {
    await d1.execute(`DELETE FROM ${table}`);
  }
  console.log('Cleared D1 tables.');

  async function bulkInsert(
    label: string,
    tableName: string,
    columns: string[],
    rows: Record<string, unknown>[],
    orIgnore = false,
  ) {
    if (rows.length === 0) { console.log(`  ${label}: 0`); return; }

    let done = 0;
    const chunks: Record<string, unknown>[][] = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      chunks.push(rows.slice(i, i + ROWS_PER_INSERT));
    }

    const tasks = chunks.map(chunk => async () => {
      const sql = buildMultiRowInsert(tableName, columns, chunk, orIgnore);
      await d1.execute(sql);
      done += chunk.length;
      process.stdout.write(`\r  ${label}: ${done}/${rows.length}`);
    });

    await runConcurrent(tasks, CONCURRENCY);
    console.log();
  }

  const artists = local.prepare('SELECT * FROM artists ORDER BY id').all() as Record<string, unknown>[];
  await bulkInsert('artists', 'artists',
    ['id', 'name', 'spotify_id', 'musicbrainz_id', 'genres', 'image_url', 'created_at', 'updated_at'],
    artists);

  const albums = local.prepare('SELECT * FROM albums ORDER BY id').all() as Record<string, unknown>[];
  await bulkInsert('albums', 'albums',
    ['id', 'name', 'artist_name', 'spotify_id', 'musicbrainz_id', 'release_date', 'album_type', 'image_url', 'total_tracks', 'queue_status', 'created_at', 'updated_at'],
    albums);

  const tracks = local.prepare('SELECT * FROM tracks ORDER BY id').all() as Record<string, unknown>[];
  await bulkInsert('tracks', 'tracks',
    ['id', 'name', 'album_id', 'artist_id', 'duration_ms', 'track_number', 'disc_number', 'spotify_id', 'musicbrainz_id', 'local_file_path', 'download_status', 'created_at', 'updated_at'],
    tracks);

  const events = local.prepare('SELECT * FROM listening_events ORDER BY id').all() as Record<string, unknown>[];
  await bulkInsert('listening_events', 'listening_events',
    ['id', 'track_id', 'played_at', 'ms_played', 'source', 'conn_country', 'platform', 'created_at'],
    events);

  const trackArtists = local.prepare('SELECT * FROM track_artists ORDER BY track_id, artist_id').all() as Record<string, unknown>[];
  await bulkInsert('track_artists', 'track_artists',
    ['track_id', 'artist_id', 'role'],
    trackArtists, true);

  const importLog = local.prepare('SELECT * FROM import_log ORDER BY id').all() as Record<string, unknown>[];
  await bulkInsert('import_log', 'import_log',
    ['id', 'source', 'source_identifier', 'imported_at', 'event_count'],
    importLog);

  local.close();

  console.log('\nFull sync to D1 complete!');
  console.log(`  Artists: ${artists.length}`);
  console.log(`  Albums:  ${albums.length}`);
  console.log(`  Tracks:  ${tracks.length}`);
  console.log(`  Events:  ${events.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
