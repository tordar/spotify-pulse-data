import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const LB_BASE = 'https://api.listenbrainz.org/1'

export interface LBPlayingNow {
  track_name: string
  artist_name: string
  release_name: string | null
  duration_ms: number | null
  cover_art_url: string | null
  source: 'spotify' | 'navidrome' | 'other'
}

export async function GET() {
  const username = process.env.LISTENBRAINZ_USERNAME
  const token = process.env.LISTENBRAINZ_TOKEN

  if (!username) {
    return NextResponse.json({ playing: null })
  }

  try {
    const headers: Record<string, string> = { 'User-Agent': 'spotify-pulse/1.0' }
    if (token) headers['Authorization'] = `Token ${token}`

    const res = await fetch(
      `${LB_BASE}/user/${encodeURIComponent(username)}/playing-now`,
      { headers }
    )
    if (!res.ok) return NextResponse.json({ playing: null })

    const data = await res.json()
    const listens: any[] = data?.payload?.listens ?? []
    if (listens.length === 0) return NextResponse.json({ playing: null })

    const listen = listens[0]
    const meta = listen.track_metadata ?? {}
    const info = meta.additional_info ?? {}
    const mbids = meta.mbid_mapping ?? {}
    const caaRelease = mbids.caa_release_mbid ?? null

    let cover_art_url: string | null = caaRelease
      ? `https://coverartarchive.org/release/${caaRelease}/front-250`
      : null

    if (!cover_art_url && meta.artist_name && (meta.release_name || meta.track_name)) {
      try {
        const term = [meta.artist_name, meta.release_name ?? meta.track_name].join(' ')
        const itunesRes = await fetch(
          `https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'album', limit: '1', media: 'music' })}`
        )
        if (itunesRes.ok) {
          const itunesData = await itunesRes.json() as { results?: Array<{ artworkUrl100?: string }> }
          const art = itunesData.results?.[0]?.artworkUrl100
          if (art) cover_art_url = art.replace('100x100bb', '250x250bb')
        }
      } catch {
        // ignore
      }
    }

    const serviceRaw = [
      info.music_service,
      info.music_service_name,
      info.submission_client,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    let source: LBPlayingNow['source'] = 'other'
    if (serviceRaw.includes('spotify')) source = 'spotify'
    else if (serviceRaw.includes('navidrome')) source = 'navidrome'

    return NextResponse.json({
      playing: {
        track_name: meta.track_name ?? '',
        artist_name: meta.artist_name ?? '',
        release_name: meta.release_name ?? null,
        duration_ms: info.duration_ms ?? info.duration ?? null,
        cover_art_url,
        source,
      } satisfies LBPlayingNow,
    })
  } catch {
    return NextResponse.json({ playing: null })
  }
}
