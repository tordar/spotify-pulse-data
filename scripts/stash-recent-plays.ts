import * as fs from 'fs';
import * as path from 'path';
import { SpotifyTokenManager } from './spotify-token-manager';

/**
 * Fetches recent Spotify plays and saves them as raw JSON to data/pending-plays/.
 * No database interaction — safe to run during migration work.
 * Deduplicates against previously stashed files by played_at timestamp.
 */

const PENDING_DIR = path.join(__dirname, '..', 'data', 'pending-plays');

interface SpotifyPlay {
  track: {
    id: string;
    name: string;
    duration_ms: number;
    artists: Array<{ id: string; name: string }>;
    album: {
      id: string;
      name: string;
      images: Array<{ height: number; url: string; width: number }>;
    };
    external_urls: { spotify: string };
    preview_url: string | null;
  };
  played_at: string;
}

interface SpotifyRecentPlaysResponse {
  items: SpotifyPlay[];
  next: string | null;
  cursors: { after: string; before: string };
  limit: number;
  href: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getLatestStashedTimestamp(): number {
  ensureDir(PENDING_DIR);
  const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));

  let latest = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, file), 'utf-8')) as SpotifyPlay[];
    for (const play of data) {
      const t = new Date(play.played_at).getTime();
      if (t > latest) latest = t;
    }
  }
  return latest;
}

async function main(): Promise<void> {
  const tokenManager = new SpotifyTokenManager();
  const accessToken = await tokenManager.getValidAccessToken();
  const isValid = await tokenManager.testToken(accessToken);
  if (!isValid) {
    throw new Error('Invalid access token');
  }

  console.log('Fetching recent Spotify plays...');
  const response = await fetch(
    'https://api.spotify.com/v1/me/player/recently-played?limit=50',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch recent plays: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as SpotifyRecentPlaysResponse;
  console.log(`Fetched ${data.items.length} plays from Spotify API`);

  const cutoff = getLatestStashedTimestamp();
  const newPlays = data.items.filter(p => new Date(p.played_at).getTime() > cutoff);

  if (newPlays.length === 0) {
    console.log('No new plays since last stash — nothing to save.');
    return;
  }

  ensureDir(PENDING_DIR);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `plays-${timestamp}.json`;
  const filepath = path.join(PENDING_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(newPlays, null, 2), 'utf-8');
  console.log(`Stashed ${newPlays.length} new plays → ${path.relative(process.cwd(), filepath)}`);
}

main().catch(err => {
  console.error('Stash failed:', err);
  process.exit(1);
});
