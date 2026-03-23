import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

const LB_BASE = 'https://api.listenbrainz.org/1'
const PAGE_SIZE = 100

/**
 * Returns listens from ListenBrainz that occurred after the last D1 sync,
 * so the web app can show up-to-date listening data between daily syncs.
 *
 * GET /api/data/live-listens
 * Response: { listens: LBListen[], since: string | null, count: number }
 */
export async function GET() {
  const username = process.env.LISTENBRAINZ_USERNAME
  const token = process.env.LISTENBRAINZ_TOKEN

  if (!username) {
    return NextResponse.json({ error: 'LISTENBRAINZ_USERNAME not configured' }, { status: 500 })
  }

  try {
    // Get last sync timestamp from D1
    const db = getDb()
    const { rows } = await db.execute(
      `SELECT source_identifier FROM import_log WHERE source = 'listenbrainz' ORDER BY imported_at DESC LIMIT 1`
    )
    const sinceTs: number = rows[0]?.source_identifier
      ? parseInt(rows[0].source_identifier as string, 10)
      : 0
    const sinceIso = sinceTs > 0 ? new Date(sinceTs * 1000).toISOString() : null

    // Fetch listens since that timestamp from LB
    const listens: Array<{
      listened_at: number
      artist_name: string
      track_name: string
      release_name: string | null
      duration_ms: number | null
    }> = []

    let maxTs: number | undefined
    while (true) {
      const params = new URLSearchParams({ count: String(PAGE_SIZE) })
      if (maxTs != null) params.set('max_ts', String(maxTs))

      const url = `${LB_BASE}/user/${encodeURIComponent(username)}/listens?${params}`
      const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' }
      if (token) headers['Authorization'] = `Token ${token}`

      const res = await fetch(url, { headers, next: { revalidate: 300 } })
      if (!res.ok) break

      const data: any = await res.json()
      const page = data?.payload?.listens ?? []
      if (page.length === 0) break

      const newItems = sinceTs > 0 ? page.filter((l: any) => l.listened_at > sinceTs) : page

      for (const l of newItems) {
        listens.push({
          listened_at: l.listened_at,
          artist_name: l.track_metadata?.artist_name ?? '',
          track_name: l.track_metadata?.track_name ?? '',
          release_name: l.track_metadata?.release_name ?? null,
          duration_ms: l.track_metadata?.additional_info?.duration_ms ?? null,
        })
      }

      if (newItems.length < page.length) break
      if (page.length < PAGE_SIZE) break

      maxTs = page[page.length - 1].listened_at
    }

    // Sort newest first
    listens.sort((a, b) => b.listened_at - a.listened_at)

    return NextResponse.json({ listens, since: sinceIso, count: listens.length })
  } catch (error) {
    console.error('Error fetching live listens:', error)
    return NextResponse.json({ error: 'Failed to fetch live listens' }, { status: 500 })
  }
}
