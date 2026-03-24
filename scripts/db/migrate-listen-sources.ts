/**
 * Migration: populate listening_events.source with actual playback source.
 *
 * - Fetches all LB history and builds a listened_at_iso → source map
 * - Recreates listening_events in local SQLite with the new CHECK constraint
 *   ('spotify','navidrome','ipod','local_import') — replacing 'listenbrainz'
 * - Updates all former 'listenbrainz' rows to 'spotify' or 'navidrome'
 * - Runs the same migration against Cloudflare D1
 *
 * Usage:
 *   tsx scripts/db/migrate-listen-sources.ts [--d1-only | --local-only]
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from './database';
import { getD1Client } from './d1-client';
import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', 'web-app', '.env.local'), override: true });

const LB_BASE = 'https://api.listenbrainz.org/1';
const PAGE_SIZE = 100;

interface LBListen {
  listened_at: number;
  track_metadata: {
    additional_info?: {
      submission_client?: string;
      music_service?: string;
      music_service_name?: string;
    };
  };
}

function detectSource(listen: LBListen): 'spotify' | 'navidrome' {
  const info = listen.track_metadata.additional_info ?? {};
  const raw = [info.music_service, info.music_service_name, info.submission_client]
    .filter(Boolean).join(' ').toLowerCase();
  return raw.includes('navidrome') ? 'navidrome' : 'spotify';
}

async function fetchAllListens(
  username: string,
  token?: string,
): Promise<Map<string, 'spotify' | 'navidrome'>> {
  const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' };
  if (token) headers['Authorization'] = `Token ${token}`;

  const sourceMap = new Map<string, 'spotify' | 'navidrome'>();
  let maxTs: number | undefined;
  let page = 0;

  console.log(`Fetching all LB history for "${username}"...`);

  while (true) {
    const params = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (maxTs != null) params.set('max_ts', String(maxTs));
    const url = `${LB_BASE}/user/${encodeURIComponent(username)}/listens?${params}`;

    let resp: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        resp = await fetch(url, { headers });
        break;
      } catch {
        if (attempt === 3) throw new Error('LB API unreachable after 4 attempts');
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (!resp || !resp.ok) throw new Error(`LB API error ${resp?.status}: ${await resp?.text()}`);
    const data = await resp.json() as { payload: { listens: LBListen[] } };
    const listens = data.payload.listens;
    page++;

    if (listens.length === 0) break;

    for (const listen of listens) {
      const iso = new Date(listen.listened_at * 1000).toISOString();
      sourceMap.set(iso, detectSource(listen));
    }

    if (page % 100 === 0) {
      console.log(`  Page ${page}: ${sourceMap.size} listens mapped`);
    }

    if (listens.length < PAGE_SIZE) break;
    maxTs = listens[listens.length - 1].listened_at - 1;
    await new Promise(r => setTimeout(r, 300));
  }

  const ndCount = [...sourceMap.values()].filter(s => s === 'navidrome').length;
  console.log(`Source map: ${sourceMap.size} listens — Navidrome: ${ndCount}, Spotify: ${sourceMap.size - ndCount}\n`);

  return sourceMap;
}

function migrateLocalDb(
  db: Database.Database,
  sourceMap: Map<string, 'spotify' | 'navidrome'>,
): void {
  console.log('Migrating local SQLite...');

  db.exec(`
    BEGIN;

    -- Recreate table with updated CHECK constraint
    CREATE TABLE listening_events_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id      INTEGER NOT NULL REFERENCES tracks(id),
      played_at     TEXT NOT NULL,
      ms_played     INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL CHECK(source IN ('spotify','navidrome','ipod','local_import')),
      conn_country  TEXT,
      platform      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Copy all rows, defaulting 'listenbrainz' to 'spotify' (will be updated below)
    INSERT INTO listening_events_new (id, track_id, played_at, ms_played, source, conn_country, platform, created_at)
    SELECT id, track_id, played_at, ms_played,
      CASE source WHEN 'listenbrainz' THEN 'spotify' ELSE source END,
      conn_country, platform, created_at
    FROM listening_events;

    DROP TABLE listening_events;
    ALTER TABLE listening_events_new RENAME TO listening_events;

    CREATE INDEX IF NOT EXISTS idx_events_track_played ON listening_events(track_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_events_source_played ON listening_events(source, played_at);
    CREATE INDEX IF NOT EXISTS idx_events_played_at ON listening_events(played_at);

    COMMIT;
  `);

  // Now update navidrome rows
  const updateStmt = db.prepare(
    `UPDATE listening_events SET source = 'navidrome' WHERE played_at = ? AND source = 'spotify'`
  );

  let navidromeUpdated = 0;
  const updateBatch = db.transaction((entries: [string, 'spotify' | 'navidrome'][]) => {
    for (const [iso, source] of entries) {
      if (source === 'navidrome') {
        const result = updateStmt.run(iso);
        navidromeUpdated += result.changes;
      }
    }
  });

  const navidromeEntries = [...sourceMap.entries()].filter(([, s]) => s === 'navidrome');
  const BATCH = 1000;
  for (let i = 0; i < navidromeEntries.length; i += BATCH) {
    updateBatch(navidromeEntries.slice(i, i + BATCH));
  }

  console.log(`  Updated ${navidromeUpdated} rows to 'navidrome'`);

  // Verify
  const counts = db.prepare(
    `SELECT source, COUNT(*) as cnt FROM listening_events GROUP BY source`
  ).all() as Array<{ source: string; cnt: number }>;
  console.log('  Source counts after migration:');
  for (const row of counts) {
    console.log(`    ${row.source}: ${row.cnt}`);
  }
  console.log('  Local SQLite migration complete.\n');
}

async function migrateD1(
  sourceMap: Map<string, 'spotify' | 'navidrome'>,
): Promise<void> {
  console.log('Migrating Cloudflare D1...');
  const d1 = getD1Client();

  // Recreate table with new CHECK constraint
  await d1.execute(`
    CREATE TABLE IF NOT EXISTS listening_events_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id      INTEGER NOT NULL REFERENCES tracks(id),
      played_at     TEXT NOT NULL,
      ms_played     INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL CHECK(source IN ('spotify','navidrome','ipod','local_import')),
      conn_country  TEXT,
      platform      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await d1.execute(`
    INSERT INTO listening_events_new (id, track_id, played_at, ms_played, source, conn_country, platform, created_at)
    SELECT id, track_id, played_at, ms_played,
      CASE source WHEN 'listenbrainz' THEN 'spotify' ELSE source END,
      conn_country, platform, created_at
    FROM listening_events
  `);

  await d1.execute(`DROP TABLE listening_events`);
  await d1.execute(`ALTER TABLE listening_events_new RENAME TO listening_events`);

  await d1.execute(`CREATE INDEX IF NOT EXISTS idx_events_track_played ON listening_events(track_id, played_at)`);
  await d1.execute(`CREATE INDEX IF NOT EXISTS idx_events_source_played ON listening_events(source, played_at)`);
  await d1.execute(`CREATE INDEX IF NOT EXISTS idx_events_played_at ON listening_events(played_at)`);

  console.log('  Table recreated with new constraint. Updating Navidrome rows...');

  // Update navidrome rows in batches
  const navidromeIsos = [...sourceMap.entries()]
    .filter(([, s]) => s === 'navidrome')
    .map(([iso]) => iso);

  let navidromeUpdated = 0;
  const BATCH = 50;
  for (let i = 0; i < navidromeIsos.length; i += BATCH) {
    const batch = navidromeIsos.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const result = await d1.execute({
      sql: `UPDATE listening_events SET source = 'navidrome' WHERE played_at IN (${placeholders}) AND source = 'spotify'`,
      args: batch,
    });
    navidromeUpdated += result.rowsAffected;
    if (i % 500 === 0) {
      console.log(`  Progress: ${i}/${navidromeIsos.length} navidrome timestamps processed`);
    }
  }

  console.log(`  Updated ${navidromeUpdated} rows to 'navidrome'`);

  // Verify
  const { rows } = await d1.execute(
    `SELECT source, COUNT(*) as cnt FROM listening_events GROUP BY source`
  );
  console.log('  Source counts after migration:');
  for (const row of rows) {
    console.log(`    ${row.source}: ${row.cnt}`);
  }
  console.log('  D1 migration complete.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const d1Only = args.includes('--d1-only');
  const localOnly = args.includes('--local-only');

  const username = process.env.LISTENBRAINZ_USERNAME;
  if (!username) {
    console.error('LISTENBRAINZ_USERNAME must be set in .env or .env.local');
    process.exit(1);
  }
  const token = process.env.LISTENBRAINZ_TOKEN;

  const sourceMap = await fetchAllListens(username, token);

  if (!d1Only) {
    const dbPath = path.join(__dirname, '..', '..', 'data', 'library.db');
    if (fs.existsSync(dbPath)) {
      const db = getDatabase(dbPath);
      migrateLocalDb(db, sourceMap);
      closeDatabase();
    } else {
      console.log('No local library.db found, skipping local migration.');
    }
  }

  if (!localOnly) {
    await migrateD1(sourceMap);
  }

  console.log('Migration complete.');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
