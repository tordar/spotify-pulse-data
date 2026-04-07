import { getDatabase, closeDatabase } from './db/database';
import {
  lookupTrackMbid,
  lookupArtistMbid,
  lookupAlbumMbids,
  searchMusicBrainzArtist,
  searchMusicBrainzRelease,
  searchMusicBrainzRecording,
  getRecordingsFromRelease,
  type MbRecording,
} from './cleaner/utils/musicbrainz-api-client';

/** Strip edition/remaster/deluxe suffixes that Spotify adds but MusicBrainz often doesn't. */
function stripEditionSuffix(name: string): string {
  return name
    .replace(/\s*[-–—]\s*(deluxe|remaster|remast|bonus|expanded|special|collector|limited|super|ultimate|anniversary|mono|stereo|extended|original\s+motion).*$/i, '')
    .replace(/\s*[\[(].*?(deluxe|remaster|remast|bonus|expanded|special|collector|limited|super|ultimate|anniversary|edition|version|soundtrack|original\s+motion|extended|mono|stereo|\d{4}\s+remaster).*?[\])]/gi, '')
    .trim();
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchRecording(
  trackName: string,
  trackDurationMs: number,
  recordings: MbRecording[],
  usedIds: Set<string>,
): MbRecording | null {
  const normTrack = normalizeForMatch(trackName);
  let best: MbRecording | null = null;
  let bestScore = 0;

  for (const rec of recordings) {
    if (usedIds.has(rec.id)) continue;
    const normRec = normalizeForMatch(rec.title);

    let score = 0;
    if (normRec === normTrack) score = 4;
    else if (normRec.startsWith(normTrack) || normTrack.startsWith(normRec)) score = 3;
    else if (normRec.includes(normTrack) || normTrack.includes(normRec)) score = 2;

    if (score > 0 && trackDurationMs > 0 && rec.lengthMs) {
      if (Math.abs(rec.lengthMs - trackDurationMs) < 3000) score += 1;
    }

    if (score > bestScore) { bestScore = score; best = rec; }
  }

  return bestScore >= 3 ? best : null;
}

async function enrichMusicBrainzIds() {
  const db = getDatabase();

  const updateArtistStmt = db.prepare(
    `UPDATE artists SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updateAlbumStmt = db.prepare(
    `UPDATE albums SET musicbrainz_id = ?, musicbrainz_release_group_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const updateTrackStmt = db.prepare(
    `UPDATE tracks SET musicbrainz_id = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const getUnenrichedTracksForAlbum = db.prepare(
    `SELECT id, name, duration_ms FROM tracks WHERE album_id = ? AND musicbrainz_id IS NULL`
  );

  // ═══ Phase 1: Artists (skipped — already completed) ═════════════════════
  let artistHits = 0;

  // ═══ Phase 2: Albums (skipped — already completed) ═════════════════════
  let albumHits = 0;

  // ═══ Phase 3: Tracks via album recordings ═════════════════════════════════
  // For albums that already have a MB release ID, fetch the release's full
  // recording list and match tracks by name/duration — one API call per album
  // instead of one (or two) per track.

  const albumsForTrackEnrichment = db.prepare(`
    SELECT al.id, al.name, al.artist_name, al.musicbrainz_id
    FROM albums al
    WHERE al.musicbrainz_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM tracks t
        WHERE t.album_id = al.id AND t.musicbrainz_id IS NULL
      )
    ORDER BY al.id DESC
  `).all() as Array<{ id: number; name: string; artist_name: string; musicbrainz_id: string }>;

  const unenrichedTrackCount = (db.prepare(
    `SELECT COUNT(*) as c FROM tracks WHERE musicbrainz_id IS NULL`
  ).get() as { c: number }).c;

  console.log(`\nPhase 3 — Track enrichment via album recordings: ${albumsForTrackEnrichment.length} albums (${unenrichedTrackCount.toLocaleString()} unenriched tracks)`);
  let trackHitsViaAlbum = 0;

  for (let i = 0; i < albumsForTrackEnrichment.length; i++) {
    const album = albumsForTrackEnrichment[i];
    const tracks = getUnenrichedTracksForAlbum.all(album.id) as Array<{ id: number; name: string; duration_ms: number }>;
    if (tracks.length === 0) continue;

    const recordings = await getRecordingsFromRelease(album.musicbrainz_id);
    if (!recordings || recordings.length === 0) continue;

    const usedIds = new Set<string>();
    const matched: Array<{ trackId: number; mbid: string }> = [];

    for (const track of tracks) {
      const rec = matchRecording(track.name, track.duration_ms, recordings, usedIds);
      if (rec) {
        usedIds.add(rec.id);
        matched.push({ trackId: track.id, mbid: rec.id });
      }
    }

    // Last-remaining auto-match: 1 unmatched local ↔ 1 unmatched recording
    const unmatchedLocal = tracks.filter(t => !matched.some(m => m.trackId === t.id));
    const unmatchedRecs = recordings.filter(r => !usedIds.has(r.id));
    if (unmatchedLocal.length === 1 && unmatchedRecs.length === 1) {
      matched.push({ trackId: unmatchedLocal[0].id, mbid: unmatchedRecs[0].id });
    }

    if (matched.length > 0) {
      db.transaction(() => {
        for (const m of matched) updateTrackStmt.run(m.mbid, m.trackId);
      })();
      console.log(`  [${i + 1}/${albumsForTrackEnrichment.length}] ✓ ${album.artist_name} — ${album.name}: ${matched.length}/${tracks.length}`);
      trackHitsViaAlbum += matched.length;
    }
  }

  console.log(`Phase 3 result: ${trackHitsViaAlbum.toLocaleString()} tracks matched via album recordings`);

  // ═══ Phase 4: Remaining tracks via individual lookup ══════════════════════

  const tracksWithSpotify = db.prepare(
    `SELECT t.id, t.name, t.spotify_id, a.name as artist_name
     FROM tracks t
     LEFT JOIN artists a ON a.id = t.artist_id
     WHERE t.spotify_id IS NOT NULL AND t.musicbrainz_id IS NULL
     ORDER BY t.id DESC`
  ).all() as Array<{ id: number; name: string; spotify_id: string; artist_name: string }>;

  console.log(`\nPhase 4a — Remaining tracks to enrich (via Spotify): ${tracksWithSpotify.length.toLocaleString()}`);
  let trackHits = 0;
  for (let i = 0; i < tracksWithSpotify.length; i++) {
    const track = tracksWithSpotify[i];
    const mbid = await lookupTrackMbid(track.spotify_id) ?? await searchMusicBrainzRecording(track.name, track.artist_name);
    if (mbid) {
      updateTrackStmt.run(mbid, track.id);
      console.log(`  [${i + 1}/${tracksWithSpotify.length}] ✓ ${track.artist_name} — ${track.name} → ${mbid}`);
      trackHits++;
    } else {
      console.log(`  [${i + 1}/${tracksWithSpotify.length}] ✗ ${track.artist_name} — ${track.name} → not found`);
    }
  }

  const tracksWithoutSpotify = db.prepare(
    `SELECT t.id, t.name, a.name as artist_name
     FROM tracks t
     LEFT JOIN artists a ON a.id = t.artist_id
     WHERE t.spotify_id IS NULL AND t.musicbrainz_id IS NULL
     ORDER BY t.id DESC`
  ).all() as Array<{ id: number; name: string; artist_name: string }>;

  console.log(`\nPhase 4b — Remaining tracks to enrich (via name search): ${tracksWithoutSpotify.length.toLocaleString()}`);
  for (let i = 0; i < tracksWithoutSpotify.length; i++) {
    const track = tracksWithoutSpotify[i];
    const mbid = await searchMusicBrainzRecording(track.name, track.artist_name);
    if (mbid) {
      updateTrackStmt.run(mbid, track.id);
      console.log(`  [${i + 1}/${tracksWithoutSpotify.length}] ✓ ${track.artist_name} — ${track.name} → ${mbid}`);
      trackHits++;
    } else {
      console.log(`  [${i + 1}/${tracksWithoutSpotify.length}] ✗ ${track.artist_name} — ${track.name} → not found`);
    }
  }

  // ═══ Summary ══════════════════════════════════════════════════════════════

  console.log(`\nDone.`);
  console.log(`  Tracks (via album recordings): ${trackHitsViaAlbum.toLocaleString()}`);
  console.log(`  Tracks (via individual lookup): ${trackHits.toLocaleString()}`);
  console.log(`  Tracks total: ${(trackHitsViaAlbum + trackHits).toLocaleString()}`);

  closeDatabase();
}

enrichMusicBrainzIds().catch(err => {
  console.error(err);
  process.exit(1);
});
