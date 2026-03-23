export const revalidate = 300

import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    const { rows } = await db.execute(`
      SELECT
        t.id as trackId,
        t.spotify_id as songId,
        t.name as trackName,
        t.duration_ms,
        a.name as artistName,
        a.genres as artistGenres,
        al.name as albumName,
        al.image_url as albumImageUrl,
        COUNT(le.id) as playCount,
        SUM(le.ms_played) as totalDurationMs
      FROM tracks t
      JOIN artists a ON a.id = t.artist_id
      JOIN albums al ON al.id = t.album_id
      LEFT JOIN listening_events le ON le.track_id = t.id
      GROUP BY t.id
      HAVING COUNT(le.id) > 0
      ORDER BY COUNT(le.id) DESC
      LIMIT 500
    `)

    const songs = rows as unknown as Array<{
      trackId: number; songId: string | null; trackName: string; duration_ms: number;
      artistName: string; artistGenres: string | null;
      albumName: string; albumImageUrl: string | null;
      playCount: number; totalDurationMs: number;
    }>

    const result = songs.map((s, i) => ({
      rank: i + 1,
      trackId: s.trackId,
      duration_ms: s.totalDurationMs,
      count: s.playCount,
      songId: s.songId || '',
      song: {
        name: s.trackName,
        preview_url: null,
        external_urls: s.songId
          ? { spotify: `https://open.spotify.com/track/${s.songId}` }
          : {},
      },
      album: {
        name: s.albumName,
        images: buildSpotifyImageArray(s.albumImageUrl),
      },
      artist: {
        name: s.artistName,
        genres: safeParseJson(s.artistGenres),
      },
      consolidated_count: s.playCount,
      original_songIds: s.songId ? [s.songId] : [],
    }))

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
      songs: result,
    })
  } catch (error) {
    console.error('Error reading song data:', error)
    return NextResponse.json({ error: 'Failed to load song data' }, { status: 500 })
  }
}

function safeParseJson(val: string | null | undefined): string[] {
  if (!val) return []
  try { return JSON.parse(val) } catch { return [] }
}
