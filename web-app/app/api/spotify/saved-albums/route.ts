import { NextResponse } from 'next/server'
import { getSpotifyAccessToken } from '@/lib/spotify-auth'
import { getDb } from '@/lib/db'

interface SpotifyImage {
  url: string
  height: number | null
  width: number | null
}

interface SpotifySavedAlbum {
  added_at: string
  album: {
    id: string
    name: string
    album_type: string
    total_tracks: number
    release_date: string
    release_date_precision: string
    images: SpotifyImage[]
    artists: { id: string; name: string }[]
    uri: string
    external_urls: { spotify?: string }
  }
}

interface SpotifyPaginatedResponse {
  items: SpotifySavedAlbum[]
  total: number
  limit: number
  offset: number
  next: string | null
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 50)
    const offset = parseInt(searchParams.get('offset') ?? '0')
    const q = (searchParams.get('q') ?? '').toLowerCase().trim()

    const accessToken = await getSpotifyAccessToken()
    const db = getDb()

    const url = `https://api.spotify.com/v1/me/albums?limit=${limit}&offset=${offset}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json(
        { error: `Spotify API error: ${res.status} ${text}` },
        { status: res.status },
      )
    }

    const data: SpotifyPaginatedResponse = await res.json()

    type LocalInfo = {
      id: number; queueStatus: string | null
      trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
    }

    const localAlbumSql = `
      SELECT
        al.id,
        al.spotify_id as spotifyId,
        LOWER(al.name) as nameLower,
        LOWER(al.artist_name) as artistNameLower,
        al.queue_status as queueStatus,
        COUNT(DISTINCT t.id) as trackCount,
        COUNT(DISTINCT CASE WHEN t.download_status = 'downloaded' OR t.local_file_path IS NOT NULL THEN t.id END) as downloadedTracks,
        COUNT(DISTINCT CASE WHEN t.download_status IN ('pending','failed') AND t.local_file_path IS NULL THEN t.id END) as pendingTracks,
        COALESCE(SUM(le_counts.cnt), 0) as playCount
      FROM albums al
      LEFT JOIN tracks t ON t.album_id = al.id
      LEFT JOIN (
        SELECT track_id, COUNT(*) as cnt FROM listening_events GROUP BY track_id
      ) le_counts ON le_counts.track_id = t.id
      GROUP BY al.id
    `
    const { rows: allLocalRows } = await db.execute(localAlbumSql)

    type LocalRow = {
      id: number; spotifyId: string | null; nameLower: string; artistNameLower: string
      queueStatus: string | null
      trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
    }
    const localRows = allLocalRows as unknown as LocalRow[]

    // Index by spotify_id and by normalized name+artist for fallback matching
    const bySpotifyId = new Map<string, LocalInfo>()
    const byNameArtist = new Map<string, LocalInfo>()
    for (const row of localRows) {
      const info: LocalInfo = {
        id: row.id,
        queueStatus: row.queueStatus,
        trackCount: row.trackCount,
        downloadedTracks: row.downloadedTracks,
        pendingTracks: row.pendingTracks,
        playCount: row.playCount,
      }
      if (row.spotifyId) bySpotifyId.set(row.spotifyId, info)
      byNameArtist.set(`${row.nameLower}||${row.artistNameLower}`, info)
    }

    function findLocal(spotifyId: string, name: string, artistName: string): LocalInfo | null {
      return bySpotifyId.get(spotifyId)
        ?? byNameArtist.get(`${name.toLowerCase()}||${artistName.toLowerCase()}`)
        ?? null
    }

    let albums = data.items.map(item => {
      const a = item.album
      const artistName = a.artists.map(ar => ar.name).join(', ')
      const imageUrl = a.images?.[0]?.url ?? null
      const local = findLocal(a.id, a.name, artistName)

      return {
        spotifyId: a.id,
        name: a.name,
        artistName,
        imageUrl,
        releaseDate: a.release_date,
        albumType: a.album_type,
        totalTracks: a.total_tracks,
        addedAt: item.added_at,
        spotifyUrl: a.external_urls?.spotify ?? null,
        localId: local?.id ?? null,
        queueStatus: local?.queueStatus ?? null,
        trackCount: local?.trackCount ?? 0,
        downloadedTracks: local?.downloadedTracks ?? 0,
        pendingTracks: local?.pendingTracks ?? 0,
        playCount: local?.playCount ?? 0,
        inLibrary: local !== null,
      }
    })

    if (q) {
      albums = albums.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.artistName.toLowerCase().includes(q)
      )
    }

    return NextResponse.json({
      albums,
      total: data.total,
      limit: data.limit,
      offset: data.offset,
      hasMore: data.next !== null,
    })
  } catch (error) {
    console.error('spotify/saved-albums error:', error)
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('credentials not configured')) {
      return NextResponse.json({ error: 'Spotify not connected', code: 'NOT_CONFIGURED' }, { status: 401 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
