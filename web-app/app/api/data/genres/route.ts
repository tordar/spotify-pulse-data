import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    const { rows } = await db.execute(`
      SELECT a.name as artistName, a.genres, COUNT(le.id) as playCount
      FROM artists a
      JOIN tracks t ON t.artist_id = a.id
      LEFT JOIN listening_events le ON le.track_id = t.id
      WHERE a.genres IS NOT NULL AND a.genres != '[]'
      GROUP BY a.id
      HAVING playCount > 0
      ORDER BY playCount DESC
    `)

    const genreRows = rows as unknown as Array<{ artistName: string; genres: string; playCount: number }>
    const genreMap = new Map<string, { count: number; artists: string[] }>()

    for (const row of genreRows) {
      let genres: string[]
      try { genres = JSON.parse(row.genres) } catch { continue }

      for (const genre of genres) {
        const existing = genreMap.get(genre)
        if (existing) {
          existing.count += row.playCount
          if (!existing.artists.includes(row.artistName)) {
            existing.artists.push(row.artistName)
          }
        } else {
          genreMap.set(genre, { count: row.playCount, artists: [row.artistName] })
        }
      }
    }

    const genres = Array.from(genreMap.entries())
      .map(([genre, data]) => ({ genre, count: data.count, artists: data.artists }))
      .sort((a, b) => b.count - a.count)

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Turso Database' },
      genres,
    })
  } catch (error) {
    console.error('Error reading genres data:', error)
    return NextResponse.json({ error: 'Failed to load genres data' }, { status: 500 })
  }
}
