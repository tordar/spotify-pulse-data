import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const albumId = parseInt(id)
    if (isNaN(albumId)) return NextResponse.json({ error: 'Invalid album id' }, { status: 400 })

    const body = await request.json() as { status: 'queued' | 'skipped' | null }
    const status = body.status // null clears the status

    if (status !== null && status !== 'queued' && status !== 'skipped') {
      return NextResponse.json({ error: 'status must be queued, skipped, or null' }, { status: 400 })
    }

    const db = getDb()
    await db.execute({
      sql: `UPDATE albums SET queue_status = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [status, albumId],
    })

    return NextResponse.json({ ok: true, id: albumId, status })
  } catch (error) {
    console.error('download/albums/queue error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
