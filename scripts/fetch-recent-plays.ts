import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { SpotifyTokenManager } from './spotify-token-manager';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
  insertListeningEvent,
  logImport,
} from './db/database';
import { createClient, type Client } from '@libsql/client';

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: Array<{
    id: string;
    name: string;
  }>;
  album: {
    id: string;
    name: string;
    images: Array<{
      height: number;
      url: string;
      width: number;
    }>;
  };
  external_urls: {
    spotify: string;
  };
  preview_url: string | null;
}

interface SpotifyPlay {
  track: SpotifyTrack;
  played_at: string;
}

interface SpotifyRecentPlaysResponse {
  items: SpotifyPlay[];
  next: string | null;
  cursors: {
    after: string;
    before: string;
  };
  limit: number;
  href: string;
}

function getTursoClient(): Client | null {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) return null;
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() });
}

/** True when running in CI (GitHub Actions) where library.db does not exist. */
function isCiMode(): boolean {
  return !fs.existsSync(path.join(__dirname, '..', 'data', 'library.db'));
}

class SpotifyRecentPlaysFetcher {
  private tokenManager: SpotifyTokenManager;

  constructor() {
    this.tokenManager = new SpotifyTokenManager();
  }

  async hasNewTracks(): Promise<boolean> {
    try {
      let latestTimestamp: string | null = null;

      if (isCiMode()) {
        // On CI there is no local library.db — query Turso instead
        const turso = getTursoClient();
        if (turso) {
          const { rows } = await turso.execute(
            `SELECT MAX(played_at) as latest FROM listening_events WHERE source = 'spotify'`
          );
          latestTimestamp = (rows[0]?.latest as string | null) ?? null;
          console.log(`[CI] Latest Spotify event in Turso: ${latestTimestamp ?? 'none'}`);
        }
      } else {
        const db = getDatabase();
        const row = db.prepare(
          `SELECT MAX(played_at) as latest FROM listening_events WHERE source = 'spotify'`
        ).get() as { latest: string | null } | undefined;
        latestTimestamp = row?.latest ?? null;
        closeDatabase();
        console.log(`Latest Spotify event in local DB: ${latestTimestamp ?? 'none'}`);
      }

      if (!latestTimestamp) {
        console.log('No existing events found, will fetch recent plays');
        return true;
      }

      const latestTime = new Date(latestTimestamp).getTime();
      const accessToken = await this.tokenManager.getValidAccessToken();
      const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=10', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        console.log('Could not check recent plays, will fetch anyway');
        return true;
      }
      const data = (await response.json()) as { items: Array<{ played_at: string }> };
      if (!data.items?.length) {
        console.log('No recent plays from API');
        return false;
      }
      const hasNew = data.items.some(item => new Date(item.played_at).getTime() > latestTime);
      if (!hasNew) console.log('No new tracks since last run');
      return hasNew;
    } catch (error) {
      console.log('Error checking for new tracks, will fetch anyway:', error);
      return true;
    }
  }

  async fetchRecentPlays(limit: number = 50): Promise<SpotifyPlay[]> {
    console.log('Fetching recent Spotify plays...');

    const accessToken = await this.tokenManager.getValidAccessToken();
    const isValid = await this.tokenManager.testToken(accessToken);
    if (!isValid) {
      throw new Error('Invalid access token');
    }

    const response = await fetch(`https://api.spotify.com/v1/me/player/recently-played?limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch recent plays: ${response.status} ${errorText}`);
    }

    const data = await response.json() as SpotifyRecentPlaysResponse;
    console.log(`Fetched ${data.items.length} recent plays`);
    return data.items;
  }

  insertPlaysIntoDb(plays: SpotifyPlay[]): number {
    const db = getDatabase();

    // Get the latest existing event timestamp to avoid duplicates
    const latest = db.prepare(`
      SELECT MAX(played_at) as latest FROM listening_events WHERE source = 'spotify'
    `).get() as { latest: string | null } | undefined;

    const cutoff = latest?.latest ? new Date(latest.latest).getTime() : 0;

    const newPlays = plays.filter(p => new Date(p.played_at).getTime() > cutoff);
    if (newPlays.length === 0) {
      console.log('No new plays to insert (all already in DB)');
      closeDatabase();
      return 0;
    }

    let inserted = 0;

    db.transaction(() => {
      for (const play of newPlays) {
        const track = play.track;
        const primaryArtist = track.artists[0]?.name || 'Unknown Artist';
        const albumName = track.album?.name || 'Unknown Album';

        const artistId = upsertArtist(db, primaryArtist, track.artists[0]?.id);
        const albumImageUrl = track.album?.images?.[0]?.url || null;
        const albumId = upsertAlbum(db, albumName, primaryArtist, {
          spotifyId: track.album?.id,
          imageUrl: albumImageUrl,
        });

        const trackId = upsertTrack(db, {
          name: track.name,
          albumId,
          artistId,
          durationMs: track.duration_ms,
          spotifyId: track.id,
        });

        // Add featured artists
        for (let i = 1; i < track.artists.length; i++) {
          const featArtistId = upsertArtist(db, track.artists[i].name, track.artists[i].id);
          db.prepare(
            `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'featured')`
          ).run(trackId, featArtistId);
        }
        db.prepare(
          `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
        ).run(trackId, artistId);

        insertListeningEvent(db, trackId, play.played_at, track.duration_ms, 'spotify');
        inserted++;

        const artists = track.artists.map(a => a.name).join(', ');
        console.log(`  Inserted: ${track.name} - ${artists}`);
      }
    })();

    if (inserted > 0) {
      logImport(db, 'spotify-recent', new Date().toISOString(), inserted);
    }

    console.log(`Inserted ${inserted} new listening events into SQLite`);
    closeDatabase();
    return inserted;
  }

  async syncPlaysToTurso(plays: SpotifyPlay[]): Promise<void> {
    const turso = getTursoClient();
    if (!turso) {
      console.log('TURSO_DATABASE_URL not set — skipping Turso sync');
      return;
    }

    console.log(`Syncing ${plays.length} plays to Turso...`);

    for (const play of plays) {
      const track = play.track;
      const primaryArtist = track.artists[0]?.name || 'Unknown Artist';
      const albumName = track.album?.name || 'Unknown Album';
      const albumImageUrl = track.album?.images?.[0]?.url || null;

      // Upsert artist
      const artistResult = await turso.execute({
        sql: `INSERT INTO artists (name, spotify_id, genres, image_url)
              VALUES (?, ?, '[]', ?)
              ON CONFLICT(name) DO UPDATE SET
                spotify_id = COALESCE(excluded.spotify_id, spotify_id),
                image_url  = COALESCE(excluded.image_url, image_url),
                updated_at = datetime('now')
              RETURNING id`,
        args: [primaryArtist, track.artists[0]?.id ?? null, albumImageUrl],
      });
      const artistId = Number(artistResult.rows[0]?.id);

      // Upsert album
      const albumResult = await turso.execute({
        sql: `INSERT INTO albums (name, artist_name, spotify_id, image_url)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(name, artist_name) DO UPDATE SET
                spotify_id = COALESCE(excluded.spotify_id, spotify_id),
                image_url  = COALESCE(excluded.image_url, image_url),
                updated_at = datetime('now')
              RETURNING id`,
        args: [albumName, primaryArtist, track.album?.id ?? null, albumImageUrl],
      });
      const albumId = Number(albumResult.rows[0]?.id);

      // Upsert track
      const trackResult = await turso.execute({
        sql: `INSERT INTO tracks (name, album_id, artist_id, duration_ms, spotify_id)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(spotify_id) WHERE spotify_id IS NOT NULL DO UPDATE SET
                name       = excluded.name,
                album_id   = excluded.album_id,
                artist_id  = excluded.artist_id,
                duration_ms = excluded.duration_ms,
                updated_at = datetime('now')
              RETURNING id`,
        args: [track.name, albumId, artistId, track.duration_ms, track.id ?? null],
      });
      const trackId = Number(trackResult.rows[0]?.id);

      // Insert listening event (ignore duplicates)
      await turso.execute({
        sql: `INSERT OR IGNORE INTO listening_events (track_id, played_at, ms_played, source)
              VALUES (?, ?, ?, 'spotify')`,
        args: [trackId, play.played_at, track.duration_ms],
      });
    }

    console.log(`Turso sync complete.`);
  }

  private writeFetchResult(hasNewTracks: boolean): void {
    const tempDir = 'temp';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(tempDir, 'fetch-result.txt'),
      `HAS_NEW_TRACKS=${hasNewTracks}\n`,
      'utf8'
    );
    const ghOut = process.env.GITHUB_OUTPUT;
    if (ghOut) {
      fs.appendFileSync(ghOut, `has_new_tracks=${hasNewTracks}\n`, 'utf8');
    }
  }

  async fetchAndSaveRecentPlays(): Promise<number> {
    try {
      const ci = isCiMode();
      if (ci) console.log('[CI mode] No local library.db — writing to Turso only');

      const shouldFetch = await this.hasNewTracks();
      if (!shouldFetch) {
        this.writeFetchResult(false);
        process.exit(0);
      }

      const plays = await this.fetchRecentPlays();

      let inserted: number;
      if (ci) {
        // In CI, skip local SQLite entirely and write directly to Turso
        await this.syncPlaysToTurso(plays);
        inserted = plays.length;
      } else {
        // Local: write only to SQLite — run db:sync-turso when ready to publish
        inserted = this.insertPlaysIntoDb(plays);
      }

      this.writeFetchResult(inserted > 0);
      console.log('Recent plays fetch completed successfully!');
      return inserted;
    } catch (error) {
      console.error('Recent plays fetch failed:', error);
      this.writeFetchResult(false);
      process.exit(0);
    }
  }
}

if (require.main === module) {
  const fetcher = new SpotifyRecentPlaysFetcher();
  fetcher.fetchAndSaveRecentPlays();
}

export { SpotifyRecentPlaysFetcher };
