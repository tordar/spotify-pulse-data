import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    const { rows } = await db.execute(`
      SELECT
        al.id as albumId,
        al.name as albumName,
        al.artist_name as artistName,
        al.spotify_id as spotifyId,
        al.image_url,
        al.release_date,
        al.album_type,
        COUNT(le.id) as playCount,
        SUM(le.ms_played) as totalDurationMs,
        COUNT(DISTINCT t.id) as uniqueSongs
      FROM albums al
      JOIN tracks t ON t.album_id = al.id
      LEFT JOIN listening_events le ON le.track_id = t.id
      GROUP BY al.id
      HAVING playCount > 0
      ORDER BY playCount DESC
      LIMIT 500
    `)

    const albums = rows as unknown as Array<{
      albumId: number; albumName: string; artistName: string;
      spotifyId: string | null; image_url: string | null;
      release_date: string | null; album_type: string | null;
      playCount: number; totalDurationMs: number; uniqueSongs: number;
    }>

    const result = albums.map((al, i) => ({
      rank: i + 1,
      duration_ms: al.totalDurationMs,
      count: al.playCount,
      differents: al.uniqueSongs,
      primaryAlbumId: al.spotifyId || String(al.albumId),
      total_count: al.playCount,
      total_duration_ms: al.totalDurationMs,
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
    }))

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
      albums: result,
    })
  } catch (error) {
    console.error('Error reading album data:', error)
    return NextResponse.json({ error: 'Failed to load album data' }, { status: 500 })
  }
}
