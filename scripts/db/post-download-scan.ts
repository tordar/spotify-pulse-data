/**
 * post-download-scan.ts
 *
 * Run this after sldl finishes to link newly downloaded files back to
 * their database tracks (which already have play counts).
 *
 * Two modes:
 *   --since <minutes>        scan files modified in the last N minutes
 *   --playlist <file.m3u8>   scan only the files listed in an sldl playlist
 *
 * If neither is given, falls back to scanning the entire music directory
 * (same as db:scan-files) but only matches tracks that still lack a local path.
 *
 * Usage:
 *   tsx scripts/db/post-download-scan.ts /Volumes/MyDrive/Music/Music --since 120
 *   tsx scripts/db/post-download-scan.ts /Volumes/MyDrive/Music/Music --playlist data/sldl-results.m3u8
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from 'music-metadata';
import { getDatabase, closeDatabase } from './database';

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.wma', '.alac', '.aiff', '.ape', '.wv',
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[^\w\s'"-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTrackNumber(s: string): string {
  return s
    .replace(/^\d{1,2}-\d{1,3}[\s.\-_]+/, '')
    .replace(/^\d{1,3}[\s.\-_]+/, '')
    .trim();
}

function stripArtistNumber(s: string): string {
  return s.replace(/^\d{1,3}\.\s+/, '').trim();
}

function titleFromFilename(filename: string): string {
  return stripTrackNumber(path.basename(filename, path.extname(filename)));
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(full);
  }
  return results;
}

function filesModifiedSince(musicDir: string, sinceMs: number): string[] {
  const cutoff = Date.now() - sinceMs;
  return walkDir(musicDir).filter(f => {
    try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
  });
}

function filesFromPlaylist(playlistPath: string): string[] {
  return fs.readFileSync(playlistPath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && AUDIO_EXTENSIONS.has(path.extname(l).toLowerCase()));
}

async function postDownloadScan(musicDir: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    console.log('No files to scan.');
    return;
  }

  console.log(`Scanning ${files.length.toLocaleString()} files…`);

  const db = getDatabase();

  // Build a normalized lookup of all DB tracks that still lack a local path
  const unmatchedTracks = db.prepare(`
    SELECT t.id, t.name, a.name as artist_name, al.name as album_name, t.duration_ms
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NULL
  `).all() as Array<{ id: number; name: string; artist_name: string; album_name: string; duration_ms: number }>;

  const lookup = new Map<string, typeof unmatchedTracks>();
  for (const track of unmatchedTracks) {
    const key = `${normalize(track.artist_name)}|||${normalize(track.name)}`;
    const arr = lookup.get(key) ?? [];
    arr.push(track);
    lookup.set(key, arr);
  }
  console.log(`  ${unmatchedTracks.length.toLocaleString()} DB tracks awaiting a local file`);

  const updatePath = db.prepare(`
    UPDATE tracks SET local_file_path = ?, download_status = 'downloaded', updated_at = datetime('now')
    WHERE id = ?
  `);

  let matched = 0;
  let skipped = 0;
  let alreadyLinked = 0;
  const matchedIds = new Set<number>();

  const BATCH = 100;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);

    await db.transaction(async () => {
      for (const filePath of batch) {
        // Skip files that already have a db entry with this exact path
        const existing = db.prepare(`SELECT id FROM tracks WHERE local_file_path = ?`).get(filePath);
        if (existing) { alreadyLinked++; continue; }

        let artist = '', title = '', album = '', durationMs = 0;

        try {
          const meta = await parseFile(filePath, { skipCovers: true, duration: true });
          const c = meta.common;
          artist = c.artist || c.albumartist || '';
          title = c.title || '';
          album = c.album || '';
          durationMs = meta.format.duration ? Math.round(meta.format.duration * 1000) : 0;

          artist = artist ? stripArtistNumber(artist) : '';
          title = title ? stripTrackNumber(title) : '';
        } catch {
          // Fall back to path structure: Artist/Album/01 Title.flac
        }

        // Path-based fallback if tags are missing
        if (!artist || !title) {
          const rel = path.relative(musicDir, filePath).split(path.sep);
          if (rel.length >= 3) { artist = artist || rel[0]; album = album || rel[1]; title = title || titleFromFilename(rel[rel.length - 1]); }
          else if (rel.length === 2) { artist = artist || rel[0]; title = title || titleFromFilename(rel[1]); }
          else { title = title || titleFromFilename(rel[0]); }
        }

        if (!title) { skipped++; continue; }

        // Find a match in the lookup
        const key = `${normalize(artist)}|||${normalize(title)}`;
        const candidates = (lookup.get(key) ?? []).filter(c => !matchedIds.has(c.id));

        let trackId: number | null = null;

        if (candidates.length === 1) {
          trackId = candidates[0].id;
        } else if (candidates.length > 1) {
          // Prefer same album
          const albumMatch = album ? candidates.find(c => normalize(c.album_name) === normalize(album)) : null;
          if (albumMatch) {
            trackId = albumMatch.id;
          } else if (durationMs > 0) {
            // Prefer closest duration within 5s
            const durMatch = candidates
              .filter(c => c.duration_ms > 0 && Math.abs(c.duration_ms - durationMs) < 5000)
              .sort((a, b) => Math.abs(a.duration_ms - durationMs) - Math.abs(b.duration_ms - durationMs))[0];
            trackId = durMatch?.id ?? candidates[0].id;
          } else {
            trackId = candidates[0].id;
          }
        }

        if (trackId) {
          matchedIds.add(trackId);
          updatePath.run(filePath, trackId);
          matched++;
          console.log(`  ✓ ${path.relative(musicDir, filePath).split(path.sep).slice(-2).join('/')}`);
        } else {
          skipped++;
          console.log(`  ✗ No match: "${artist}" – "${title}" (${path.basename(filePath)})`);
        }
      }
    })();

    if (files.length > BATCH) {
      const done = Math.min(i + BATCH, files.length);
      process.stdout.write(`\r  Progress: ${done}/${files.length} files…`);
    }
  }

  if (files.length > BATCH) console.log();

  console.log(`\nDone.`);
  console.log(`  Linked to existing tracks:  ${matched.toLocaleString()}`);
  console.log(`  Already linked (skipped):   ${alreadyLinked.toLocaleString()}`);
  console.log(`  No match found:             ${skipped.toLocaleString()}`);

  if (skipped > 0) {
    console.log(`\n  Unmatched files may have been added as catalog tracks by a previous scan.`);
    console.log(`  Run the mapping tool at /mapping to link them manually.`);
  }

  if (matched > 0) {
    console.log(`\n  Run 'npm run db:sync-turso' to push changes to Turso.`);
  }

  closeDatabase();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const musicDir = args[0];

  if (!musicDir) {
    console.error('Usage:');
    console.error('  tsx scripts/db/post-download-scan.ts <music-dir> --since <minutes>');
    console.error('  tsx scripts/db/post-download-scan.ts <music-dir> --playlist <file.m3u8>');
    console.error('  tsx scripts/db/post-download-scan.ts <music-dir>   (scans everything)');
    process.exit(1);
  }

  const sinceIdx = args.indexOf('--since');
  const playlistIdx = args.indexOf('--playlist');

  let files: string[];

  if (sinceIdx !== -1) {
    const minutes = parseInt(args[sinceIdx + 1]);
    if (isNaN(minutes)) { console.error('--since requires a number of minutes'); process.exit(1); }
    const sinceMs = minutes * 60 * 1000;
    files = filesModifiedSince(path.resolve(musicDir), sinceMs);
    console.log(`Collecting files modified in the last ${minutes} minutes: ${files.length} found`);
  } else if (playlistIdx !== -1) {
    const playlistFile = args[playlistIdx + 1];
    files = filesFromPlaylist(path.resolve(playlistFile));
    console.log(`Reading playlist ${playlistFile}: ${files.length} files`);
  } else {
    files = walkDir(path.resolve(musicDir)).filter(f =>
      AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase())
    );
    console.log(`Full scan mode: ${files.length} audio files found`);
  }

  postDownloadScan(path.resolve(musicDir), files).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { postDownloadScan };
