/**
 * normalize-album-mbids.ts
 *
 * Fixes split albums caused by inconsistent MusicBrainz Album Id tags.
 *
 * For each folder containing audio files, finds the most common
 * MusicBrainz Album Id across all files in that folder, then writes
 * that single MBID to every file that has a different value.
 *
 * Usage:
 *   tsx scripts/db/normalize-album-mbids.ts
 *   tsx scripts/db/normalize-album-mbids.ts --dry-run
 *   tsx scripts/db/normalize-album-mbids.ts --artist "Angel Du$t"
 */

import { File as TagFile } from 'node-taglib-sharp';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '../../data/library.db');
const DRY_RUN = process.argv.includes('--dry-run');
const ARTIST_FILTER = (() => {
  const idx = process.argv.indexOf('--artist');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.wav', '.wv', '.ape']);

function getAlbumId(filePath: string): string | null {
  try {
    const tf = TagFile.createFromPath(filePath);
    const mbid = tf.tag.musicBrainzReleaseId || null;
    tf.dispose();
    return mbid;
  } catch {
    return null;
  }
}

function setAlbumId(filePath: string, mbid: string): void {
  const tf = TagFile.createFromPath(filePath);
  tf.tag.musicBrainzReleaseId = mbid;
  tf.save();
  tf.dispose();
}

function majorityMbid(counts: Map<string, number>): string {
  let best = '';
  let bestCount = 0;
  for (const [mbid, count] of counts) {
    if (count > bestCount) { best = mbid; bestCount = count; }
  }
  return best;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const artistClause = ARTIST_FILTER
    ? `AND ar.name = '${ARTIST_FILTER.replace(/'/g, "''")}'`
    : '';

  // Get all distinct folders that have files in library.db
  const folders = db.prepare(`
    SELECT DISTINCT
      ar.name   AS artist_name,
      al.name   AS album_name,
      t.local_file_path
    FROM tracks t
    JOIN artists ar ON ar.id = t.artist_id
    JOIN albums  al ON al.id = t.album_id
    WHERE t.local_file_path IS NOT NULL AND t.local_file_path != ''
    ${artistClause}
  `).all() as { artist_name: string; album_name: string; local_file_path: string }[];

  db.close();

  // Group by folder
  const byFolder = new Map<string, { artist: string; album: string; files: string[] }>();
  for (const row of folders) {
    const dir = path.dirname(row.local_file_path);
    if (!byFolder.has(dir)) {
      byFolder.set(dir, { artist: row.artist_name, album: row.album_name, files: [] });
    }
    byFolder.get(dir)!.files.push(row.local_file_path);
  }

  console.log(`Checking ${byFolder.size.toLocaleString()} folders${ARTIST_FILTER ? ` for "${ARTIST_FILTER}"` : ''}...`);
  if (DRY_RUN) console.log('DRY RUN — no files will be modified');
  console.log();

  let foldersFixed = 0;
  let filesFixed = 0;
  let foldersSkipped = 0;
  let foldersNoMbid = 0;

  for (const [dir, { artist, album, files }] of byFolder) {
    // Also include any audio files in the folder not in library.db
    let allFiles = files.filter(f => fs.existsSync(f));
    try {
      const dirFiles = fs.readdirSync(dir)
        .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
        .map(f => path.join(dir, f));
      for (const f of dirFiles) {
        if (!allFiles.includes(f)) allFiles.push(f);
      }
    } catch { /* folder not accessible */ }

    if (allFiles.length === 0) continue;

    // Read current MBIDs from all files
    const counts = new Map<string, number>();
    const fileMbids = new Map<string, string | null>();
    for (const f of allFiles) {
      const mbid = getAlbumId(f);
      fileMbids.set(f, mbid);
      if (mbid) counts.set(mbid, (counts.get(mbid) || 0) + 1);
    }

    if (counts.size === 0) {
      foldersNoMbid++;
      continue;
    }

    // Pick the majority (or only) MBID as the winner
    const winner = majorityMbid(counts);

    // Files that need updating: wrong MBID OR missing MBID
    const mismatchedFiles = allFiles.filter(f => fileMbids.get(f) !== winner);

    if (mismatchedFiles.length === 0) {
      foldersSkipped++;
      continue; // already fully consistent
    }

    console.log(`  ${artist} — ${album}`);
    console.log(`    Folder: ${dir}`);
    for (const [mbid, count] of counts) {
      console.log(`    ${mbid === winner ? '✓' : '✗'} ${mbid} (${count} files)`);
    }
    console.log(`    Fixing ${mismatchedFiles.length} files → ${winner}`);

    if (!DRY_RUN) {
      let fixed = 0;
      for (const f of mismatchedFiles) {
        try {
          setAlbumId(f, winner);
          fixed++;
        } catch (err) {
          console.error(`    ✗ ${path.basename(f)}: ${(err as Error).message}`);
        }
      }
      filesFixed += fixed;
    } else {
      filesFixed += mismatchedFiles.length;
    }

    foldersFixed++;
    console.log();
  }

  console.log('Done.');
  console.log(`  Folders fixed:       ${foldersFixed.toLocaleString()}`);
  console.log(`  Files updated:       ${filesFixed.toLocaleString()}`);
  console.log(`  Folders consistent:  ${foldersSkipped.toLocaleString()}`);
  console.log(`  Folders without MBID:${foldersNoMbid.toLocaleString()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
