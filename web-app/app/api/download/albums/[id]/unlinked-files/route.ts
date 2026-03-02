/**
 * GET /api/download/albums/[id]/unlinked-files
 *
 * Scans the album's folder on disk (derived from already-linked tracks) and
 * returns audio files that aren't yet linked to any track in the database.
 * Only works when the Next.js server has access to the local filesystem (dev).
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import fs from 'fs'
import path from 'path'

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aiff', '.aac', '.opus', '.wma'])

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const albumId = parseInt(id)
    if (isNaN(albumId)) return NextResponse.json({ error: 'Invalid album ID' }, { status: 400 })

    const db = getDb()

    // Get all local file paths already linked to tracks in this album
    const { rows: linkedInAlbum } = await db.execute({
      sql: `SELECT local_file_path FROM tracks WHERE album_id = ? AND local_file_path IS NOT NULL`,
      args: [albumId],
    })

    if (!linkedInAlbum.length) {
      return NextResponse.json({ files: [], folder: null, reason: 'No downloaded tracks to determine folder' })
    }

    // Derive folder from the first linked file in this album
    const firstPath = linkedInAlbum[0].local_file_path as string
    const folder = path.dirname(firstPath)

    // Scan the folder for audio files
    let allFilesInFolder: string[]
    try {
      allFilesInFolder = fs.readdirSync(folder)
        .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
        .map(f => path.join(folder, f))
    } catch {
      return NextResponse.json({ files: [], folder, reason: 'Could not read folder' })
    }

    // Get every file path already linked anywhere in the DB (not just this album)
    const { rows: allLinked } = await db.execute(
      `SELECT local_file_path FROM tracks WHERE local_file_path IS NOT NULL`
    )
    const linkedSet = new Set(allLinked.map(r => r.local_file_path as string))

    const unlinked = allFilesInFolder.filter(f => !linkedSet.has(f))

    return NextResponse.json({ files: unlinked, folder })
  } catch (error) {
    console.error('unlinked-files error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
