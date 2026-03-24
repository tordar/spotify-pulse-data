/**
 * pull-from-d1.ts
 *
 * Pulls listening events that were added to Cloudflare D1 (by GitHub Actions)
 * and inserts them into the local library.db.
 *
 * Run this before any local enrichment work so your local db is up to date,
 * and before running db:sync-d1 so those plays don't get wiped out.
 *
 * Usage: npm run db:pull-from-d1
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') });
dotenv.config({ path: path.join(__dirname, '..', '..', 'web-app', '.env.local'), override: true });

import { getD1Client } from './d1-client';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
  insertListeningEvent,
} from './database';

interface RemoteEvent {
  played_at: string;
  ms_played: number;
  source: string;
  track_name: string;
  track_spotify_id: string | null;
  track_duration_ms: number;
  track_number: number | null;
  disc_number: number | null;
  artist_name: string;
  artist_spotify_id: string | null;
  album_name: string;
  album_spotify_id: string | null;
  album_image_url: string | null;
  album_release_date: string | null;
}

async function pullFromD1(): Promise<void> {
  const d1 = getD1Client();
  const db = getDatabase();

  const localLatest = db.prepare(
    `SELECT MAX(played_at) as latest FROM listening_events`
  ).get() as { latest: string | null };
  const since = localLatest.latest ?? '1970-01-01T00:00:00.000Z';
  console.log(`Local db latest event: ${since}`);

  const { rows } = await d1.execute({
    sql: `
      SELECT
        le.played_at,
        le.ms_played,
        le.source,
        t.name       as track_name,
        t.spotify_id as track_spotify_id,
        t.duration_ms as track_duration_ms,
        t.track_number,
        t.disc_number,
        a.name       as artist_name,
        a.spotify_id as artist_spotify_id,
        al.name      as album_name,
        al.spotify_id as album_spotify_id,
        al.image_url  as album_image_url,
        al.release_date as album_release_date
      FROM listening_events le
      JOIN tracks  t  ON t.id  = le.track_id
      JOIN artists a  ON a.id  = t.artist_id
      JOIN albums  al ON al.id = t.album_id
      WHERE le.played_at > ?
      ORDER BY le.played_at ASC
    `,
    args: [since],
  });

  if (rows.length === 0) {
    console.log('No new events in D1 since last local sync. Nothing to do.');
    closeDatabase();
    return;
  }

  console.log(`Found ${rows.length} new event(s) in D1 — importing into local db…`);

  const events = rows as unknown as RemoteEvent[];

  const existingEvents = new Set(
    (db.prepare(`
      SELECT t.spotify_id || '|' || le.played_at as key
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      WHERE t.spotify_id IS NOT NULL
    `).all() as Array<{ key: string }>).map(r => r.key)
  );

  let inserted = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const ev of events) {
      const dedupeKey = ev.track_spotify_id ? `${ev.track_spotify_id}|${ev.played_at}` : null;
      if (dedupeKey && existingEvents.has(dedupeKey)) {
        skipped++;
        continue;
      }

      const artistId = upsertArtist(
        db,
        ev.artist_name,
        ev.artist_spotify_id ?? undefined,
      );
      const albumId = upsertAlbum(db, ev.album_name, ev.artist_name, {
        spotifyId: ev.album_spotify_id ?? undefined,
        imageUrl: ev.album_image_url ?? undefined,
        releaseDate: ev.album_release_date ?? undefined,
      });
      const trackId = upsertTrack(db, {
        name: ev.track_name,
        albumId,
        artistId,
        durationMs: ev.track_duration_ms,
        trackNumber: ev.track_number ?? undefined,
        discNumber: ev.disc_number ?? undefined,
        spotifyId: ev.track_spotify_id ?? undefined,
      });

      insertListeningEvent(db, trackId, ev.played_at, ev.ms_played, ev.source);
      inserted++;
    }
  })();

  console.log(`Done. Inserted: ${inserted}  Skipped (already existed): ${skipped}`);
  if (inserted > 0) {
    console.log(`\nRemember to run 'npm run db:sync-d1' after any local enrichment work`);
    console.log(`to keep D1 fully up to date.`);
  }

  closeDatabase();
}

pullFromD1().catch(err => { console.error(err); process.exit(1); });
