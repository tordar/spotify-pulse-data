import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync } from 'fs'

let _db: Database.Database | null = null

function getDbPath(): string {
  const envDir = process.env.DATA_DIR?.trim()
  if (envDir) return join(envDir, 'library.db')

  const fromWebApp = join(process.cwd(), '..', 'data', 'library.db')
  const fromRepoRoot = join(process.cwd(), 'data', 'library.db')
  if (existsSync(fromWebApp)) return fromWebApp
  if (existsSync(fromRepoRoot)) return fromRepoRoot
  return fromWebApp
}

export function getDb(): Database.Database {
  if (_db) return _db

  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run 'npm run db:import' first.`)
  }

  _db = new Database(dbPath, { readonly: true })
  _db.pragma('journal_mode = WAL')
  return _db
}

export function buildSpotifyImageArray(imageUrl: string | null): Array<{ url: string; width: number; height: number }> {
  if (!imageUrl) return []

  // Spotify CDN images follow predictable URL patterns based on size prefix
  const match = imageUrl.match(/\/image\/ab67616d\w{8}(\w+)$/)
  if (match) {
    const hash = match[1]
    return [
      { url: `https://i.scdn.co/image/ab67616d0000b273${hash}`, width: 640, height: 640 },
      { url: `https://i.scdn.co/image/ab67616d00001e02${hash}`, width: 300, height: 300 },
      { url: `https://i.scdn.co/image/ab67616d00004851${hash}`, width: 64, height: 64 },
    ]
  }

  // Non-standard URL — return as-is
  if (imageUrl) {
    return [{ url: imageUrl, width: 640, height: 640 }]
  }

  return []
}

export function buildArtistImageArray(imageUrl: string | null): Array<{ url: string; width: number; height: number }> {
  if (!imageUrl) return []
  return [{ url: imageUrl, width: 640, height: 640 }]
}
