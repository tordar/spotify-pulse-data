export const revalidate = 300

import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    const [{ rows }, { rows: rows30 }] = await Promise.all([
      db.execute(`
        SELECT
          al.id as albumId,
          al.name as albumName,
          al.artist_name as artistName,
          al.spotify_id as spotifyId,
          al.image_url,
          al.release_date,
          al.album_type,
          al.total_tracks,
          COUNT(le.id) as playCount,
          SUM(le.ms_played) as totalDurationMs,
          COUNT(DISTINCT t.id) as uniqueSongs,
          MIN(le.played_at) as earliestPlayedAt
        FROM albums al
        JOIN tracks t ON t.album_id = al.id
        LEFT JOIN listening_events le ON le.track_id = t.id
        GROUP BY al.id
        HAVING COUNT(le.id) > 0
        ORDER BY COUNT(le.id) DESC
        LIMIT 500
      `),
      db.execute(`
        SELECT al.id as albumId, COUNT(le.id) as playCount30
        FROM albums al
        JOIN tracks t ON t.album_id = al.id
        JOIN listening_events le ON le.track_id = t.id
          AND le.played_at < datetime('now', '-30 days')
        GROUP BY al.id
        HAVING COUNT(le.id) > 0
        ORDER BY COUNT(le.id) DESC
      `),
    ])

    const albums = rows as unknown as Array<{
      albumId: number; albumName: string; artistName: string;
      spotifyId: string | null; image_url: string | null;
      release_date: string | null; album_type: string | null;
      total_tracks: number | null;
      playCount: number; totalDurationMs: number; uniqueSongs: number;
      earliestPlayedAt: string | null;
    }>

    // Build 30-days-ago rank + count lookup
    const prev30 = rows30 as unknown as Array<{ albumId: number; playCount30: number }>
    const prev30Map = new Map(prev30.map((r, i) => [r.albumId, { rank: i + 1, count: r.playCount30 }]))

    const result = albums.map((al, i) => {
      const prev = prev30Map.get(al.albumId)
      return {
        rank: i + 1,
        rank_30_days_ago: prev?.rank,
        count_30_days_ago: prev?.count,
        albumId: al.albumId,
        duration_ms: al.totalDurationMs,
        count: al.playCount,
        differents: al.uniqueSongs,
        primaryAlbumId: al.spotifyId || String(al.albumId),
        total_count: al.playCount,
        total_duration_ms: al.totalDurationMs,
        total_songs: al.total_tracks || al.uniqueSongs,
        earliest_played_at: al.earliestPlayedAt || undefined,
        album: {
          name: al.albumName,
          album_type: al.album_type || '',
          artists: [al.artistName],
          release_date: al.release_date || '',
          release_date_precision: al.release_date ? 'day' : '',
          popularity: 0,
          images: buildSpotifyImageArray(al.image_url),
          external_urls: al.spotifyId
            ? { spotify: `https://open.spotify.com/album/${al.spotifyId}` }
            : {},
          genres: [],
        },
        consolidated_count: al.playCount,
        original_albumIds: al.spotifyId ? [al.spotifyId] : [],
      }
    })

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
      albums: result,
    })
  } catch (error) {
    console.error('Error reading album data:', error)
    return NextResponse.json({ error: 'Failed to load album data' }, { status: 500 })
  }
}
