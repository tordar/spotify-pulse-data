import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export const revalidate = 300

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

    // Aggregate in SQL — returns ~365 rows per year instead of all individual events
    const { rows } = await db.execute({
      sql: `
        SELECT
          date(played_at) as day,
          SUM(ms_played) as totalMs
        FROM listening_events
        WHERE date(played_at) >= ? AND date(played_at) <= ?
        GROUP BY day
        ORDER BY day
      `,
      args: [startDate, endDate],
    })

    const dataArray = (rows as unknown as Array<{ day: string; totalMs: number }>).map(r => ({
      date: Date.UTC(
        parseInt(r.day.slice(0, 4)),
        parseInt(r.day.slice(5, 7)) - 1,
        parseInt(r.day.slice(8, 10)),
      ),
      value: r.totalMs,
    }))

    return NextResponse.json({ years, data: dataArray })
  } catch (error) {
    console.error('Error building daily listening data:', error)
    return NextResponse.json({ error: 'Failed to load daily listening data' }, { status: 500 })
  }
}
