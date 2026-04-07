/**
 * import-plays-to-navidrome.ts
 *
 * Imports play counts and last-played dates from library.db into Navidrome's
 * annotation table, so Navidrome reflects your full listening history.
 *
 * Matching strategy (in order):
 *   1. MusicBrainz recording MBID  (mbz_recording_id)
 *   2. File path (strips local prefix to match Navidrome's relative path)
 *
 * Usage:
 *   tsx scripts/db/import-plays-to-navidrome.ts
 *   tsx scripts/db/import-plays-to-navidrome.ts --dry-run
 *
 * Requires SSH access to tordar@loxodonta
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const DB_PATH        = path.resolve(__dirname, '../../data/library.db');
const NAVIDROME_DB   = '/volume1/docker/navidrome/navidrome.db';
const NAS_HOST       = 'tordar@loxodonta';
const MUSIC_PREFIX   = '/Volumes/MyDrive/Music/Music/';
const SQL_TMP        = '/tmp/navidrome-plays.sql';
const DRY_RUN        = process.argv.includes('--dry-run');

interface TrackPlay {
  recording_mbid: string | null;
  local_file_path: string | null;
  play_count: number;
  last_played: string;
}

function fetchPlayCounts(): TrackPlay[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT
      t.musicbrainz_id      AS recording_mbid,
      t.local_file_path     AS local_file_path,
      COUNT(le.id)          AS play_count,
      MAX(le.played_at)     AS last_played
    FROM listening_events le
    JOIN tracks t ON t.id = le.track_id
    GROUP BY t.id
    HAVING COUNT(le.id) > 0
    ORDER BY play_count DESC
  `).all() as TrackPlay[];
  db.close();
  return rows;
}

function toNavidromePath(localPath: string): string {
  if (localPath.startsWith(MUSIC_PREFIX)) {
    return localPath.slice(MUSIC_PREFIX.length);
  }
  return localPath;
}

function fetchNavidromeIndex(): { byMbid: Map<string, string>; byPath: Map<string, string>; userId: string } {
  const result = execSync(
    `ssh ${NAS_HOST} "sqlite3 ${NAVIDROME_DB} 'SELECT id,mbz_recording_id,path FROM media_file'"`,
    { encoding: 'utf8', shell: '/bin/sh', maxBuffer: 32 * 1024 * 1024 }
  );
  const userResult = execSync(
    `ssh ${NAS_HOST} "sqlite3 ${NAVIDROME_DB} 'SELECT id FROM user LIMIT 1'"`,
    { encoding: 'utf8', shell: '/bin/sh', maxBuffer: 32 * 1024 * 1024 }
  );

  const byMbid = new Map<string, string>();
  const byPath = new Map<string, string>();

  for (const line of result.trim().split('\n')) {
    const [id, mbid, filePath] = line.split('|');
    if (!id) continue;
    if (mbid) byMbid.set(mbid, id);
    if (filePath) byPath.set(filePath, id);
  }

  return { byMbid, byPath, userId: userResult.trim() };
}

async function main() {
  console.log('Fetching play counts from library.db...');
  const plays = fetchPlayCounts();
  console.log(`  ${plays.length.toLocaleString()} tracks with listens\n`);

  console.log('Fetching Navidrome media index via SSH...');
  const { byMbid, byPath, userId } = fetchNavidromeIndex();
  console.log(`  ${byMbid.size.toLocaleString()} tracks indexed by MBID`);
  console.log(`  ${byPath.size.toLocaleString()} tracks indexed by path`);
  console.log(`  User ID: ${userId}\n`);

  let matchedMbid  = 0;
  let matchedPath  = 0;
  let unmatched    = 0;
  const statements: string[] = [];

  for (const play of plays) {
    let navId: string | undefined;

    // 1. Match by recording MBID
    if (play.recording_mbid) {
      navId = byMbid.get(play.recording_mbid);
      if (navId) matchedMbid++;
    }

    // 2. Fallback: match by path
    if (!navId && play.local_file_path) {
      const relPath = toNavidromePath(play.local_file_path);
      navId = byPath.get(relPath);
      if (navId) matchedPath++;
    }

    if (!navId) {
      unmatched++;
      continue;
    }

    // Format last_played as ISO datetime for SQLite
    const lastPlayed = new Date(play.last_played).toISOString().replace('T', ' ').replace('Z', '+00:00');

    statements.push(
      `INSERT INTO annotation (user_id, item_id, item_type, play_count, play_date) ` +
      `VALUES ('${userId}', '${navId}', 'media_file', ${play.play_count}, '${lastPlayed}') ` +
      `ON CONFLICT(user_id, item_id, item_type) DO UPDATE SET ` +
      `play_count = MAX(play_count, excluded.play_count), ` +
      `play_date = CASE WHEN excluded.play_date > play_date THEN excluded.play_date ELSE play_date END;`
    );
  }

  console.log(`Matched by MBID:  ${matchedMbid.toLocaleString()}`);
  console.log(`Matched by path:  ${matchedPath.toLocaleString()}`);
  console.log(`Unmatched:        ${unmatched.toLocaleString()}`);
  console.log(`Total statements: ${statements.length.toLocaleString()}\n`);

  if (statements.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — first 3 statements:');
    statements.slice(0, 3).forEach(s => console.log(' ', s));
    return;
  }

  // Write SQL to temp file and execute on NAS
  const sql = 'BEGIN;\n' + statements.join('\n') + '\nCOMMIT;\n';
  fs.writeFileSync(SQL_TMP, sql);
  console.log(`Executing ${statements.length.toLocaleString()} statements on Navidrome...`);

  execSync(`ssh ${NAS_HOST} "sqlite3 ${NAVIDROME_DB}" < ${SQL_TMP}`, { stdio: 'inherit', shell: '/bin/sh' });
  fs.unlinkSync(SQL_TMP);

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
