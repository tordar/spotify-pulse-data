import * as fs from 'fs';
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
import { getD1Client, type D1Client } from './d1-client';
import 'dotenv/config';

const LB_BASE = 'https://api.listenbrainz.org/1';
const PAGE_SIZE = 100;

type ListenSource = 'spotify' | 'navidrome'

function detectSource(listen: LBListen): ListenSource {
  const info = listen.track_metadata.additional_info ?? {}
  const raw = [info.music_service, info.music_service_name, info.submission_client]
    .filter(Boolean).join(' ').toLowerCase()
  return raw.includes('navidrome') ? 'navidrome' : 'spotify'
}

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
      submission_client?: string;
      music_service?: string;
      music_service_name?: string;
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

/** True when running in CI (GitHub Actions) where library.db does not exist. */
function isCiMode(): boolean {
  return !fs.existsSync(path.join(__dirname, '..', '..', 'data', 'library.db'));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchPage(username: string, token?: string, maxTs?: number): Promise<LBListensResponse> {
  const params = new URLSearchParams({ count: String(PAGE_SIZE) });
  if (maxTs != null) params.set('max_ts', String(maxTs));

  const url = `${LB_BASE}/user/${encodeURIComponent(username)}/listens?${params}`;
  const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' };
  if (token) headers['Authorization'] = `Token ${token}`;

  const resp = await fetch(url, { headers });

  if (!resp.ok) {
    throw new Error(`ListenBrainz API error: ${resp.status} ${await resp.text()}`);
  }

  return resp.json() as Promise<LBListensResponse>;
}

async function getCutoffFromD1(d1: D1Client): Promise<number> {
  const { rows } = await d1.execute(
    `SELECT source_identifier FROM import_log WHERE source = 'listenbrainz' ORDER BY imported_at DESC LIMIT 1`
  );
  if (rows[0]?.source_identifier) return parseInt(rows[0].source_identifier as string, 10);

  const { rows: evRows } = await d1.execute(
    `SELECT MAX(played_at) as latest FROM listening_events`
  );
  if (evRows[0]?.latest) {
    return Math.floor(new Date(evRows[0].latest as string).getTime() / 1000);
  }

  return 0;
}

function getCutoffFromSqlite(db: Database.Database): number {
  const lbRow = db.prepare(`
    SELECT source_identifier FROM import_log
    WHERE source = 'listenbrainz'
    ORDER BY imported_at DESC LIMIT 1
  `).get() as { source_identifier: string } | undefined;

  if (lbRow) return parseInt(lbRow.source_identifier, 10);

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
): number | null {
  const exact = db.prepare(`
    SELECT t.id FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    WHERE a.name = ? COLLATE NOCASE AND t.name = ? COLLATE NOCASE
    LIMIT 1
  `).get(artistName, trackName) as { id: number } | undefined;

  if (exact) return exact.id;

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

async function syncListensToD1(d1: D1Client, listens: LBListen[]): Promise<void> {
  let latestTs = 0;

  for (const listen of listens) {
    const meta = listen.track_metadata;
    const artistName = meta.artist_name;
    const trackName = meta.track_name;
    const albumName = meta.release_name || 'Unknown Album';
    const playedAt = new Date(listen.listened_at * 1000).toISOString();
    const durationMs = meta.additional_info?.duration_ms ?? 0;

    const artistResult = await d1.execute({
      sql: `INSERT INTO artists (name, genres) VALUES (?, '[]')
            ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')
            RETURNING id`,
      args: [artistName],
    });
    const artistId = Number(artistResult.rows[0]?.id);

    const albumResult = await d1.execute({
      sql: `INSERT INTO albums (name, artist_name) VALUES (?, ?)
            ON CONFLICT(name, artist_name) DO UPDATE SET updated_at = datetime('now')
            RETURNING id`,
      args: [albumName, artistName],
    });
    const albumId = Number(albumResult.rows[0]?.id);

    const existingTrack = await d1.execute({
      sql: `SELECT id FROM tracks WHERE name = ? AND artist_id = ? LIMIT 1`,
      args: [trackName, artistId],
    });

    let trackId = Number(existingTrack.rows[0]?.id) || 0;
    if (!trackId) {
      const inserted = await d1.execute({
        sql: `INSERT INTO tracks (name, album_id, artist_id, duration_ms) VALUES (?, ?, ?, ?) RETURNING id`,
        args: [trackName, albumId, artistId, durationMs],
      });
      trackId = Number(inserted.rows[0]?.id);
    }

    if (!trackId) continue;

    const source = detectSource(listen);
    await d1.execute({
      sql: `INSERT OR IGNORE INTO listening_events (track_id, played_at, ms_played, source)
            VALUES (?, ?, ?, ?)`,
      args: [trackId, playedAt, durationMs, source],
    });

    if (listen.listened_at > latestTs) latestTs = listen.listened_at;
  }

  if (latestTs > 0) {
    await d1.execute({
      sql: `INSERT INTO import_log (source, source_identifier, event_count) VALUES ('listenbrainz', ?, ?)`,
      args: [String(latestTs), listens.length],
    });
  }

  console.log(`D1 sync complete. ${listens.length} listens written.`);
}

async function fetchListenBrainz(username?: string): Promise<void> {
  const lbUser = username || process.env.LISTENBRAINZ_USERNAME;
  if (!lbUser) {
    console.error('Usage: tsx scripts/db/fetch-listenbrainz.ts <username>');
    console.error('  Or set LISTENBRAINZ_USERNAME in .env');
    process.exit(1);
  }

  const token = process.env.LISTENBRAINZ_TOKEN;
  const ci = isCiMode();

  let minTs: number;
  let d1: D1Client | null = null;
  let db: Database.Database | null = null;

  if (ci) {
    console.log('[CI mode] No local library.db — writing to D1 only');
    d1 = getD1Client();
    minTs = await getCutoffFromD1(d1);
  } else {
    db = getDatabase();
    minTs = getCutoffFromSqlite(db);
  }

  console.log(`Fetching listens for user "${lbUser}" since ${minTs > 0 ? new Date(minTs * 1000).toISOString() : 'the beginning'}...`);

  let allListens: LBListen[] = [];
  let maxTs: number | undefined;
  let page = 0;

  while (true) {
    const data = await fetchPage(lbUser, token, maxTs);
    const listens = data.payload.listens;
    page++;

    if (listens.length === 0) break;

    const newListens = minTs > 0
      ? listens.filter(l => l.listened_at > minTs)
      : listens;

    allListens.push(...newListens);
    console.log(`  Page ${page}: ${listens.length} fetched, ${newListens.length} new (total so far: ${allListens.length})`);

    if (newListens.length < listens.length) break;
    if (listens.length < PAGE_SIZE) break;

    maxTs = listens[listens.length - 1].listened_at;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (allListens.length === 0) {
    console.log('No new listens found.');
    if (db) closeDatabase();
    return;
  }

  // Sort oldest first
  allListens.sort((a, b) => a.listened_at - b.listened_at);

  if (ci && d1) {
    await syncListensToD1(d1, allListens);
    return;
  }

  // Local SQLite path
  if (!db) return;

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

      let trackId = findTrackInDb(db!, artistName, trackName);

      if (trackId) {
        matched++;
      } else {
        const artistId = upsertArtist(db!, artistName);
        const albumId = upsertAlbum(db!, albumName || 'Unknown Album', artistName);
        trackId = upsertTrack(db!, {
          name: trackName,
          albumId,
          artistId,
          durationMs: meta.additional_info?.duration_ms || 0,
          trackNumber: meta.additional_info?.tracknumber ?? null,
        });
        db!.prepare(
          `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
        ).run(trackId, artistId);
        created++;
      }

      const source = detectSource(listen);
      const alreadyExists = db!.prepare(
        `SELECT 1 FROM listening_events WHERE track_id = ? AND played_at = ? LIMIT 1`
      ).get(trackId, playedAt);

      if (!alreadyExists) {
        let msPlayed = meta.additional_info?.duration_ms;
        if (!msPlayed) {
          const track = db!.prepare(`SELECT duration_ms FROM tracks WHERE id = ?`).get(trackId) as { duration_ms: number } | undefined;
          msPlayed = track?.duration_ms || 0;
        }
        insertListeningEvent(db!, trackId, playedAt, msPlayed, source);
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
