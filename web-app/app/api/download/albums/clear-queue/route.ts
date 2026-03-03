import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function POST() {
  try {
    const db = getDb()

    const { rows } = await db.execute(
      `SELECT COUNT(*) as c FROM albums WHERE queue_status = 'queued'`
    )
    const count = (rows[0] as unknown as { c: number }).c

    await db.execute(
      `UPDATE albums SET queue_status = NULL, updated_at = datetime('now') WHERE queue_status = 'queued'`
    )

    return NextResponse.json({ ok: true, cleared: count })
  } catch (error) {
    console.error('download/albums/clear-queue error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
