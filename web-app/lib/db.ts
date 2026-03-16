import { createD1Client, type D1Client } from './d1-client'

let _client: D1Client | null = null

export function getDb(): D1Client {
  if (_client) return _client

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
  const apiToken = process.env.CLOUDFLARE_API_TOKEN

  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      'Cloudflare D1 env vars missing. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN.'
    )
  }

  _client = createD1Client({ accountId, databaseId, apiToken })
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
