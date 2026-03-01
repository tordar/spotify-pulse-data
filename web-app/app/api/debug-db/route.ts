import { NextResponse } from 'next/server'

export async function GET() {
  const info: Record<string, unknown> = {
    cwd: process.cwd(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hasTursoUrl: !!process.env.TURSO_DATABASE_URL,
    hasTursoToken: !!process.env.TURSO_AUTH_TOKEN,
  }

  try {
    const { getDb } = await import('@/lib/db')
    const db = getDb()
    const result = await db.execute('SELECT COUNT(*) as cnt FROM tracks')
    info.dbOpen = true
    info.trackCount = result.rows[0]?.cnt
  } catch (e: unknown) {
    info.dbOpen = false
    info.dbError = e instanceof Error ? { message: e.message, stack: e.stack } : String(e)
  }

  return NextResponse.json(info)
}
