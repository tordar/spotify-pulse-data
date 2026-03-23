export const revalidate = 300

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const trackId = req.nextUrl.searchParams.get('trackId')
  if (!trackId) {
    return NextResponse.json({ error: 'trackId required' }, { status: 400 })
  }

  try {
    const db = getDb()

    const { rows } = await db.execute({
      sql: `
        SELECT strftime('%Y', le.played_at) as year, SUM(le.ms_played) as totalMs
        FROM listening_events le
        WHERE le.track_id = ?
        GROUP BY year
        ORDER BY year
      `,
      args: [trackId],
    })

    type YearlyRow = { year: string; totalMs: number }

    return NextResponse.json({
      yearly_play_time: (rows as unknown as YearlyRow[]).map(r => ({
        year: r.year,
        totalListeningTimeMs: r.totalMs,
      })),
    })
  } catch (error) {
    console.error('Error fetching song details:', error)
    return NextResponse.json({ error: 'Failed to load song details' }, { status: 500 })
  }
}
