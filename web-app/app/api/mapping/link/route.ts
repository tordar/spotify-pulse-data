import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

// POST: link a catalog track's local file to an existing DB track (which has listening events)
// Body: { catalogTrackId: number, targetTrackId: number }
// Effect:
//   1. Copy local_file_path from catalog track → target track, mark target as downloaded
//   2. Delete the catalog track (it was a duplicate created by the scan)
//
// POST with { catalogTrackId, skip: true }: mark the catalog track as skipped
// (i.e. it's legitimately not in Spotify history — keep it as a catalog-only track)
export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      catalogTrackId: number;
      targetTrackId?: number;
      skip?: boolean;
    }

    const { catalogTrackId, targetTrackId, skip } = body
    if (!catalogTrackId) {
      return NextResponse.json({ error: 'catalogTrackId required' }, { status: 400 })
    }

    const db = getDb()

    if (skip) {
      // Just add a spotify_id placeholder so it stops appearing in the unmatched list
      // Actually: insert a fake "skipped" flag — easiest is to set download_status = 'skipped'
      // but the track has a file so we leave it as downloaded and note it's catalog-only
      // We can signal "reviewed" by setting spotify_id to a sentinel or adding a note.
      // Simplest: set download_status to 'skipped' so it's filtered out of sldl
      await db.execute({
        sql: `UPDATE tracks SET download_status = 'skipped', updated_at = datetime('now') WHERE id = ?`,
        args: [catalogTrackId],
      })
      return NextResponse.json({ ok: true, action: 'skipped' })
    }

    if (!targetTrackId) {
      return NextResponse.json({ error: 'targetTrackId required when not skipping' }, { status: 400 })
    }

    // Get the catalog track's local_file_path
    const catalogResult = await db.execute({
      sql: `SELECT local_file_path FROM tracks WHERE id = ?`,
      args: [catalogTrackId],
    })
    const catalogTrack = catalogResult.rows[0] as unknown as { local_file_path: string | null }
    if (!catalogTrack?.local_file_path) {
      return NextResponse.json({ error: 'Catalog track has no local_file_path' }, { status: 400 })
    }

    const filePath = catalogTrack.local_file_path

    // Batch: update target track + delete catalog track
    await db.batch([
      {
        sql: `UPDATE tracks
              SET local_file_path = ?, download_status = 'downloaded', updated_at = datetime('now')
              WHERE id = ?`,
        args: [filePath, targetTrackId],
      },
      // Remove listening_events references to catalog track (there are none, but be safe)
      { sql: `DELETE FROM listening_events WHERE track_id = ?`, args: [catalogTrackId] },
      { sql: `DELETE FROM track_artists WHERE track_id = ?`, args: [catalogTrackId] },
      { sql: `DELETE FROM tracks WHERE id = ?`, args: [catalogTrackId] },
    ], 'write')

    return NextResponse.json({ ok: true, action: 'linked', filePath })
  } catch (error) {
    console.error('mapping/link error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
