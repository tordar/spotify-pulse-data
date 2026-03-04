import { getDatabase, closeDatabase } from './db/database';
import { lookupTrackMbid, lookupArtistMbid, lookupAlbumMbid } from './cleaner/utils/musicbrainz-api-client';

async function enrichMusicBrainzIds() {
  const db = getDatabase();

  // --- Artists ---
  const artists = db.prepare(
    `SELECT id, name, spotify_id FROM artists WHERE spotify_id IS NOT NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; spotify_id: string }>;

  console.log(`Artists to enrich: ${artists.length}`);
  let artistHits = 0;
  for (const artist of artists) {
    const mbid = await lookupArtistMbid(artist.spotify_id);
    if (mbid) {
      db.prepare(`UPDATE artists SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(mbid, artist.id);
      console.log(`  artist  ${artist.name} → ${mbid}`);
      artistHits++;
    } else {
      console.log(`  artist  ${artist.name} → not found`);
    }
  }

  // --- Albums ---
  const albums = db.prepare(
    `SELECT id, name, artist_name, spotify_id FROM albums WHERE spotify_id IS NOT NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; artist_name: string; spotify_id: string }>;

  console.log(`\nAlbums to enrich: ${albums.length}`);
  let albumHits = 0;
  for (const album of albums) {
    const mbid = await lookupAlbumMbid(album.spotify_id);
    if (mbid) {
      db.prepare(`UPDATE albums SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(mbid, album.id);
      console.log(`  album   ${album.artist_name} — ${album.name} → ${mbid}`);
      albumHits++;
    } else {
      console.log(`  album   ${album.artist_name} — ${album.name} → not found`);
    }
  }

  // --- Tracks ---
  const tracks = db.prepare(
    `SELECT id, name, spotify_id FROM tracks WHERE spotify_id IS NOT NULL AND musicbrainz_id IS NULL`
  ).all() as Array<{ id: number; name: string; spotify_id: string }>;

  console.log(`\nTracks to enrich: ${tracks.length}`);
  let trackHits = 0;
  for (const track of tracks) {
    const mbid = await lookupTrackMbid(track.spotify_id);
    if (mbid) {
      db.prepare(`UPDATE tracks SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(mbid, track.id);
      console.log(`  track   ${track.name} → ${mbid}`);
      trackHits++;
    } else {
      console.log(`  track   ${track.name} → not found`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Artists: ${artistHits}/${artists.length}`);
  console.log(`  Albums:  ${albumHits}/${albums.length}`);
  console.log(`  Tracks:  ${trackHits}/${tracks.length}`);

  closeDatabase();
}

enrichMusicBrainzIds().catch(err => {
  console.error(err);
  process.exit(1);
});
