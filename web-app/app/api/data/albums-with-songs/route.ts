import { NextResponse } from 'next/server'
import { readdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { getCleanedDataDir } from '@/lib/data-dir'
import { getRecentlyPlayed } from '@/lib/spotify-recently-played'

type AlbumWithName = {
  primaryAlbumId?: string
  album?: { name?: string; artists?: string[] }
  count?: number
  total_count?: number
  total_duration_ms?: number
  songs?: Array<{ songId?: string; play_count?: number; total_listening_time_ms?: number }>
}

/** Normalize dash variants to standard hyphen (matches scripts/cleaner) */
function normalizeDashes(text: string): string {
  return text
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2015/g, '-')
    .replace(/\u2212/g, '-')
    .replace(/\uFE63/g, '-')
    .replace(/\uFF0D/g, '-')
}

function normalizeAlbumKey(s: string): string {
  return normalizeDashes(s.toLowerCase().trim())
}

function getRulesPath(): string | null {
  const fromWebApp = join(process.cwd(), '..', 'data', 'album-consolidation-rules.json')
  const fromRepoRoot = join(process.cwd(), 'data', 'album-consolidation-rules.json')
  if (existsSync(fromWebApp)) return fromWebApp
  if (existsSync(fromRepoRoot)) return fromRepoRoot
  return null
}

let rulesMap: Map<string, string> | null = null

async function loadRulesMap(): Promise<Map<string, string>> {
  if (rulesMap) return rulesMap
  rulesMap = new Map()
  const path = getRulesPath()
  if (!path) return rulesMap
  try {
    const content = await readFile(path, 'utf-8')
    const data = JSON.parse(content) as { rules: Array<{ artistName: string; baseAlbumName: string; variations: string[] }> }
    if (!Array.isArray(data.rules)) return rulesMap
    for (const rule of data.rules) {
      const artistKey = normalizeAlbumKey(rule.artistName)
      const baseAlbumName = rule.baseAlbumName
      rulesMap.set(`${artistKey}|${normalizeAlbumKey(baseAlbumName)}`, baseAlbumName)
      for (const variation of rule.variations) {
        rulesMap.set(`${artistKey}|${normalizeAlbumKey(variation)}`, baseAlbumName)
      }
    }
  } catch {
    // no rules or parse error
  }
  return rulesMap
}

async function getCanonicalAlbumName(albumName: string, artistName: string): Promise<string> {
  const map = await loadRulesMap()
  const key = `${normalizeAlbumKey(artistName)}|${normalizeAlbumKey(albumName)}`
  return map.get(key) ?? albumName
}

function findAlbumByNameAndArtist(
  albums: AlbumWithName[],
  canonicalAlbumName: string,
  primaryArtistName: string
): AlbumWithName | undefined {
  const canonicalKey = normalizeAlbumKey(canonicalAlbumName)
  const artistKey = normalizeAlbumKey(primaryArtistName)
  return albums.find((a) => {
    const nameMatch = a.album?.name && normalizeAlbumKey(a.album.name) === canonicalKey
    const artistMatch = Array.isArray(a.album?.artists) &&
      a.album.artists.some((ar) => normalizeAlbumKey(ar) === artistKey)
    return nameMatch && artistMatch
  })
}

export async function GET() {
  try {
    const dataDir = getCleanedDataDir()
    const files = await readdir(dataDir)
    const albumFile = files
      .filter(f => f.startsWith('cleaned-albums-with-songs-') && f.endsWith('.json'))
      .sort()
      .pop()

    if (!albumFile) {
      return NextResponse.json({ error: 'Album with songs data not found' }, { status: 404 })
    }

    const filePath = join(dataDir, albumFile)
    const fileContents = await readFile(filePath, 'utf-8')
    const data = JSON.parse(fileContents)

    const recentPlays = await getRecentlyPlayed(50) ?? []
    const lastSyncAt = data.metadata?.timestamp ? new Date(data.metadata.timestamp).getTime() : null
    const playsToAppend =
      lastSyncAt != null
        ? recentPlays.filter((item) => new Date(item.played_at).getTime() > lastSyncAt)
        : recentPlays

    if (playsToAppend.length > 0 && data.albums) {
      const albums = data.albums as AlbumWithName[]
      for (const item of playsToAppend) {
        const albumId = item.track.album?.id
        const trackId = item.track.id
        const artists = item.track.artists?.map((a: { name: string }) => a.name).join(', ') ?? ''
        const albumName = item.track.album?.name ?? ''
        const primaryArtistName = item.track.artists?.[0]?.name ?? ''

        if (!trackId) {
          console.log('[albums-with-songs] Not appended (missing track id):', item.track.name, '—', artists, '(', albumName, ')')
          continue
        }

        let album = albumId
          ? albums.find((a: { primaryAlbumId?: string }) => a.primaryAlbumId === albumId)
          : undefined

        if (!album && albumName && primaryArtistName) {
          const canonicalName = await getCanonicalAlbumName(albumName, primaryArtistName)
          album = findAlbumByNameAndArtist(albums, canonicalName, primaryArtistName)
        }

        if (!album) {
          console.log('[albums-with-songs] Not appended (album not in top 500):', item.track.name, '—', artists, '(', albumName, ')')
          continue
        }

        console.log('[albums-with-songs] Appended:', item.track.name, '—', artists, '(', albumName, ')')

        album.count = (album.count ?? 0) + 1
        album.total_count = (album.total_count ?? 0) + 1
        album.total_duration_ms = (album.total_duration_ms ?? 0) + (item.track.duration_ms ?? 0)

        if (Array.isArray(album.songs)) {
          const song = album.songs.find((s: { songId?: string }) => s.songId === trackId)
          if (song) {
            song.play_count = (song.play_count ?? 0) + 1
            song.total_listening_time_ms = (song.total_listening_time_ms ?? 0) + (item.track.duration_ms ?? 0)
          }
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
    console.error('Error reading album with songs data:', error)
    return NextResponse.json({ error: 'Failed to load album with songs data' }, { status: 500 })
  }
}
