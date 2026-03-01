import { NextResponse } from 'next/server'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'

export async function GET() {
  const info: Record<string, unknown> = {
    cwd: process.cwd(),
    __dirname_equivalent: 'N/A (ESM)',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }

  // Check candidate db paths
  const candidates = [
    join(process.cwd(), '..', 'data', 'library.db'),
    join(process.cwd(), 'data', 'library.db'),
    join(process.cwd(), 'web-app', '..', 'data', 'library.db'),
    '/var/task/data/library.db',
    '/var/task/web-app/../data/library.db',
  ]
  info.candidates = candidates.map(p => ({ path: p, exists: existsSync(p) }))

  // List cwd contents
  try { info.cwdContents = readdirSync(process.cwd()) } catch (e) { info.cwdContents = String(e) }
  try { info.cwdParentContents = readdirSync(join(process.cwd(), '..')) } catch (e) { info.cwdParentContents = String(e) }

  // Try to actually open the db
  try {
    const { getDb } = await import('@/lib/db')
    const db = getDb()
    const row = db.prepare('SELECT COUNT(*) as cnt FROM tracks').get() as { cnt: number }
    info.dbOpen = true
    info.trackCount = row.cnt
  } catch (e: unknown) {
    info.dbOpen = false
    info.dbError = e instanceof Error ? { message: e.message, stack: e.stack } : String(e)
  }

  return NextResponse.json(info)
}
