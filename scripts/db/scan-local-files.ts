import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { parseFile, type IAudioMetadata } from 'music-metadata';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
} from './database';

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.wma', '.alac', '.aiff', '.ape', '.wv',
]);

interface ScanResult {
  totalFiles: number;
  matchedToDb: number;
  addedAsCatalog: number;
  skippedNonAudio: number;
  errors: number;
}

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
    // Disc-track format first: "1-04 ", "2-01. ", "1-04 - "
    .replace(/^\d{1,2}-\d{1,3}[\s.\-_]+/, '')
    // Simple track/catalog number: "04 ", "04. ", "04 - ", "04_"
    .replace(/^\d{1,3}[\s.\-_]+/, '')
    .trim();
}

function stripArtistNumber(s: string): string {
  // Strip catalog-style number prefixes from artist tags: "04. Social Distortion" → "Social Distortion"
  // Only match "digits + dot + space" — avoids stripping real artist names like "10cc" or "2PAC"
  return s.replace(/^\d{1,3}\.\s+/, '').trim();
}

function titleFromFilename(filename: string): string {
  const name = path.basename(filename, path.extname(filename));
  return stripTrackNumber(name);
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

function tryMatchTrack(
  db: Database.Database,
  artist: string,
  title: string,
  album: string | null,
  durationMs: number,
): number | null {
  const normArtist = normalize(artist);
  const normTitle = normalize(title);

  // Strategy 1: exact artist + title match
  let candidates = db.prepare(`
    SELECT t.id, t.name, t.duration_ms, a.name as artist_name, al.name as album_name
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NULL
  `).all() as Array<{
    id: number; name: string; duration_ms: number;
    artist_name: string; album_name: string;
  }>;

  // This full-table scan would be slow on repeated calls, so use a pre-built lookup instead
  // But for correctness let's do a targeted query
  candidates = db.prepare(`
    SELECT t.id, t.name, t.duration_ms, a.name as artist_name, al.name as album_name
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NULL
      AND a.name = ? COLLATE NOCASE
      AND t.name = ? COLLATE NOCASE
  `).all(artist, title) as Array<{
    id: number; name: string; duration_ms: number;
    artist_name: string; album_name: string;
  }>;

  if (candidates.length === 1) return candidates[0].id;

  if (candidates.length > 1) {
    // Disambiguate by album name
    if (album) {
      const albumMatch = candidates.find(c => normalize(c.album_name) === normalize(album));
      if (albumMatch) return albumMatch.id;
    }
    // Disambiguate by duration (within 5s tolerance)
    if (durationMs > 0) {
      const durMatch = candidates.find(c =>
        c.duration_ms > 0 && Math.abs(c.duration_ms - durationMs) < 5000
      );
      if (durMatch) return durMatch.id;
    }
    // Take the first if all else fails
    return candidates[0].id;
  }

  // Strategy 2: normalized matching (handles slight spelling differences)
  const fuzzyResult = db.prepare(`
    SELECT t.id, t.name, a.name as artist_name
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    WHERE t.local_file_path IS NULL
  `).all() as Array<{ id: number; name: string; artist_name: string }>;

  for (const row of fuzzyResult) {
    if (normalize(row.artist_name) === normArtist && normalize(row.name) === normTitle) {
      return row.id;
    }
  }

  return null;
}

async function scanLocalFiles(musicDir: string): Promise<void> {
  if (!fs.existsSync(musicDir)) {
    console.error(`Directory not found: ${musicDir}`);
    process.exit(1);
  }

  console.log(`Scanning ${musicDir} for audio files...`);
  const allFiles = walkDir(musicDir);
  console.log(`Found ${allFiles.length.toLocaleString()} audio files`);

  const db = getDatabase();

  // Pre-build a normalized lookup for faster fuzzy matching
  const allUnmatchedTracks = db.prepare(`
    SELECT t.id, t.name, a.name as artist_name, al.name as album_name, t.duration_ms
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    WHERE t.local_file_path IS NULL
  `).all() as Array<{
    id: number; name: string; artist_name: string; album_name: string; duration_ms: number;
  }>;

  const normLookup = new Map<string, Array<typeof allUnmatchedTracks[0]>>();
  for (const track of allUnmatchedTracks) {
    const key = `${normalize(track.artist_name)}|||${normalize(track.name)}`;
    const existing = normLookup.get(key) || [];
    existing.push(track);
    normLookup.set(key, existing);
  }

  const matchedIds = new Set<number>();
  const result: ScanResult = {
    totalFiles: allFiles.length,
    matchedToDb: 0,
    addedAsCatalog: 0,
    skippedNonAudio: 0,
    errors: 0,
  };

  const updateTrackPath = db.prepare(`
    UPDATE tracks SET local_file_path = ?, download_status = 'downloaded', updated_at = datetime('now')
    WHERE id = ?
  `);

  const processBatch = db.transaction((files: string[]) => {
    for (const filePath of files) {
      processFile(filePath);
    }
  });

  const unmatchedFiles: Array<{ path: string; artist?: string; title?: string; album?: string }> = [];

  function matchFromLookup(
    artist: string,
    title: string,
    album: string | null,
    durationMs: number,
  ): number | null {
    const key = `${normalize(artist)}|||${normalize(title)}`;
    const candidates = normLookup.get(key);
    if (!candidates || candidates.length === 0) return null;

    const unmatched = candidates.filter(c => !matchedIds.has(c.id));
    if (unmatched.length === 0) return null;

    if (unmatched.length === 1) return unmatched[0].id;

    // Disambiguate by album
    if (album) {
      const normAlbum = normalize(album);
      const albumMatch = unmatched.find(c => normalize(c.album_name) === normAlbum);
      if (albumMatch) return albumMatch.id;
    }

    // Disambiguate by duration
    if (durationMs > 0) {
      const durMatch = unmatched.find(c =>
        c.duration_ms > 0 && Math.abs(c.duration_ms - durationMs) < 5000
      );
      if (durMatch) return durMatch.id;
    }

    return unmatched[0].id;
  }

  let metadataCache: { artist: string; title: string; album: string; durationMs: number } | null = null;

  function processFile(filePath: string): void {
    const cache = metadataCache;
    metadataCache = null;

    let artist = cache?.artist || '';
    let title = cache?.title || '';
    let album = cache?.album || '';
    let durationMs = cache?.durationMs || 0;

    // If no metadata was pre-loaded, parse from path
    if (!artist && !title) {
      const relativePath = path.relative(musicDir, filePath);
      const parts = relativePath.split(path.sep);

      if (parts.length >= 3) {
        artist = parts[0];
        album = parts[1];
        title = titleFromFilename(parts[parts.length - 1]);
      } else if (parts.length === 2) {
        artist = parts[0];
        title = titleFromFilename(parts[1]);
      } else {
        title = titleFromFilename(parts[0]);
      }
    }

    if (!title) {
      result.errors++;
      return;
    }

    // Try to match to existing DB track
    const trackId = matchFromLookup(artist, title, album || null, durationMs);

    if (trackId && !matchedIds.has(trackId)) {
      matchedIds.add(trackId);
      updateTrackPath.run(filePath, trackId);
      result.matchedToDb++;
    } else {
      // Add as new catalog track
      const artistId = upsertArtist(db, artist || 'Unknown Artist');
      const albumId = upsertAlbum(db, album || 'Unknown Album', artist || 'Unknown Artist');
      const newTrackId = upsertTrack(db, {
        name: title,
        albumId,
        artistId,
        durationMs,
      });

      updateTrackPath.run(filePath, newTrackId);
      db.prepare(
        `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
      ).run(newTrackId, artistId);
      result.addedAsCatalog++;
    }
  }

  // Process files: first read metadata, then match
  const BATCH_SIZE = 200;
  const startTime = Date.now();

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);

    // Read metadata for the batch
    const metadataEntries: Array<{
      filePath: string;
      artist: string;
      title: string;
      album: string;
      durationMs: number;
    }> = [];

    for (const filePath of batch) {
      try {
        const meta: IAudioMetadata = await parseFile(filePath, { skipCovers: true, duration: true }) as any;
        const common = meta.common;
        // Strip number prefixes from both artist and title — some taggers embed
        // "04. Social Distortion" as artist or "1-04 Song Name" as title
        const rawArtist = common?.artist || common?.albumartist || '';
        const artist = rawArtist ? stripArtistNumber(rawArtist) : '';
        const title = common?.title ? stripTrackNumber(common.title) : '';
        const album = common?.album || '';
        const durationMs = meta.format?.duration ? Math.round(meta.format.duration * 1000) : 0;

        metadataEntries.push({ filePath, artist, title, album, durationMs });
      } catch {
        // Metadata read failed; use path-based fallback
        metadataEntries.push({ filePath, artist: '', title: '', album: '', durationMs: 0 });
      }
    }

    // Process in a transaction
    db.transaction(() => {
      for (const entry of metadataEntries) {
        metadataCache = {
          artist: entry.artist,
          title: entry.title,
          album: entry.album,
          durationMs: entry.durationMs,
        };
        processFile(entry.filePath);
      }
    })();

    if ((i + BATCH_SIZE) % 2000 < BATCH_SIZE) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const total = result.matchedToDb + result.addedAsCatalog;
      console.log(`  Scanned ${Math.min(i + BATCH_SIZE, allFiles.length)}/${allFiles.length} files — ${total} processed (${elapsed}s)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nScan complete in ${elapsed}s`);
  console.log(`  Total audio files:        ${result.totalFiles.toLocaleString()}`);
  console.log(`  Matched to DB tracks:     ${result.matchedToDb.toLocaleString()}`);
  console.log(`  Added as catalog tracks:  ${result.addedAsCatalog.toLocaleString()}`);
  console.log(`  Errors:                   ${result.errors.toLocaleString()}`);

  // Show updated status breakdown
  const statusBreakdown = db.prepare(`
    SELECT download_status, COUNT(*) as c FROM tracks GROUP BY download_status ORDER BY c DESC
  `).all() as { download_status: string; c: number }[];

  console.log('\n  Download status after scan:');
  for (const row of statusBreakdown) {
    console.log(`    ${row.download_status}: ${row.c.toLocaleString()}`);
  }

  closeDatabase();
}

// CLI entry point
if (require.main === module) {
  const musicDir = process.argv[2];
  if (!musicDir) {
    console.error('Usage: tsx scripts/db/scan-local-files.ts <music-directory>');
    console.error('  e.g. tsx scripts/db/scan-local-files.ts /volume1/MyDrive/Music/Music');
    process.exit(1);
  }
  scanLocalFiles(path.resolve(musicDir));
}

export { scanLocalFiles };
