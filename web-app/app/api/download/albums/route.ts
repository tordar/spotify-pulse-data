import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''
    const status = searchParams.get('status') ?? 'all' // all | queued | skipped | undecided
    const sort = searchParams.get('sort') ?? 'plays'   // plays | name | downloaded | az
    const minPlays = parseInt(searchParams.get('minPlays') ?? '0')
    const hideMostlyDownloaded = searchParams.get('hideMostlyDownloaded') === '1' // exclude albums with ≥50% tracks downloaded
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)
    const offset = parseInt(searchParams.get('offset') ?? '0')

    const db = getDb()

    // Build WHERE clause
    const conditions: string[] = []
    const args: (string | number)[] = []

    if (q.trim()) {
      conditions.push(`(al.name LIKE ? OR al.artist_name LIKE ?)`)
      args.push(`%${q}%`, `%${q}%`)
    }

    if (status === 'queued') {
      conditions.push(`al.queue_status = 'queued'`)
    } else if (status === 'skipped') {
      conditions.push(`al.queue_status = 'skipped'`)
    } else if (status === 'undecided') {
      conditions.push(`al.queue_status IS NULL`)
    }
    // 'all' = no filter

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const havingParts: string[] = []
    if (minPlays > 0) havingParts.push(`playCount >= ${minPlays}`)
    if (hideMostlyDownloaded) havingParts.push(`(trackCount = 0 OR (downloadedTracks * 100.0 / trackCount) <= 50)`)
    const having = havingParts.length ? `HAVING ${havingParts.join(' AND ')}` : ''

    const orderBy = {
      plays: 'playCount DESC, al.artist_name, al.name',
      name: 'al.name',
      az: 'al.artist_name, al.name',
      downloaded: 'downloadedTracks DESC',
    }[sort] ?? 'playCount DESC, al.artist_name, al.name'

    const sql = `
      SELECT
        al.id,
        al.name,
        al.artist_name as artistName,
        al.spotify_id as spotifyId,
        al.image_url as imageUrl,
        al.release_date as releaseDate,
        al.album_type as albumType,
        al.total_tracks as totalTracks,
        al.queue_status as queueStatus,
        COUNT(DISTINCT t.id) as trackCount,
        COUNT(DISTINCT CASE WHEN t.download_status = 'downloaded' OR t.local_file_path IS NOT NULL THEN t.id END) as downloadedTracks,
        COUNT(DISTINCT CASE WHEN t.download_status IN ('pending','failed') AND t.local_file_path IS NULL THEN t.id END) as pendingTracks,
        COALESCE(SUM(le_counts.cnt), 0) as playCount,
        COALESCE((
          SELECT COUNT(*)
          FROM (
            SELECT disc_number, track_number
            FROM tracks
            WHERE album_id = al.id AND track_number IS NOT NULL AND track_number > 0
            GROUP BY disc_number, track_number
            HAVING COUNT(*) > 1
          )
        ), 0) as duplicateCount
      FROM albums al
      LEFT JOIN tracks t ON t.album_id = al.id
      LEFT JOIN (
        SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
      ) le_counts ON le_counts.track_id = t.id
      ${where}
      GROUP BY al.id
      ${having}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT al.id,
          COUNT(DISTINCT t.id) as trackCount,
          COUNT(DISTINCT CASE WHEN t.download_status = 'downloaded' OR t.local_file_path IS NOT NULL THEN t.id END) as downloadedTracks,
          COALESCE(SUM(le_counts.cnt), 0) as playCount
        FROM albums al
        LEFT JOIN tracks t ON t.album_id = al.id
        LEFT JOIN (
          SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
        ) le_counts ON le_counts.track_id = t.id
        ${where}
        GROUP BY al.id
        ${having}
      )
    `

    // Ensure queue_status column exists (may be missing from older Turso deployments)
    try {
      await db.execute(`ALTER TABLE albums ADD COLUMN queue_status TEXT CHECK(queue_status IN ('queued','skipped')) DEFAULT NULL`)
    } catch { /* already exists */ }

    const [countResult, rows] = await Promise.all([
      db.execute({ sql: countSql, args }),
      db.execute({ sql, args: [...args, limit, offset] }),
    ])

    const total = (countResult.rows[0] as unknown as { total: number }).total

    type Row = {
      id: number; name: string; artistName: string; spotifyId: string | null; imageUrl: string | null
      releaseDate: string | null; albumType: string | null; totalTracks: number | null
      queueStatus: string | null; trackCount: number; downloadedTracks: number
      pendingTracks: number; playCount: number; duplicateCount: number
    }

    const albums = (rows.rows as unknown as Row[]).map(r => ({
      id: r.id,
      name: r.name,
      artistName: r.artistName,
      spotifyId: r.spotifyId,
      imageUrl: r.imageUrl,
      releaseDate: r.releaseDate,
      albumType: r.albumType,
      totalTracks: r.totalTracks ?? r.trackCount,
      queueStatus: r.queueStatus,
      trackCount: r.trackCount,
      downloadedTracks: r.downloadedTracks,
      pendingTracks: r.pendingTracks,
      playCount: r.playCount,
      duplicateCount: r.duplicateCount,
    }))

    return NextResponse.json({ albums, total, limit, offset })
  } catch (error) {
    console.error('download/albums error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
