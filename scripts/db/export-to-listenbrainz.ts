/**
 * export-to-listenbrainz.ts
 *
 * Exports listening history from library.db to ListenBrainz.
 * Submits in batches of 1000. Saves a checkpoint so it can resume
 * if interrupted.
 *
 * Usage:
 *   tsx scripts/db/export-to-listenbrainz.ts
 *   tsx scripts/db/export-to-listenbrainz.ts --dry-run
 *   tsx scripts/db/export-to-listenbrainz.ts --reset   (ignore checkpoint, start over)
 *
 * Requires LISTENBRAINZ_TOKEN in .env
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import 'dotenv/config';

const DB_PATH        = path.resolve(__dirname, '../../data/library.db');
const HISTORY_DIR    = path.resolve(__dirname, '../../data/merged-streaming-history');
const CHECKPOINT_PATH = path.resolve(__dirname, '../../data/lb-export-checkpoint.json');
const FIXED_IDS_PATH  = path.resolve(__dirname, '../../data/repaired-listen-ids.json');
const LB_BASE = 'https://api.listenbrainz.org/1';
const BATCH_SIZE = 1000;
const RATE_LIMIT_MS = 1000;

const DRY_RUN        = process.argv.includes('--dry-run');
const RESET          = process.argv.includes('--reset');
const ONLY_REPAIRED  = process.argv.includes('--only-repaired');
const ORPHANS_FROM_JSON = process.argv.includes('--orphans-from-json');
const ALL_ORPHANS    = process.argv.includes('--orphans');

interface Listen {
  listened_at: number;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  recording_mbid: string | null;
  release_mbid: string | null;
  artist_mbid: string | null;
}

interface HistoryEvent { playedAt: string; msPlayed: number; }
interface HistorySong {
  songId: string;
  name: string;
  artists: string[];
  album: { name: string };
  listeningEvents: HistoryEvent[];
}

function loadHistoryByTimestamp(): Map<string, { name: string; artist: string; album: string }> {
  const map = new Map<string, { name: string; artist: string; album: string }>();
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8'));
    for (const song of (data.songs || []) as HistorySong[]) {
      for (const event of song.listeningEvents) {
        const ts = new Date(event.playedAt).toISOString();
        map.set(ts, { name: song.name, artist: song.artists[0] || '', album: song.album.name });
      }
    }
  }
  return map;
}

interface Checkpoint {
  lastSubmittedTs: number;   // Unix timestamp of last successfully submitted listen
  totalSubmitted: number;
}

function loadCheckpoint(): Checkpoint {
  if (!RESET && fs.existsSync(CHECKPOINT_PATH)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
  }
  return { lastSubmittedTs: 0, totalSubmitted: 0 };
}

function saveCheckpoint(cp: Checkpoint) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function buildLBPayload(listens: Listen[]) {
  return listens.map(l => ({
    listened_at: l.listened_at,
    track_metadata: {
      artist_name: l.artist_name,
      track_name: l.track_name,
      ...(l.album_name ? { release_name: l.album_name } : {}),
      additional_info: {
        media_player: 'spotify-pulse',
        submission_client: 'spotify-pulse-export',
        ...(l.recording_mbid ? { recording_mbid: l.recording_mbid } : {}),
        ...(l.release_mbid   ? { release_mbid:   l.release_mbid   } : {}),
        ...(l.artist_mbid    ? { artist_mbids:    [l.artist_mbid]  } : {}),
      },
    },
  }));
}

async function submitBatch(token: string, listens: Listen[]): Promise<void> {
  const body = {
    listen_type: 'import',
    payload: buildLBPayload(listens),
  };

  const resp = await fetch(`${LB_BASE}/submit-listens`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'spotify-pulse/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ListenBrainz API error ${resp.status}: ${text}`);
  }
}

async function main() {
  const token = process.env.LISTENBRAINZ_TOKEN;
  if (!token && !DRY_RUN) {
    console.error('Error: LISTENBRAINZ_TOKEN not set in .env');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const cp = loadCheckpoint();

  console.log(`ListenBrainz export${DRY_RUN ? ' (DRY RUN)' : ''}${ALL_ORPHANS ? ' (all orphans)' : ONLY_REPAIRED ? ' (repaired listens only)' : ORPHANS_FROM_JSON ? ' (unmatched orphans from JSON)' : ''}${RESET ? ' (RESET checkpoint)' : ''}`);

  let rows: Listen[];

  if (ALL_ORPHANS) {
    // Part 1: repaired listens (now have valid track_id in DB)
    let repairedRows: Listen[] = [];
    if (fs.existsSync(FIXED_IDS_PATH)) {
      const ids: number[] = JSON.parse(fs.readFileSync(FIXED_IDS_PATH, 'utf8'));
      const placeholders = ids.map(() => '?').join(',');
      repairedRows = db.prepare(`
        SELECT
          CAST(strftime('%s', le.played_at) AS INTEGER) AS listened_at,
          t.name        AS track_name,
          ar.name       AS artist_name,
          al.name       AS album_name,
          t.musicbrainz_id   AS recording_mbid,
          al.musicbrainz_id  AS release_mbid,
          ar.musicbrainz_id  AS artist_mbid
        FROM listening_events le
        JOIN tracks  t  ON t.id  = le.track_id
        JOIN artists ar ON ar.id = t.artist_id
        JOIN albums  al ON al.id = t.album_id
        WHERE le.id IN (${placeholders})
        ORDER BY le.played_at ASC
      `).all(...ids) as Listen[];
      console.log(`Repaired listens (from DB):  ${repairedRows.length.toLocaleString()}`);
    }

    // Part 2: still-orphaned listens resolved from JSON
    const orphans = db.prepare(`
      SELECT le.id, le.played_at
      FROM listening_events le
      LEFT JOIN tracks t ON t.id = le.track_id
      WHERE t.id IS NULL
      ORDER BY le.played_at ASC
    `).all() as { id: number; played_at: string }[];

    console.log(`Loading streaming history JSON for ${orphans.length.toLocaleString()} remaining orphans...`);
    const historyMap = loadHistoryByTimestamp();
    const jsonRows: Listen[] = [];
    let notFound = 0;
    for (const orphan of orphans) {
      const ts   = new Date(orphan.played_at).toISOString();
      const meta = historyMap.get(ts);
      if (!meta) { notFound++; continue; }
      jsonRows.push({
        listened_at:  Math.floor(new Date(orphan.played_at).getTime() / 1000),
        track_name:   meta.name,
        artist_name:  meta.artist,
        album_name:   meta.album || null,
        recording_mbid: null,
        release_mbid:   null,
        artist_mbid:    null,
      });
    }
    console.log(`Orphans resolved from JSON:  ${jsonRows.length.toLocaleString()} (${notFound} unrecoverable)\n`);

    rows = [...repairedRows, ...jsonRows].sort((a, b) => a.listened_at - b.listened_at);
  } else if (ORPHANS_FROM_JSON) {
    // Find still-orphaned events (track_id missing) and resolve via JSON by timestamp
    const orphans = db.prepare(`
      SELECT le.id, le.played_at
      FROM listening_events le
      LEFT JOIN tracks t ON t.id = le.track_id
      WHERE t.id IS NULL
      ORDER BY le.played_at ASC
    `).all() as { id: number; played_at: string }[];

    console.log(`Loading streaming history JSON for ${orphans.length.toLocaleString()} remaining orphans...`);
    const historyMap = loadHistoryByTimestamp();

    rows = [];
    let notFound = 0;
    for (const orphan of orphans) {
      const ts   = new Date(orphan.played_at).toISOString();
      const meta = historyMap.get(ts);
      if (!meta) { notFound++; continue; }
      rows.push({
        listened_at:  Math.floor(new Date(orphan.played_at).getTime() / 1000),
        track_name:   meta.name,
        artist_name:  meta.artist,
        album_name:   meta.album || null,
        recording_mbid: null,
        release_mbid:   null,
        artist_mbid:    null,
      });
    }
    console.log(`Resolved ${rows.length.toLocaleString()} from JSON, ${notFound} not found\n`);
  } else if (ONLY_REPAIRED) {
    if (!fs.existsSync(FIXED_IDS_PATH)) {
      console.error(`No repaired IDs file found at ${FIXED_IDS_PATH}. Run repair-orphaned-listens.ts first.`);
      process.exit(1);
    }
    const ids: number[] = JSON.parse(fs.readFileSync(FIXED_IDS_PATH, 'utf8'));
    console.log(`Exporting ${ids.length.toLocaleString()} repaired listens\n`);
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT
        CAST(strftime('%s', le.played_at) AS INTEGER) AS listened_at,
        t.name        AS track_name,
        ar.name       AS artist_name,
        al.name       AS album_name,
        t.musicbrainz_id   AS recording_mbid,
        al.musicbrainz_id  AS release_mbid,
        ar.musicbrainz_id  AS artist_mbid
      FROM listening_events le
      JOIN tracks  t  ON t.id  = le.track_id
      JOIN artists ar ON ar.id = t.artist_id
      JOIN albums  al ON al.id = t.album_id
      WHERE le.id IN (${placeholders})
      ORDER BY le.played_at ASC
    `).all(...ids) as Listen[];
  } else {
    if (cp.lastSubmittedTs > 0) {
      console.log(`Resuming from checkpoint: ${new Date(cp.lastSubmittedTs * 1000).toISOString()} (${cp.totalSubmitted.toLocaleString()} already submitted)`);
    }
    const { total } = db.prepare(`
      SELECT COUNT(*) as total
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      WHERE le.source != 'listenbrainz'
        AND CAST(strftime('%s', le.played_at) AS INTEGER) > ?
    `).get(cp.lastSubmittedTs) as { total: number };

    console.log(`Listens to submit: ${total.toLocaleString()}\n`);

    if (total === 0) {
      console.log('Nothing to submit.');
      db.close();
      return;
    }

    rows = db.prepare(`
      SELECT
        CAST(strftime('%s', le.played_at) AS INTEGER) AS listened_at,
        t.name        AS track_name,
        ar.name       AS artist_name,
        al.name       AS album_name,
        t.musicbrainz_id   AS recording_mbid,
        al.musicbrainz_id  AS release_mbid,
        ar.musicbrainz_id  AS artist_mbid
      FROM listening_events le
      JOIN tracks  t  ON t.id  = le.track_id
      JOIN artists ar ON ar.id = t.artist_id
      JOIN albums  al ON al.id = t.album_id
      WHERE le.source != 'listenbrainz'
        AND CAST(strftime('%s', le.played_at) AS INTEGER) > ?
      ORDER BY le.played_at ASC
    `).all(cp.lastSubmittedTs) as Listen[];
  }

  db.close();

  if (rows.length === 0) {
    console.log('Nothing to submit.');
    return;
  }

  let submitted = 0;
  let batches = 0;
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    batches++;

    const batchStart = new Date(batch[0].listened_at * 1000).toISOString().substring(0, 10);
    const batchEnd   = new Date(batch[batch.length - 1].listened_at * 1000).toISOString().substring(0, 10);
    process.stdout.write(`  Batch ${batches}/${totalBatches} (${batchStart} → ${batchEnd}, ${batch.length} listens)...`);

    if (!DRY_RUN) {
      await submitBatch(token!, batch);

      cp.lastSubmittedTs = batch[batch.length - 1].listened_at;
      cp.totalSubmitted += batch.length;
      saveCheckpoint(cp);
    }

    submitted += batch.length;
    console.log(` ✓`);

    // Rate limit
    if (!DRY_RUN && i + BATCH_SIZE < rows.length) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  console.log(`\nDone.`);
  console.log(`  Submitted: ${submitted.toLocaleString()} listens in ${batches} batches`);
  console.log(`  Total submitted all time: ${(cp.totalSubmitted).toLocaleString()}`);
  if (DRY_RUN) console.log(`  (dry run — nothing was actually sent)`);
}

main().catch(err => { console.error(err); process.exit(1); });
