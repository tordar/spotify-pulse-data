/**
 * fix-disc-nulls.ts
 *
 * Fixes albums where some tracks have disc=0 (from NULL disc_number in library.db)
 * while others have disc=1. This causes Navidrome to split single-disc albums.
 *
 * Strategy: For each album folder where max(disc_number)=1 in library.db but some
 * tracks have NULL disc_number, set disc=1 on all audio files in that folder
 * that currently have disc≠1.
 *
 * Usage:
 *   tsx scripts/db/fix-disc-nulls.ts
 *   tsx scripts/db/fix-disc-nulls.ts --dry-run
 */

import { File as TagFile } from 'node-taglib-sharp';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '../../data/library.db');
const DRY_RUN = process.argv.includes('--dry-run');
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.aac', '.wav', '.wv', '.ape']);

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Get file paths for albums where max_disc=1 but some tracks have NULL disc_number
  const rows = db.prepare(`
    SELECT DISTINCT t.local_file_path
    FROM tracks t
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NOT NULL AND t.local_file_path != ''
      AND al.id IN (
        SELECT t2.album_id
        FROM tracks t2
        WHERE t2.local_file_path IS NOT NULL
        GROUP BY t2.album_id
        HAVING SUM(CASE WHEN t2.disc_number IS NULL THEN 1 ELSE 0 END) > 0
           AND MAX(t2.disc_number) = 1
      )
  `).all() as { local_file_path: string }[];

  db.close();

  // Group by folder
  const folders = new Set<string>();
  for (const row of rows) {
    folders.add(path.dirname(row.local_file_path));
  }

  console.log(`Found ${folders.size} folders to check${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  let foldersFixed = 0;
  let filesFixed = 0;
  let errors = 0;

  for (const dir of folders) {
    if (!fs.existsSync(dir)) continue;

    const audioFiles = fs.readdirSync(dir)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .map(f => path.join(dir, f));

    if (audioFiles.length === 0) continue;

    // Check which files need fixing (disc !== 1)
    const toFix: string[] = [];
    for (const f of audioFiles) {
      try {
        const tf = TagFile.createFromPath(f);
        const disc = tf.tag.disc || 0;
        tf.dispose();
        if (disc !== 1) toFix.push(f);
      } catch { /* skip unreadable */ }
    }

    if (toFix.length === 0) continue;

    console.log(`  ${path.relative('/Volumes/MyDrive/Music/Music', dir)} — fixing ${toFix.length} files`);
    foldersFixed++;

    if (!DRY_RUN) {
      for (const f of toFix) {
        try {
          const tf = TagFile.createFromPath(f);
          tf.tag.disc = 1;
          tf.save();
          tf.dispose();
          filesFixed++;
        } catch (err: any) {
          console.error(`    Error: ${path.basename(f)}: ${err.message}`);
          errors++;
        }
      }
    } else {
      filesFixed += toFix.length;
    }
  }

  console.log('\nDone.');
  console.log(`  Folders fixed: ${foldersFixed.toLocaleString()}`);
  console.log(`  Files updated: ${filesFixed.toLocaleString()}`);
  if (errors > 0) console.log(`  Errors:        ${errors.toLocaleString()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
