import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  getDatabase,
  closeDatabase,
  upsertArtist,
  upsertAlbum,
  upsertTrack,
  insertListeningEvent,
  logImport,
  hasBeenImported,
} from './database';
import type { CompleteSong } from '../cleaner/utils/types';

interface MergedHistoryFile {
  metadata?: {
    totalSongs?: number;
    totalListeningTime?: number;
    dateRange?: { earliest: string; latest: string };
    source?: string;
    lastUpdated?: string;
  };
  songs: CompleteSong[];
}

interface ConsolidationRule {
  artistName: string;
  baseAlbumName: string;
  variations: string[];
}

function loadConsolidationRules(): Map<string, string> {
  const rulesPath = path.join(__dirname, '..', '..', 'data', 'album-consolidation-rules.json');
  const map = new Map<string, string>();

  if (!fs.existsSync(rulesPath)) return map;

  const data = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) as { rules: ConsolidationRule[] };
  for (const rule of data.rules) {
    const artistKey = rule.artistName.toLowerCase().trim();
    for (const variation of rule.variations) {
      const key = `${artistKey}|||${variation.toLowerCase().trim()}`;
      map.set(key, rule.baseAlbumName);
    }
  }
  return map;
}

function consolidateAlbumName(
  artistName: string,
  albumName: string,
  rules: Map<string, string>,
): string {
  const key = `${artistName.toLowerCase().trim()}|||${albumName.toLowerCase().trim()}`;
  return rules.get(key) ?? albumName;
}

function findLatestMergedHistory(): string | null {
  const dir = path.join(__dirname, '..', '..', 'data', 'merged-streaming-history');
  if (!fs.existsSync(dir)) return null;

  const files = glob.sync(path.join(dir, 'merged-streaming-history-*.json'));
  if (files.length === 0) return null;

  files.sort((a, b) => {
    const tsA = parseInt(path.basename(a).match(/(\d+)/)?.[1] || '0');
    const tsB = parseInt(path.basename(b).match(/(\d+)/)?.[1] || '0');
    return tsB - tsA;
  });

  return files[0];
}

function importHistory(): void {
  const historyPath = findLatestMergedHistory();
  if (!historyPath) {
    console.error('No merged streaming history file found.');
    process.exit(1);
  }

  const sourceId = path.basename(historyPath);
  const db = getDatabase();

  if (hasBeenImported(db, 'merged-history', sourceId)) {
    console.log(`Already imported: ${sourceId}`);
    closeDatabase();
    return;
  }

  console.log(`Loading ${sourceId} ...`);
  const raw: MergedHistoryFile = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  const songs = raw.songs;
  console.log(`Loaded ${songs.length} songs`);

  const consolidationRules = loadConsolidationRules();
  console.log(`Loaded ${consolidationRules.size} album consolidation mappings`);

  let totalEventsInserted = 0;
  let songsProcessed = 0;
  const startTime = Date.now();

  const BATCH_SIZE = 500;
  const insertBatch = db.transaction((batch: CompleteSong[]) => {
    for (const song of batch) {
      const artistName = song.artist?.name || song.artists?.[0] || 'Unknown Artist';
      const albumName = consolidateAlbumName(
        artistName,
        song.album?.name || 'Unknown Album',
        consolidationRules,
      );

      const artistId = upsertArtist(db, artistName, null, song.artist?.genres);

      const albumImageUrl = song.album?.images?.[0]?.url ?? null;
      const albumId = upsertAlbum(db, albumName, artistName, {
        spotifyId: song.album?.id || null,
        imageUrl: albumImageUrl,
      });

      const spotifyId = song.songId || null;
      const trackId = upsertTrack(db, {
        name: song.name,
        albumId,
        artistId,
        durationMs: song.duration_ms || 0,
        spotifyId,
      });

      // Insert additional artists via track_artists
      if (song.artists && song.artists.length > 1) {
        for (let i = 1; i < song.artists.length; i++) {
          const featArtistId = upsertArtist(db, song.artists[i]);
          db.prepare(
            `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'featured')`
          ).run(trackId, featArtistId);
        }
      }
      // Primary artist link
      db.prepare(
        `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role) VALUES (?, ?, 'primary')`
      ).run(trackId, artistId);

      for (const evt of song.listeningEvents || []) {
        insertListeningEvent(
          db,
          trackId,
          evt.playedAt,
          evt.msPlayed,
          'spotify',
          evt.conn_country ?? null,
        );
        totalEventsInserted++;
      }

      songsProcessed++;
    }
  });

  // Process in batches
  for (let i = 0; i < songs.length; i += BATCH_SIZE) {
    const batch = songs.slice(i, i + BATCH_SIZE);
    insertBatch(batch);

    if ((i + BATCH_SIZE) % 5000 < BATCH_SIZE) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, songs.length)}/${songs.length} songs (${elapsed}s)`);
    }
  }

  logImport(db, 'merged-history', sourceId, totalEventsInserted);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const artistCount = (db.prepare('SELECT COUNT(*) as c FROM artists').get() as { c: number }).c;
  const albumCount = (db.prepare('SELECT COUNT(*) as c FROM albums').get() as { c: number }).c;
  const trackCount = (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number }).c;
  const eventCount = (db.prepare('SELECT COUNT(*) as c FROM listening_events').get() as { c: number }).c;

  console.log(`\nImport complete in ${elapsed}s`);
  console.log(`  Artists:          ${artistCount.toLocaleString()}`);
  console.log(`  Albums:           ${albumCount.toLocaleString()}`);
  console.log(`  Tracks:           ${trackCount.toLocaleString()}`);
  console.log(`  Listening events: ${eventCount.toLocaleString()}`);

  closeDatabase();
}

if (require.main === module) {
  importHistory();
}

export { importHistory };
