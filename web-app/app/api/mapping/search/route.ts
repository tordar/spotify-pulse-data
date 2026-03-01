import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

// Search for existing DB tracks that have listening events (i.e. from Spotify history)
// but no local file yet — these are candidates to link an unmatched file to.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''
    if (!q.trim()) return NextResponse.json({ tracks: [] })

    const db = getDb()

    // Split into tokens so "candidate bowie" matches track="Candidate" + artist="Bowie"
    const tokens = q.trim().split(/\s+/).filter(Boolean)
    const tokenClauses = tokens
      .map(() => `(t.name LIKE ? OR a.name LIKE ? OR al.name LIKE ?)`)
      .join(' AND ')
    const tokenArgs = tokens.flatMap(tok => [`%${tok}%`, `%${tok}%`, `%${tok}%`])

    const { rows } = await db.execute({
      sql: `
        SELECT
          t.id, t.name as trackName, t.duration_ms,
          a.name as artistName,
          al.name as albumName,
          t.spotify_id,
          t.local_file_path,
          COUNT(le.id) as playCount
        FROM tracks t
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
        LEFT JOIN listening_events le ON le.track_id = t.id
        WHERE ${tokenClauses}
        GROUP BY t.id
        HAVING playCount > 0
        ORDER BY playCount DESC
        LIMIT 30
      `,
      args: tokenArgs,
    })

    type Row = {
      id: number; trackName: string; duration_ms: number;
      artistName: string; albumName: string;
      spotify_id: string | null; local_file_path: string | null; playCount: number;
    }
    const tracks = rows as unknown as Row[]

    return NextResponse.json({
      tracks: tracks.map(t => ({
        id: t.id,
        trackName: t.trackName,
        artistName: t.artistName,
        albumName: t.albumName,
        durationMs: t.duration_ms,
        spotifyId: t.spotify_id,
        hasFile: !!t.local_file_path,
        playCount: t.playCount,
      })),
    })
  } catch (error) {
    console.error('mapping/search error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
