import { NextResponse } from 'next/server'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getCleanedDataDir } from '@/lib/data-dir'
import { getRecentlyPlayed } from '@/lib/spotify-recently-played'

export async function GET() {
  try {
    const dataDir = getCleanedDataDir()
    const files = await readdir(dataDir)
    const artistFile = files
      .filter(f => f.startsWith('cleaned-artists-') && f.endsWith('.json'))
      .sort()
      .pop()

    if (!artistFile) {
      return NextResponse.json({ error: 'Artist data not found' }, { status: 404 })
    }

    const filePath = join(dataDir, artistFile)
    const fileContents = await readFile(filePath, 'utf-8')
    const data = JSON.parse(fileContents)

    const recentPlays = (await getRecentlyPlayed(50)) ?? []
    const lastSyncAt = data.metadata?.timestamp ? new Date(data.metadata.timestamp).getTime() : null
    const playsToAppend =
      lastSyncAt != null
        ? recentPlays.filter((item) => new Date(item.played_at).getTime() > lastSyncAt)
        : recentPlays

    if (playsToAppend.length > 0 && data.artists) {
      const durationPerPlay = (item: { track: { duration_ms?: number } }) => item.track.duration_ms ?? 0
      for (const item of playsToAppend) {
        const artistIds = item.track.artists?.map(a => a.id).filter(Boolean) ?? []
        const durationMs = durationPerPlay(item)
        const trackName = item.track.name
        for (const artistId of artistIds) {
          const artistName = item.track.artists?.find((a: { id?: string }) => a.id === artistId)?.name ?? 'Unknown'
          let artist = data.artists.find(
            (a: { primaryArtistId?: string; original_artistIds?: (string | null)[] }) =>
              a.primaryArtistId === artistId || (Array.isArray(a.original_artistIds) && a.original_artistIds.includes(artistId))
          )
          if (!artist && artistName) {
            const byName = data.artists.find(
              (a: { artist?: { name?: string } }) =>
                a.artist?.name?.toLowerCase().trim() === artistName.toLowerCase().trim()
            )
            if (byName) artist = byName
          }
          if (!artist) {
            console.log('[artists] Not appended (artist not in top list):', trackName, '—', artistName)
            continue
          }
          console.log('[artists] Appended:', trackName, '→', artistName)
          artist.count = (artist.count ?? 0) + 1
          artist.total_count = (artist.total_count ?? 0) + 1
          artist.total_duration_ms = (artist.total_duration_ms ?? 0) + durationMs
        }
      }
      if (data.metadata) {
        data.metadata.recentlyPlayedMergedAt = new Date().toISOString()
      }
    } else if (recentPlays && recentPlays.length > 0 && playsToAppend.length === 0) {
      if (data.metadata) {
        data.metadata.recentlyPlayedMergedAt = new Date().toISOString()
      }
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error reading artist data:', error)
    return NextResponse.json({ error: 'Failed to load artist data' }, { status: 500 })
  }
}
