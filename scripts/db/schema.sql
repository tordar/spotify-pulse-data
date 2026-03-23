-- SQLite schema for the music library database.
-- All listening data, track metadata, and local file references live here.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  spotify_id      TEXT,
  musicbrainz_id  TEXT,
  genres          TEXT DEFAULT '[]',   -- JSON array of genre strings
  image_url       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name ON artists(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_artists_spotify_id ON artists(spotify_id);

CREATE TABLE IF NOT EXISTS albums (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  artist_name     TEXT NOT NULL,
  spotify_id      TEXT,
  musicbrainz_id  TEXT,
  release_date    TEXT,
  album_type      TEXT,
  image_url       TEXT,
  total_tracks    INTEGER,
  queue_status    TEXT CHECK(queue_status IN ('queued','skipped')) DEFAULT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name_artist ON albums(name COLLATE NOCASE, artist_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_albums_spotify_id ON albums(spotify_id);

CREATE TABLE IF NOT EXISTS tracks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  album_id          INTEGER REFERENCES albums(id),
  artist_id         INTEGER REFERENCES artists(id),
  duration_ms       INTEGER DEFAULT 0,
  track_number      INTEGER,
  disc_number       INTEGER,
  spotify_id        TEXT,
  musicbrainz_id    TEXT,
  local_file_path   TEXT,
  download_status   TEXT NOT NULL DEFAULT 'pending'
                    CHECK(download_status IN ('pending','downloading','downloaded','failed','skipped')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_spotify_id ON tracks(spotify_id) WHERE spotify_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_name_artist ON tracks(name COLLATE NOCASE, artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_download_status ON tracks(download_status);
CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'primary',
  PRIMARY KEY (track_id, artist_id, role)
);

CREATE TABLE IF NOT EXISTS listening_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL REFERENCES tracks(id),
  played_at     TEXT NOT NULL,
  ms_played     INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL CHECK(source IN ('spotify','listenbrainz','local_import')),
  conn_country  TEXT,
  platform      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_track_played ON listening_events(track_id, played_at);
CREATE INDEX IF NOT EXISTS idx_events_source_played ON listening_events(source, played_at);
CREATE INDEX IF NOT EXISTS idx_events_played_at ON listening_events(played_at);

CREATE TABLE IF NOT EXISTS import_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,
  source_identifier TEXT,
  imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
  event_count       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fresh_releases (
  id           TEXT PRIMARY KEY,  -- MusicBrainz release-group MBID
  artist_name  TEXT NOT NULL,
  artist_mbid  TEXT NOT NULL,
  title        TEXT NOT NULL,
  release_date TEXT,              -- ISO date: "2025-04-15"
  primary_type TEXT,              -- Album, EP, Single, etc.
  caa_release_mbid TEXT,              -- release MBID for Cover Art Archive lookup
  fetched_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fresh_releases_date ON fresh_releases(release_date);
CREATE INDEX IF NOT EXISTS idx_fresh_releases_artist ON fresh_releases(artist_mbid);
