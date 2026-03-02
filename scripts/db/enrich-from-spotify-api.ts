/**
 * Enriches artists and albums in the database using Spotify's batch endpoints:
 *
 *   Phase 1 — GET /v1/tracks?ids= (50 at a time)
 *     For every track with a spotify_id, pull its full Spotify metadata and use
 *     the embedded album/artist objects to:
 *       - Set album.spotify_id where missing
 *       - Set artist.spotify_id where missing
 *       - Update album.image_url, release_date, total_tracks, album_type
 *
 *   Phase 2 — GET /v1/albums?ids= (20 at a time)
 *     For every album now with a spotify_id, fill any remaining gaps in
 *     image_url, release_date, total_tracks.
 *
 *   Phase 3 — GET /v1/artists?ids= (50 at a time)
 *     For every artist now with a spotify_id, fill image_url and genres.
 *
 * Usage: npm run db:enrich-from-spotify-api
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

// ── Spotify response shapes ──────────────────────────────────────────────────

interface SpotifyImage { url: string; width: number; height: number }

interface SpotifyArtistRef { id: string; name: string }

interface SpotifyAlbumRef {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  images: SpotifyImage[];
  artists: SpotifyArtistRef[];
}

interface SpotifyTrackFull {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
  album: SpotifyAlbumRef;
  artists: SpotifyArtistRef[];
}

interface SpotifyAlbumFull {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  images: SpotifyImage[];
  artists: SpotifyArtistRef[];
  genres: string[];
}

interface SpotifyArtistFull {
  id: string;
  name: string;
  genres: string[];
  images: SpotifyImage[];
  followers: { total: number };
  popularity: number;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

/** Valid Spotify IDs are exactly 22 alphanumeric characters (Base62). */
function isValidSpotifyId(id: string): boolean {
  return /^[A-Za-z0-9]{22}$/.test(id);
}

async function spotifyGet<T>(url: string, token: string): Promise<T> {
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') ?? '5');
      process.stdout.write(`  [rate-limited] waiting ${retry}s…\r`);
      await new Promise(r => setTimeout(r, (retry + 1) * 1000));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Spotify ${res.status} — ${url}`), { status: res.status });
    return res.json() as Promise<T>;
  }
}

function bestImage(images: SpotifyImage[]): string | null {
  if (!images?.length) return null;
  // prefer ~640px; fall back to largest
  const sorted = [...images].sort((a, b) => Math.abs(a.width - 640) - Math.abs(b.width - 640));
  return sorted[0]?.url ?? null;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('library.db not found'); process.exit(1); }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Optional --phase N flag to run only a specific phase (1, 2, or 3)
  const phaseArg = process.argv.indexOf('--phase');
  const onlyPhase = phaseArg !== -1 ? parseInt(process.argv[phaseArg + 1]) : null;
  if (onlyPhase) console.log(`Running phase ${onlyPhase} only\n`);

  const tokenManager = new SpotifyTokenManager();

  // ── Prepared statements ────────────────────────────────────────────────────

  const getArtistByName = db.prepare<[string], { id: number; spotify_id: string | null }>(
    `SELECT id, spotify_id FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1`
  );
  const getAlbumById = db.prepare<[number], { spotify_id: string | null }>(
    `SELECT spotify_id FROM albums WHERE id = ?`
  );

  const setArtistSpotifyId = db.prepare(
    `UPDATE artists SET spotify_id = ?, updated_at = datetime('now') WHERE id = ? AND (spotify_id IS NULL OR spotify_id = '')`
  );
  const setAlbumSpotifyId = db.prepare(
    `UPDATE albums SET spotify_id = ?, updated_at = datetime('now') WHERE id = ? AND (spotify_id IS NULL OR spotify_id = '')`
  );
  const updateTrackNumbers = db.prepare(`
    UPDATE tracks SET
      track_number = CASE WHEN track_number IS NULL OR track_number = 0 THEN ? ELSE track_number END,
      disc_number  = CASE WHEN disc_number  IS NULL OR disc_number  = 0 THEN ? ELSE disc_number  END,
      duration_ms  = CASE WHEN duration_ms  IS NULL OR duration_ms  = 0 THEN ? ELSE duration_ms  END,
      updated_at   = datetime('now')
    WHERE id = ?
  `);
  const updateAlbumMeta = db.prepare(`
    UPDATE albums SET
      image_url    = COALESCE(NULLIF(image_url, ''), ?),
      release_date = COALESCE(NULLIF(release_date, ''), ?),
      total_tracks = COALESCE(total_tracks, ?),
      album_type   = COALESCE(NULLIF(album_type, ''), ?),
      updated_at   = datetime('now')
    WHERE spotify_id = ?
  `);
  const updateArtistMeta = db.prepare(`
    UPDATE artists SET
      image_url  = COALESCE(NULLIF(image_url, ''), ?),
      genres     = CASE WHEN genres IS NULL OR genres = '[]' THEN ? ELSE genres END,
      updated_at = datetime('now')
    WHERE spotify_id = ?
  `);

  // Shared sets accumulated across phases
  const newAlbumSpotifyIds = new Set<string>();
  const newArtistSpotifyIds = new Set<string>();

  // ── Phase 1: Batch-fetch tracks ───────────────────────────────────────────
  if (onlyPhase && onlyPhase !== 1) { console.log('Skipping phase 1'); }
  else {

  const tracksWithIds = (db.prepare(`
    SELECT t.id, t.spotify_id, t.album_id, t.artist_id
    FROM tracks t
    WHERE t.spotify_id IS NOT NULL
  `).all() as Array<{ id: number; spotify_id: string; album_id: number; artist_id: number }>)
    .filter(t => isValidSpotifyId(t.spotify_id));

  console.log(`\nPhase 1: fetching metadata for ${tracksWithIds.length.toLocaleString()} tracks (${Math.ceil(tracksWithIds.length / 50)} API calls)…`);

  let trackBatch = 0;
  let trackErrors = 0;
  for (const chunk of chunks(tracksWithIds, 50)) {
    const token = await tokenManager.getValidAccessToken();
    const ids = chunk.map(t => t.spotify_id).join(',');
    let tracks: (SpotifyTrackFull | null)[];
    try {
      ({ tracks } = await spotifyGet<{ tracks: (SpotifyTrackFull | null)[] }>(
        `https://api.spotify.com/v1/tracks?ids=${ids}`,
        token
      ));
    } catch (err) {
      trackErrors++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    db.transaction(() => {
      for (let i = 0; i < chunk.length; i++) {
        const local = chunk[i];
        const sp = tracks[i];
        if (!sp) continue;

        // Track numbers + duration
        updateTrackNumbers.run(sp.track_number, sp.disc_number, sp.duration_ms, local.id);

        // Album spotify_id
        const currentAlbum = getAlbumById.get(local.album_id);
        if (currentAlbum && !currentAlbum.spotify_id) {
          setAlbumSpotifyId.run(sp.album.id, local.album_id);
        }
        newAlbumSpotifyIds.add(sp.album.id);

        // Album image / release date from track's embedded album object
        updateAlbumMeta.run(
          bestImage(sp.album.images),
          sp.album.release_date || null,
          sp.album.total_tracks || null,
          sp.album.album_type || null,
          sp.album.id
        );

        // Primary artist spotify_id
        const primaryArtist = sp.artists[0];
        if (primaryArtist) {
          const localArtist = getArtistByName.get(primaryArtist.name);
          if (localArtist && !localArtist.spotify_id) {
            setArtistSpotifyId.run(primaryArtist.id, localArtist.id);
          }
          newArtistSpotifyIds.add(primaryArtist.id);
          // collect all artists
          for (const a of sp.artists) newArtistSpotifyIds.add(a.id);
        }
      }
    })();

    trackBatch++;
    if (trackBatch % 20 === 0 || trackBatch === Math.ceil(tracksWithIds.length / 50)) {
      process.stdout.write(`  batch ${trackBatch}/${Math.ceil(tracksWithIds.length / 50)}\r`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  Phase 1 done. Discovered ${newAlbumSpotifyIds.size} Spotify album IDs, ${newArtistSpotifyIds.size} artist IDs.${trackErrors ? ` (${trackErrors} chunk errors skipped)` : ''}`);
  } // end phase 1

  // ── Phase 2: Batch-fetch albums ───────────────────────────────────────────
  if (onlyPhase && onlyPhase !== 2) { console.log('Skipping phase 2'); }
  else {

  // All albums in DB that now have a valid spotify_id
  const albumsToFetch = (db.prepare(`
    SELECT id, spotify_id FROM albums WHERE spotify_id IS NOT NULL
  `).all() as Array<{ id: number; spotify_id: string }>)
    .filter(a => isValidSpotifyId(a.spotify_id));

  console.log(`\nPhase 2: fetching metadata for ${albumsToFetch.length.toLocaleString()} albums (${Math.ceil(albumsToFetch.length / 20)} API calls)…`);

  let albumBatch = 0;
  for (const chunk of chunks(albumsToFetch, 20)) {
    const token = await tokenManager.getValidAccessToken();
    const ids = chunk.map(a => a.spotify_id).join(',');
    let albums: (SpotifyAlbumFull | null)[];
    try {
      ({ albums } = await spotifyGet<{ albums: (SpotifyAlbumFull | null)[] }>(
        `https://api.spotify.com/v1/albums?ids=${ids}`,
        token
      ));
    } catch {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    db.transaction(() => {
      for (let i = 0; i < chunk.length; i++) {
        const sp = albums[i];
        if (!sp) continue;
        updateAlbumMeta.run(
          bestImage(sp.images),
          sp.release_date || null,
          sp.total_tracks || null,
          sp.album_type || null,
          sp.id
        );
        // Also collect artist IDs from album
        for (const a of sp.artists) newArtistSpotifyIds.add(a.id);
      }
    })();

    albumBatch++;
    if (albumBatch % 10 === 0 || albumBatch === Math.ceil(albumsToFetch.length / 20)) {
      process.stdout.write(`  batch ${albumBatch}/${Math.ceil(albumsToFetch.length / 20)}\r`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  Phase 2 done.`);
  } // end phase 2

  // ── Phase 3: Batch-fetch artists ──────────────────────────────────────────
  if (onlyPhase && onlyPhase !== 3) { console.log('Skipping phase 3'); }
  else {

  // All artists in DB with a valid spotify_id
  const artistsToFetch = (db.prepare(`
    SELECT id, spotify_id FROM artists WHERE spotify_id IS NOT NULL
  `).all() as Array<{ id: number; spotify_id: string }>)
    .filter(a => isValidSpotifyId(a.spotify_id));

  console.log(`\nPhase 3: fetching metadata for ${artistsToFetch.length.toLocaleString()} artists (${Math.ceil(artistsToFetch.length / 50)} API calls)…`);

  let artistBatch = 0;
  for (const chunk of chunks(artistsToFetch, 50)) {
    const token = await tokenManager.getValidAccessToken();
    const ids = chunk.map(a => a.spotify_id).join(',');
    let artists: (SpotifyArtistFull | null)[];
    try {
      ({ artists } = await spotifyGet<{ artists: (SpotifyArtistFull | null)[] }>(
        `https://api.spotify.com/v1/artists?ids=${ids}`,
        token
      ));
    } catch {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    db.transaction(() => {
      for (const sp of artists) {
        if (!sp) continue;
        updateArtistMeta.run(
          bestImage(sp.images),
          JSON.stringify(sp.genres ?? []),
          sp.id
        );
      }
    })();

    artistBatch++;
    if (artistBatch % 10 === 0 || artistBatch === Math.ceil(artistsToFetch.length / 50)) {
      process.stdout.write(`  batch ${artistBatch}/${Math.ceil(artistsToFetch.length / 50)}\r`);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  Phase 3 done.`);
  } // end phase 3

  // ── Summary ───────────────────────────────────────────────────────────────

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM artists WHERE spotify_id IS NOT NULL) as artists_with_id,
      (SELECT COUNT(*) FROM artists WHERE image_url IS NOT NULL) as artists_with_image,
      (SELECT COUNT(*) FROM artists WHERE genres != '[]' AND genres IS NOT NULL) as artists_with_genres,
      (SELECT COUNT(*) FROM albums WHERE spotify_id IS NOT NULL) as albums_with_id,
      (SELECT COUNT(*) FROM albums WHERE image_url IS NOT NULL) as albums_with_image,
      (SELECT COUNT(*) FROM albums WHERE release_date IS NOT NULL) as albums_with_date,
      (SELECT COUNT(*) FROM tracks WHERE spotify_id IS NOT NULL) as tracks_with_id,
      (SELECT COUNT(*) FROM tracks WHERE track_number > 0) as tracks_with_number,
      (SELECT COUNT(*) FROM tracks WHERE disc_number > 0) as tracks_with_disc
  `).get() as Record<string, number>;

  console.log('\n── Final stats ──────────────────────────────────────────');
  console.log(`Artists  with Spotify ID:  ${stats.artists_with_id.toLocaleString()}`);
  console.log(`Artists  with image:       ${stats.artists_with_image.toLocaleString()}`);
  console.log(`Artists  with genres:      ${stats.artists_with_genres.toLocaleString()}`);
  console.log(`Albums   with Spotify ID:  ${stats.albums_with_id.toLocaleString()}`);
  console.log(`Albums   with image:       ${stats.albums_with_image.toLocaleString()}`);
  console.log(`Albums   with release date:${stats.albums_with_date.toLocaleString()}`);
  console.log(`Tracks   with Spotify ID:  ${stats.tracks_with_id.toLocaleString()}`);
  console.log(`Tracks   with track_number:${stats.tracks_with_number.toLocaleString()}`);
  console.log(`Tracks   with disc_number: ${stats.tracks_with_disc.toLocaleString()}`);

  db.close();
  console.log('\nDone. Run `npm run db:sync-turso` to push to production.');
}

main().catch(err => { console.error(err); process.exit(1); });
