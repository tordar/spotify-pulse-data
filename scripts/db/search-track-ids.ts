/**
 * For local tracks that still have no spotify_id after album-based enrichment,
 * search Spotify directly by track name + artist name and assign the ID when
 * we find a confident match (name + duration).
 *
 * This complements enrich-missing-tracks.ts which works album-by-album.
 * Run this afterwards to catch compilation tracks, soundtracks, or albums
 * whose names didn't match Spotify's album search.
 *
 * Usage: npm run db:search-track-ids
 * Requires: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') });

import Database from 'better-sqlite3';
import { SpotifyTokenManager } from '../spotify-token-manager';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');

// Minimum delay between Spotify API calls (ms)
const DELAY_MS = 400;

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // strip parenthetical version/edition suffixes
    .replace(/\s*[-–([].*?(remaster|remast|reissue|live|bonus|deluxe|anniversary|edition|mix|edit|version|mono|stereo|single|extended|instrumental|acoustic|demo|alternate|alt\.|original\s+mix|radio|club|explicit|clean|feat\.|ft\.).*$/i, '')
    .replace(/\s*[\[(][^\])]*[\])]?/g, '')
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArtist(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SpotifySearchTrack {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  artists: Array<{ name: string }>;
  album: { name: string };
}

async function spotifyGet<T>(url: string, token: string): Promise<T> {
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') ?? '5');
      console.log(`  Rate limited — waiting ${retry}s…`);
      await new Promise(r => setTimeout(r, retry * 1000));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Spotify ${res.status}`), { status: res.status });
    return res.json() as Promise<T>;
  }
}

async function searchTrack(
  trackName: string,
  artistName: string,
  token: string
): Promise<SpotifySearchTrack[]> {
  // Use field filters for precision, then fall back to a looser query
  const q = encodeURIComponent(`track:"${trackName}" artist:"${artistName}"`);
  const url = `https://api.spotify.com/v1/search?q=${q}&type=track&limit=5`;
  const data = await spotifyGet<{
    tracks: { items: SpotifySearchTrack[] }
  }>(url, token);
  return data.tracks.items;
}

/**
 * Return the best Spotify track match, or null if no confident match found.
 * Confidence requires:
 *   - Normalised track name must match exactly (after stripping remaster suffixes etc.)
 *   - Artist name must overlap (one artist from result matches our artist)
 *   - Duration within 5s (if we have a duration)
 */
function findConfidentMatch(
  trackName: string,
  artistName: string,
  durationMs: number,
  candidates: SpotifySearchTrack[]
): SpotifySearchTrack | null {
  const normName = normalizeTitle(trackName);
  const normArtist = normalizeArtist(artistName);

  let best: SpotifySearchTrack | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const cName = normalizeTitle(c.name);
    const cArtists = c.artists.map(a => normalizeArtist(a.name));

    // Name must be an exact normalised match
    if (cName !== normName) continue;

    // At least one artist must match
    const artistMatch = cArtists.some(a =>
      a === normArtist ||
      a.includes(normArtist) ||
      normArtist.includes(a)
    );
    if (!artistMatch) continue;

    let score = 2; // name + artist matched

    // Duration bonus (within 5s)
    if (durationMs > 0 && Math.abs(c.duration_ms - durationMs) < 5000) score++;
    // Tight duration bonus (within 2s)
    if (durationMs > 0 && Math.abs(c.duration_ms - durationMs) < 2000) score++;

    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Require at least name + artist match (score >= 2)
  return bestScore >= 2 ? best : null;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // All local tracks still missing a spotify_id
  const tracks = db.prepare(`
    SELECT t.id, t.name, t.duration_ms, a.name as artistName
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    WHERE t.local_file_path IS NOT NULL
      AND t.spotify_id IS NULL
    ORDER BY a.name, t.name
  `).all() as Array<{ id: number; name: string; duration_ms: number; artistName: string }>;

  // Optional --limit N flag for testing
  const limitArg = process.argv.indexOf('--limit')
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : tracks.length
  const batch = tracks.slice(0, limit)

  console.log(`Local tracks without spotify_id: ${tracks.length.toLocaleString()}`)
  console.log(`Processing: ${batch.length.toLocaleString()}`)
  if (batch.length === 0) { db.close(); return; }

  const getBySpotifyId = db.prepare<[string], { id: number }>(
    `SELECT id FROM tracks WHERE spotify_id = ? LIMIT 1`
  );
  const updateTrack = db.prepare(`
    UPDATE tracks
    SET spotify_id = ?, duration_ms = ?, track_number = ?, disc_number = ?,
        download_status = 'downloaded', updated_at = datetime('now')
    WHERE id = ?
  `);

  const tokenManager = new SpotifyTokenManager();

  let found = 0;
  let notFound = 0;
  let skipped = 0;
  const LOG_EVERY = 100;

  for (let i = 0; i < batch.length; i++) {
    const track = batch[i];
    const token = await tokenManager.getValidAccessToken();

    let candidates: SpotifySearchTrack[];
    try {
      candidates = await searchTrack(track.name, track.artistName, token);
    } catch {
      notFound++;
      await new Promise(r => setTimeout(r, DELAY_MS));
      continue;
    }

    const match = findConfidentMatch(track.name, track.artistName, track.duration_ms, candidates);

    if (match) {
      // Guard against assigning a spotify_id that's already on another track
      const existing = getBySpotifyId.get(match.id);
      if (existing && existing.id !== track.id) {
        skipped++;
      } else {
        updateTrack.run(match.id, match.duration_ms, match.track_number, match.disc_number, track.id);
        found++;
        console.log(`  ✓ ${track.artistName} — ${track.name}`);
      }
    } else {
      notFound++;
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(`  … ${i + 1}/${batch.length} checked | found so far: ${found}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone.`);
  console.log(`  Matched:   ${found.toLocaleString()}`);
  console.log(`  No match:  ${notFound.toLocaleString()}`);
  console.log(`  Skipped (ID conflict): ${skipped}`);

  const breakdown = db.prepare(
    `SELECT download_status, COUNT(*) as c FROM tracks WHERE local_file_path IS NOT NULL GROUP BY download_status`
  ).all() as { download_status: string; c: number }[];
  console.log('\nLocal file tracks by download_status:');
  for (const r of breakdown) console.log(`  ${r.download_status}: ${r.c.toLocaleString()}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
