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
 * Usage:
 *   npm run db:enrich-missing-tracks              # automatic only
 *   npm run db:enrich-missing-tracks -- -i        # automatic + interactive
 *
 * Requires: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') });

import Database from 'better-sqlite3';
import { SpotifyTokenManager } from '../spotify-token-manager';
import { queryBeetsLibrary } from './beets-lookup';
import {
  searchMusicBrainzRelease,
  getSpotifyIdFromRelease,
} from '../cleaner/utils/musicbrainz-api-client';

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

interface CatalogTrack {
  id: number;
  name: string;
  duration_ms: number;
}

interface SpotifyAlbumTracksResponse {
  items: SpotifyTrack[];
  next: string | null;
  total: number;
}

interface AlbumInfo {
  albumId: number;
  albumName: string;
  artistName: string;
  albumSpotifyId: string | null;
  catalogCount: number;
}

interface UnmatchedData {
  localTracks: CatalogTrack[];
  spotifyTracks: SpotifyTrack[];
  resolvedAlbumId: string | null;
}

interface ProcessResult {
  enriched: number;
  refreshedId: boolean;
  unmatched: UnmatchedData | null;
  noSpotifyMatch: boolean;
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
    const data: SpotifyAlbumTracksResponse = await spotifyGet<SpotifyAlbumTracksResponse>(url, token);
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
  album: AlbumInfo,
  token: string,
  db: Database.Database,
  updateTrack: Database.Statement,
  updateAlbumSpotifyId: Database.Statement,
  getBySpotifyId: Database.Statement<[string]>,
): Promise<ProcessResult> {
  const catalogTracks = db.prepare(`
    SELECT t.id, t.name, t.duration_ms
    FROM tracks t
    WHERE t.album_id = ?
      AND t.spotify_id IS NULL
      AND t.local_file_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
  `).all(album.albumId) as CatalogTrack[];

  if (catalogTracks.length === 0) {
    return { enriched: 0, refreshedId: false, unmatched: null, noSpotifyMatch: false };
  }

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
      if (!found) {
        return {
          enriched: 0, refreshedId: false, noSpotifyMatch: true,
          unmatched: { localTracks: catalogTracks, spotifyTracks: [], resolvedAlbumId: null },
        };
      }
      resolvedAlbumId = found;
      spotifyTracks = await tryFetch(resolvedAlbumId);
    }
  } else {
    const found = await trySearch();
    if (!found) {
      return {
        enriched: 0, refreshedId: false, noSpotifyMatch: true,
        unmatched: { localTracks: catalogTracks, spotifyTracks: [], resolvedAlbumId: null },
      };
    }
    resolvedAlbumId = found;
    spotifyTracks = await tryFetch(resolvedAlbumId);
  }

  await new Promise(r => setTimeout(r, 120));

  let enriched = 0;
  const usedIds = new Set<string>();
  const matchedLocalIds = new Set<number>();

  db.transaction(() => {
    for (const catalog of catalogTracks) {
      const match = matchTrack(catalog.name, catalog.duration_ms, spotifyTracks, usedIds);
      if (!match) continue;

      const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(match.id);
      if (existing && existing.id !== catalog.id) continue;

      usedIds.add(match.id);
      matchedLocalIds.add(catalog.id);
      updateTrack.run(match.id, match.duration_ms, match.track_number, match.disc_number, catalog.id);
      enriched++;
    }

    // "Last remaining" auto-match: 1 unmatched local + 1 unmatched Spotify
    const remainingLocal = catalogTracks.filter(t => !matchedLocalIds.has(t.id));
    const remainingSpotify = spotifyTracks.filter(t => !usedIds.has(t.id));
    if (remainingLocal.length === 1 && remainingSpotify.length === 1) {
      const local = remainingLocal[0];
      const sp = remainingSpotify[0];
      const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(sp.id);
      if (!existing || existing.id === local.id) {
        usedIds.add(sp.id);
        matchedLocalIds.add(local.id);
        updateTrack.run(sp.id, sp.duration_ms, sp.track_number, sp.disc_number, local.id);
        enriched++;
      }
    }
  })();

  const refreshedId = resolvedAlbumId !== album.albumSpotifyId;
  if (resolvedAlbumId && (refreshedId || !album.albumSpotifyId)) {
    updateAlbumSpotifyId.run(resolvedAlbumId, album.albumId);
  }

  const unmatchedLocal = catalogTracks.filter(t => !matchedLocalIds.has(t.id));
  const unmatchedSpotify = spotifyTracks.filter(t => !usedIds.has(t.id));

  return {
    enriched,
    refreshedId,
    noSpotifyMatch: false,
    unmatched: unmatchedLocal.length > 0
      ? { localTracks: unmatchedLocal, spotifyTracks: unmatchedSpotify, resolvedAlbumId }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Interactive CLI helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '?:??';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

const LABELS = 'abcdefghijklmnopqrstuvwxyz';

async function runInteractiveMode(
  unmatchedAlbums: Array<{ album: AlbumInfo; unmatched: UnmatchedData }>,
  db: Database.Database,
  updateTrack: Database.Statement,
  getBySpotifyId: Database.Statement<[string]>,
): Promise<number> {
  if (unmatchedAlbums.length === 0) {
    console.log('\nNo unmatched tracks remaining for interactive matching.');
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let totalMatched = 0;

  console.log(`\n━━━ Interactive matching: ${unmatchedAlbums.length} albums with unmatched tracks ━━━\n`);

  for (const { album, unmatched } of unmatchedAlbums) {
    const { localTracks, spotifyTracks } = unmatched;

    console.log(`━━━ ${album.artistName} — ${album.albumName} (${localTracks.length} unmatched) ━━━\n`);

    if (spotifyTracks.length === 0) {
      console.log('  No Spotify tracks available to match against.\n');
      continue;
    }

    console.log('  Unmatched local tracks:');
    localTracks.forEach((t, i) => {
      console.log(`    ${i + 1}. ${t.name} (${formatDuration(t.duration_ms)})`);
    });

    console.log('\n  Available Spotify tracks:');
    spotifyTracks.forEach((t, i) => {
      const label = i < LABELS.length ? LABELS[i] : String(i);
      console.log(`    ${label}. ${t.name} (${formatDuration(t.duration_ms)})`);
    });

    console.log('\n  Enter pairs (e.g. "1a 2b 3c"), [s]kip album, or [q]uit');
    const answer = (await ask(rl, '  > ')).trim().toLowerCase();

    if (answer === 'q') {
      console.log('\nQuitting interactive mode.');
      break;
    }
    if (answer === 's' || answer === '') {
      console.log('  Skipped.\n');
      continue;
    }

    const pairRegex = /(\d+)([a-z])/g;
    let pairMatch: RegExpExecArray | null;
    let albumMatched = 0;

    db.transaction(() => {
      while ((pairMatch = pairRegex.exec(answer)) !== null) {
        const localIdx = parseInt(pairMatch[1]) - 1;
        const spotifyIdx = LABELS.indexOf(pairMatch[2]);

        if (localIdx < 0 || localIdx >= localTracks.length) {
          console.log(`    ⚠ Invalid local track number: ${pairMatch[1]}`);
          continue;
        }
        if (spotifyIdx < 0 || spotifyIdx >= spotifyTracks.length) {
          console.log(`    ⚠ Invalid Spotify track letter: ${pairMatch[2]}`);
          continue;
        }

        const local = localTracks[localIdx];
        const sp = spotifyTracks[spotifyIdx];

        const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(sp.id);
        if (existing && existing.id !== local.id) {
          console.log(`    ⚠ Spotify track "${sp.name}" already assigned to another track`);
          continue;
        }

        updateTrack.run(sp.id, sp.duration_ms, sp.track_number, sp.disc_number, local.id);
        console.log(`    ✓ ${local.name} → ${sp.name}`);
        albumMatched++;
      }
    })();

    totalMatched += albumMatched;
    console.log(albumMatched > 0 ? `  Matched ${albumMatched} track(s).\n` : '  No valid pairs entered.\n');
  }

  rl.close();
  return totalMatched;
}

// ---------------------------------------------------------------------------
// Beets / MusicBrainz fallback: try to discover Spotify album IDs for albums
// that Spotify search couldn't find, using beets DB → MusicBrainz → Spotify.
// ---------------------------------------------------------------------------

async function runBeetsMbFallback(
  entries: Array<{ album: AlbumInfo; unmatched: UnmatchedData }>,
  tokenManager: SpotifyTokenManager,
  db: Database.Database,
  updateTrack: Database.Statement,
  updateAlbumSpotifyId: Database.Statement,
  getBySpotifyId: Database.Statement<[string]>,
): Promise<number> {
  let totalEnriched = 0;

  for (const entry of entries) {
    const { album } = entry;

    // 1. Try beets DB
    const beetsResult = queryBeetsLibrary(album.albumName, album.artistName);
    let mbReleaseId = beetsResult?.mbAlbumId ?? null;

    // 2. Try MusicBrainz search if beets didn't have it
    if (!mbReleaseId) {
      try {
        mbReleaseId = await searchMusicBrainzRelease(album.albumName, album.artistName);
      } catch { /* rate limit or network error — skip */ }
    }

    if (!mbReleaseId) continue;

    // 3. Get Spotify album ID from MB release URL relationships
    let spotifyAlbumId: string | null = null;
    try {
      spotifyAlbumId = await getSpotifyIdFromRelease(mbReleaseId);
    } catch { /* skip */ }

    if (!spotifyAlbumId) continue;

    // 4. Fetch Spotify tracks and run automatic matching
    try {
      const token = await tokenManager.getValidAccessToken();
      const spotifyTracks = await fetchAllAlbumTracks(spotifyAlbumId, token);

      const usedIds = new Set<string>();
      const matchedLocalIds = new Set<number>();

      db.transaction(() => {
        for (const local of entry.unmatched.localTracks) {
          const m = matchTrack(local.name, local.duration_ms, spotifyTracks, usedIds);
          if (!m) continue;
          const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(m.id);
          if (existing && existing.id !== local.id) continue;
          usedIds.add(m.id);
          matchedLocalIds.add(local.id);
          updateTrack.run(m.id, m.duration_ms, m.track_number, m.disc_number, local.id);
        }

        // Last remaining
        const rl = entry.unmatched.localTracks.filter(t => !matchedLocalIds.has(t.id));
        const rs = spotifyTracks.filter(t => !usedIds.has(t.id));
        if (rl.length === 1 && rs.length === 1) {
          const existing = (getBySpotifyId as Database.Statement<[string], { id: number }>).get(rs[0].id);
          if (!existing || existing.id === rl[0].id) {
            usedIds.add(rs[0].id);
            matchedLocalIds.add(rl[0].id);
            updateTrack.run(rs[0].id, rs[0].duration_ms, rs[0].track_number, rs[0].disc_number, rl[0].id);
          }
        }
      })();

      updateAlbumSpotifyId.run(spotifyAlbumId, album.albumId);

      const matched = matchedLocalIds.size;
      totalEnriched += matched;

      // Update unmatched lists for interactive phase
      entry.unmatched.localTracks = entry.unmatched.localTracks.filter(t => !matchedLocalIds.has(t.id));
      entry.unmatched.spotifyTracks = spotifyTracks.filter(t => !usedIds.has(t.id));
      entry.unmatched.resolvedAlbumId = spotifyAlbumId;

      if (matched > 0) {
        console.log(`  ✓ ${album.artistName} — ${album.albumName}: +${matched} (via beets/MusicBrainz)`);
      }
    } catch { /* fetch error — skip */ }
  }

  return totalEnriched;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const interactive = process.argv.includes('-i') || process.argv.includes('--interactive');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`library.db not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
  `).all() as Array<AlbumInfo & { trackedCount: number }>;

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
      AND (t.spotify_id IS NULL OR t.spotify_id = '')
      AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
      AND NOT EXISTS (
        SELECT 1 FROM tracks t2
        JOIN listening_events le ON le.track_id = t2.id
        WHERE t2.album_id = al.id
      )
    GROUP BY al.id
    HAVING catalogCount > 0
    ORDER BY catalogCount DESC
  `).all() as Array<AlbumInfo & { trackedCount: number }>;

  const allAlbums: AlbumInfo[] = [...mixedAlbums, ...fullyCatalogAlbums];
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
  const unmatchedAlbums: Array<{ album: AlbumInfo; unmatched: UnmatchedData }> = [];

  // --- Phase 1: Automatic matching ------------------------------------------

  for (const album of allAlbums) {
    const token = await tokenManager.getValidAccessToken();
    try {
      const result = await processAlbum(
        album, token, db, updateTrack, updateAlbumSpotifyId, getBySpotifyId
      );
      if (result.enriched > 0) {
        const tag = result.refreshedId || !album.albumSpotifyId ? ' (found via search)' : '';
        console.log(`  ✓ ${album.artistName} — ${album.albumName}: +${result.enriched}/${album.catalogCount}${tag}`);
        totalEnriched += result.enriched;
        totalAlbumsProcessed++;
      }
      if (result.unmatched) {
        unmatchedAlbums.push({ album, unmatched: result.unmatched });
      }
    } catch (err) {
      noResult++;
      if (String(err).includes('404')) {
        console.error(`  ✗ ${album.artistName} — ${album.albumName}: ${err}`);
      }
    }
  }

  console.log(`\nPhase 1 (automatic): enriched ${totalEnriched} tracks across ${totalAlbumsProcessed} albums`);
  console.log(`Albums with no Spotify match: ~${noResult + (allAlbums.length - totalAlbumsProcessed - noResult)}`);
  if (unmatchedAlbums.length > 0) {
    const unmatchedTrackCount = unmatchedAlbums.reduce((s, a) => s + a.unmatched.localTracks.length, 0);
    console.log(`Albums with remaining unmatched tracks: ${unmatchedAlbums.length} (${unmatchedTrackCount} tracks)`);
  }

  // --- Phase 2 (interactive mode only): Beets/MB fallback + manual matching --

  if (interactive) {
    const albumsNeedingFallback = unmatchedAlbums.filter(a => a.unmatched.spotifyTracks.length === 0);

    if (albumsNeedingFallback.length > 0) {
      console.log(`\nAttempting beets/MusicBrainz fallback for ${albumsNeedingFallback.length} albums…`);
      const fallbackEnriched = await runBeetsMbFallback(
        albumsNeedingFallback, tokenManager, db, updateTrack, updateAlbumSpotifyId, getBySpotifyId
      );
      totalEnriched += fallbackEnriched;
    }

    const stillUnmatched = unmatchedAlbums.filter(a => a.unmatched.localTracks.length > 0);
    const interactiveMatched = await runInteractiveMode(stillUnmatched, db, updateTrack, getBySpotifyId);
    totalEnriched += interactiveMatched;
  }

  // --- Summary ---------------------------------------------------------------

  console.log(`\nTotal enriched: ${totalEnriched} tracks`);

  const breakdown = db.prepare(
    `SELECT download_status, COUNT(*) as c FROM tracks GROUP BY download_status`
  ).all() as { download_status: string; c: number }[];
  console.log('\nDownload status breakdown:');
  for (const r of breakdown) console.log(`  ${r.download_status}: ${r.c.toLocaleString()}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
