/**
 * Find listens in local SQLite that are NOT in ListenBrainz.
 * Usage: npx tsx scripts/db/diff-db-vs-lb.ts [year]
 * Defaults to current year.
 */

import * as path from 'path';
import Database from 'better-sqlite3';
import 'dotenv/config';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', 'web-app', '.env.local'), override: true });

const LB_BASE = 'https://api.listenbrainz.org/1';
const PAGE_SIZE = 100;

const year = process.argv[2] ?? new Date().getFullYear().toString();
const minTs = Math.floor(new Date(`${year}-01-01T00:00:00Z`).getTime() / 1000);
const maxBound = Math.floor(new Date(`${parseInt(year) + 1}-01-01T00:00:00Z`).getTime() / 1000);

const username = process.env.LISTENBRAINZ_USERNAME!;
const token = process.env.LISTENBRAINZ_TOKEN;
const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' };
if (token) headers['Authorization'] = `Token ${token}`;

async function fetchLBTimestamps(): Promise<Set<string>> {
  const set = new Set<string>();
  let maxTs: number | undefined;

  while (true) {
    const params = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (maxTs != null) params.set('max_ts', String(maxTs));

    const resp = await fetch(`${LB_BASE}/user/${encodeURIComponent(username)}/listens?${params}`, { headers });
    if (!resp.ok) throw new Error(`LB error ${resp.status}`);
    const data = await resp.json() as { payload: { listens: Array<{ listened_at: number }> } };
    const listens = data.payload.listens;

    if (listens.length === 0) break;

    for (const l of listens) {
      if (l.listened_at < minTs) { return set; }
      if (l.listened_at < maxBound) {
        set.add(new Date(l.listened_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
      }
    }

    if (listens[listens.length - 1].listened_at <= minTs) break;
    if (listens.length < PAGE_SIZE) break;
    maxTs = listens[listens.length - 1].listened_at - 1;
    await new Promise(r => setTimeout(r, 300));
  }

  return set;
}

const dbPath = path.join(__dirname, '..', '..', 'data', 'library.db');
const db = new Database(dbPath, { readonly: true });

const dbEvents = db.prepare(`
  SELECT le.played_at, t.name as track, a.name as artist
  FROM listening_events le
  JOIN tracks t ON t.id = le.track_id
  JOIN artists a ON a.id = t.artist_id
  WHERE strftime('%Y', le.played_at) = ?
  ORDER BY le.played_at ASC
`).all(year) as Array<{ played_at: string; track: string; artist: string }>;

console.log(`DB has ${dbEvents.length} listens in ${year}. Fetching LB history...`);

fetchLBTimestamps().then(lbSet => {
  console.log(`LB has ${lbSet.size} listens in ${year}.\n`);

  const missing = dbEvents.filter(e => !lbSet.has(e.played_at.replace(/\.\d{3}Z$/, 'Z')));
  console.log(`In DB but NOT in LB: ${missing.length}\n`);

  for (const e of missing) {
    console.log(`${e.played_at}  ${e.artist} — ${e.track}`);
  }
});
