/**
 * repair-orphaned-listens.ts
 *
 * Fixes listening_events rows whose track_id no longer exists in the tracks
 * table. Uses the merged streaming history JSON to match events by timestamp
 * and re-link them to the correct track via spotify_id.
 *
 * Usage:
 *   tsx scripts/db/repair-orphaned-listens.ts
 *   tsx scripts/db/repair-orphaned-listens.ts --dry-run
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';

const DB_PATH      = path.resolve(__dirname, '../../data/library.db');
const HISTORY_DIR  = path.resolve(__dirname, '../../data/merged-streaming-history');
const FIXED_IDS_PATH = path.resolve(__dirname, '../../data/repaired-listen-ids.json');
const DRY_RUN      = process.argv.includes('--dry-run');

interface HistoryEvent {
  playedAt: string;
  msPlayed: number;
}

interface HistorySong {
  songId: string;
  name: string;
  artists: string[];
  album: { name: string };
  listeningEvents: HistoryEvent[];
}

interface TrackMeta {
  spotifyId: string;
  name: string;
  artist: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function loadJsonHistory(): Map<string, TrackMeta> {
  // Returns map: playedAt ISO string → { spotifyId, name, artist }
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`No JSON files found in ${HISTORY_DIR}`);

  const tsToMeta = new Map<string, TrackMeta>();

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
    const songs: HistorySong[] = data.songs || [];
    for (const song of songs) {
      for (const event of song.listeningEvents) {
        const ts = new Date(event.playedAt).toISOString();
        tsToMeta.set(ts, {
          spotifyId: song.songId,
          name: song.name,
          artist: song.artists[0] || '',
        });
      }
    }
  }

  return tsToMeta;
}

function findTrackId(db: Database.Database, meta: TrackMeta): number | null {
  // 1. Exact spotify_id match
  const bySpotify = db.prepare(`SELECT id FROM tracks WHERE spotify_id = ? LIMIT 1`)
    .get(meta.spotifyId) as { id: number } | undefined;
  if (bySpotify) return bySpotify.id;

  // 2. Exact name + artist match (case-insensitive)
  const byExact = db.prepare(`
    SELECT t.id FROM tracks t
    JOIN artists ar ON ar.id = t.artist_id
    WHERE t.name = ? COLLATE NOCASE AND ar.name = ? COLLATE NOCASE
    LIMIT 1
  `).get(meta.name, meta.artist) as { id: number } | undefined;
  if (byExact) return byExact.id;

  // 3. Normalized name + artist match
  const normName   = normalize(meta.name);
  const normArtist = normalize(meta.artist);
  const prefix     = meta.artist.substring(0, Math.min(meta.artist.length, 10));

  const candidates = db.prepare(`
    SELECT t.id, t.name, ar.name as artist_name FROM tracks t
    JOIN artists ar ON ar.id = t.artist_id
    WHERE ar.name LIKE ? COLLATE NOCASE
  `).all(`%${prefix}%`) as { id: number; name: string; artist_name: string }[];

  for (const c of candidates) {
    if (normalize(c.name) === normName && normalize(c.artist_name) === normArtist) {
      return c.id;
    }
  }

  return null;
}

async function main() {
  const db = new Database(DB_PATH);

  // Find all orphaned listening events
  const orphans = db.prepare(`
    SELECT le.id, le.played_at, le.track_id
    FROM listening_events le
    LEFT JOIN tracks t ON t.id = le.track_id
    WHERE t.id IS NULL
    ORDER BY le.played_at ASC
  `).all() as { id: number; played_at: string; track_id: number }[];

  console.log(`Orphaned listening events: ${orphans.length.toLocaleString()}`);
  if (DRY_RUN) console.log('DRY RUN — no changes will be written\n');

  if (orphans.length === 0) {
    console.log('Nothing to fix.');
    db.close();
    return;
  }

  console.log('Loading streaming history JSON...');
  const tsToMeta = loadJsonHistory();
  console.log(`Loaded ${tsToMeta.size.toLocaleString()} events from JSON\n`);

  let fixed    = 0;
  let noMatch  = 0;
  let noJson   = 0;
  const fixedIds: number[] = [];

  const updateStmt = db.prepare(`UPDATE listening_events SET track_id = ? WHERE id = ?`);

  const repair = db.transaction(() => {
    for (const orphan of orphans) {
      const ts   = new Date(orphan.played_at).toISOString();
      const meta = tsToMeta.get(ts);

      if (!meta) { noJson++; continue; }

      const trackId = findTrackId(db, meta);

      if (trackId === null) { noMatch++; continue; }

      if (!DRY_RUN) {
        updateStmt.run(trackId, orphan.id);
        fixedIds.push(orphan.id);
      }
      fixed++;
    }
  });

  repair();

  if (!DRY_RUN && fixedIds.length > 0) {
    fs.writeFileSync(FIXED_IDS_PATH, JSON.stringify(fixedIds));
    console.log(`Saved ${fixedIds.length} fixed event IDs to ${FIXED_IDS_PATH}`);
  }

  console.log('\nDone.');
  console.log(`  Fixed (track_id updated):  ${fixed.toLocaleString()}`);
  console.log(`  No matching track in DB:   ${noMatch.toLocaleString()}`);
  console.log(`  Not found in JSON:         ${noJson.toLocaleString()}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
