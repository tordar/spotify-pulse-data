import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

// Catalog tracks: have a local_file_path but zero listening events.
// These are either legitimately untracked music, or files that failed to auto-match
// against a Spotify history track and need manual linking.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)
    const offset = parseInt(searchParams.get('offset') ?? '0')
    const filter = searchParams.get('q') ?? ''

    const db = getDb()

    const filterClause = filter
      ? `AND (t.name LIKE ? OR a.name LIKE ? OR al.name LIKE ?)`
      : ''
    const filterArgs = filter ? [`%${filter}%`, `%${filter}%`, `%${filter}%`] : []

    const [countResult, rows] = await Promise.all([
      db.execute({
        sql: `
          SELECT COUNT(*) as total
          FROM tracks t
          JOIN artists a ON a.id = t.artist_id
          JOIN albums al ON al.id = t.album_id
          WHERE t.local_file_path IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
            ${filterClause}
        `,
        args: filterArgs,
      }),
      db.execute({
        sql: `
          SELECT
            t.id, t.name as trackName, t.duration_ms,
            a.name as artistName,
            al.name as albumName,
            t.local_file_path,
            t.spotify_id
          FROM tracks t
          JOIN artists a ON a.id = t.artist_id
          JOIN albums al ON al.id = t.album_id
          WHERE t.local_file_path IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM listening_events le WHERE le.track_id = t.id)
            ${filterClause}
          ORDER BY a.name, al.name, t.name
          LIMIT ? OFFSET ?
        `,
        args: [...filterArgs, limit, offset],
      }),
    ])

    const total = Number((countResult.rows[0] as unknown as { total: number }).total)

    type Row = {
      id: number; trackName: string; duration_ms: number;
      artistName: string; albumName: string;
      local_file_path: string; spotify_id: string | null;
    }
    const tracks = rows.rows as unknown as Row[]

    return NextResponse.json({
      total,
      offset,
      limit,
      tracks: tracks.map(t => ({
        id: t.id,
        trackName: t.trackName,
        artistName: t.artistName,
        albumName: t.albumName,
        durationMs: t.duration_ms,
        localFilePath: t.local_file_path,
        spotifyId: t.spotify_id,
        // Derive a short display path (last 3 path segments)
        displayPath: t.local_file_path.split('/').slice(-3).join(' / '),
      })),
    })
  } catch (error) {
    console.error('mapping/unmatched error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
