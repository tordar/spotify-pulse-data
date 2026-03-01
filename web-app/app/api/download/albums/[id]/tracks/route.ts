import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const albumId = parseInt(id)
    if (isNaN(albumId)) return NextResponse.json({ error: 'Invalid album id' }, { status: 400 })

    const db = getDb()

    const { rows } = await db.execute({
      sql: `
        SELECT
          t.id,
          t.name,
          t.track_number as trackNumber,
          t.disc_number as discNumber,
          t.duration_ms as durationMs,
          t.spotify_id as spotifyId,
          t.local_file_path as localFilePath,
          t.download_status as downloadStatus,
          a.name as artistName,
          COUNT(le.id) as playCount
        FROM tracks t
        JOIN artists a ON a.id = t.artist_id
        LEFT JOIN listening_events le ON le.track_id = t.id
        WHERE t.album_id = ?
        GROUP BY t.id
        ORDER BY t.disc_number, t.track_number, t.name
      `,
      args: [albumId],
    })

    type Row = {
      id: number; name: string; trackNumber: number | null; discNumber: number | null
      durationMs: number; spotifyId: string | null; localFilePath: string | null
      downloadStatus: string; artistName: string; playCount: number
    }

    const tracks = (rows as unknown as Row[]).map(r => ({
      id: r.id,
      name: r.name,
      trackNumber: r.trackNumber,
      discNumber: r.discNumber,
      durationMs: r.durationMs,
      spotifyId: r.spotifyId,
      localFilePath: r.localFilePath,
      downloadStatus: r.downloadStatus,
      artistName: r.artistName,
      playCount: r.playCount,
    }))

    return NextResponse.json({ tracks })
  } catch (error) {
    console.error('download/albums/[id]/tracks error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
