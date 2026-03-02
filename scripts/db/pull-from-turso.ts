/**
 * pull-from-turso.ts
 *
 * Pulls listening events that were added to Turso (by GitHub Actions) and
 * inserts them into the local library.db, resolving track/artist/album IDs
 * against the local database.
 *
 * Run this before any local enrichment work so your local db is up to date,
 * and before running db:sync-turso so those plays don't get wiped out.
 *
 * Usage: npm run db:pull-from-turso
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local') });

import { createClient } from '@libsql/client';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
  insertListeningEvent,
} from './database';

interface TursoEvent {
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

async function pullFromTurso(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url) {
    console.error('TURSO_DATABASE_URL not set in .env / .env.local');
    process.exit(1);
  }

  const turso = createClient({ url, authToken: token });
  const db = getDatabase();

  // Find the latest listening event already in local db
  const localLatest = db.prepare(
    `SELECT MAX(played_at) as latest FROM listening_events`
  ).get() as { latest: string | null };
  const since = localLatest.latest ?? '1970-01-01T00:00:00.000Z';
  console.log(`Local db latest event: ${since}`);

  // Fetch all events from Turso newer than that timestamp
  const { rows } = await turso.execute({
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
    console.log('No new events in Turso since last local sync. Nothing to do.');
    closeDatabase();
    return;
  }

  console.log(`Found ${rows.length} new event(s) in Turso — importing into local db…`);

  const events = rows as unknown as TursoEvent[];

  // Check for duplicates: get all (track_spotify_id, played_at) pairs already in local db
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
      // Skip if we already have this exact event
      const dedupeKey = ev.track_spotify_id ? `${ev.track_spotify_id}|${ev.played_at}` : null;
      if (dedupeKey && existingEvents.has(dedupeKey)) {
        skipped++;
        continue;
      }

      // Resolve artist / album / track against local db (creates if missing)
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
    console.log(`\nRemember to run 'npm run db:sync-turso' after any local enrichment work`);
    console.log(`to keep Turso fully up to date.`);
  }

  closeDatabase();
}

pullFromTurso().catch(err => { console.error(err); process.exit(1); });
