export const revalidate = 300

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const albumId = req.nextUrl.searchParams.get('albumId')
  if (!albumId) {
    return NextResponse.json({ error: 'albumId required' }, { status: 400 })
  }

  try {
    const db = getDb()

    const [{ rows }, { rows: yearlyRows }] = await Promise.all([
      db.execute({
        sql: `
          SELECT
            t.id,
            t.spotify_id as songId,
            t.name,
            t.duration_ms,
            t.track_number,
            t.disc_number,
            a.name as artistName,
            COUNT(le.id) as playCount,
            SUM(le.ms_played) as totalListeningTimeMs
          FROM tracks t
          JOIN artists a ON a.id = t.artist_id
          LEFT JOIN listening_events le ON le.track_id = t.id
          WHERE t.album_id = ?
          GROUP BY t.id
          ORDER BY t.disc_number, t.track_number, t.name
        `,
        args: [albumId],
      }),
      db.execute({
        sql: `
          SELECT strftime('%Y', le.played_at) as year, SUM(le.ms_played) as totalMs
          FROM listening_events le
          JOIN tracks t ON t.id = le.track_id
          WHERE t.album_id = ?
          GROUP BY year
          ORDER BY year
        `,
        args: [albumId],
      }),
    ])

    type SongRow = {
      id: number; songId: string | null; name: string;
      duration_ms: number; track_number: number | null; disc_number: number | null;
      artistName: string; playCount: number; totalListeningTimeMs: number;
    }
    const songs = rows as unknown as SongRow[]

    const result = songs.map(s => ({
      songId: s.songId || String(s.id),
      name: s.name,
      duration_ms: s.duration_ms,
      track_number: s.track_number || 0,
      disc_number: s.disc_number || 1,
      explicit: false,
      preview_url: null,
      external_urls: s.songId ? { spotify: `https://open.spotify.com/track/${s.songId}` } : {},
      play_count: s.playCount,
      total_listening_time_ms: s.totalListeningTimeMs || 0,
      artists: [s.artistName],
    }))

    const playedSongs = result.filter(s => s.play_count > 0).length

    type YearlyRow = { year: string; totalMs: number }
    const yearly_play_time = (yearlyRows as unknown as YearlyRow[]).map(r => ({
      year: r.year,
      totalListeningTimeMs: r.totalMs,
    }))

    return NextResponse.json({
      songs: result,
      played_songs: playedSongs,
      unplayed_songs: result.length - playedSongs,
      yearly_play_time,
    })
  } catch (error) {
    console.error('Error fetching album songs:', error)
    return NextResponse.json({ error: 'Failed to load album songs' }, { status: 500 })
  }
}
