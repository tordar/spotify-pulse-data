const MB_BASE = 'https://musicbrainz.org/ws/2';
const RATE_LIMIT_MS = 1100;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mbUrlLookup(spotifyUrl: string, inc: string): Promise<any> {
  const params = new URLSearchParams({ resource: spotifyUrl, inc, fmt: 'json' });
  const res = await fetch(`${MB_BASE}/url?${params}`, {
    headers: { 'User-Agent': 'spotify-pulse/1.0 (https://github.com/tordar/spotify-pulse)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`MusicBrainz error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function lookupTrackMbid(spotifyTrackId: string): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const data = await mbUrlLookup(
    `https://open.spotify.com/track/${spotifyTrackId}`,
    'recording-rels',
  );
  const rel = data?.relations?.find((r: any) => r.recording);
  return rel?.recording?.id ?? null;
}

export async function lookupArtistMbid(spotifyArtistId: string): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const data = await mbUrlLookup(
    `https://open.spotify.com/artist/${spotifyArtistId}`,
    'artist-rels',
  );
  const rel = data?.relations?.find((r: any) => r.artist);
  return rel?.artist?.id ?? null;
}

export async function lookupAlbumMbid(spotifyAlbumId: string): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const data = await mbUrlLookup(
    `https://open.spotify.com/album/${spotifyAlbumId}`,
    'release-rels',
  );
  const rel = data?.relations?.find((r: any) => r.release);
  return rel?.release?.id ?? null;
}
