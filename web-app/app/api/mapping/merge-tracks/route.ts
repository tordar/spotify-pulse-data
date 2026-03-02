/**
 * POST /api/mapping/merge-tracks
 *
 * Merges two duplicate track entries into one.
 *
 * Body: { keepId: number, mergeId: number }
 *
 * - All listening_events from mergeId are moved to keepId.
 *   Events whose played_at already exists on keepId are deduplicated (kept once).
 * - local_file_path is copied to keepId if keepId lacks one
 * - track_artists from mergeId are copied if missing on keepId
 * - mergeId is deleted
 * - Response includes the combined play count
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function POST(request: Request) {
  try {
    const body = await request.json() as { keepId: number; mergeId: number }
    const { keepId, mergeId } = body

    if (!keepId || !mergeId || keepId === mergeId) {
      return NextResponse.json({ error: 'keepId and mergeId must be different valid IDs' }, { status: 400 })
    }

    const db = getDb()

    // Verify both tracks exist
    const [keep, merge] = await Promise.all([
      db.execute({ sql: `SELECT id, name, local_file_path, download_status, spotify_id, track_number, disc_number, duration_ms FROM tracks WHERE id = ?`, args: [keepId] }),
      db.execute({ sql: `SELECT id, name, local_file_path, download_status, spotify_id, track_number, disc_number, duration_ms FROM tracks WHERE id = ?`, args: [mergeId] }),
    ])

    if (!keep.rows.length) return NextResponse.json({ error: `Track ${keepId} not found` }, { status: 404 })
    if (!merge.rows.length) return NextResponse.json({ error: `Track ${mergeId} not found` }, { status: 404 })

    type TrackRow = {
      id: number; name: string; local_file_path: string | null; download_status: string
      spotify_id: string | null; track_number: number | null; disc_number: number | null; duration_ms: number | null
    }
    const keepRow = keep.rows[0] as unknown as TrackRow
    const mergeRow = merge.rows[0] as unknown as TrackRow

    // 1. Move listening events from mergeId → keepId, skipping any played_at that
    //    already exists on keepId (genuine deduplication by timestamp).
    await db.execute({
      sql: `
        INSERT INTO listening_events (track_id, played_at, ms_played, source, conn_country, platform, created_at)
        SELECT ?, played_at, ms_played, source, conn_country, platform, created_at
        FROM listening_events
        WHERE track_id = ?
          AND played_at NOT IN (
            SELECT played_at FROM listening_events WHERE track_id = ?
          )
      `,
      args: [keepId, mergeId, keepId],
    })

    await db.execute({ sql: `DELETE FROM listening_events WHERE track_id = ?`, args: [mergeId] })

    // 2. Copy any missing fields from the merged track to the kept track:
    //    local_file_path, spotify_id, track_number, disc_number, duration_ms
    await db.execute({
      sql: `
        UPDATE tracks SET
          local_file_path  = CASE WHEN local_file_path  IS NULL AND ? IS NOT NULL THEN ? ELSE local_file_path  END,
          download_status  = CASE WHEN local_file_path  IS NULL AND ? IS NOT NULL THEN 'downloaded'            ELSE download_status  END,
          spotify_id       = CASE WHEN spotify_id       IS NULL AND ? IS NOT NULL THEN ? ELSE spotify_id       END,
          track_number     = CASE WHEN (track_number    IS NULL OR track_number  = 0) AND ? IS NOT NULL THEN ? ELSE track_number     END,
          disc_number      = CASE WHEN (disc_number     IS NULL OR disc_number   = 0) AND ? IS NOT NULL THEN ? ELSE disc_number      END,
          duration_ms      = CASE WHEN (duration_ms     IS NULL OR duration_ms   = 0) AND ? IS NOT NULL THEN ? ELSE duration_ms      END,
          updated_at       = datetime('now')
        WHERE id = ?
      `,
      args: [
        mergeRow.local_file_path, mergeRow.local_file_path,
        mergeRow.local_file_path,
        mergeRow.spotify_id, mergeRow.spotify_id,
        mergeRow.track_number, mergeRow.track_number,
        mergeRow.disc_number, mergeRow.disc_number,
        mergeRow.duration_ms, mergeRow.duration_ms,
        keepId,
      ],
    })

    // 3. Copy any track_artists entries missing on keepId
    await db.execute({
      sql: `
        INSERT OR IGNORE INTO track_artists (track_id, artist_id, role)
        SELECT ?, artist_id, role FROM track_artists WHERE track_id = ?
      `,
      args: [keepId, mergeId],
    })

    // 4. Delete the merged track
    await db.execute({ sql: `DELETE FROM track_artists WHERE track_id = ?`, args: [mergeId] })
    await db.execute({ sql: `DELETE FROM tracks WHERE id = ?`, args: [mergeId] })

    // 5. Return the final combined play count so the UI can update immediately
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as playCount FROM listening_events WHERE track_id = ?`,
      args: [keepId],
    })
    const combinedPlayCount = (countResult.rows[0] as unknown as { playCount: number }).playCount

    return NextResponse.json({
      ok: true,
      kept: keepRow.name,
      merged: mergeRow.name,
      combinedPlayCount,
      message: `Merged "${mergeRow.name}" into "${keepRow.name}" — ${combinedPlayCount} total plays`,
    })
  } catch (error) {
    console.error('merge-tracks error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
