import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

export async function GET() {
  try {
    const db = getDb()

    // Yearly listening time
    const yearlyRows = db.prepare(`
      SELECT
        strftime('%Y', played_at) as year,
        SUM(ms_played) as totalListeningTimeMs,
        COUNT(*) as playCount
      FROM listening_events
      GROUP BY year ORDER BY year
    `).all() as Array<{ year: string; totalListeningTimeMs: number; playCount: number }>

    const yearlyListeningTime = yearlyRows.map(r => ({
      year: r.year,
      totalListeningTimeMs: r.totalListeningTimeMs,
      totalListeningHours: Math.round((r.totalListeningTimeMs / MS_PER_HOUR) * 100) / 100,
      playCount: r.playCount,
      totalPodcastListeningTimeMs: 0,
      totalPodcastListeningHours: 0,
    }))

    // Total stats
    const totals = db.prepare(`
      SELECT SUM(ms_played) as totalMs, COUNT(*) as totalEvents
      FROM listening_events
    `).get() as { totalMs: number; totalEvents: number }

    const totalListeningHours = Math.round((totals.totalMs / MS_PER_HOUR) * 100) / 100
    const totalListeningDays = Math.round((totals.totalMs / MS_PER_DAY) * 100) / 100

    // Yearly top items (top 5 songs, artists, albums per year)
    const years = yearlyRows.map(r => r.year)
    const yearlyTopItems = years.map(year => {
      const topSongs = db.prepare(`
        SELECT t.spotify_id as songId, t.name, a.name as artist, al.image_url,
               COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs
        FROM listening_events le
        JOIN tracks t ON t.id = le.track_id
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
        WHERE strftime('%Y', le.played_at) = ?
        GROUP BY t.id ORDER BY playCount DESC LIMIT 5
      `).all(year) as Array<{
        songId: string; name: string; artist: string; image_url: string | null;
        playCount: number; totalListeningTimeMs: number;
      }>

      const topArtists = db.prepare(`
        SELECT a.name as artistName, a.image_url,
               COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs,
               COUNT(DISTINCT t.id) as uniqueSongs
        FROM listening_events le
        JOIN tracks t ON t.id = le.track_id
        JOIN artists a ON a.id = t.artist_id
        WHERE strftime('%Y', le.played_at) = ?
        GROUP BY a.id ORDER BY playCount DESC LIMIT 5
      `).all(year) as Array<{
        artistName: string; image_url: string | null;
        playCount: number; totalListeningTimeMs: number; uniqueSongs: number;
      }>

      const topAlbums = db.prepare(`
        SELECT al.name as albumName, a.name as artist, al.image_url,
               COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs,
               COUNT(DISTINCT t.id) as uniqueSongs
        FROM listening_events le
        JOIN tracks t ON t.id = le.track_id
        JOIN artists a ON a.id = t.artist_id
        JOIN albums al ON al.id = t.album_id
        WHERE strftime('%Y', le.played_at) = ?
        GROUP BY al.id ORDER BY playCount DESC LIMIT 5
      `).all(year) as Array<{
        albumName: string; artist: string; image_url: string | null;
        playCount: number; totalListeningTimeMs: number; uniqueSongs: number;
      }>

      return {
        year: parseInt(year),
        topSongs: topSongs.map(s => ({
          songId: s.songId || '',
          name: s.name,
          artist: s.artist,
          playCount: s.playCount,
          totalListeningTimeMs: s.totalListeningTimeMs,
          images: buildSpotifyImageArray(s.image_url),
        })),
        topArtists: topArtists.map(a => ({
          artistName: a.artistName,
          playCount: a.playCount,
          totalListeningTimeMs: a.totalListeningTimeMs,
          uniqueSongs: a.uniqueSongs,
          images: a.image_url ? [{ url: a.image_url, width: 640, height: 640 }] : [],
        })),
        topAlbums: topAlbums.map(a => ({
          albumName: a.albumName,
          artist: a.artist,
          playCount: a.playCount,
          totalListeningTimeMs: a.totalListeningTimeMs,
          uniqueSongs: a.uniqueSongs,
          images: buildSpotifyImageArray(a.image_url),
        })),
      }
    })

    // Hourly listening distribution
    const hourlyRows = db.prepare(`
      SELECT
        CAST(strftime('%H', played_at) AS INTEGER) as hour,
        SUM(ms_played) as totalListeningTimeMs,
        COUNT(*) as playCount
      FROM listening_events
      GROUP BY hour ORDER BY hour
    `).all() as Array<{ hour: number; totalListeningTimeMs: number; playCount: number }>

    const hourlyListeningDistribution = Array.from({ length: 24 }, (_, h) => {
      const row = hourlyRows.find(r => r.hour === h)
      return {
        hour: h,
        totalListeningTimeMs: row?.totalListeningTimeMs ?? 0,
        totalListeningHours: Math.round(((row?.totalListeningTimeMs ?? 0) / MS_PER_HOUR) * 100) / 100,
        playCount: row?.playCount ?? 0,
      }
    })

    // Country listening data
    const countryRows = db.prepare(`
      SELECT
        conn_country as countryCode,
        SUM(ms_played) as totalMsPlayed,
        COUNT(*) as playCount,
        MIN(played_at) as firstPlayedAt,
        MAX(played_at) as lastPlayedAt
      FROM listening_events
      WHERE conn_country IS NOT NULL AND conn_country != ''
      GROUP BY conn_country ORDER BY totalMsPlayed DESC
    `).all() as Array<{
      countryCode: string; totalMsPlayed: number; playCount: number;
      firstPlayedAt: string; lastPlayedAt: string;
    }>

    const countryListeningData = countryRows.map(r => ({
      countryCode: r.countryCode,
      totalMsPlayed: r.totalMsPlayed,
      totalHours: Math.round((r.totalMsPlayed / MS_PER_HOUR) * 100) / 100,
      playCount: r.playCount,
      firstPlayedAt: r.firstPlayedAt,
      lastPlayedAt: r.lastPlayedAt,
    }))

    return NextResponse.json({
      metadata: {
        timestamp: new Date().toISOString(),
        source: 'SQLite Database',
      },
      stats: {
        yearlyListeningTime,
        yearlyTopItems,
        totalListeningHours,
        totalListeningDays,
        totalListeningEvents: totals.totalEvents,
        hourlyListeningDistribution,
        countryListeningData,
      },
    })
  } catch (error) {
    console.error('Error reading stats data:', error)
    return NextResponse.json({ error: 'Failed to load stats data' }, { status: 500 })
  }
}
