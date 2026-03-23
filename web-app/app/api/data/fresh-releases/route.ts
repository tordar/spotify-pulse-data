import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const view = searchParams.get('view') ?? 'all'
    const today = new Date().toISOString().split('T')[0]

    let whereClause = ''
    if (view === 'upcoming') whereClause = `WHERE fr.release_date >= '${today}'`
    else if (view === 'recent') whereClause = `WHERE fr.release_date < '${today}'`

    const db = getDb()
    const { rows } = await db.execute(`
      SELECT
        fr.id,
        fr.artist_name,
        fr.artist_mbid,
        fr.title,
        fr.release_date,
        fr.primary_type,
        fr.caa_release_mbid,
        fr.fetched_at
      FROM fresh_releases fr
      ${whereClause}
      ORDER BY fr.release_date ASC
    `)

    return NextResponse.json({
      releases: rows,
      count: rows.length,
    })
  } catch (error) {
    console.error('Error fetching fresh releases:', error)
    return NextResponse.json({ error: 'Failed to load releases' }, { status: 500 })
  }
}
