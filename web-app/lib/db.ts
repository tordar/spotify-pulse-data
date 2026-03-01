import { createClient, type Client } from '@libsql/client'

let _client: Client | null = null

export function getDb(): Client {
  if (_client) return _client

  const url = process.env.TURSO_DATABASE_URL
  const authToken = process.env.TURSO_AUTH_TOKEN

  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL is not set. ' +
      'Add it to Vercel project settings or .env.local for local dev.'
    )
  }

  _client = createClient({ url, authToken })
  return _client
}

export function buildSpotifyImageArray(imageUrl: string | null | undefined): Array<{ url: string; width: number; height: number }> {
  if (!imageUrl) return []

  const match = imageUrl.match(/\/image\/ab67616d\w{8}(\w+)$/)
  if (match) {
    const hash = match[1]
    return [
      { url: `https://i.scdn.co/image/ab67616d0000b273${hash}`, width: 640, height: 640 },
      { url: `https://i.scdn.co/image/ab67616d00001e02${hash}`, width: 300, height: 300 },
      { url: `https://i.scdn.co/image/ab67616d00004851${hash}`, width: 64, height: 64 },
    ]
  }

  return [{ url: imageUrl, width: 640, height: 640 }]
}

export function buildArtistImageArray(imageUrl: string | null | undefined): Array<{ url: string; width: number; height: number }> {
  if (!imageUrl) return []
  return [{ url: imageUrl, width: 640, height: 640 }]
}
