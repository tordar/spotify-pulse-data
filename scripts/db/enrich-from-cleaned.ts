import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { getDatabase, closeDatabase } from './database';

function findLatestFile(pattern: string): string | null {
  const dir = path.join(__dirname, '..', '..', 'data', 'cleaned-data');
  const files = glob.sync(path.join(dir, pattern));
  if (files.length === 0) return null;
  files.sort();
  return files[files.length - 1];
}

function enrichFromCleaned(): void {
  const db = getDatabase();
  const startTime = Date.now();

  // Enrich from cleaned-songs (album images, artist genres, spotify URLs)
  const songsFile = findLatestFile('cleaned-songs-*.json');
  if (songsFile) {
    console.log(`Enriching from ${path.basename(songsFile)} ...`);
    const data = JSON.parse(fs.readFileSync(songsFile, 'utf-8'));
    const songs = data.songs || [];

    let albumsUpdated = 0;
    let artistsUpdated = 0;
    let tracksUpdated = 0;

    const updateAlbumImage = db.prepare(`
      UPDATE albums SET image_url = ?, updated_at = datetime('now')
      WHERE name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
        AND (image_url IS NULL OR image_url = '')
    `);

    const updateArtistGenres = db.prepare(`
      UPDATE artists SET genres = ?, updated_at = datetime('now')
      WHERE name = ? COLLATE NOCASE
        AND (genres IS NULL OR genres = '[]')
    `);

    const updateTrackSpotifyUrl = db.prepare(`
      UPDATE tracks SET updated_at = datetime('now')
      WHERE spotify_id = ?
    `);

    db.transaction(() => {
      for (const song of songs) {
        const albumName = song.album?.name;
        const artistName = song.artist?.name;
        const albumImages = song.album?.images;

        if (albumName && artistName && albumImages && albumImages.length > 0) {
          const primaryImage = albumImages[0]?.url;
          if (primaryImage) {
            const result = updateAlbumImage.run(primaryImage, albumName, artistName);
            if (result.changes > 0) albumsUpdated++;
          }
        }

        if (artistName && song.artist?.genres?.length > 0) {
          const result = updateArtistGenres.run(
            JSON.stringify(song.artist.genres),
            artistName,
          );
          if (result.changes > 0) artistsUpdated++;
        }
      }
    })();

    console.log(`  Album images updated: ${albumsUpdated}`);
    console.log(`  Artist genres updated: ${artistsUpdated}`);
  }

  // Enrich from cleaned-artists (artist images, follower counts)
  const artistsFile = findLatestFile('cleaned-artists-*.json');
  if (artistsFile) {
    console.log(`Enriching from ${path.basename(artistsFile)} ...`);
    const data = JSON.parse(fs.readFileSync(artistsFile, 'utf-8'));
    const artists = data.artists || [];

    let updated = 0;
    const updateArtist = db.prepare(`
      UPDATE artists SET
        image_url = COALESCE(NULLIF(?, ''), image_url),
        genres = CASE WHEN (genres IS NULL OR genres = '[]') AND ? != '[]' THEN ? ELSE genres END,
        spotify_id = COALESCE(NULLIF(?, ''), spotify_id),
        updated_at = datetime('now')
      WHERE name = ? COLLATE NOCASE
    `);

    db.transaction(() => {
      for (const a of artists) {
        const name = a.artist?.name;
        if (!name) continue;

        const imageUrl = a.artist?.images?.[0]?.url || '';
        const genres = JSON.stringify(a.artist?.genres || []);
        const spotifyId = a.primaryArtistId || '';

        const result = updateArtist.run(imageUrl, genres, genres, spotifyId, name);
        if (result.changes > 0) updated++;
      }
    })();

    console.log(`  Artists enriched: ${updated}`);
  }

  // Enrich from cleaned-albums-with-songs (album details, song details)
  const albumsFile = findLatestFile('cleaned-albums-with-songs-*.json');
  if (albumsFile) {
    console.log(`Enriching from ${path.basename(albumsFile)} ...`);
    const data = JSON.parse(fs.readFileSync(albumsFile, 'utf-8'));
    const albums = data.albums || [];

    let albumsUpdated = 0;
    let tracksUpdated = 0;

    const updateAlbum = db.prepare(`
      UPDATE albums SET
        image_url = COALESCE(NULLIF(?, ''), image_url),
        release_date = COALESCE(NULLIF(?, ''), release_date),
        album_type = COALESCE(NULLIF(?, ''), album_type),
        spotify_id = COALESCE(NULLIF(?, ''), spotify_id),
        total_tracks = COALESCE(?, total_tracks),
        updated_at = datetime('now')
      WHERE name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
    `);

    const updateTrack = db.prepare(`
      UPDATE tracks SET
        duration_ms = CASE WHEN duration_ms = 0 AND ? > 0 THEN ? ELSE duration_ms END,
        track_number = COALESCE(?, track_number),
        disc_number = COALESCE(?, disc_number),
        updated_at = datetime('now')
      WHERE spotify_id = ?
    `);

    db.transaction(() => {
      for (const alb of albums) {
        const albumName = alb.album?.name;
        const artistName = alb.album?.artists?.[0];
        if (!albumName || !artistName) continue;

        const imageUrl = alb.album?.images?.[0]?.url || '';
        const result = updateAlbum.run(
          imageUrl,
          alb.album?.release_date || '',
          alb.album?.album_type || '',
          alb.primaryAlbumId || '',
          alb.total_songs || null,
          albumName,
          artistName,
        );
        if (result.changes > 0) albumsUpdated++;

        if (alb.songs) {
          for (const song of alb.songs) {
            if (!song.songId) continue;
            const r = updateTrack.run(
              song.duration_ms || 0, song.duration_ms || 0,
              song.track_number ?? null,
              song.disc_number ?? null,
              song.songId,
            );
            if (r.changes > 0) tracksUpdated++;
          }
        }
      }
    })();

    console.log(`  Albums enriched: ${albumsUpdated}`);
    console.log(`  Tracks enriched: ${tracksUpdated}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  const albumsWithImg = (db.prepare(
    "SELECT COUNT(*) as c FROM albums WHERE image_url IS NOT NULL AND image_url != ''"
  ).get() as { c: number }).c;
  const totalAlbums = (db.prepare('SELECT COUNT(*) as c FROM albums').get() as { c: number }).c;
  const artistsWithImg = (db.prepare(
    "SELECT COUNT(*) as c FROM artists WHERE image_url IS NOT NULL AND image_url != ''"
  ).get() as { c: number }).c;
  const totalArtists = (db.prepare('SELECT COUNT(*) as c FROM artists').get() as { c: number }).c;

  console.log(`\nEnrichment complete in ${elapsed}s`);
  console.log(`  Albums with images: ${albumsWithImg}/${totalAlbums}`);
  console.log(`  Artists with images: ${artistsWithImg}/${totalArtists}`);

  closeDatabase();
}

if (require.main === module) {
  enrichFromCleaned();
}

export { enrichFromCleaned };
