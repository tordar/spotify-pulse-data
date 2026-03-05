const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'spotify-pulse/1.0 (https://github.com/tordar/spotify-pulse)';
const RATE_LIMIT_MS = 1100;
const MAX_RETRIES = 3;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mbFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': MB_USER_AGENT } });
      if (res.status === 429) {
        // Rate limited — wait longer and retry
        await sleep(5000 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err: any) {
      const isRetryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(err?.cause?.code);
      if (isRetryable && attempt < MAX_RETRIES - 1) {
        console.warn(`  ⚠ Network error (${err?.cause?.code}), retrying in ${3 * (attempt + 1)}s...`);
        await sleep(3000 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function mbUrlLookup(spotifyUrl: string, inc: string): Promise<any> {
  await sleep(RATE_LIMIT_MS);
  const params = new URLSearchParams({ resource: spotifyUrl, inc, fmt: 'json' });
  const res = await mbFetch(`${MB_BASE}/url?${params}`);
  if (!res || res.status === 404) return null;
  if (!res.ok) return null;
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

async function fetchReleaseGroupId(releaseMbid: string): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const res = await mbFetch(`${MB_BASE}/release/${releaseMbid}?inc=release-groups&fmt=json`);
  if (!res?.ok) return null;
  const data: any = await res.json();
  return data?.['release-group']?.id ?? null;
}

export async function lookupAlbumMbids(spotifyAlbumId: string): Promise<{ releaseId: string; releaseGroupId: string | null } | null> {
  await sleep(RATE_LIMIT_MS);
  const data = await mbUrlLookup(
    `https://open.spotify.com/album/${spotifyAlbumId}`,
    'release-rels',
  );
  const rel = data?.relations?.find((r: any) => r.release);
  const releaseId = rel?.release?.id ?? null;
  if (!releaseId) return null;
  const releaseGroupId = await fetchReleaseGroupId(releaseId);
  return { releaseId, releaseGroupId };
}

/** Search MusicBrainz for a release by album name + artist, returning the best-match release MBID. */
export async function searchMusicBrainzRelease(
  albumName: string,
  artistName: string,
): Promise<{ releaseId: string; releaseGroupId: string | null } | null> {
  await sleep(RATE_LIMIT_MS);
  const query = encodeURIComponent(`release:"${albumName}" AND artist:"${artistName}"`);
  const res = await mbFetch(`${MB_BASE}/release?query=${query}&fmt=json&limit=5`);
  if (!res?.ok) return null;
  const data: any = await res.json();
  const release = data?.releases?.[0];
  if (!release) return null;
  return {
    releaseId: release.id,
    releaseGroupId: release['release-group']?.id ?? null,
  };
}

/** Search MusicBrainz for an artist by name, returning the best-match artist MBID. */
export async function searchMusicBrainzArtist(
  artistName: string,
): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const query = encodeURIComponent(`artist:"${artistName}"`);
  const res = await mbFetch(`${MB_BASE}/artist?query=${query}&fmt=json&limit=5`);
  if (!res?.ok) return null;
  const data: any = await res.json();
  return data?.artists?.[0]?.id ?? null;
}

/** Search MusicBrainz for a recording by track name + artist, returning the best-match recording MBID. */
export async function searchMusicBrainzRecording(
  trackName: string,
  artistName: string,
): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const query = encodeURIComponent(`recording:"${trackName}" AND artist:"${artistName}"`);
  const res = await mbFetch(`${MB_BASE}/recording?query=${query}&fmt=json&limit=5`);
  if (!res?.ok) return null;
  const data: any = await res.json();
  return data?.recordings?.[0]?.id ?? null;
}

/** Given a MusicBrainz release MBID, find a linked Spotify album ID via URL relationships. */
export async function getSpotifyIdFromRelease(
  mbReleaseId: string,
): Promise<string | null> {
  await sleep(RATE_LIMIT_MS);
  const url = `${MB_BASE}/release/${mbReleaseId}?inc=url-rels&fmt=json`;
  const res = await mbFetch(url);
  if (!res?.ok) return null;
  const data: any = await res.json();

  const spotifyRel = data?.relations?.find((r: any) =>
    r.type === 'streaming' && r.url?.resource?.includes('open.spotify.com/album/')
  );
  if (!spotifyRel) return null;

  const match = spotifyRel.url.resource.match(/album\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}
