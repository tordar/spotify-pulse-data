import { NextResponse } from 'next/server'
import { getDb, buildSpotifyImageArray } from '@/lib/db'

export const revalidate = 300

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

export async function GET() {
  try {
    const db = getDb()

    // Step 1: fetch years (needed to build per-year batch statements)
    const { rows: yearRows } = await db.execute(`
      SELECT strftime('%Y', played_at) as year
      FROM listening_events
      GROUP BY year ORDER BY year
    `)
    const years = (yearRows as unknown as Array<{ year: string }>).map(r => r.year)

    // Step 2: send all remaining queries in a single HTTP round trip
    const topSongsSql = `
      SELECT t.spotify_id as songId, t.name, a.name as artist, al.image_url,
             COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      JOIN artists a ON a.id = t.artist_id
      JOIN albums al ON al.id = t.album_id
      WHERE strftime('%Y', le.played_at) = ?
      GROUP BY t.id ORDER BY playCount DESC LIMIT 5
    `
    const topArtistsSql = `
      SELECT a.name as artistName, a.image_url,
             COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs,
             COUNT(DISTINCT t.id) as uniqueSongs
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      JOIN artists a ON a.id = t.artist_id
      WHERE strftime('%Y', le.played_at) = ?
      GROUP BY a.id ORDER BY playCount DESC LIMIT 5
    `
    const topAlbumsSql = `
      SELECT al.name as albumName, a.name as artist, al.image_url,
             COUNT(*) as playCount, SUM(le.ms_played) as totalListeningTimeMs,
             COUNT(DISTINCT t.id) as uniqueSongs
      FROM listening_events le
      JOIN tracks t ON t.id = le.track_id
      JOIN artists a ON a.id = t.artist_id
      JOIN albums al ON al.id = t.album_id
      WHERE strftime('%Y', le.played_at) = ?
      GROUP BY al.id ORDER BY playCount DESC LIMIT 5
    `

    const batchStatements = [
      {
        sql: `
          SELECT strftime('%Y', played_at) as year,
                 SUM(ms_played) as totalListeningTimeMs, COUNT(*) as playCount
          FROM listening_events GROUP BY year ORDER BY year
        `,
        args: [] as unknown[],
      },
      {
        sql: `SELECT SUM(ms_played) as totalMs, COUNT(*) as totalEvents FROM listening_events`,
        args: [] as unknown[],
      },
      {
        sql: `
          SELECT CAST(strftime('%H', played_at) AS INTEGER) as hour,
                 SUM(ms_played) as totalListeningTimeMs, COUNT(*) as playCount
          FROM listening_events GROUP BY hour ORDER BY hour
        `,
        args: [] as unknown[],
      },
      {
        sql: `
          SELECT conn_country as countryCode, SUM(ms_played) as totalMsPlayed,
                 COUNT(*) as playCount, MIN(played_at) as firstPlayedAt, MAX(played_at) as lastPlayedAt
          FROM listening_events
          WHERE conn_country IS NOT NULL AND conn_country != ''
          GROUP BY conn_country ORDER BY totalMsPlayed DESC
        `,
        args: [] as unknown[],
      },
      ...years.flatMap(year => [
        { sql: topSongsSql, args: [year] as unknown[] },
        { sql: topArtistsSql, args: [year] as unknown[] },
        { sql: topAlbumsSql, args: [year] as unknown[] },
      ]),
    ]

    const results = await db.batch(batchStatements)

    const yearlyRows = results[0].rows as unknown as Array<{ year: string; totalListeningTimeMs: number; playCount: number }>
    const totals = results[1].rows[0] as unknown as { totalMs: number; totalEvents: number }
    const hourlyRows = results[2].rows as unknown as Array<{ hour: number; totalListeningTimeMs: number; playCount: number }>
    const countryRows = results[3].rows as unknown as Array<{ countryCode: string; totalMsPlayed: number; playCount: number; firstPlayedAt: string; lastPlayedAt: string }>

    const yearlyTopItems = years.map((year, i) => {
      const base = 4 + i * 3
      const topSongs = results[base].rows as unknown as Array<{ songId: string | null; name: string; artist: string; image_url: string | null; playCount: number; totalListeningTimeMs: number }>
      const topArtists = results[base + 1].rows as unknown as Array<{ artistName: string; image_url: string | null; playCount: number; totalListeningTimeMs: number; uniqueSongs: number }>
      const topAlbums = results[base + 2].rows as unknown as Array<{ albumName: string; artist: string; image_url: string | null; playCount: number; totalListeningTimeMs: number; uniqueSongs: number }>

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

    const totalListeningHours = Math.round((totals.totalMs / MS_PER_HOUR) * 100) / 100
    const totalListeningDays = Math.round((totals.totalMs / MS_PER_DAY) * 100) / 100

    const yearlyListeningTime = yearlyRows.map(r => ({
      year: r.year,
      totalListeningTimeMs: r.totalListeningTimeMs,
      totalListeningHours: Math.round((r.totalListeningTimeMs / MS_PER_HOUR) * 100) / 100,
      playCount: r.playCount,
      totalPodcastListeningTimeMs: 0,
      totalPodcastListeningHours: 0,
    }))

    const hourlyListeningDistribution = Array.from({ length: 24 }, (_, h) => {
      const row = hourlyRows.find(r => r.hour === h)
      return {
        hour: h,
        totalListeningTimeMs: row?.totalListeningTimeMs ?? 0,
        totalListeningHours: Math.round(((row?.totalListeningTimeMs ?? 0) / MS_PER_HOUR) * 100) / 100,
        playCount: row?.playCount ?? 0,
      }
    })

    const countryListeningData = countryRows.map(r => ({
      countryCode: r.countryCode,
      totalMsPlayed: r.totalMsPlayed,
      totalHours: Math.round((r.totalMsPlayed / MS_PER_HOUR) * 100) / 100,
      playCount: r.playCount,
      firstPlayedAt: r.firstPlayedAt,
      lastPlayedAt: r.lastPlayedAt,
    }))

    return NextResponse.json({
      metadata: { timestamp: new Date().toISOString(), source: 'Cloudflare D1' },
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
