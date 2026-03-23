export const revalidate = 300

import { NextRequest, NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export async function GET(req: NextRequest) {
  const artistId = req.nextUrl.searchParams.get('artistId')
  if (!artistId) {
    return NextResponse.json({ error: 'artistId required' }, { status: 400 })
  }

  try {
    const db = getDb()

    const [{ rows: yearlyRows }, { rows: songRows }, { rows: albumRows }] = await Promise.all([
      db.execute({
        sql: `
          SELECT strftime('%Y', le.played_at) as year, SUM(le.ms_played) as totalMs
          FROM listening_events le
          JOIN tracks t ON t.id = le.track_id
          WHERE t.artist_id = ?
          GROUP BY year
          ORDER BY year
        `,
        args: [artistId],
      }),
      db.execute({
        sql: `
          SELECT t.id as trackId, t.spotify_id as songId, t.name,
            al.name as albumName, al.image_url as albumImageUrl,
            COUNT(le.id) as playCount, SUM(le.ms_played) as totalMs
          FROM tracks t
          JOIN albums al ON al.id = t.album_id
          LEFT JOIN listening_events le ON le.track_id = t.id
          WHERE t.artist_id = ?
          GROUP BY t.id
          HAVING COUNT(le.id) > 0
          ORDER BY COUNT(le.id) DESC
          LIMIT 5
        `,
        args: [artistId],
      }),
      db.execute({
        sql: `
          SELECT al.id as albumId, al.spotify_id as spotifyId, al.name,
            al.image_url, al.artist_name as artistName,
            COUNT(le.id) as playCount, SUM(le.ms_played) as totalMs
          FROM albums al
          JOIN tracks t ON t.album_id = al.id
          LEFT JOIN listening_events le ON le.track_id = t.id
          WHERE t.artist_id = ?
          GROUP BY al.id
          HAVING COUNT(le.id) > 0
          ORDER BY COUNT(le.id) DESC
          LIMIT 5
        `,
        args: [artistId],
      }),
    ])

    type YearlyRow = { year: string; totalMs: number }
    type SongRow = { trackId: number; songId: string | null; name: string; albumName: string; albumImageUrl: string | null; playCount: number; totalMs: number }
    type AlbumRow = { albumId: number; spotifyId: string | null; name: string; image_url: string | null; artistName: string; playCount: number; totalMs: number }

    return NextResponse.json({
      yearly_play_time: (yearlyRows as unknown as YearlyRow[]).map(r => ({
        year: r.year,
        totalListeningTimeMs: r.totalMs,
      })),
      top_songs: (songRows as unknown as SongRow[]).map(s => ({
        songId: s.songId || String(s.trackId),
        name: s.name,
        play_count: s.playCount,
        total_listening_time_ms: s.totalMs,
        album: {
          name: s.albumName,
          images: buildSpotifyImageArray(s.albumImageUrl),
        },
      })),
      top_albums: (albumRows as unknown as AlbumRow[]).map(al => ({
        primaryAlbumId: al.spotifyId || String(al.albumId),
        name: al.name,
        play_count: al.playCount,
        total_listening_time_ms: al.totalMs,
        images: buildSpotifyImageArray(al.image_url),
        artists: [al.artistName],
      })),
    })
  } catch (error) {
    console.error('Error fetching artist details:', error)
    return NextResponse.json({ error: 'Failed to load artist details' }, { status: 500 })
  }
}
