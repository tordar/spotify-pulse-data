import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export const revalidate = 300

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const date = searchParams.get('date') // YYYY-MM-DD
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
  }

  try {
    const db = getDb()
    const { rows } = await db.execute({
      sql: `
        SELECT
          t.name as songName,
          a.name as artistName,
          al.name as albumName,
          le.ms_played as msPlayed
        FROM listening_events le
        JOIN tracks t ON t.id = le.track_id
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
        WHERE date(le.played_at) = ?
        ORDER BY le.played_at
      `,
      args: [date],
    })

    const plays = (rows as unknown as Array<{
      songName: string; artistName: string; albumName: string; msPlayed: number
    }>).map(r => ({
      songName: r.songName || 'Unknown',
      artists: [r.artistName || 'Unknown'],
      albumName: r.albumName || 'Unknown Album',
      msPlayed: r.msPlayed,
    }))

    return NextResponse.json({ plays })
  } catch (error) {
    console.error('Error fetching day plays:', error)
    return NextResponse.json({ error: 'Failed to fetch day plays' }, { status: 500 })
  }
}
