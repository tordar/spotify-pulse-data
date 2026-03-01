import * as fs from 'fs';
import * as path from 'path';
import { getDatabase, closeDatabase } from './database';

interface PendingTrack {
  id: number;
  name: string;
  artist_name: string;
  album_name: string;
  duration_ms: number;
}

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function generateSldlCsv(opts?: { includeRetries?: boolean; queuedOnly?: boolean }): void {
  const db = getDatabase();
  const includeRetries = opts?.includeRetries ?? true;
  const queuedOnly = opts?.queuedOnly ?? false;

  const statusFilter = includeRetries
    ? `('pending', 'failed')`
    : `('pending')`;

  // If queuedOnly, only include tracks from albums marked as 'queued'.
  // Falls back to all pending tracks if no albums are queued yet.
  const queuedCount = queuedOnly
    ? (db.prepare(`SELECT COUNT(*) as c FROM albums WHERE queue_status = 'queued'`).get() as { c: number }).c
    : 0;
  const useQueueFilter = queuedOnly && queuedCount > 0;

  if (queuedOnly) {
    console.log(useQueueFilter
      ? `Queue filter active: ${queuedCount} albums queued`
      : `No albums queued — falling back to all pending tracks`);
  }

  const tracks = db.prepare(`
    SELECT t.id, t.name, a.name as artist_name, al.name as album_name, t.duration_ms
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.download_status IN ${statusFilter}
      AND t.local_file_path IS NULL
      ${useQueueFilter ? `AND al.queue_status = 'queued'` : ''}
    ORDER BY a.name, al.name, t.disc_number, t.track_number, t.name
  `).all() as PendingTrack[];

  if (tracks.length === 0) {
    console.log('No pending tracks to download.');
    closeDatabase();
    return;
  }

  const lines = ['Artist,Title,Album,Length'];
  for (const t of tracks) {
    const lengthSec = t.duration_ms > 0 ? Math.round(t.duration_ms / 1000) : '';
    lines.push([
      escapeCsvField(t.artist_name),
      escapeCsvField(t.name),
      escapeCsvField(t.album_name),
      String(lengthSec),
    ].join(','));
  }

  const outputPath = path.join(__dirname, '..', '..', 'data', 'sldl-input.csv');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  console.log(`Generated ${outputPath}`);
  console.log(`  Tracks to download: ${tracks.length.toLocaleString()}`);

  // Show breakdown by status
  const statusBreakdown = db.prepare(`
    SELECT download_status, COUNT(*) as c FROM tracks GROUP BY download_status ORDER BY c DESC
  `).all() as { download_status: string; c: number }[];

  console.log('\n  Download status breakdown:');
  for (const row of statusBreakdown) {
    console.log(`    ${row.download_status}: ${row.c.toLocaleString()}`);
  }

  console.log(`\nRun sldl with:`);
  console.log(`  sldl "${outputPath}" \\`);
  console.log(`    --artist-col "Artist" \\`);
  console.log(`    --title-col "Title" \\`);
  console.log(`    --album-col "Album" \\`);
  console.log(`    --length-col "Length" \\`);
  console.log(`    -p /path/to/nas/music \\`);
  console.log(`    --name-format "{albumartist(/)album(/)track(. )title|filename}" \\`);
  console.log(`    --pref-format "flac,mp3" \\`);
  console.log(`    --pref-min-bitrate 320 \\`);
  console.log(`    --concurrent-downloads 4`);

  closeDatabase();
}

if (require.main === module) {
  const queuedOnly = process.argv.includes('--queued-only');
  generateSldlCsv({ queuedOnly });
}

export { generateSldlCsv };
