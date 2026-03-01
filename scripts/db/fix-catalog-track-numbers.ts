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
  return s
    .replace(/^\d{1,2}-\d{1,3}[\s.\-_]+/, '') // "1-04 " disc-track format
    .replace(/^\d{1,3}[\s.\-_]+/, '')           // "04 " simple track number
    .trim();
}

function stripArtistNumber(s: string): string {
  return s.replace(/^\d{1,3}\.\s+/, '').trim(); // "04. Artist" catalog prefix
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

  // Catalog tracks with a leading track number in name OR artist
  const numbered = catalogTracks.filter(t =>
    /^\d{1,2}-\d{1,3}[\s.\-_]/.test(t.name) ||   // "1-04 Song"
    /^\d{1,3}[\s.\-_]/.test(t.name) ||             // "04 Song"
    /^\d{1,3}\.\s/.test(t.artist_name)              // "04. Artist"
  );
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
  const updateNameAndArtist = db.prepare(`
    UPDATE tracks SET name = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const getArtistByName = db.prepare<[string], { id: number }>(
    `SELECT id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1`
  );
  const updateTrackArtist = db.prepare(
    `UPDATE tracks SET artist_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updateTrackArtistRow = db.prepare(
    `UPDATE track_artists SET artist_id = ? WHERE track_id = ? AND artist_id = (SELECT artist_id FROM tracks WHERE id = ?)`
  );
  const renameArtistRow = db.prepare(
    `UPDATE artists SET name = ?, updated_at = datetime('now') WHERE name = ? COLLATE NOCASE`
  );
  const deleteOrphanArtist = db.prepare(
    `DELETE FROM artists WHERE name = ? AND NOT EXISTS (SELECT 1 FROM tracks WHERE artist_id = artists.id)`
  );
  const deleteTrack = db.prepare(`DELETE FROM tracks WHERE id = ?`);
  const deleteTrackArtists = db.prepare(`DELETE FROM track_artists WHERE track_id = ?`);

  let linked = 0;
  let renamed = 0;
  const usedIds = new Set<number>();

  db.transaction(() => {
    for (const catalog of numbered) {
      const cleanName = stripTrackNumber(catalog.name);
      const cleanArtist = stripArtistNumber(catalog.artist_name);

      // Try match with cleaned name + cleaned artist
      const key = `${normalize(cleanArtist)}|||${normalize(cleanName)}`;
      const candidates = (lookup.get(key) ?? []).filter(t => !usedIds.has(t.id));

      let matched: typeof historyTracks[0] | null = null;
      if (candidates.length === 1) {
        matched = candidates[0];
      } else if (candidates.length > 1) {
        matched =
          candidates.find(c => normalize(c.album_name) === normalize(catalog.album_name)) ??
          candidates.find(c => c.duration_ms > 0 && Math.abs(c.duration_ms - catalog.duration_ms) < 5000) ??
          candidates[0];
      }

      if (matched) {
        usedIds.add(matched.id);
        updatePath.run(catalog.local_file_path, matched.id);
        deleteTrackArtists.run(catalog.id);
        deleteTrack.run(catalog.id);
        linked++;
        const changed = cleanName !== catalog.name || cleanArtist !== catalog.artist_name;
        console.log(`  ✓ Linked "${cleanArtist} - ${cleanName}"${changed ? ` (was "${catalog.artist_name} - ${catalog.name}")` : ''} → history #${matched.id}`);
      } else {
        // Fix name in place
        updateNameAndArtist.run(cleanName, catalog.id);

        // Fix artist: if clean name already exists, re-point the track; otherwise just rename
        if (cleanArtist !== catalog.artist_name) {
          const existing = getArtistByName.get(cleanArtist);
          if (existing) {
            // Clean artist already exists — update track + track_artists to use it,
            // then clean up the orphaned numbered artist row
            updateTrackArtistRow.run(existing.id, catalog.id, catalog.id);
            updateTrackArtist.run(existing.id, catalog.id);
            deleteOrphanArtist.run(catalog.artist_name);
          } else {
            // Safe to rename the artist row in place
            renameArtistRow.run(cleanArtist, catalog.artist_name);
          }
        }
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
