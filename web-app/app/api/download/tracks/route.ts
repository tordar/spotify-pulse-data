import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''
    const status = searchParams.get('status') ?? 'all' // all | downloaded | missing | pending
    const sort = searchParams.get('sort') ?? 'plays'
    const minPlays = parseInt(searchParams.get('minPlays') ?? '1') // default: only played tracks
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)
    const offset = parseInt(searchParams.get('offset') ?? '0')

    const db = getDb()

    const conditions: string[] = []
    const args: (string | number)[] = []

    if (q.trim()) {
      const tokens = q.trim().split(/\s+/).filter(Boolean)
      tokens.forEach(tok => {
        conditions.push(`(t.name LIKE ? OR a.name LIKE ? OR al.name LIKE ?)`)
        args.push(`%${tok}%`, `%${tok}%`, `%${tok}%`)
      })
    }

    if (status === 'downloaded') {
      conditions.push(`t.local_file_path IS NOT NULL`)
    } else if (status === 'missing') {
      conditions.push(`t.local_file_path IS NULL AND t.download_status IN ('pending','failed')`)
    } else if (status === 'pending') {
      conditions.push(`t.local_file_path IS NULL AND t.download_status = 'pending'`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const having = minPlays > 0 ? `HAVING playCount >= ${minPlays}` : ''

    const orderBy = {
      plays: 'playCount DESC, a.name, al.name, t.track_number',
      az: 'a.name, al.name, t.track_number',
      album: 'a.name, al.name, t.disc_number, t.track_number',
    }[sort] ?? 'playCount DESC, a.name, al.name, t.track_number'

    const sql = `
      SELECT
        t.id,
        t.name,
        t.track_number     as trackNumber,
        t.disc_number      as discNumber,
        t.duration_ms      as durationMs,
        t.spotify_id       as spotifyId,
        t.local_file_path  as localFilePath,
        t.download_status  as downloadStatus,
        a.name             as artistName,
        al.name            as albumName,
        al.image_url       as albumImageUrl,
        COALESCE(le_counts.cnt, 0) as playCount
      FROM tracks t
      JOIN artists a  ON a.id  = t.artist_id
      JOIN albums  al ON al.id = t.album_id
      LEFT JOIN (
        SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
      ) le_counts ON le_counts.track_id = t.id
      ${where}
      GROUP BY t.id
      ${having}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT t.id, COALESCE(le_counts.cnt, 0) as playCount
        FROM tracks t
        JOIN artists a  ON a.id  = t.artist_id
        JOIN albums  al ON al.id = t.album_id
        LEFT JOIN (
          SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
        ) le_counts ON le_counts.track_id = t.id
        ${where}
        GROUP BY t.id
        ${having}
      )
    `

    const [countResult, result] = await Promise.all([
      db.execute({ sql: countSql, args }),
      db.execute({ sql, args: [...args, limit, offset] }),
    ])

    const total = (countResult.rows[0] as unknown as { total: number }).total

    type Row = {
      id: number; name: string; trackNumber: number | null; discNumber: number | null
      durationMs: number; spotifyId: string | null; localFilePath: string | null
      downloadStatus: string; artistName: string; albumName: string
      albumImageUrl: string | null; playCount: number
    }

    const tracks = (result.rows as unknown as Row[]).map(r => ({
      id: r.id,
      name: r.name,
      trackNumber: r.trackNumber,
      discNumber: r.discNumber,
      durationMs: r.durationMs,
      spotifyId: r.spotifyId,
      localFilePath: r.localFilePath,
      downloadStatus: r.downloadStatus,
      artistName: r.artistName,
      albumName: r.albumName,
      albumImageUrl: r.albumImageUrl,
      playCount: r.playCount,
    }))

    return NextResponse.json({ tracks, total, limit, offset })
  } catch (error) {
    console.error('download/tracks error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
