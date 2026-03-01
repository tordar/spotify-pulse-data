/**
 * Syncs the local library.db to Turso by clearing all tables and re-inserting
 * everything in batches. Run after a full rebuild (e.g. import-history-to-db).
 *
 * Usage:  npm run db:sync-turso
 * Requires: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN env vars
 */

import Database from 'better-sqlite3';
import { createClient } from '@libsql/client';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');
const BATCH_SIZE = 200;

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!url) {
    console.error('TURSO_DATABASE_URL env var is required');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const local = new Database(DB_PATH, { readonly: true });
  const turso = createClient({ url, authToken });

  console.log('Starting full sync from library.db → Turso…');

  // Clear in reverse FK order
  await turso.batch([
    { sql: 'DELETE FROM listening_events', args: [] },
    { sql: 'DELETE FROM track_artists', args: [] },
    { sql: 'DELETE FROM tracks', args: [] },
    { sql: 'DELETE FROM albums', args: [] },
    { sql: 'DELETE FROM artists', args: [] },
    { sql: 'DELETE FROM import_log', args: [] },
  ], 'write');

  // Reset autoincrement sequences
  await turso.batch([
    { sql: "DELETE FROM sqlite_sequence WHERE name IN ('artists','albums','tracks','listening_events','import_log')", args: [] },
  ], 'write');

  console.log('Cleared Turso tables.');

  async function batchInsert<T>(
    label: string,
    rows: T[],
    toStatement: (row: T) => { sql: string; args: (string | number | null)[] },
  ) {
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await turso.batch(chunk.map(toStatement), 'write');
      done += chunk.length;
      process.stdout.write(`\r  ${label}: ${done}/${rows.length}`);
    }
    console.log();
  }

  // Artists
  const artists = local.prepare('SELECT * FROM artists ORDER BY id').all() as Array<{
    id: number; name: string; spotify_id: string | null; genres: string | null; image_url: string | null;
    created_at: string; updated_at: string;
  }>;
  await batchInsert('artists', artists, r => ({
    sql: `INSERT INTO artists (id, name, spotify_id, genres, image_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [r.id, r.name, r.spotify_id, r.genres, r.image_url, r.created_at, r.updated_at],
  }));

  // Albums
  const albums = local.prepare('SELECT * FROM albums ORDER BY id').all() as Array<{
    id: number; name: string; artist_name: string; spotify_id: string | null;
    release_date: string | null; album_type: string | null; image_url: string | null;
    total_tracks: number | null; created_at: string; updated_at: string;
  }>;
  await batchInsert('albums', albums, r => ({
    sql: `INSERT INTO albums (id, name, artist_name, spotify_id, release_date, album_type, image_url, total_tracks, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.id, r.name, r.artist_name, r.spotify_id, r.release_date, r.album_type, r.image_url, r.total_tracks, r.created_at, r.updated_at],
  }));

  // Tracks
  const tracks = local.prepare('SELECT * FROM tracks ORDER BY id').all() as Array<{
    id: number; name: string; album_id: number; artist_id: number; duration_ms: number;
    track_number: number | null; disc_number: number | null; spotify_id: string | null;
    musicbrainz_id: string | null; local_file_path: string | null; download_status: string;
    created_at: string; updated_at: string;
  }>;
  await batchInsert('tracks', tracks, r => ({
    sql: `INSERT INTO tracks (id, name, album_id, artist_id, duration_ms, track_number, disc_number,
                              spotify_id, musicbrainz_id, local_file_path, download_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.id, r.name, r.album_id, r.artist_id, r.duration_ms, r.track_number, r.disc_number,
           r.spotify_id, r.musicbrainz_id, r.local_file_path, r.download_status, r.created_at, r.updated_at],
  }));

  // Listening events
  const events = local.prepare('SELECT * FROM listening_events ORDER BY id').all() as Array<{
    id: number; track_id: number; played_at: string; ms_played: number;
    source: string; conn_country: string | null; platform: string | null; created_at: string;
  }>;
  await batchInsert('listening_events', events, r => ({
    sql: `INSERT INTO listening_events (id, track_id, played_at, ms_played, source, conn_country, platform, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.id, r.track_id, r.played_at, r.ms_played, r.source, r.conn_country, r.platform, r.created_at],
  }));

  // Track artists
  const trackArtists = local.prepare('SELECT * FROM track_artists ORDER BY track_id, artist_id').all() as Array<{
    track_id: number; artist_id: number; role: string;
  }>;
  await batchInsert('track_artists', trackArtists, r => ({
    sql: `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, ?)`,
    args: [r.track_id, r.artist_id, r.role],
  }));

  local.close();

  console.log('\nFull sync to Turso complete!');
  console.log(`  Artists: ${artists.length}`);
  console.log(`  Albums:  ${albums.length}`);
  console.log(`  Tracks:  ${tracks.length}`);
  console.log(`  Events:  ${events.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
