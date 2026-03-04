import 'dotenv/config';

const BASE = process.env.NAVIDROME_URL!;
const USER = process.env.NAVIDROME_USER!;
const PASS = process.env.NAVIDROME_PASS!;
const CLIENT = 'spotify-consolidator-explorer';
const VERSION = '1.16.1';

function subsonicUrl(endpoint: string, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    u: USER,
    p: PASS,
    v: VERSION,
    c: CLIENT,
    f: 'json',
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  return `${BASE}/rest/${endpoint}?${params}`;
}

async function get(endpoint: string, extra: Record<string, string | number> = {}) {
  const res = await fetch(subsonicUrl(endpoint, extra));
  const json = await res.json() as any;
  return json['subsonic-response'];
}

async function main() {
  console.log('=== Navidrome Subsonic API Explorer ===\n');

  // 1. Ping
  const ping = await get('ping');
  console.log('Ping:', ping.status, `(v${ping.version})\n`);

  // 2. Recently played albums
  console.log('--- Recently Played Albums (last 10) ---');
  const recent = await get('getAlbumList2', { type: 'recent', size: 10 });
  const recentAlbums = recent.albumList2?.album ?? [];
  for (const a of recentAlbums) {
    console.log(`  ${a.artist} — ${a.name}  [played: ${a.played ?? 'n/a'}, playCount: ${a.playCount ?? 0}]`);
  }

  // 3. Most played albums
  console.log('\n--- Most Played Albums (top 10) ---');
  const frequent = await get('getAlbumList2', { type: 'frequent', size: 10 });
  const frequentAlbums = frequent.albumList2?.album ?? [];
  for (const a of frequentAlbums) {
    console.log(`  ${a.artist} — ${a.name}  [playCount: ${a.playCount ?? 0}, played: ${a.played ?? 'n/a'}]`);
  }

  // 4. Now playing
  console.log('\n--- Now Playing ---');
  const nowPlaying = await get('getNowPlaying');
  const entries = nowPlaying.nowPlaying?.entry ?? [];
  if (entries.length === 0) {
    console.log('  Nothing playing right now');
  } else {
    for (const e of entries) {
      console.log(`  ${e.artist} — ${e.title} (${e.minutesAgo}m ago)`);
    }
  }

  // 5. Drill into songs of most recently played album to see song-level fields
  if (recentAlbums.length > 0) {
    const album = recentAlbums[0];
    console.log(`\n--- Song details from most recent album: "${album.name}" ---`);
    const albumDetail = await get('getAlbum', { id: album.id });
    const songs = albumDetail.album?.song ?? [];
    for (const s of songs.slice(0, 5)) {
      console.log(`  Track ${s.track ?? '?'}: ${s.title}`);
      console.log(`    playCount: ${s.playCount ?? 0}, lastPlayed: ${s.lastPlayed ?? 'never'}, duration: ${s.duration}s`);
    }
    if (songs.length > 5) console.log(`  ... and ${songs.length - 5} more`);
  }

  // 6. Starred content
  console.log('\n--- Starred Songs (up to 10) ---');
  const starred = await get('getStarred2');
  const starredSongs = starred.starred2?.song ?? [];
  if (starredSongs.length === 0) {
    console.log('  No starred songs');
  } else {
    for (const s of starredSongs.slice(0, 10)) {
      console.log(`  ${s.artist} — ${s.title}  [starred: ${s.starred}, playCount: ${s.playCount ?? 0}]`);
    }
  }

  // 7. Show raw song object shape
  if (recentAlbums.length > 0) {
    const albumDetail = await get('getAlbum', { id: recentAlbums[0].id });
    const firstSong = albumDetail.album?.song?.[0];
    if (firstSong) {
      console.log('\n--- Raw song object (all available fields) ---');
      console.log(JSON.stringify(firstSong, null, 2));
    }
  }
}

main().catch(console.error);
