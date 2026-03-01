/**
 * One-shot fix for catalog tracks whose names have a leading track number
 * (e.g. "06 So Vivid!" → "So Vivid!") because music-metadata returned the
 * tagged title including the number.
 *
 * For each such track:
 *   1. Strip the number from the name.
 *   2. Try to match against an existing Spotify-history track with the clean name.
 *   3. If matched: copy local_file_path to the history track, delete the catalog duplicate.
 *   4. If not matched: update the catalog track's name to the clean version.
 *
 * Usage: npm run db:fix-track-numbers
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');

function stripTrackNumber(s: string): string {
  return s.replace(/^\d{1,3}[\s.\-_]+/, '').trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[^\w\s'"-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Catalog tracks = local file, no listening events
  const catalogTracks = db.prepare(`
    SELECT t.id, t.name, t.local_file_path, t.duration_ms,
           a.name as artist_name, al.name as album_name
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
  `).all() as Array<{
    id: number; name: string; local_file_path: string; duration_ms: number;
    artist_name: string; album_name: string;
  }>;

  // Only care about those with a leading track number
  const numbered = catalogTracks.filter(t => /^\d{1,3}[\s.\-_]/.test(t.name));
  console.log(`Found ${numbered.length} catalog tracks with leading track numbers (out of ${catalogTracks.length} total catalog tracks)`);

  // Pre-load Spotify history tracks (have listening events) for fast lookup
  const historyTracks = db.prepare(`
    SELECT t.id, t.name, t.duration_ms, t.local_file_path,
           a.name as artist_name, al.name as album_name
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
  `).all() as Array<{
    id: number; name: string; duration_ms: number; local_file_path: string | null;
    artist_name: string; album_name: string;
  }>;

  // Build normalized lookup: "normArtist|||normTitle" → track[]
  const lookup = new Map<string, typeof historyTracks>();
  for (const t of historyTracks) {
    const key = `${normalize(t.artist_name)}|||${normalize(t.name)}`;
    const list = lookup.get(key) ?? [];
    list.push(t);
    lookup.set(key, list);
  }

  const updatePath = db.prepare(`
    UPDATE tracks SET local_file_path = ?, download_status = 'downloaded', updated_at = datetime('now')
    WHERE id = ?
  `);
  const updateName = db.prepare(`
    UPDATE tracks SET name = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const deleteTrack = db.prepare(`DELETE FROM tracks WHERE id = ?`);
  const deleteTrackArtists = db.prepare(`DELETE FROM track_artists WHERE track_id = ?`);

  let linked = 0;
  let renamed = 0;
  const usedIds = new Set<number>();

  db.transaction(() => {
    for (const catalog of numbered) {
      const cleanName = stripTrackNumber(catalog.name);
      const key = `${normalize(catalog.artist_name)}|||${normalize(cleanName)}`;
      const candidates = (lookup.get(key) ?? []).filter(t => !usedIds.has(t.id));

      let matched: typeof historyTracks[0] | null = null;

      if (candidates.length === 1) {
        matched = candidates[0];
      } else if (candidates.length > 1) {
        // Prefer same album, then duration within 5s
        matched =
          candidates.find(c => normalize(c.album_name) === normalize(catalog.album_name)) ??
          candidates.find(c => c.duration_ms > 0 && Math.abs(c.duration_ms - catalog.duration_ms) < 5000) ??
          candidates[0];
      }

      if (matched) {
        usedIds.add(matched.id);
        // Copy file path to the history track
        updatePath.run(catalog.local_file_path, matched.id);
        // Delete the catalog duplicate
        deleteTrackArtists.run(catalog.id);
        deleteTrack.run(catalog.id);
        linked++;
        console.log(`  ✓ Linked "${cleanName}" (was "${catalog.name}") → history track #${matched.id} (${matched.name})`);
      } else {
        // Just fix the name in place
        updateName.run(cleanName, catalog.id);
        renamed++;
      }
    }
  })();

  console.log(`\nDone:`);
  console.log(`  Linked to Spotify history: ${linked}`);
  console.log(`  Renamed (no history match): ${renamed}`);
  console.log(`  Total fixed: ${linked + renamed} / ${numbered.length}`);

  db.close();
}

main();
