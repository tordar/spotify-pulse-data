/**
 * Fetches upcoming and recent releases from ListenBrainz for the authenticated user
 * and writes them to Cloudflare D1.
 *
 * Uses the LB user fresh_releases endpoint — no per-artist iteration needed.
 * Window: 30 days past, 90 days future.
 * Runs daily via GitHub Actions.
 *
 * Usage: npm run db:fetch-upcoming-releases
 */

import 'dotenv/config';
import { getD1Client } from './d1-client';

const LB_BASE = 'https://api.listenbrainz.org/1';
const BATCH_SIZE = 10;

const SKIP_SECONDARY = new Set([
  'Live', 'Compilation', 'Remix', 'DJ-mix', 'Mixtape/Street',
  'Interview', 'Spokenword', 'Audiobook',
]);

interface LBFreshRelease {
  release_name: string;
  release_mbid: string;
  artist_credit_name: string;
  artist_mbids: string[];
  release_date: string;
  release_group_primary_type: string | null;
  release_group_secondary_type: string | null;
  caa_id: number | null;
  caa_release_mbid: string | null;
}

async function fetchListenedArtistMbids(username: string, token: string): Promise<Set<string>> {
  const mbids = new Set<string>();
  const pageSize = 1000;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${LB_BASE}/stats/user/${encodeURIComponent(username)}/artists?count=${pageSize}&offset=${offset}&range=all_time`;
    const res = await fetch(url, { headers: { 'Authorization': `Token ${token}` } });
    if (!res.ok) break;
    const data: any = await res.json();
    const payload = data?.payload;
    if (!payload) break;
    total = payload.total_artist_count ?? 0;
    const artists: Array<{ artist_mbid?: string }> = payload.artists ?? [];
    for (const a of artists) {
      if (a.artist_mbid) mbids.add(a.artist_mbid);
    }
    offset += artists.length;
    if (artists.length < pageSize) break;
  }

  return mbids;
}

async function main() {
  const username = process.env.LISTENBRAINZ_USERNAME;
  const token = process.env.LISTENBRAINZ_TOKEN;
  if (!username || !token) throw new Error('LISTENBRAINZ_USERNAME and LISTENBRAINZ_TOKEN are required');

  const db = getD1Client();

  console.log(`Fetching listened artists for ${username}...`);
  const listenedMbids = await fetchListenedArtistMbids(username, token);
  console.log(`${listenedMbids.size} artists in listening history`);

  const url = `${LB_BASE}/user/${encodeURIComponent(username)}/fresh_releases?days=90&sort=release_date&past=true&future=true`;
  console.log(`Fetching fresh releases...`);

  const res = await fetch(url, { headers: { 'Authorization': `Token ${token}` } });
  if (!res.ok) throw new Error(`LB API error ${res.status}: ${await res.text()}`);

  const data: any = await res.json();
  const all: LBFreshRelease[] = data?.payload?.releases ?? [];
  console.log(`Got ${all.length} releases from ListenBrainz`);

  const today = new Date();
  const pastCutoff = new Date(today);
  pastCutoff.setDate(today.getDate() - 30);
  const pastCutoffStr = pastCutoff.toISOString().split('T')[0];

  const releases = all.filter(r => {
    if (!r.release_date) return false;
    if (r.release_date < pastCutoffStr) return false;
    if (r.release_group_secondary_type && SKIP_SECONDARY.has(r.release_group_secondary_type)) return false;
    if (listenedMbids.size > 0 && !r.artist_mbids?.some(mbid => listenedMbids.has(mbid))) return false;
    return true;
  });
  console.log(`${releases.length} after filtering to listened artists + no compilations/live/remixes`);

  await db.execute('DELETE FROM fresh_releases');

  for (let i = 0; i < releases.length; i += BATCH_SIZE) {
    const chunk = releases.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, datetime('now'))").join(', ');
    const args: unknown[] = [];
    for (const r of chunk) {
      args.push(
        r.release_mbid,
        r.artist_credit_name,
        r.artist_mbids?.[0] ?? null,
        r.release_name,
        r.release_date,
        r.release_group_primary_type ?? 'Other',
        r.caa_release_mbid ?? r.release_mbid,
      );
    }
    await db.execute({
      sql: `INSERT OR REPLACE INTO fresh_releases (id, artist_name, artist_mbid, title, release_date, primary_type, caa_release_mbid, fetched_at) VALUES ${placeholders}`,
      args,
    });
  }

  console.log(`Done. ${releases.length} releases written.`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
