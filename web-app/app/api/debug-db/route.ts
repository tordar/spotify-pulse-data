import { NextResponse } from 'next/server'

export async function GET() {
  const info: Record<string, unknown> = {
    cwd: process.cwd(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hasD1AccountId: !!process.env.CLOUDFLARE_ACCOUNT_ID,
    hasD1DatabaseId: !!process.env.CLOUDFLARE_D1_DATABASE_ID,
    hasD1ApiToken: !!process.env.CLOUDFLARE_API_TOKEN,
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
