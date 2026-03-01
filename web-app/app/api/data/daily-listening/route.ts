import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const yearParam = searchParams.get('year')
    const yearsParam = searchParams.get('years')
    let years: number[]

    if (yearsParam) {
      years = yearsParam.split(',').map(y => parseInt(y.trim(), 10)).filter(y => !Number.isNaN(y))
      if (years.length === 0) {
        return NextResponse.json({ error: 'Invalid years' }, { status: 400 })
      }
    } else if (yearParam) {
      const y = parseInt(yearParam, 10)
      if (Number.isNaN(y)) return NextResponse.json({ error: 'Invalid year' }, { status: 400 })
      years = [y]
    } else {
      const current = new Date().getFullYear()
      years = [current - 4, current - 3, current - 2, current - 1, current]
    }

    const db = getDb()
    const minYear = Math.min(...years)
    const maxYear = Math.max(...years)
    const startDate = `${minYear}-01-01`
    const endDate = `${maxYear}-12-31`

    const rows = db.prepare(`
      SELECT
        le.played_at,
        le.ms_played,
        t.name as songName,
        a.name as artistName,
        al.name as albumName
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      JOIN artists a ON a.id = t.artist_id
      JOIN albums al ON al.id = t.album_id
      WHERE date(le.played_at) >= ? AND date(le.played_at) <= ?
      ORDER BY le.played_at
    `).all(startDate, endDate) as Array<{
      played_at: string; ms_played: number;
      songName: string; artistName: string; albumName: string;
    }>

    const dayMap = new Map<number, { totalMs: number; plays: Array<{
      songName: string; artists: string[]; albumName: string; msPlayed: number;
    }> }>()

    for (const row of rows) {
      const d = new Date(row.played_at)
      d.setUTCHours(0, 0, 0, 0)
      const key = d.getTime()

      let rec = dayMap.get(key)
      if (!rec) {
        rec = { totalMs: 0, plays: [] }
        dayMap.set(key, rec)
      }
      rec.totalMs += row.ms_played
      rec.plays.push({
        songName: row.songName || 'Unknown',
        artists: [row.artistName || 'Unknown'],
        albumName: row.albumName || 'Unknown Album',
        msPlayed: row.ms_played,
      })
    }

    const dataArray = Array.from(dayMap.entries()).map(([date, rec]) => ({
      date,
      value: rec.totalMs,
      plays: rec.plays,
    }))

    return NextResponse.json({ years, data: dataArray })
  } catch (error) {
    console.error('Error building daily listening data:', error)
    return NextResponse.json({ error: 'Failed to load daily listening data' }, { status: 500 })
  }
}
