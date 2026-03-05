import { getDatabase, closeDatabase } from './db/database';
import {
  lookupTrackMbid,
  lookupArtistMbid,
  lookupAlbumMbids,
  searchMusicBrainzArtist,
  searchMusicBrainzRelease,
  searchMusicBrainzRecording,
} from './cleaner/utils/musicbrainz-api-client';

async function enrichMusicBrainzIds() {
  const db = getDatabase();

  // --- Artists with Spotify ID ---
  const artistsWithSpotify = db.prepare(
    `SELECT id, name, spotify_id FROM artists WHERE spotify_id IS NOT NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; spotify_id: string }>;

  console.log(`Artists to enrich (via Spotify): ${artistsWithSpotify.length}`);
  let artistHits = 0;
  for (const artist of artistsWithSpotify) {
    const mbid = await lookupArtistMbid(artist.spotify_id) ?? await searchMusicBrainzArtist(artist.name);
    if (mbid) {
      db.prepare(`UPDATE artists SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`).run(mbid, artist.id);
      console.log(`  ✓ ${artist.name} → ${mbid}`);
      artistHits++;
    } else {
      console.log(`  ✗ ${artist.name} → not found`);
    }
  }

  // --- Artists without Spotify ID (search by name) ---
  const artistsWithoutSpotify = db.prepare(
    `SELECT id, name FROM artists WHERE spotify_id IS NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string }>;

  console.log(`\nArtists to enrich (via name search): ${artistsWithoutSpotify.length}`);
  for (const artist of artistsWithoutSpotify) {
    const mbid = await searchMusicBrainzArtist(artist.name);
    if (mbid) {
      db.prepare(`UPDATE artists SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`).run(mbid, artist.id);
      console.log(`  ✓ ${artist.name} → ${mbid}`);
      artistHits++;
    } else {
      console.log(`  ✗ ${artist.name} → not found`);
    }
  }

  // --- Albums with Spotify ID ---
  const albumsWithSpotify = db.prepare(
    `SELECT id, name, artist_name, spotify_id FROM albums WHERE spotify_id IS NOT NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; artist_name: string; spotify_id: string }>;

  console.log(`\nAlbums to enrich (via Spotify): ${albumsWithSpotify.length}`);
  let albumHits = 0;
  for (const album of albumsWithSpotify) {
    const result = await lookupAlbumMbids(album.spotify_id) ?? await searchMusicBrainzRelease(album.name, album.artist_name);
    if (result) {
      db.prepare(`UPDATE albums SET musicbrainz_id = ?, musicbrainz_release_group_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(result.releaseId, result.releaseGroupId, album.id);
      console.log(`  ✓ ${album.artist_name} — ${album.name} → ${result.releaseId} (rg: ${result.releaseGroupId})`);
      albumHits++;
    } else {
      console.log(`  ✗ ${album.artist_name} — ${album.name} → not found`);
    }
  }

  // --- Albums without Spotify ID (search by name) ---
  const albumsWithoutSpotify = db.prepare(
    `SELECT id, name, artist_name FROM albums WHERE spotify_id IS NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; artist_name: string }>;

  console.log(`\nAlbums to enrich (via name search): ${albumsWithoutSpotify.length}`);
  for (const album of albumsWithoutSpotify) {
    const result = await searchMusicBrainzRelease(album.name, album.artist_name);
    if (result) {
      db.prepare(`UPDATE albums SET musicbrainz_id = ?, musicbrainz_release_group_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(result.releaseId, result.releaseGroupId, album.id);
      console.log(`  ✓ ${album.artist_name} — ${album.name} → ${result.releaseId} (rg: ${result.releaseGroupId})`);
      albumHits++;
    } else {
      console.log(`  ✗ ${album.artist_name} — ${album.name} → not found`);
    }
  }

  // --- Tracks with Spotify ID ---
  const tracksWithSpotify = db.prepare(
    `SELECT t.id, t.name, t.spotify_id, a.name as artist_name
     FROM tracks t
     LEFT JOIN artists a ON a.id = t.artist_id
     WHERE t.spotify_id IS NOT NULL AND t.musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; spotify_id: string; artist_name: string }>;

  console.log(`\nTracks to enrich (via Spotify): ${tracksWithSpotify.length}`);
  let trackHits = 0;
  for (const track of tracksWithSpotify) {
    const mbid = await lookupTrackMbid(track.spotify_id) ?? await searchMusicBrainzRecording(track.name, track.artist_name);
    if (mbid) {
      db.prepare(`UPDATE tracks SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`).run(mbid, track.id);
      console.log(`  ✓ ${track.artist_name} — ${track.name} → ${mbid}`);
      trackHits++;
    } else {
      console.log(`  ✗ ${track.artist_name} — ${track.name} → not found`);
    }
  }

  // --- Tracks without Spotify ID (search by name) ---
  const tracksWithoutSpotify = db.prepare(
    `SELECT t.id, t.name, a.name as artist_name
     FROM tracks t
     LEFT JOIN artists a ON a.id = t.artist_id
     WHERE t.spotify_id IS NULL AND t.musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; artist_name: string }>;

  console.log(`\nTracks to enrich (via name search): ${tracksWithoutSpotify.length}`);
  for (const track of tracksWithoutSpotify) {
    const mbid = await searchMusicBrainzRecording(track.name, track.artist_name);
    if (mbid) {
      db.prepare(`UPDATE tracks SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`).run(mbid, track.id);
      console.log(`  ✓ ${track.artist_name} — ${track.name} → ${mbid}`);
      trackHits++;
    } else {
      console.log(`  ✗ ${track.artist_name} — ${track.name} → not found`);
    }
  }

  const totalArtists = artistsWithSpotify.length + artistsWithoutSpotify.length;
  const totalAlbums = albumsWithSpotify.length + albumsWithoutSpotify.length;
  const totalTracks = tracksWithSpotify.length + tracksWithoutSpotify.length;

  console.log(`\nDone.`);
  console.log(`  Artists: ${artistHits}/${totalArtists}`);
  console.log(`  Albums:  ${albumHits}/${totalAlbums}`);
  console.log(`  Tracks:  ${trackHits}/${totalTracks}`);

  closeDatabase();
}

enrichMusicBrainzIds().catch(err => {
  console.error(err);
  process.exit(1);
});
