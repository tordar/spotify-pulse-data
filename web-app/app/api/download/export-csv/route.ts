import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// Returns a sldl-compatible CSV of all pending tracks in queued albums.
// If no albums are queued, falls back to all pending tracks.
export async function GET() {
  try {
    const db = getDb()

    const queuedCount = (await db.execute(
      `SELECT COUNT(*) as c FROM albums WHERE queue_status = 'queued'`
    )).rows[0] as { c: number }

    const useQueueFilter = queuedCount.c > 0

    const { rows } = await db.execute(`
      SELECT
        t.name,
        a.name as artistName,
        al.name as albumName,
        t.duration_ms as durationMs
      FROM tracks t
      JOIN artists a ON a.id = t.artist_id
      JOIN albums al ON al.id = t.album_id
      WHERE t.download_status IN ('pending', 'failed')
        AND t.local_file_path IS NULL
        ${useQueueFilter ? `AND al.queue_status = 'queued'` : ''}
      ORDER BY a.name, al.name, t.disc_number, t.track_number, t.name
    `)

    type Row = { name: string; artistName: string; albumName: string; durationMs: number }
    const tracks = rows as unknown as Row[]

    const lines = ['Artist,Title,Album,Length']
    for (const t of tracks) {
      const lengthSec = t.durationMs > 0 ? Math.round(t.durationMs / 1000) : ''
      lines.push([
        escapeCsv(t.artistName),
        escapeCsv(t.name),
        escapeCsv(t.albumName),
        String(lengthSec),
      ].join(','))
    }

    const csv = lines.join('\n')
    const filename = useQueueFilter ? 'sldl-queued.csv' : 'sldl-all-pending.csv'

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Track-Count': String(tracks.length),
        'X-Queue-Filtered': String(useQueueFilter),
      },
    })
  } catch (error) {
    console.error('download/export-csv error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
