import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'library.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db: Database.Database | null = null;

export function getDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isNew = !fs.existsSync(dbPath);
  _db = new Database(dbPath);

  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  if (isNew) {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    _db.exec(schema);
    console.log('Database created and schema applied.');
  }

  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function runMigrations(db: Database.Database): void {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
}

// ---------------------------------------------------------------------------
// Prepared-statement helpers (lazy-initialized per db instance)
// ---------------------------------------------------------------------------

export function upsertArtist(
  db: Database.Database,
  name: string,
  spotifyId?: string | null,
  genres?: string[],
  imageUrl?: string | null,
): number {
  const existing = db.prepare(
    `SELECT id FROM artists WHERE name = ? COLLATE NOCASE`
  ).get(name) as { id: number } | undefined;

  if (existing) {
    if (spotifyId || genres || imageUrl) {
      const updates: string[] = [];
      const params: unknown[] = [];
      if (spotifyId) { updates.push('spotify_id = ?'); params.push(spotifyId); }
      if (genres && genres.length > 0) { updates.push('genres = ?'); params.push(JSON.stringify(genres)); }
      if (imageUrl) { updates.push('image_url = ?'); params.push(imageUrl); }
      updates.push("updated_at = datetime('now')");
      params.push(existing.id);
      db.prepare(`UPDATE artists SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO artists (name, spotify_id, genres, image_url) VALUES (?, ?, ?, ?)`
  ).run(name, spotifyId ?? null, JSON.stringify(genres ?? []), imageUrl ?? null);

  return result.lastInsertRowid as number;
}

export function upsertAlbum(
  db: Database.Database,
  name: string,
  artistName: string,
  opts?: {
    spotifyId?: string | null;
    releaseDate?: string | null;
    albumType?: string | null;
    imageUrl?: string | null;
    totalTracks?: number | null;
  },
): number {
  const existing = db.prepare(
    `SELECT id FROM albums WHERE name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE`
  ).get(name, artistName) as { id: number } | undefined;

  if (existing) {
    if (opts) {
      const updates: string[] = [];
      const params: unknown[] = [];
      if (opts.spotifyId) { updates.push('spotify_id = ?'); params.push(opts.spotifyId); }
      if (opts.releaseDate) { updates.push('release_date = ?'); params.push(opts.releaseDate); }
      if (opts.albumType) { updates.push('album_type = ?'); params.push(opts.albumType); }
      if (opts.imageUrl) { updates.push('image_url = ?'); params.push(opts.imageUrl); }
      if (opts.totalTracks != null) { updates.push('total_tracks = ?'); params.push(opts.totalTracks); }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        params.push(existing.id);
        db.prepare(`UPDATE albums SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO albums (name, artist_name, spotify_id, release_date, album_type, image_url, total_tracks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name,
    artistName,
    opts?.spotifyId ?? null,
    opts?.releaseDate ?? null,
    opts?.albumType ?? null,
    opts?.imageUrl ?? null,
    opts?.totalTracks ?? null,
  );

  return result.lastInsertRowid as number;
}

export function upsertTrack(
  db: Database.Database,
  opts: {
    name: string;
    albumId: number;
    artistId: number;
    durationMs?: number;
    trackNumber?: number | null;
    discNumber?: number | null;
    spotifyId?: string | null;
  },
): number {
  if (opts.spotifyId) {
    const existing = db.prepare(
      `SELECT id FROM tracks WHERE spotify_id = ?`
    ).get(opts.spotifyId) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE tracks SET
           name = ?, album_id = ?, artist_id = ?, duration_ms = ?,
           track_number = COALESCE(?, track_number),
           disc_number = COALESCE(?, disc_number),
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        opts.name, opts.albumId, opts.artistId, opts.durationMs ?? 0,
        opts.trackNumber ?? null, opts.discNumber ?? null,
        existing.id,
      );
      return existing.id;
    }
  }

  // Fall back to name + artist match when no spotify_id or no match
  const byName = db.prepare(
    `SELECT id FROM tracks WHERE name = ? COLLATE NOCASE AND artist_id = ? AND album_id = ?`
  ).get(opts.name, opts.artistId, opts.albumId) as { id: number } | undefined;

  if (byName) {
    const updates: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];
    if (opts.spotifyId) { updates.unshift('spotify_id = ?'); params.push(opts.spotifyId); }
    if (opts.durationMs) { updates.unshift('duration_ms = ?'); params.push(opts.durationMs); }
    if (opts.trackNumber != null) { updates.unshift('track_number = ?'); params.push(opts.trackNumber); }
    if (opts.discNumber != null) { updates.unshift('disc_number = ?'); params.push(opts.discNumber); }
    params.push(byName.id);
    db.prepare(`UPDATE tracks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return byName.id;
  }

  const result = db.prepare(
    `INSERT INTO tracks (name, album_id, artist_id, duration_ms, track_number, disc_number, spotify_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.name,
    opts.albumId,
    opts.artistId,
    opts.durationMs ?? 0,
    opts.trackNumber ?? null,
    opts.discNumber ?? null,
    opts.spotifyId ?? null,
  );

  return result.lastInsertRowid as number;
}

export function insertListeningEvent(
  db: Database.Database,
  trackId: number,
  playedAt: string,
  msPlayed: number,
  source: string,
  connCountry?: string | null,
  platform?: string | null,
): void {
  db.prepare(
    `INSERT INTO listening_events (track_id, played_at, ms_played, source, conn_country, platform)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(trackId, playedAt, msPlayed, source, connCountry ?? null, platform ?? null);
}

export function logImport(
  db: Database.Database,
  source: string,
  sourceIdentifier: string,
  eventCount: number,
): void {
  db.prepare(
    `INSERT INTO import_log (source, source_identifier, event_count) VALUES (?, ?, ?)`
  ).run(source, sourceIdentifier, eventCount);
}

export function hasBeenImported(db: Database.Database, source: string, sourceIdentifier: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM import_log WHERE source = ? AND source_identifier = ?`
  ).get(source, sourceIdentifier);
  return !!row;
}
