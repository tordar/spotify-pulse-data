export const revalidate = 300

import { NextResponse } from 'next/server'
import { getDb, buildArtistImageArray } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    const [{ rows }, { rows: rows30 }] = await Promise.all([
      db.execute(`
        SELECT
          a.id as artistId,
          a.name as artistName,
          a.spotify_id as spotifyId,
          a.genres,
          a.image_url,
          COUNT(le.id) as playCount,
          SUM(le.ms_played) as totalDurationMs,
          COUNT(DISTINCT t.id) as uniqueSongs
        FROM artists a
        JOIN tracks t ON t.artist_id = a.id
        LEFT JOIN listening_events le ON le.track_id = t.id
        GROUP BY a.id
        HAVING COUNT(le.id) > 0
        ORDER BY COUNT(le.id) DESC
        LIMIT 500
      `),
      db.execute(`
        SELECT a.id as artistId, COUNT(le.id) as playCount30
        FROM artists a
        JOIN tracks t ON t.artist_id = a.id
        JOIN listening_events le ON le.track_id = t.id
          AND le.played_at < datetime('now', '-30 days')
        GROUP BY a.id
        HAVING COUNT(le.id) > 0
        ORDER BY COUNT(le.id) DESC
      `),
    ])

    const artists = rows as unknown as Array<{
      artistId: number; artistName: string; spotifyId: string | null;
      genres: string | null; image_url: string | null;
      playCount: number; totalDurationMs: number; uniqueSongs: number;
    }>

    const prev30 = rows30 as unknown as Array<{ artistId: number; playCount30: number }>
    const prev30Map = new Map(prev30.map((r, i) => [r.artistId, { rank: i + 1, count: r.playCount30 }]))

    const result = artists.map((a, i) => {
      const prev = prev30Map.get(a.artistId)
      return {
        rank: i + 1,
        rank_30_days_ago: prev?.rank,
        count_30_days_ago: prev?.count,
        artistId: a.artistId,
        duration_ms: a.totalDurationMs,
        count: a.playCount,
        differents: a.uniqueSongs,
        primaryArtistId: a.spotifyId || String(a.artistId),
        total_count: a.playCount,
        total_duration_ms: a.totalDurationMs,
        artist: {
          name: a.artistName,
          genres: safeParseJson(a.genres),
          popularity: 0,
          followers: { total: 0 },
          images: buildArtistImageArray(a.image_url),
          external_urls: a.spotifyId
            ? { spotify: `https://open.spotify.com/artist/${a.spotifyId}` }
            : {},
        },
        consolidated_count: a.playCount,
        original_artistIds: a.spotifyId ? [a.spotifyId] : [],
      }
    })

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
      artists: result,
    })
  } catch (error) {
    console.error('Error reading artist data:', error)
    return NextResponse.json({ error: 'Failed to load artist data' }, { status: 500 })
  }
}

function safeParseJson(val: string | null | undefined): string[] {
  if (!val) return []
  try { return JSON.parse(val) } catch { return [] }
}
