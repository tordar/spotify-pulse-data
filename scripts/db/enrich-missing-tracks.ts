/**
 * Enriches local-only catalog tracks with Spotify IDs by fetching full album
 * track listings from Spotify. Covers two cases:
 *
 *   1. Mixed albums — some tracks have listening history (and thus a spotify_id),
 *      some are local-only. The album spotify_id may be stale, so we search as
 *      a fallback.
 *   2. Fully-catalog albums — all tracks are local-only with no listening
 *      history. We search Spotify by album name + artist and enrich everything.
 *
 * Usage: npm run db:enrich-missing-tracks
 * Requires: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load both .env and .env.local so Spotify credentials are available
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') });

import Database from 'better-sqlite3';
import { SpotifyTokenManager } from '../spotify-token-manager';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');

/** Strip version/edition suffixes before comparing track names. */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    // curly quotes → straight
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // remove parenthetical/dash suffixes like:
    //   "- Remastered 2009", "(Remastered)", "- Live", "(Bonus Track)",
    //   "- Deluxe Edition", "[2023 Mix]", "- Radio Edit"
    .replace(/\s*[-–([].*?(remaster|remast|reissue|live|bonus|deluxe|anniversary|edition|mix|edit|version|mono|stereo|single|extended|instrumental|acoustic|demo|alternate|alt\.|original\s+mix|radio|club|explicit|clean|feat\.|ft\.).*$/i, '')
    // strip remaining brackets/parens and their contents
    .replace(/\s*[\[(][^\])]*/g, '')
    // strip non-alphanumeric (except spaces and apostrophes)
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  track_number: number;
  disc_number: number;
}

interface SpotifyAlbumTracksResponse {
  items: SpotifyTrack[];
  next: string | null;
  total: number;
}

async function spotifyGet<T>(url: string, token: string): Promise<T> {
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('Retry-After') ?? '5');
      await new Promise(r => setTimeout(r, retry * 1000));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`Spotify ${res.status}`), { status: res.status });
    return res.json() as Promise<T>;
  }
}

async function fetchAllAlbumTracks(albumSpotifyId: string, token: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url: string | null = `https://api.spotify.com/v1/albums/${albumSpotifyId}/tracks?limit=50`;
  while (url) {
    const data = await spotifyGet<SpotifyAlbumTracksResponse>(url, token);
    tracks.push(...data.items);
    url = data.next;
  }
  return tracks;
}

/** Search Spotify for an album by name + artist, returning the best-match album ID. */
async function searchForAlbumId(
  albumName: string,
  artistName: string,
  token: string
): Promise<string | null> {
  const q = encodeURIComponent(`album:"${albumName}" artist:"${artistName}"`);
  const url = `https://api.spotify.com/v1/search?q=${q}&type=album&limit=10`;
  const data = await spotifyGet<{
    albums: { items: Array<{ id: string; name: string; artists: Array<{ name: string }> }> }
  }>(url, token);

  const normAlbum = normalizeTitle(albumName);
  const normArtist = normalizeTitle(artistName);

  // Exact album + exact artist
  for (const item of data.albums.items) {
    if (
      normalizeTitle(item.name) === normAlbum &&
      item.artists.some(a => normalizeTitle(a.name) === normArtist)
    ) return item.id;
  }

  // Normalised album prefix (handles "(Deluxe Edition)" etc. in Spotify name)
  for (const item of data.albums.items) {
    if (
      normalizeTitle(item.name).startsWith(normAlbum) &&
      item.artists.some(a => normalizeTitle(a.name) === normArtist)
    ) return item.id;
  }

  return null;
}

/** Match a catalog track name against a list of Spotify tracks. Returns best match or null. */
function matchTrack(
  catalogName: string,
  catalogDurationMs: number,
  spotifyTracks: SpotifyTrack[],
  usedIds: Set<string>
): SpotifyTrack | null {
  const normCatalog = normalizeTitle(catalogName);

  let best: SpotifyTrack | null = null;
  let bestScore = 0;

  for (const st of spotifyTracks) {
    if (usedIds.has(st.id)) continue;
    const normSpotify = normalizeTitle(st.name);

    let score = 0;
    if (normSpotify === normCatalog) {
      score = 4; // exact after normalisation
    } else if (normSpotify.startsWith(normCatalog) || normCatalog.startsWith(normSpotify)) {
      score = 3; // prefix
    } else if (normSpotify.includes(normCatalog) || normCatalog.includes(normSpotify)) {
      score = 2; // substring
    }

    // Bonus for duration match within 3 s
    if (score > 0 && catalogDurationMs > 0) {
      if (Math.abs(st.duration_ms - catalogDurationMs) < 3000) score += 1;
    }

    if (score > bestScore) { bestScore = score; best = st; }
  }

  return bestScore >= 3 ? best : null;
}

async function processAlbum(
  album: { albumId: number; albumName: string; artistName: string; albumSpotifyId: string | null },
  token: string,
  db: Database.Database,
  updateTrack: Database.Statement,
  updateAlbumSpotifyId: Database.Statement,
  getBySpotifyId: Database.Statement<[string]>,
): Promise<{ enriched: number; refreshedId: boolean }> {
  // Catalog tracks for this album
  const catalogTracks = db.prepare(`
    SELECT t.id, t.name, t.duration_ms
    FROM tracks t
    WHERE t.album_id = ?
      AND t.spotify_id IS NULL
      AND t.local_file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
  `).all(album.albumId) as Array<{ id: number; name: string; duration_ms: number }>;

  if (catalogTracks.length === 0) return { enriched: 0, refreshedId: false };

  let resolvedAlbumId = album.albumSpotifyId;
  let spotifyTracks: SpotifyTrack[];

  const tryFetch = async (id: string) => fetchAllAlbumTracks(id, token);
  const trySearch = async () => searchForAlbumId(album.albumName, album.artistName, token);

  if (resolvedAlbumId) {
    try {
      spotifyTracks = await tryFetch(resolvedAlbumId);
    } catch (err: unknown) {
      if ((err as { status?: number }).status !== 404) throw err;
      const found = await trySearch();
      if (!found) return { enriched: 0, refreshedId: false };
      resolvedAlbumId = found;
      spotifyTracks = await tryFetch(resolvedAlbumId);
    }
  } else {
    // Fully-catalog album: must search
    const found = await trySearch();
    if (!found) return { enriched: 0, refreshedId: false };
    resolvedAlbumId = found;
    spotifyTracks = await tryFetch(resolvedAlbumId);
  }

  await new Promise(r => setTimeout(r, 120));

  let enriched = 0;
  const usedIds = new Set<string>();

  db.transaction(() => {
    for (const catalog of catalogTracks) {
      const match = matchTrack(catalog.name, catalog.duration_ms, spotifyTracks, usedIds);
      if (!match) continue;

      const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(match.id);
      if (existing && existing.id !== catalog.id) continue; // already assigned elsewhere

      usedIds.add(match.id);
      updateTrack.run(match.id, match.duration_ms, match.track_number, match.disc_number, catalog.id);
      enriched++;
    }
  })();

  const refreshedId = resolvedAlbumId !== album.albumSpotifyId;
  if (resolvedAlbumId && refreshedId) {
    updateAlbumSpotifyId.run(resolvedAlbumId, album.albumId);
  } else if (!album.albumSpotifyId && resolvedAlbumId) {
    // Newly discovered album ID for a fully-catalog album
    updateAlbumSpotifyId.run(resolvedAlbumId, album.albumId);
  }

  return { enriched, refreshedId };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // --- 1. Mixed albums (some listened, some local-only) ----------------------
  const mixedAlbums = db.prepare(`
    SELECT
      al.id as albumId,
      al.name as albumName,
      al.artist_name as artistName,
      al.spotify_id as albumSpotifyId,
      COUNT(CASE WHEN t.spotify_id IS NOT NULL THEN 1 END) as trackedCount,
      COUNT(CASE WHEN t.spotify_id IS NULL
                  AND t.local_file_path IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
               THEN 1 END) as catalogCount
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    WHERE al.spotify_id IS NOT NULL
    GROUP BY al.id
    HAVING trackedCount > 0 AND catalogCount > 0
    ORDER BY catalogCount DESC
  `).all() as Array<{
    albumId: number; albumName: string; artistName: string;
    albumSpotifyId: string; trackedCount: number; catalogCount: number;
  }>;

  // --- 2. Fully-catalog albums (local files, zero listening history) ----------
  const fullyCatalogAlbums = db.prepare(`
    SELECT
      al.id as albumId,
      al.name as albumName,
      al.artist_name as artistName,
      al.spotify_id as albumSpotifyId,
      0 as trackedCount,
      COUNT(*) as catalogCount
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    WHERE t.local_file_path IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM tracks t2
        JOIN listening_events le ON le.track_id = t2.id
        WHERE t2.album_id = al.id
      )
    GROUP BY al.id
    ORDER BY catalogCount DESC
  `).all() as Array<{
    albumId: number; albumName: string; artistName: string;
    albumSpotifyId: string | null; trackedCount: number; catalogCount: number;
  }>;

  const allAlbums = [...mixedAlbums, ...fullyCatalogAlbums];
  console.log(`Mixed albums to process:          ${mixedAlbums.length}`);
  console.log(`Fully-catalog albums to process:  ${fullyCatalogAlbums.length}`);
  console.log(`Total:                            ${allAlbums.length}\n`);

  if (allAlbums.length === 0) { db.close(); return; }

  const tokenManager = new SpotifyTokenManager();

  const updateAlbumSpotifyId = db.prepare(
    `UPDATE albums SET spotify_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updateTrack = db.prepare(`
    UPDATE tracks
    SET spotify_id = ?, duration_ms = ?, track_number = ?, disc_number = ?,
        download_status = 'downloaded', updated_at = datetime('now')
    WHERE id = ?
  `);
  const getBySpotifyId = db.prepare(
    `SELECT id FROM tracks WHERE spotify_id = ? LIMIT 1`
  );

  let totalEnriched = 0;
  let totalAlbumsProcessed = 0;
  let noResult = 0;

  for (const album of allAlbums) {
    const token = await tokenManager.getValidAccessToken();
    try {
      const { enriched, refreshedId } = await processAlbum(
        album, token, db, updateTrack, updateAlbumSpotifyId, getBySpotifyId
      );
      if (enriched > 0) {
        const tag = refreshedId || !album.albumSpotifyId ? ' (found via search)' : '';
        console.log(`  ✓ ${album.artistName} — ${album.albumName}: +${enriched}/${album.catalogCount}${tag}`);
        totalEnriched += enriched;
        totalAlbumsProcessed++;
      }
    } catch (err) {
      noResult++;
      // Silence "no search result" noise for fully-catalog albums — expected for many
      if (String(err).includes('404')) {
        // already tried search inside processAlbum; if it throws it's a real error
        console.error(`  ✗ ${album.artistName} — ${album.albumName}: ${err}`);
      }
    }
  }

  console.log(`\nEnriched ${totalEnriched} tracks across ${totalAlbumsProcessed} albums`);
  console.log(`Albums with no Spotify match: ~${noResult + (allAlbums.length - totalAlbumsProcessed - noResult)}`);

  const breakdown = db.prepare(
    `SELECT download_status, COUNT(*) as c FROM tracks GROUP BY download_status`
  ).all() as { download_status: string; c: number }[];
  console.log('\nDownload status breakdown:');
  for (const r of breakdown) console.log(`  ${r.download_status}: ${r.c.toLocaleString()}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
