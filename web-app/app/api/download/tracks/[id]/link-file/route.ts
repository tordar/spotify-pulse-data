/**
 * POST /api/download/tracks/[id]/link-file
 *
 * Links a local file path to an existing track, marking it as downloaded.
 * Body: { filePath: string }
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import fs from 'fs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const trackId = parseInt(id)
    if (isNaN(trackId)) return NextResponse.json({ error: 'Invalid track ID' }, { status: 400 })

    const { filePath } = await request.json() as { filePath: string }
    if (!filePath) return NextResponse.json({ error: 'filePath is required' }, { status: 400 })

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found on disk' }, { status: 400 })
    }

    const db = getDb()
    await db.execute({
      sql: `UPDATE tracks SET local_file_path = ?, download_status = 'downloaded', updated_at = datetime('now') WHERE id = ?`,
      args: [filePath, trackId],
    })

    return NextResponse.json({ ok: true, filePath })
  } catch (error) {
    console.error('link-file error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
