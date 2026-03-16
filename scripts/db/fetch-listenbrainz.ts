import * as path from 'path';
import Database from 'better-sqlite3';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
  insertListeningEvent,
  logImport,
} from './database';
import 'dotenv/config';

const LB_BASE = 'https://api.listenbrainz.org/1';
const PAGE_SIZE = 100;

interface LBListen {
  listened_at: number;
  track_metadata: {
    artist_name: string;
    track_name: string;
    release_name?: string;
    additional_info?: {
      duration_ms?: number;
      recording_mbid?: string;
      release_mbid?: string;
      artist_mbids?: string[];
      tracknumber?: number;
    };
  };
}

interface LBListensResponse {
  payload: {
    count: number;
    listens: LBListen[];
    latest_listen_ts?: number;
    oldest_listen_ts?: number;
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchPage(username: string, maxTs?: number): Promise<LBListensResponse> {
  const params = new URLSearchParams({ count: String(PAGE_SIZE) });
  if (maxTs != null) params.set('max_ts', String(maxTs));

  const url = `${LB_BASE}/user/${encodeURIComponent(username)}/listens?${params}`;
  const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' };
  const token = process.env.LISTENBRAINZ_TOKEN;
  if (token) headers['Authorization'] = `Token ${token}`;

  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    throw new Error(`ListenBrainz API error: ${resp.status} ${await resp.text()}`);
  }

  return resp.json() as Promise<LBListensResponse>;
}

function getCutoffTimestamp(db: Database.Database): number {
  // First check if we've fetched from ListenBrainz before
  const lbRow = db.prepare(`
    SELECT source_identifier FROM import_log
    WHERE source = 'listenbrainz'
    ORDER BY imported_at DESC LIMIT 1
  `).get() as { source_identifier: string } | undefined;

  if (lbRow) return parseInt(lbRow.source_identifier, 10);

  // Otherwise use the latest listening event from any source,
  // so we don't re-import history that's already in the DB from Spotify
  const row = db.prepare(`
    SELECT MAX(played_at) as latest FROM listening_events
  `).get() as { latest: string | null } | undefined;

  if (row?.latest) {
    return Math.floor(new Date(row.latest).getTime() / 1000);
  }

  return 0;
}

function findTrackInDb(
  db: Database.Database,
  artistName: string,
  trackName: string,
  albumName?: string,
): number | null {
  // Exact match first
  const exact = db.prepare(`
    SELECT t.id FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    WHERE a.name = ? COLLATE NOCASE AND t.name = ? COLLATE NOCASE
    LIMIT 1
  `).get(artistName, trackName) as { id: number } | undefined;

  if (exact) return exact.id;

  // Normalized match via a targeted scan
  const normArtist = normalize(artistName);
  const normTrack = normalize(trackName);

  const candidates = db.prepare(`
    SELECT t.id, t.name, a.name as artist_name FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    WHERE a.name LIKE ? COLLATE NOCASE
  `).all(`%${artistName.substring(0, Math.min(artistName.length, 10))}%`) as Array<{
    id: number; name: string; artist_name: string;
  }>;

  for (const c of candidates) {
    if (normalize(c.artist_name) === normArtist && normalize(c.name) === normTrack) {
      return c.id;
    }
  }

  return null;
}

async function fetchListenBrainz(username?: string): Promise<void> {
  const lbUser = username || process.env.LISTENBRAINZ_USERNAME;
  if (!lbUser) {
    console.error('Usage: tsx scripts/db/fetch-listenbrainz.ts <username>');
    console.error('  Or set LISTENBRAINZ_USERNAME in .env');
    process.exit(1);
  }

  const db = getDatabase();
  const minTs = getCutoffTimestamp(db);

  console.log(`Fetching listens for user "${lbUser}" since ${minTs > 0 ? new Date(minTs * 1000).toISOString() : 'the beginning'}...`);

  let allListens: LBListen[] = [];
  let maxTs: number | undefined;
  let page = 0;
  let reachedCutoff = false;

  // Paginate backwards from newest using only max_ts
  // (ListenBrainz API forbids using min_ts and max_ts together)
  while (true) {
    const data = await fetchPage(lbUser, maxTs);
    const listens = data.payload.listens;
    page++;

    if (listens.length === 0) break;

    // Filter out listens at or before the last import timestamp
    const newListens = minTs > 0
      ? listens.filter(l => l.listened_at > minTs)
      : listens;

    allListens.push(...newListens);
    console.log(`  Page ${page}: ${listens.length} fetched, ${newListens.length} new (total so far: ${allListens.length})`);

    if (newListens.length < listens.length) {
      reachedCutoff = true;
      break;
    }

    if (listens.length < PAGE_SIZE) break;

    maxTs = listens[listens.length - 1].listened_at;

    // Rate limit courtesy
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (allListens.length === 0) {
    console.log('No new listens found.');
    closeDatabase();
    return;
  }

  // Sort oldest first
  allListens.sort((a, b) => a.listened_at - b.listened_at);

  let matched = 0;
  let created = 0;
  let latestTs = 0;

  const insertBatch = db.transaction((listens: LBListen[]) => {
    for (const listen of listens) {
      const meta = listen.track_metadata;
      const playedAt = new Date(listen.listened_at * 1000).toISOString();
      const artistName = meta.artist_name;
      const trackName = meta.track_name;
      const albumName = meta.release_name;

      let trackId = findTrackInDb(db, artistName, trackName, albumName);

      if (trackId) {
        matched++;
      } else {
        // Create new track entry
        const artistId = upsertArtist(db, artistName);
        const albumId = upsertAlbum(db, albumName || 'Unknown Album', artistName);
        trackId = upsertTrack(db, {
          name: trackName,
          albumId,
          artistId,
          durationMs: meta.additional_info?.duration_ms || 0,
          trackNumber: meta.additional_info?.tracknumber ?? null,
        });
        db.prepare(
          `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
        ).run(trackId, artistId);
        created++;
      }

      const alreadyExists = db.prepare(
        `SELECT 1 FROM listening_events WHERE track_id = ? AND played_at = ? AND source = 'listenbrainz' LIMIT 1`
      ).get(trackId, playedAt);

      if (!alreadyExists) {
        let msPlayed = meta.additional_info?.duration_ms;
        if (!msPlayed) {
          const track = db.prepare(`SELECT duration_ms FROM tracks WHERE id = ?`).get(trackId) as { duration_ms: number } | undefined;
          msPlayed = track?.duration_ms || 0;
        }
        insertListeningEvent(db, trackId, playedAt, msPlayed, 'listenbrainz');
      }

      if (listen.listened_at > latestTs) {
        latestTs = listen.listened_at;
      }
    }
  });

  const BATCH = 500;
  for (let i = 0; i < allListens.length; i += BATCH) {
    insertBatch(allListens.slice(i, i + BATCH));
  }

  logImport(db, 'listenbrainz', String(latestTs), allListens.length);

  console.log(`\nImported ${allListens.length} listens`);
  console.log(`  Matched to existing tracks: ${matched}`);
  console.log(`  Created new tracks:         ${created}`);
  console.log(`  Latest timestamp:           ${new Date(latestTs * 1000).toISOString()}`);

  closeDatabase();
}

if (require.main === module) {
  const username = process.argv[2];
  fetchListenBrainz(username).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

export { fetchListenBrainz };
