import { NextResponse } from 'next/server'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getCleanedDataDir } from '@/lib/data-dir'
import { getRecentlyPlayed, type PlayHistoryItem } from '@/lib/spotify-recently-played'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

function norm(s: string): string {
  return s.toLowerCase().trim()
}

function toImage(img: { url: string; height?: number | null; width?: number | null }): { height: number; url: string; width: number } {
  return { url: img.url, height: img.height ?? 0, width: img.width ?? 0 }
}

function mergeRecentlyPlayedIntoYearTopItems(
  yearTopItems: {
    topSongs: Array<{ songId: string; name: string; artist: string; playCount: number; totalListeningTimeMs: number; images: Array<{ height: number; url: string; width: number }> }>
    topArtists: Array<{ artistName: string; playCount: number; totalListeningTimeMs: number; uniqueSongs: number; images: Array<{ height: number; url: string; width: number }> }>
    topAlbums: Array<{ albumName: string; artist: string; playCount: number; totalListeningTimeMs: number; uniqueSongs: number; images: Array<{ height: number; url: string; width: number }> }>
  },
  plays: PlayHistoryItem[]
): void {
  for (const item of plays) {
    const track = item.track
    const durationMs = track.duration_ms ?? 0
    const primaryArtist = track.artists?.[0]?.name ?? ''
    const albumName = track.album?.name ?? ''
    const images = (track.album?.images ?? []).map(toImage)

    const songId = track.id
    if (songId) {
      const existing = yearTopItems.topSongs.find((s) => s.songId === songId)
      if (existing) {
        existing.playCount += 1
        existing.totalListeningTimeMs += durationMs
      } else {
        yearTopItems.topSongs.push({
          songId,
          name: track.name ?? '',
          artist: primaryArtist,
          playCount: 1,
          totalListeningTimeMs: durationMs,
          images,
        })
      }
    }

    if (primaryArtist) {
      const existing = yearTopItems.topArtists.find((a) => norm(a.artistName) === norm(primaryArtist))
      if (existing) {
        existing.playCount += 1
        existing.totalListeningTimeMs += durationMs
      } else {
        yearTopItems.topArtists.push({
          artistName: primaryArtist,
          playCount: 1,
          totalListeningTimeMs: durationMs,
          uniqueSongs: 1,
          images: [], // Recently played track doesn't include artist images
        })
      }
    }

    if (albumName && primaryArtist) {
      const existing = yearTopItems.topAlbums.find(
        (a) => norm(a.albumName) === norm(albumName) && norm(a.artist) === norm(primaryArtist)
      )
      if (existing) {
        existing.playCount += 1
        existing.totalListeningTimeMs += durationMs
      } else {
        yearTopItems.topAlbums.push({
          albumName,
          artist: primaryArtist,
          playCount: 1,
          totalListeningTimeMs: durationMs,
          uniqueSongs: 1,
          images,
        })
      }
    }
  }

  yearTopItems.topSongs.sort((a, b) => b.playCount - a.playCount)
  yearTopItems.topArtists.sort((a, b) => b.playCount - a.playCount)
  yearTopItems.topAlbums.sort((a, b) => b.playCount - a.playCount)

  yearTopItems.topSongs.splice(5)
  yearTopItems.topArtists.splice(5)
  yearTopItems.topAlbums.splice(5)
}

export async function GET() {
  try {
    const dataDir = getCleanedDataDir()
    const files = await readdir(dataDir)
    const statsFile = files
      .filter(f => f.startsWith('detailed-stats-') && f.endsWith('.json'))
      .sort()
      .pop()

    if (!statsFile) {
      return NextResponse.json({ error: 'Stats data not found' }, { status: 404 })
    }

    const filePath = join(dataDir, statsFile)
    const fileContents = await readFile(filePath, 'utf-8')
    const data = JSON.parse(fileContents)

    const recentPlays = (await getRecentlyPlayed(50)) ?? []
    const lastSyncAt = data.metadata?.timestamp ? new Date(data.metadata.timestamp).getTime() : null
    const playsToAppend =
      lastSyncAt != null
        ? recentPlays.filter((item) => new Date(item.played_at).getTime() > lastSyncAt)
        : recentPlays

    if (playsToAppend.length > 0 && data.stats?.yearlyListeningTime) {
      const currentYear = new Date().getFullYear().toString()
      const yearEntry = data.stats.yearlyListeningTime.find(
        (y: { year: string }) => y.year === currentYear
      )
      if (yearEntry) {
        playsToAppend.forEach((item) => {
          const artists = item.track.artists?.map((a: { name: string }) => a.name).join(', ') ?? ''
          console.log('[stats] Appended:', item.track.name, '—', artists)
        })
        const extraMs = playsToAppend.reduce((sum, item) => sum + (item.track.duration_ms ?? 0), 0)
        const extraPlays = playsToAppend.length
        const extraHours = extraMs / MS_PER_HOUR
        const extraDays = extraMs / MS_PER_DAY

        yearEntry.totalListeningTimeMs = (yearEntry.totalListeningTimeMs ?? 0) + extraMs
        yearEntry.playCount = (yearEntry.playCount ?? 0) + extraPlays
        yearEntry.totalListeningHours = (yearEntry.totalListeningHours ?? 0) + extraHours

        if (typeof data.stats.totalListeningHours === 'number') {
          data.stats.totalListeningHours += extraHours
        }
        if (typeof data.stats.totalListeningDays === 'number') {
          data.stats.totalListeningDays += extraDays
        }
        if (typeof data.stats.totalListeningEvents === 'number') {
          data.stats.totalListeningEvents += extraPlays
        }
      }

      if (data.stats?.yearlyTopItems && playsToAppend.length > 0) {
        const yearTopEntry = data.stats.yearlyTopItems.find(
          (y: { year: string }) => y.year === currentYear
        )
        if (yearTopEntry) {
          mergeRecentlyPlayedIntoYearTopItems(yearTopEntry, playsToAppend)
        }
      }

      if (data.metadata) {
        data.metadata.recentlyPlayedMergedAt = new Date().toISOString()
      }
    } else if (recentPlays && recentPlays.length > 0 && playsToAppend.length === 0 && data.metadata) {
      data.metadata.recentlyPlayedMergedAt = new Date().toISOString()
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error reading stats data:', error)
    return NextResponse.json({ error: 'Failed to load stats data' }, { status: 500 })
  }
}
