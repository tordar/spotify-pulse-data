import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()

    // Top 500 albums by play count
    const { rows: albumRows } = await db.execute(`
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
      HAVING playCount > 0
      ORDER BY playCount DESC
      LIMIT 500
    `)

    const albums = albumRows as unknown as Array<{
      albumId: number; albumName: string; artistName: string;
      spotifyId: string | null; image_url: string | null;
      release_date: string | null; album_type: string | null;
      total_tracks: number | null;
      playCount: number; totalDurationMs: number; uniqueSongs: number;
      earliestPlayedAt: string | null;
    }>

    if (albums.length === 0) {
      return NextResponse.json({ metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' }, albums: [] })
    }

    // Fetch all songs for these albums, batching to avoid SQLite/D1 variable limits
    const albumIds = albums.map(a => a.albumId)
    // Keep batches small to avoid hitting SQLite / D1 variable limits (e.g. 999)
    const BATCH_SIZE = 50
    let songRows: unknown[] = []

    for (let i = 0; i < albumIds.length; i += BATCH_SIZE) {
      const batchIds = albumIds.slice(i, i + BATCH_SIZE)
      const placeholders = batchIds.map(() => '?').join(', ')
      const { rows } = await db.execute({
        sql: `
          SELECT
            t.album_id,
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
          WHERE t.album_id IN (${placeholders})
          GROUP BY t.id
          ORDER BY t.album_id, t.disc_number, t.track_number, t.name
        `,
        args: batchIds,
      })
      songRows = songRows.concat(rows as unknown[])
    }

    type SongRow = {
      album_id: number; id: number; songId: string | null; name: string;
      duration_ms: number; track_number: number | null; disc_number: number | null;
      artistName: string; playCount: number; totalListeningTimeMs: number;
    }
    const songs = songRows as unknown as SongRow[]

    // Group songs by album_id
    const songsByAlbum = new Map<number, SongRow[]>()
    for (const song of songs) {
      const list = songsByAlbum.get(song.album_id) ?? []
      list.push(song)
      songsByAlbum.set(song.album_id, list)
    }

    const result = albums.map((al, i) => {
      const albumSongs = songsByAlbum.get(al.albumId) ?? []
      const totalSongs = al.total_tracks || albumSongs.length
      const playedSongs = albumSongs.filter(s => s.playCount > 0).length

      return {
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
        total_songs: totalSongs,
        played_songs: playedSongs,
        unplayed_songs: totalSongs - playedSongs,
        earliest_played_at: al.earliestPlayedAt || undefined,
        songs: albumSongs.map(s => ({
          songId: s.songId || String(s.id),
          name: s.name,
          duration_ms: s.duration_ms,
          track_number: s.track_number || 0,
          disc_number: s.disc_number || 1,
          explicit: false,
          preview_url: null,
          external_urls: s.songId
            ? { spotify: `https://open.spotify.com/track/${s.songId}` }
            : {},
          play_count: s.playCount,
          total_listening_time_ms: s.totalListeningTimeMs || 0,
          artists: [s.artistName],
        })),
      }
    })

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
      albums: result,
    })
  } catch (error) {
    console.error('Error reading album with songs data:', error)
    return NextResponse.json({ error: 'Failed to load album with songs data' }, { status: 500 })
  }
}
