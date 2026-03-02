import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''
    const sort = searchParams.get('sort') ?? 'plays'
    const minPlays = parseInt(searchParams.get('minPlays') ?? '0')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)
    const offset = parseInt(searchParams.get('offset') ?? '0')

    const db = getDb()

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (q.trim()) {
      conditions.push(`a.name LIKE ?`)
      args.push(`%${q}%`)
    }

    const having = minPlays > 0 ? `HAVING playCount >= ${minPlays}` : ''
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const orderBy = {
      plays: 'playCount DESC, a.name',
      az: 'a.name',
      downloaded: 'downloadedTracks DESC, playCount DESC',
    }[sort] ?? 'playCount DESC, a.name'

    const sql = `
      SELECT
        a.id,
        a.name,
        a.image_url        as imageUrl,
        a.spotify_id       as spotifyId,
        COUNT(DISTINCT t.id)   as trackCount,
        COUNT(DISTINCT CASE WHEN t.local_file_path IS NOT NULL THEN t.id END) as downloadedTracks,
        COUNT(DISTINCT CASE WHEN t.download_status IN ('pending','failed') AND t.local_file_path IS NULL THEN t.id END) as pendingTracks,
        COALESCE(SUM(le_counts.cnt), 0) as playCount
      FROM artists a
      LEFT JOIN tracks t ON t.artist_id = a.id
      LEFT JOIN (
        SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
      ) le_counts ON le_counts.track_id = t.id
      ${where}
      GROUP BY a.id
      ${having}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT a.id, COALESCE(SUM(le_counts.cnt), 0) as playCount
        FROM artists a
        LEFT JOIN tracks t ON t.artist_id = a.id
        LEFT JOIN (
          SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
        ) le_counts ON le_counts.track_id = t.id
        ${where}
        GROUP BY a.id
        ${having}
      )
    `

    const [countResult, result] = await Promise.all([
      db.execute({ sql: countSql, args }),
      db.execute({ sql, args: [...args, limit, offset] }),
    ])

    const total = (countResult.rows[0] as unknown as { total: number }).total

    type Row = {
      id: number; name: string; imageUrl: string | null; spotifyId: string | null
      trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
    }

    const artists = (result.rows as unknown as Row[]).map(r => ({
      id: r.id,
      name: r.name,
      imageUrl: r.imageUrl,
      spotifyId: r.spotifyId,
      trackCount: r.trackCount,
      downloadedTracks: r.downloadedTracks,
      pendingTracks: r.pendingTracks,
      playCount: r.playCount,
    }))

    return NextResponse.json({ artists, total, limit, offset })
  } catch (error) {
    console.error('download/artists error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
