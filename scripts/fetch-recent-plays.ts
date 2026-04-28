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
} from './db/database';
import { getD1Client, type D1Client } from './db/d1-client';

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

function getRemoteClient(): D1Client | null {
  try {
    return getD1Client();
  } catch {
    return null;
  }
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
        const remote = getRemoteClient();
        if (remote) {
          const { rows } = await remote.execute(
            `SELECT MAX(played_at) as latest FROM listening_events WHERE source = 'spotify'`
          );
          latestTimestamp = (rows[0]?.latest as string | null) ?? null;
          console.log(`[CI] Latest Spotify event in D1: ${latestTimestamp ?? 'none'}`);
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

  enrichMetadataLocal(plays: SpotifyPlay[]): number {
    const db = getDatabase();

    let enriched = 0;
    db.transaction(() => {
      for (const play of plays) {
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

        for (let i = 1; i < track.artists.length; i++) {
          const featArtistId = upsertArtist(db, track.artists[i].name, track.artists[i].id);
          db.prepare(
            `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'featured')`
          ).run(trackId, featArtistId);
        }
        db.prepare(
          `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
        ).run(trackId, artistId);

        enriched++;
      }
    })();

    console.log(`Refreshed Spotify metadata for ${enriched} recently-played tracks`);
    closeDatabase();
    return enriched;
  }

  async enrichMetadataD1(plays: SpotifyPlay[]): Promise<void> {
    const remote = getRemoteClient();
    if (!remote) {
      console.log('D1 env vars not set — skipping metadata refresh');
      return;
    }

    console.log(`Refreshing Spotify metadata for ${plays.length} tracks in D1...`);

    for (const play of plays) {
      const track = play.track;
      const primaryArtist = track.artists[0]?.name || 'Unknown Artist';
      const albumName = track.album?.name || 'Unknown Album';
      const albumImageUrl = track.album?.images?.[0]?.url || null;

      const artistResult = await remote.execute({
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

      const albumResult = await remote.execute({
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

      await remote.execute({
        sql: `INSERT INTO tracks (name, album_id, artist_id, duration_ms, spotify_id)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(spotify_id) WHERE spotify_id IS NOT NULL DO UPDATE SET
                name       = excluded.name,
                album_id   = excluded.album_id,
                artist_id  = excluded.artist_id,
                duration_ms = excluded.duration_ms,
                updated_at = datetime('now')`,
        args: [track.name, albumId, artistId, track.duration_ms, track.id ?? null],
      });
    }

    console.log(`D1 metadata refresh complete.`);
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
      if (ci) console.log('[CI mode] No local library.db — writing to D1 only');

      const shouldFetch = await this.hasNewTracks();
      if (!shouldFetch) {
        this.writeFetchResult(false);
        process.exit(0);
      }

      const plays = await this.fetchRecentPlays();

      // Listening events are sourced from ListenBrainz (which scrobbles Spotify
      // and Navidrome with millisecond precision and submission_client tags).
      // This script only refreshes Spotify metadata (spotify_id, image_url) for
      // recently-played tracks/albums/artists — it no longer writes to listening_events.
      let touched: number;
      if (ci) {
        await this.enrichMetadataD1(plays);
        touched = plays.length;
      } else {
        touched = this.enrichMetadataLocal(plays);
      }

      this.writeFetchResult(touched > 0);
      console.log('Spotify metadata refresh completed successfully!');
      return touched;
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
