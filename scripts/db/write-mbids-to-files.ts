/**
 * write-mbids-to-files.ts
 *
 * Reads MusicBrainz IDs and album artwork from library.db and writes them
 * directly into the embedded tags of local audio files.
 *
 * Tags written:
 *   musicBrainzTrackId   ← tracks.musicbrainz_id  (recording MBID)
 *   musicBrainzReleaseId ← albums.musicbrainz_id   (release MBID)
 *   musicBrainzArtistId  ← artists.musicbrainz_id  (artist MBID)
 *   pictures             ← albums.image_url         (cover art, if missing)
 *
 * Usage:
 *   tsx scripts/db/write-mbids-to-files.ts
 *   tsx scripts/db/write-mbids-to-files.ts --dry-run
 *   tsx scripts/db/write-mbids-to-files.ts --artist "The Beatles"
 *   tsx scripts/db/write-mbids-to-files.ts --no-art   (skip artwork embedding)
 */

import Database from 'better-sqlite3';
import { File as TagFile, Picture, PictureType, ByteVector } from 'node-taglib-sharp';
import NodeID3 from 'node-id3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.resolve(__dirname, '../../data/library.db');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_ART  = process.argv.includes('--no-art');
const ARTIST_FILTER = (() => {
  const idx = process.argv.indexOf('--artist');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

interface TrackRow {
  id: number;
  local_file_path: string;
  track_mbid: string | null;
  album_mbid: string | null;
  artist_mbid: string | null;
  image_url: string | null;
  track_number: number | null;
  disc_number: number | null;
  artist_name: string;
  album_name: string;
  track_name: string;
}

function buildQuery(artistFilter: string | null): string {
  const artistClause = artistFilter
    ? `AND ar.name = '${artistFilter.replace(/'/g, "''")}'`
    : '';

  return `
    SELECT
      t.id,
      t.local_file_path,
      t.musicbrainz_id   AS track_mbid,
      al.musicbrainz_id  AS album_mbid,
      ar.musicbrainz_id  AS artist_mbid,
      al.image_url       AS image_url,
      t.track_number     AS track_number,
      t.disc_number      AS disc_number,
      ar.name            AS artist_name,
      al.name            AS album_name,
      t.name             AS track_name
    FROM tracks t
    JOIN artists ar ON ar.id = t.artist_id
    JOIN albums  al ON al.id = t.album_id
    WHERE t.local_file_path IS NOT NULL
      AND t.local_file_path <> ''
      AND (
        (t.musicbrainz_id  IS NOT NULL AND t.musicbrainz_id  <> '') OR
        (al.musicbrainz_id IS NOT NULL AND al.musicbrainz_id <> '') OR
        (ar.musicbrainz_id IS NOT NULL AND ar.musicbrainz_id <> '') OR
        (al.image_url      IS NOT NULL AND al.image_url      <> '')
      )
      ${artistClause}
    ORDER BY ar.name, al.name, t.track_number
  `;
}

function writeTagsWithNodeId3(
  filePath: string,
  track: TrackRow,
  imageBuffer: Buffer | null,
): void {
  const existingTags = NodeID3.read(filePath);
  const userDefinedText: Array<{ description: string; value: string }> =
    Array.isArray(existingTags.userDefinedText) ? [...existingTags.userDefinedText] : [];

  function setUdt(description: string, value: string) {
    const idx = userDefinedText.findIndex(u => u.description === description);
    if (idx >= 0) userDefinedText[idx] = { description, value };
    else userDefinedText.push({ description, value });
  }

  if (track.track_mbid)  setUdt('MusicBrainz Recording Id', track.track_mbid);
  if (track.album_mbid)  setUdt('MusicBrainz Release Id',   track.album_mbid);
  if (track.artist_mbid) setUdt('MusicBrainz Artist Id',    track.artist_mbid);

  const tags: NodeID3.Tags = { userDefinedText };

  if (track.track_number) tags.trackNumber = String(track.track_number);
  if (track.disc_number)  tags.partOfSet   = String(track.disc_number);

  if (imageBuffer && !(existingTags.image)) {
    tags.image = {
      mime: 'image/jpeg',
      type: { id: 3, name: 'Front Cover' },
      description: 'Cover',
      imageBuffer,
    };
  }

  NodeID3.update(tags, filePath);
}

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const tracks = db.prepare(buildQuery(ARTIST_FILTER)).all() as TrackRow[];
  db.close();

  console.log(`Found ${tracks.length.toLocaleString()} tracks to process${ARTIST_FILTER ? ` for "${ARTIST_FILTER}"` : ''}`);
  if (DRY_RUN) console.log('DRY RUN — no files will be modified');
  if (NO_ART)  console.log('Skipping artwork embedding (--no-art)');
  console.log();

  // Cache downloaded images by URL — one download per album
  const imageCache = new Map<string, Buffer | null>();

  let updated = 0;
  let skipped = 0;
  let missing = 0;
  let errors  = 0;
  let artEmbedded = 0;

  for (const track of tracks) {
    if (!fs.existsSync(track.local_file_path)) {
      missing++;
      continue;
    }

    // Fetch artwork if needed (outside try so fallback can use it too)
    let imageBuffer: Buffer | null = null;
    if (!NO_ART && !DRY_RUN && track.image_url) {
      if (!imageCache.has(track.image_url)) {
        imageCache.set(track.image_url, await fetchImageBuffer(track.image_url));
      }
      imageBuffer = imageCache.get(track.image_url) ?? null;
    }

    try {
      const f = TagFile.createFromPath(track.local_file_path);
      const tag = f.tag;

      const currentTrackMbid   = tag.musicBrainzTrackId;
      const currentReleaseMbid = tag.musicBrainzReleaseId;
      const currentArtistMbid  = tag.musicBrainzArtistId;
      const hasArt = tag.pictures && tag.pictures.length > 0;

      const mbidNeedsUpdate =
        (track.track_mbid  && track.track_mbid  !== currentTrackMbid)  ||
        (track.album_mbid  && track.album_mbid  !== currentReleaseMbid) ||
        (track.artist_mbid && track.artist_mbid !== currentArtistMbid)  ||
        (track.track_number && track.track_number !== tag.track)        ||
        (track.disc_number  && track.disc_number  !== tag.disc);

      const artNeedsUpdate = !NO_ART && !hasArt && !!track.image_url;

      if (!mbidNeedsUpdate && !artNeedsUpdate) {
        f.dispose();
        skipped++;
        continue;
      }

      if (!DRY_RUN) {
        if (mbidNeedsUpdate) {
          if (track.track_mbid)  tag.musicBrainzTrackId   = track.track_mbid;
          if (track.album_mbid)  tag.musicBrainzReleaseId = track.album_mbid;
          if (track.artist_mbid) tag.musicBrainzArtistId  = track.artist_mbid;
          if (track.track_number) tag.track = track.track_number;
          if (track.disc_number)  tag.disc  = track.disc_number;
        }
        if (artNeedsUpdate && imageBuffer) {
          const pic = Picture.fromData(ByteVector.fromByteArray(imageBuffer));
          pic.type = PictureType.FrontCover;
          pic.mimeType = 'image/jpeg';
          tag.pictures = [pic];
          artEmbedded++;
        }
        f.save();
      }

      f.dispose();
      updated++;

      if (DRY_RUN || updated <= 5) {
        console.log(`  ${DRY_RUN ? '[dry]' : '✓'} ${track.artist_name} - ${track.album_name} - ${track.track_name}`);
        if (mbidNeedsUpdate) {
          if (track.track_mbid  && track.track_mbid  !== currentTrackMbid)  console.log(`      recording: ${track.track_mbid}`);
          if (track.album_mbid  && track.album_mbid  !== currentReleaseMbid) console.log(`      release:   ${track.album_mbid}`);
          if (track.artist_mbid && track.artist_mbid !== currentArtistMbid)  console.log(`      artist:    ${track.artist_mbid}`);
        }
        if (artNeedsUpdate) console.log(`      artwork:   ${imageBuffer ? 'fetched' : 'fetch failed'}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('MPEG audio header not found')) {
        // Fallback: use node-id3 for MP3s that taglib can't parse
        try {
          if (!DRY_RUN) writeTagsWithNodeId3(track.local_file_path, track, imageBuffer);
          updated++;
          if (DRY_RUN || updated <= 5) {
            console.log(`  ${DRY_RUN ? '[dry]' : '✓'} ${track.artist_name} - ${track.album_name} - ${track.track_name} (fallback)`);
          }
        } catch (fallbackErr) {
          errors++;
          if (errors <= 10) {
            console.error(`  ✗ ${track.artist_name} - ${track.track_name}: ${(fallbackErr as Error).message}`);
          }
        }
      } else {
        errors++;
        if (errors <= 10) {
          console.error(`  ✗ ${track.artist_name} - ${track.track_name}: ${msg}`);
        }
      }
    }

    if (!DRY_RUN && updated % 500 === 0 && updated > 0) {
      console.log(`  ... ${updated.toLocaleString()} updated so far`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Updated:        ${updated.toLocaleString()}`);
  console.log(`  Art embedded:   ${artEmbedded.toLocaleString()}`);
  console.log(`  Already tagged: ${skipped.toLocaleString()}`);
  console.log(`  File missing:   ${missing.toLocaleString()}`);
  console.log(`  Errors:         ${errors.toLocaleString()}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
