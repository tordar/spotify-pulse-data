import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const BEETS_DB_PATH = path.join(os.homedir(), 'Music', 'beets.db');

export function queryBeetsLibrary(
  albumName: string,
  artistName: string,
): { mbAlbumId: string } | null {
  if (!fs.existsSync(BEETS_DB_PATH)) return null;

  const db = new Database(BEETS_DB_PATH, { readonly: true });
  try {
    let row = db.prepare(`
      SELECT mb_albumid FROM albums
      WHERE album = ? AND albumartist = ?
        AND mb_albumid IS NOT NULL AND mb_albumid != ''
      LIMIT 1
    `).get(albumName, artistName) as { mb_albumid: string } | undefined;

    if (!row) {
      row = db.prepare(`
        SELECT mb_albumid FROM albums
        WHERE LOWER(album) = LOWER(?) AND LOWER(albumartist) = LOWER(?)
          AND mb_albumid IS NOT NULL AND mb_albumid != ''
        LIMIT 1
      `).get(albumName, artistName) as { mb_albumid: string } | undefined;
    }

    return row ? { mbAlbumId: row.mb_albumid } : null;
  } finally {
    db.close();
  }
}
