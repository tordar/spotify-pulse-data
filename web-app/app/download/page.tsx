'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'

// ── Types ──────────────────────────────────────────────────────────────────

interface Album {
  id: number; name: string; artistName: string; spotifyId: string | null; imageUrl: string | null
  releaseDate: string | null; albumType: string | null; totalTracks: number
  queueStatus: 'queued' | 'skipped' | null
  trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
  duplicateCount: number
}

interface SavedAlbum {
  spotifyId: string; name: string; artistName: string; imageUrl: string | null
  releaseDate: string; albumType: string; totalTracks: number; addedAt: string
  spotifyUrl: string | null
  localId: number | null; queueStatus: string | null
  trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
  inLibrary: boolean
}

interface Artist {
  id: number; name: string; imageUrl: string | null; spotifyId: string | null
  trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
}

interface Track {
  id: number; name: string; trackNumber: number | null; discNumber: number | null
  durationMs: number; spotifyId: string | null; localFilePath: string | null
  downloadStatus: string; artistName: string; albumName: string
  albumImageUrl: string | null; playCount: number
}

interface AlbumTrack {
  id: number; name: string; trackNumber: number | null; discNumber: number | null
  durationMs: number; spotifyId: string | null; localFilePath: string | null
  downloadStatus: string; artistName: string; playCount: number
}

interface Summary { queuedAlbums: number; queuedTracks: number }

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_TABS = [
  { key: 'listened', label: 'Most Listened' },
  { key: 'saved', label: 'Saved Albums' },
]

const VIEW_TABS = [
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
  { key: 'tracks', label: 'Tracks' },
]

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'undecided', label: 'Undecided' },
  { key: 'queued', label: 'Queued' },
  { key: 'skipped', label: 'Skipped' },
]

const TRACK_STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'downloaded', label: 'Downloaded' },
  { key: 'missing', label: 'Missing' },
]

const ALBUM_SORT = [
  { key: 'plays', label: 'Most played' },
  { key: 'downloaded', label: 'Most downloaded' },
  { key: 'az', label: 'A–Z' },
]

const ARTIST_SORT = [
  { key: 'plays', label: 'Most played' },
  { key: 'downloaded', label: 'Most downloaded' },
  { key: 'az', label: 'A–Z' },
]

const TRACK_SORT = [
  { key: 'plays', label: 'Most played' },
  { key: 'album', label: 'By album' },
  { key: 'az', label: 'A–Z' },
]

const MIN_PLAYS_OPTIONS = [
  { value: 0, label: 'Any plays' },
  { value: 1, label: '1+ plays' },
  { value: 5, label: '5+ plays' },
  { value: 10, label: '10+ plays' },
  { value: 25, label: '25+ plays' },
  { value: 50, label: '50+ plays' },
]

const LIMIT = 40

const SPOTIFY_URL_LIST_KEY = 'spotify-pulse-sldl-url-list'

type UrlListEntry = { spotifyId: string; artistName: string; albumName: string }

function loadUrlList(): Map<string, UrlListEntry> {
  if (typeof window === 'undefined') return new Map()
  try {
    const raw = localStorage.getItem(SPOTIFY_URL_LIST_KEY)
    if (!raw) return new Map()
    const arr = JSON.parse(raw) as UrlListEntry[]
    return Array.isArray(arr) ? new Map(arr.map(e => [e.spotifyId, e])) : new Map()
  } catch { return new Map() }
}

function saveUrlList(map: Map<string, UrlListEntry>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SPOTIFY_URL_LIST_KEY, JSON.stringify([...map.values()]))
  } catch { /* ignore */ }
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`
  return val
}

// ── Small components ───────────────────────────────────────────────────────

function fmt(ms: number) {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function DownloadBar({ downloaded, total, compact }: { downloaded: number; total: number; compact?: boolean }) {
  const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0
  return (
    <div className={compact ? 'mt-1' : 'mt-2'}>
      {!compact && (
        <div className="flex justify-between text-xs text-white/40 mb-1">
          <span>{downloaded} / {total} downloaded</span>
          <span>{pct}%</span>
        </div>
      )}
      <div className={`${compact ? 'h-0.5' : 'h-1'} bg-white/10 rounded-full overflow-hidden`}>
        <div className="h-full bg-green-500/70 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      {compact && <p className="text-xs text-white/30 mt-0.5">{downloaded}/{total}</p>}
    </div>
  )
}

function TrackStatusDot({ status, hasFile }: { status: string; hasFile: boolean }) {
  if (hasFile) return <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Downloaded" />
  if (status === 'failed') return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Failed" />
  if (status === 'skipped') return <span className="w-2 h-2 rounded-full bg-white/15 shrink-0" title="Skipped" />
  return <span className="w-2 h-2 rounded-full bg-white/10 shrink-0" title="Pending" />
}

function QueueButton({ status, pendingTracks, onChange }: {
  status: 'queued' | 'skipped' | null; pendingTracks: number
  onChange: (next: 'queued' | 'skipped' | null) => void
}) {
  if (status === 'queued') return (
    <div className="flex gap-1.5 mt-3">
      <button onClick={() => onChange(null)} className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-green-500/20 text-green-400 border border-green-500/40 hover:bg-green-500/30 transition-colors">
        ✓ Queued ({pendingTracks} to get)
      </button>
      <button onClick={e => { e.stopPropagation(); onChange('skipped') }} className="px-3 py-1.5 text-xs rounded-lg bg-white/5 text-white/40 hover:bg-white/10 transition-colors">✕</button>
    </div>
  )
  if (status === 'skipped') return (
    <div className="flex gap-1.5 mt-3">
      <button onClick={() => onChange('queued')} className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-white/5 text-white/30 border border-white/10 hover:bg-white/10 transition-colors">Queue for download</button>
      <button onClick={e => { e.stopPropagation(); onChange(null) }} className="px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400/60 border border-red-500/20 hover:bg-red-500/20 transition-colors">Skipped</button>
    </div>
  )
  return (
    <div className="flex gap-1.5 mt-3">
      <button onClick={() => onChange('queued')} className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-white/15 text-white/60 hover:bg-green-500/15 hover:border-green-500/40 hover:text-green-400 transition-colors">
        + Queue ({pendingTracks} tracks)
      </button>
      <button onClick={e => { e.stopPropagation(); onChange('skipped') }} className="px-3 py-1.5 text-xs rounded-lg bg-white/5 text-white/30 hover:bg-white/10 transition-colors">✕</button>
    </div>
  )
}

// ── Merge modal ────────────────────────────────────────────────────────────

function MergeModal({ group, remaining, onDismiss, onMerged }: {
  group: AlbumTrack[]
  remaining: number  // total duplicate groups left including this one
  onDismiss: () => void
  onMerged: (removedId: number, keptId: number, combinedPlayCount: number) => void
}) {
  const [keepId, setKeepId] = useState<number>(() => {
    // Default: keep the one with more plays, or the one with a local file
    const withFile = group.find(t => t.localFilePath)
    const mostPlayed = [...group].sort((a, b) => b.playCount - a.playCount)[0]
    return (withFile ?? mostPlayed ?? group[0]).id
  })
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset keepId when group changes (next duplicate shown)
  useEffect(() => {
    const withFile = group.find(t => t.localFilePath)
    const mostPlayed = [...group].sort((a, b) => b.playCount - a.playCount)[0]
    setKeepId((withFile ?? mostPlayed ?? group[0]).id)
    setError(null)
  }, [group])

  async function doMerge() {
    const mergeId = group.find(t => t.id !== keepId)!.id
    setMerging(true); setError(null)
    try {
      const res = await fetch('/api/mapping/merge-tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepId, mergeId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Merge failed')
      onMerged(mergeId, keepId, data.combinedPlayCount ?? 0)
    } catch (e) {
      setError(String(e))
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onDismiss} />
      <div className="relative bg-gray-900 border border-white/15 rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-base font-semibold">Merge duplicate tracks</h2>
          {remaining > 1 && (
            <span className="text-xs text-orange-400 bg-orange-500/15 px-2 py-0.5 rounded-full">
              {remaining} left
            </span>
          )}
        </div>
        <p className="text-xs text-white/40 mb-5">
          Both entries are the same song. Pick the name to keep — plays and local file are combined automatically.
        </p>

        <div className="space-y-2 mb-6">
          {group.map(track => (
            <label key={track.id}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${keepId === track.id ? 'border-green-500/50 bg-green-500/8' : 'border-white/10 hover:border-white/20'}`}>
              <input type="radio" name="keep" value={track.id} checked={keepId === track.id}
                onChange={() => setKeepId(track.id)} className="mt-0.5 accent-green-500" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{track.name}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                  <span className="text-xs text-white/40">{track.playCount > 0 ? `${track.playCount.toLocaleString()} plays` : 'No plays'}</span>
                  {track.localFilePath
                    ? <span className="text-xs text-green-400">Has local file</span>
                    : <span className="text-xs text-yellow-500/70">No local file</span>}
                  {track.durationMs > 0 && <span className="text-xs text-white/30">{fmt(track.durationMs)}</span>}
                </div>
                {track.localFilePath && (
                  <p className="text-xs text-white/20 font-mono truncate mt-1">
                    {track.localFilePath.split('/').slice(-2).join('/')}
                  </p>
                )}
              </div>
            </label>
          ))}
        </div>

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        <div className="flex gap-3">
          <button onClick={onDismiss}
            className="px-4 py-2 text-sm rounded-lg bg-white/5 text-white/50 hover:bg-white/10 transition-colors">
            Dismiss all
          </button>
          <button onClick={doMerge} disabled={merging}
            className="flex-1 py-2 text-sm font-medium rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 transition-colors">
            {merging ? 'Merging…' : remaining > 1 ? `Merge & continue →` : 'Merge tracks'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Album detail panel ─────────────────────────────────────────────────────

function AlbumDetailPanel({ album, onClose, onQueueChange }: {
  album: Album; onClose: () => void
  onQueueChange: (s: 'queued' | 'skipped' | null) => void
}) {
  const [tracks, setTracks] = useState<AlbumTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [mergeGroupIdx, setMergeGroupIdx] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [unlinkedFiles, setUnlinkedFiles] = useState<string[]>([])
  const [linkPickerTrackId, setLinkPickerTrackId] = useState<number | null>(null)

  function loadTracks() {
    setLoading(true)
    setDismissed(false)
    setMergeGroupIdx(null)
    setUnlinkedFiles([])
    Promise.all([
      fetch(`/api/download/albums/${album.id}/tracks`).then(r => r.json()),
      fetch(`/api/download/albums/${album.id}/unlinked-files`).then(r => r.json()),
    ]).then(([trackData, fileData]) => {
      setTracks(trackData.tracks ?? [])
      setUnlinkedFiles(fileData.files ?? [])
    }).finally(() => setLoading(false))
  }

  async function handleLinkFile(trackId: number, filePath: string) {
    const res = await fetch(`/api/download/tracks/${trackId}/link-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    })
    if (!res.ok) return
    setTracks(prev => prev.map(t => t.id === trackId
      ? { ...t, localFilePath: filePath, downloadStatus: 'downloaded' }
      : t
    ))
    setUnlinkedFiles(prev => prev.filter(f => f !== filePath))
    setLinkPickerTrackId(null)
  }

  useEffect(() => { loadTracks() }, [album.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Find groups of tracks that are duplicates, using two passes:
  // 1. Track-number based: same disc+track slot
  // 2. Name-based: same normalized name (strips remaster/edition suffixes) — catches
  //    local-file tracks that lack a track_number but are clearly the same song
  const duplicateGroups = (() => {
    function normName(s: string) {
      return s
        .toLowerCase()
        .replace(/\s*[-–]\s*(19|20)\d{2}\s+remaster(ed)?/gi, '')
        .replace(/\s*[-–]\s*remaster(ed)?(\s+(19|20)\d{2})?/gi, '')
        .replace(/\s*\((19|20)\d{2}\s+remaster(ed)?\)/gi, '')
        .replace(/\s*\(remaster(ed)?\)/gi, '')
        .replace(/\s*[-–]\s*(deluxe|anniversary|expanded|special)\s*(edition|version)?/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    // Pass 1: group by disc+track number
    const bySlot = new Map<string, AlbumTrack[]>()
    for (const t of tracks) {
      if (!t.trackNumber) continue
      const key = `${t.discNumber ?? 1}-${t.trackNumber}`
      const arr = bySlot.get(key) ?? []
      arr.push(t)
      bySlot.set(key, arr)
    }
    const groups = [...bySlot.values()].filter(g => g.length > 1)

    // Pass 2: for tracks not yet in any group, match by normalized name
    const groupedIds = new Set(groups.flatMap(g => g.map(t => t.id)))
    const byNorm = new Map<string, AlbumTrack[]>()
    for (const t of tracks) {
      const norm = normName(t.name)
      const arr = byNorm.get(norm) ?? []
      arr.push(t)
      byNorm.set(norm, arr)
    }
    for (const [, grp] of byNorm) {
      if (grp.length < 2) continue
      // Check if any member is already in a slot-based group
      const existingGroup = groups.find(g => g.some(t => grp.some(r => r.id === t.id)))
      if (existingGroup) {
        // Add ungrouped members to the existing group
        for (const t of grp) {
          if (!groupedIds.has(t.id)) {
            existingGroup.push(t)
            groupedIds.add(t.id)
          }
        }
      } else {
        // Entirely new name-based group
        groups.push(grp)
        grp.forEach(t => groupedIds.add(t.id))
      }
    }

    return groups
  })()

  // Auto-open first merge modal when duplicates are found, and advance after each merge
  useEffect(() => {
    if (!loading && !dismissed && duplicateGroups.length > 0 && mergeGroupIdx === null) {
      setMergeGroupIdx(0)
    }
  }, [loading, dismissed, duplicateGroups.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const duplicateIds = new Set(duplicateGroups.flatMap(g => g.map(t => t.id)))
  const discs = [...new Set(tracks.map(t => t.discNumber ?? 1))].sort((a, b) => a - b)
  const isMultiDisc = discs.length > 1
  const downloaded = tracks.filter(t => t.localFilePath).length
  const missing = tracks.filter(t => !t.localFilePath && t.downloadStatus !== 'skipped').length

  function handleMerged(removedId: number, keptId: number, combinedPlayCount: number) {
    setTracks(prev =>
      prev
        .filter(t => t.id !== removedId)
        .map(t => t.id === keptId ? { ...t, playCount: combinedPlayCount } : t)
    )
    // mergeGroupIdx stays the same; duplicateGroups will shrink by 1 after tracks update,
    // so the same index will point to the next group (or be out of bounds → modal closes)
  }

  return (
    <>
      <div className="fixed inset-y-0 right-0 w-[480px] bg-gray-950 border-l border-white/10 z-20 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-start gap-3 p-4 border-b border-white/10">
          <div className="w-16 h-16 rounded-lg overflow-hidden bg-white/5 relative shrink-0">
            {album.imageUrl ? <Image src={album.imageUrl} alt={album.name} fill className="object-cover" sizes="64px" unoptimized /> : <div className="w-full h-full flex items-center justify-center text-white/10 text-2xl">♪</div>}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold truncate">{album.name}</p>
            <p className="text-sm text-white/50 truncate">{album.artistName}</p>
            <p className="text-xs text-white/30 mt-0.5">{album.releaseDate?.slice(0, 4)} · {album.playCount > 0 ? `${album.playCount.toLocaleString()} plays` : 'No plays'}</p>
            <div className="flex flex-wrap gap-3 text-xs mt-1.5">
              <span className="text-green-400">{downloaded} downloaded</span>
              {missing > 0 && <span className="text-yellow-400">{missing} missing</span>}
              {duplicateGroups.length > 0 && (
                <span className="text-orange-400">{duplicateGroups.length} duplicate{duplicateGroups.length > 1 ? 's' : ''}</span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 text-xl shrink-0 mt-0.5">✕</button>
        </div>

        {/* Queue button */}
        <div className="px-4 py-3 border-b border-white/10">
          <QueueButton status={album.queueStatus} pendingTracks={album.pendingTracks} onChange={onQueueChange} />
        </div>

        {/* Duplicate banner */}
        {duplicateGroups.length > 0 && (
          <div className="px-4 py-3 border-b border-orange-500/20 bg-orange-500/5">
            <p className="text-xs text-orange-300/80 font-medium mb-2">
              {duplicateGroups.length} track{duplicateGroups.length > 1 ? 's have' : ' has'} duplicate entries — likely renamed on Spotify
            </p>
            <div className="space-y-1.5">
              {duplicateGroups.map((group, i) => (
                <button key={i} onClick={() => { setDismissed(false); setMergeGroupIdx(i) }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/25 hover:bg-orange-500/20 transition-colors text-left">
                  <div className="min-w-0">
                    <p className="text-xs text-orange-200 font-medium">Track {group[0].trackNumber}</p>
                    <p className="text-xs text-white/40 truncate">{group.map(t => t.name).join(' · ')}</p>
                  </div>
                  <span className="text-xs text-orange-400 shrink-0 ml-2">Merge →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Unlinked files banner */}
        {unlinkedFiles.length > 0 && (
          <div className="px-4 py-3 border-b border-blue-500/20 bg-blue-500/5">
            <p className="text-xs text-blue-300/80 font-medium">
              {unlinkedFiles.length} file{unlinkedFiles.length > 1 ? 's' : ''} in folder not linked to any track — click &ldquo;Link&rdquo; on a missing track
            </p>
          </div>
        )}

        {/* Track list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? <div className="p-6 text-center text-white/30 text-sm">Loading tracks…</div> : (
            <div className="py-2">
              {discs.map(disc => (
                <div key={disc}>
                  {isMultiDisc && <p className="px-4 py-2 text-xs font-semibold text-white/30 uppercase tracking-wider">Disc {disc}</p>}
                  {tracks.filter(t => (t.discNumber ?? 1) === disc).map(track => (
                    <div key={track.id}
                      className={`px-4 py-2.5 transition-colors ${duplicateIds.has(track.id) ? 'bg-orange-500/5 hover:bg-orange-500/10' : 'hover:bg-white/5'}`}>
                      <div className="flex items-start gap-3">
                        <span className="text-xs text-white/25 w-5 text-right shrink-0 mt-0.5">{track.trackNumber ?? '–'}</span>
                        {duplicateIds.has(track.id)
                          ? <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0 mt-1.5" title="Duplicate" />
                          : <TrackStatusDot status={track.downloadStatus} hasFile={!!track.localFilePath} />}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-sm truncate ${track.localFilePath ? 'text-white' : duplicateIds.has(track.id) ? 'text-orange-200/70' : 'text-white/50'}`}>{track.name}</p>
                            <span className="text-xs text-white/25 shrink-0">{fmt(track.durationMs)}</span>
                          </div>
                          {track.playCount > 0 && <p className="text-xs text-white/30 mt-0.5">{track.playCount.toLocaleString()} plays</p>}
                          {track.localFilePath && <p className="text-xs text-white/25 font-mono truncate mt-0.5" title={track.localFilePath}>{track.localFilePath.split('/').slice(-3).join('/')}</p>}
                          {!track.localFilePath && !duplicateIds.has(track.id) && track.downloadStatus !== 'skipped' && (
                            <>
                              <p className="text-xs text-yellow-500/50 mt-0.5">Missing</p>
                              {linkPickerTrackId === track.id && unlinkedFiles.length > 0 && (
                                <div className="mt-2 rounded-lg border border-blue-500/30 bg-blue-500/5 overflow-hidden">
                                  {unlinkedFiles.map(f => (
                                    <button key={f}
                                      onClick={() => handleLinkFile(track.id, f)}
                                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-500/15 transition-colors border-b border-blue-500/10 last:border-0">
                                      <span className="text-blue-400 shrink-0 text-xs">📁</span>
                                      <span className="text-xs text-white/60 font-mono truncate">{f.split('/').pop()}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                        {duplicateIds.has(track.id) && (
                          <button
                            onClick={() => {
                              const idx = duplicateGroups.findIndex(g => g.some(t => t.id === track.id))
                              setDismissed(false)
                              setMergeGroupIdx(idx === -1 ? 0 : idx)
                            }}
                            className="text-xs text-orange-400 hover:text-orange-300 shrink-0 mt-0.5 transition-colors"
                            title="Merge this duplicate">
                            Merge
                          </button>
                        )}
                        {!track.localFilePath && !duplicateIds.has(track.id) && track.downloadStatus !== 'skipped' && unlinkedFiles.length > 0 && (
                          <button
                            onClick={() => setLinkPickerTrackId(linkPickerTrackId === track.id ? null : track.id)}
                            className={`text-xs shrink-0 mt-0.5 transition-colors ${linkPickerTrackId === track.id ? 'text-blue-300' : 'text-blue-500/70 hover:text-blue-400'}`}
                            title="Link a local file to this track">
                            Link
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="px-4 py-3 border-t border-white/10 flex flex-wrap gap-4 text-xs text-white/30">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" /> Downloaded</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-500/50" /> Missing</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400" /> Duplicate</span>
          {unlinkedFiles.length > 0 && <span className="flex items-center gap-1.5 text-blue-400/60">📁 {unlinkedFiles.length} unlinked file{unlinkedFiles.length > 1 ? 's' : ''} in folder</span>}
        </div>
      </div>

      {mergeGroupIdx !== null && mergeGroupIdx < duplicateGroups.length && (
        <MergeModal
          group={duplicateGroups[mergeGroupIdx]}
          remaining={duplicateGroups.length - mergeGroupIdx}
          onDismiss={() => { setMergeGroupIdx(null); setDismissed(true) }}
          onMerged={(removedId, keptId, combinedPlayCount) => {
            handleMerged(removedId, keptId, combinedPlayCount)
            // After merge, duplicateGroups will shrink; the same index now points to the
            // next group (or becomes out-of-bounds, which closes the modal naturally).
          }}
        />
      )}
    </>
  )
}

// ── Filter bar ─────────────────────────────────────────────────────────────

function FilterBar({ q, onQ, tabs, activeTab, onTab, sortOptions, sort, onSort, minPlays, onMinPlays, showMinPlays }: {
  q: string; onQ: (v: string) => void
  tabs: { key: string; label: string }[]; activeTab: string; onTab: (k: string) => void
  sortOptions: { key: string; label: string }[]; sort: string; onSort: (v: string) => void
  minPlays: number; onMinPlays: (v: number) => void; showMinPlays: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      <input
        className="flex-1 min-w-48 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-white/30"
        placeholder="Search…"
        value={q}
        onChange={e => onQ(e.target.value)}
      />
      <div className="flex bg-white/5 rounded-lg p-0.5">
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => onTab(tab.key)}
            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${activeTab === tab.key ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'}`}>
            {tab.label}
          </button>
        ))}
      </div>
      {showMinPlays && (
        <select value={minPlays} onChange={e => onMinPlays(Number(e.target.value))}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-white/30">
          {MIN_PLAYS_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-gray-900">{o.label}</option>)}
        </select>
      )}
      <select value={sort} onChange={e => onSort(e.target.value)}
        className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-white/30">
        {sortOptions.map(o => <option key={o.key} value={o.key} className="bg-gray-900">{o.label}</option>)}
      </select>
    </div>
  )
}

// ── Albums view ────────────────────────────────────────────────────────────

function AlbumsView({
  selectedAlbum,
  onSelectAlbum,
  onQueueChange,
  urlListSpotifyIds = new Set<string>(),
  onToggleUrlList,
}: {
  selectedAlbum: Album | null
  onSelectAlbum: (a: Album | null) => void
  onQueueChange: (id: number, s: 'queued' | 'skipped' | null) => void
  urlListSpotifyIds?: Set<string>
  onToggleUrlList?: (album: Album) => void
}) {
  const [albums, setAlbums] = useState<Album[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [q, setQ] = useState('')
  const [statusTab, setStatusTab] = useState('all')
  const [sort, setSort] = useState('plays')
  const [minPlays, setMinPlays] = useState(0)
  const [hideMostlyDownloaded, setHideMostlyDownloaded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (query: string, status: string, sortBy: string, mp: number, off: number, append = false, hideMostly = false) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ q: query, status, sort: sortBy, minPlays: String(mp), limit: String(LIMIT), offset: String(off) })
      if (hideMostly) p.set('hideMostlyDownloaded', '1')
      const res = await fetch(`/api/download/albums?${p}`)
      const data = await res.json()
      if (append) setAlbums(prev => [...prev, ...(data.albums ?? [])])
      else { setAlbums(data.albums ?? []); setOffset(0) }
      setTotal(data.total ?? 0)
      setHasMore((data.albums?.length ?? 0) === LIMIT)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetch_(q, statusTab, sort, minPlays, 0, false, hideMostlyDownloaded) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fetch_(q, statusTab, sort, minPlays, 0, false, hideMostlyDownloaded), 300)
  }, [q, statusTab, sort, minPlays, hideMostlyDownloaded, fetch_])

  async function loadMore() {
    const next = offset + LIMIT; setOffset(next)
    await fetch_(q, statusTab, sort, minPlays, next, true, hideMostlyDownloaded)
  }

  const year = (d: string | null) => d?.slice(0, 4) ?? null

  return (
    <>
      <FilterBar q={q} onQ={setQ} tabs={STATUS_TABS} activeTab={statusTab} onTab={setStatusTab}
        sortOptions={ALBUM_SORT} sort={sort} onSort={setSort}
        minPlays={minPlays} onMinPlays={setMinPlays} showMinPlays={true} />
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
          <input
            type="checkbox"
            checked={hideMostlyDownloaded}
            onChange={e => setHideMostlyDownloaded(e.target.checked)}
            className="rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500/50"
          />
          Hide albums with ≥50% tracks downloaded
        </label>
        <p className="text-xs text-white/30">{total.toLocaleString()} albums</p>
      </div>

      {loading && albums.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">Loading…</div>
      ) : albums.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">No albums found</div>
      ) : (
        <>
          <div className={`grid gap-4 ${selectedAlbum ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'}`}>
            {albums.map(album => (
              <div key={album.id} onClick={() => onSelectAlbum(selectedAlbum?.id === album.id ? null : album)}
                className={`rounded-xl bg-white/5 border transition-all p-3 flex flex-col cursor-pointer ${
                  selectedAlbum?.id === album.id ? 'border-white/40 ring-1 ring-white/20'
                  : album.queueStatus === 'queued' ? 'border-green-500/30 bg-green-500/5 hover:border-green-500/50'
                  : album.queueStatus === 'skipped' ? 'border-white/5 opacity-40 hover:opacity-60'
                  : 'border-white/10 hover:border-white/25'
                }`}>
                <div className="aspect-square rounded-lg overflow-hidden bg-white/5 mb-3 relative">
                  {album.imageUrl ? <Image src={album.imageUrl} alt={album.name} fill className="object-cover" sizes="200px" unoptimized />
                    : <div className="w-full h-full flex items-center justify-center text-white/10 text-3xl">♪</div>}
                  {album.duplicateCount > 0 && (
                      <div className="absolute top-1 right-1 bg-orange-500/90 text-white text-xs px-1.5 py-0.5 rounded font-medium" title={`${album.duplicateCount} duplicate track slot${album.duplicateCount > 1 ? 's' : ''}`}>
                        {album.duplicateCount}×
                      </div>
                    )}
                  {album.playCount > 0 && (
                      <div className="absolute bottom-1 right-1 bg-black/70 text-white/80 text-xs px-1.5 py-0.5 rounded">
                        {album.playCount.toLocaleString()} plays
                      </div>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate leading-tight">{album.name}</p>
                  <p className="text-xs text-white/50 truncate mt-0.5">{album.artistName}</p>
                  {year(album.releaseDate) && <p className="text-xs text-white/30 mt-0.5">{year(album.releaseDate)}</p>}
                </div>
                <DownloadBar downloaded={album.downloadedTracks} total={album.trackCount} />
                <div onClick={e => e.stopPropagation()} className="flex flex-wrap gap-1 mt-1">
                  <QueueButton status={album.queueStatus} pendingTracks={album.pendingTracks}
                    onChange={s => onQueueChange(album.id, s)} />
                  {album.spotifyId && onToggleUrlList && (
                    <button
                      type="button"
                      onClick={() => onToggleUrlList(album)}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        urlListSpotifyIds.has(album.spotifyId)
                          ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                          : 'border-white/15 text-white/60 hover:border-white/30 hover:text-white/80'
                      }`}
                      title={urlListSpotifyIds.has(album.spotifyId) ? 'Remove from sldl URL list' : 'Add to sldl URL list'}
                    >
                      {urlListSpotifyIds.has(album.spotifyId) ? '✓ In list' : '+ sldl list'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center mt-8">
              <button onClick={loadMore} disabled={loading}
                className="px-6 py-2.5 text-sm rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors">
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Artists view ───────────────────────────────────────────────────────────

function ArtistsView() {
  const [artists, setArtists] = useState<Artist[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('plays')
  const [minPlays, setMinPlays] = useState(1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (query: string, sortBy: string, mp: number, off: number, append = false) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ q: query, sort: sortBy, minPlays: String(mp), limit: String(LIMIT), offset: String(off) })
      const res = await fetch(`/api/download/artists?${p}`)
      const data = await res.json()
      if (append) setArtists(prev => [...prev, ...(data.artists ?? [])])
      else { setArtists(data.artists ?? []); setOffset(0) }
      setTotal(data.total ?? 0)
      setHasMore((data.artists?.length ?? 0) === LIMIT)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetch_(q, sort, minPlays, 0) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fetch_(q, sort, minPlays, 0), 300)
  }, [q, sort, minPlays, fetch_])

  async function loadMore() {
    const next = offset + LIMIT; setOffset(next)
    await fetch_(q, sort, minPlays, next, true)
  }

  return (
    <>
      <FilterBar q={q} onQ={setQ} tabs={[]} activeTab="" onTab={() => {}}
        sortOptions={ARTIST_SORT} sort={sort} onSort={setSort}
        minPlays={minPlays} onMinPlays={setMinPlays} showMinPlays={true} />
      <p className="text-xs text-white/30 mb-4">{total.toLocaleString()} artists</p>

      {loading && artists.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">Loading…</div>
      ) : artists.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">No artists found</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {artists.map(artist => (
              <div key={artist.id} className="rounded-xl bg-white/5 border border-white/10 p-3 flex flex-col hover:border-white/25 transition-colors">
                <div className="aspect-square rounded-full overflow-hidden bg-white/5 mb-3 relative">
                  {artist.imageUrl ? <Image src={artist.imageUrl} alt={artist.name} fill className="object-cover" sizes="200px" unoptimized />
                    : <div className="w-full h-full flex items-center justify-center text-white/10 text-3xl">♪</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate leading-tight text-center">{artist.name}</p>
                  <p className="text-xs text-white/40 text-center mt-0.5">{artist.playCount.toLocaleString()} plays</p>
                </div>
                <DownloadBar downloaded={artist.downloadedTracks} total={artist.trackCount} compact />
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center mt-8">
              <button onClick={loadMore} disabled={loading}
                className="px-6 py-2.5 text-sm rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors">
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Tracks view ────────────────────────────────────────────────────────────

function TracksView() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [q, setQ] = useState('')
  const [statusTab, setStatusTab] = useState('all')
  const [sort, setSort] = useState('plays')
  const [minPlays, setMinPlays] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (query: string, status: string, sortBy: string, mp: number, off: number, append = false) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ q: query, status, sort: sortBy, minPlays: String(mp), limit: String(LIMIT), offset: String(off) })
      const res = await fetch(`/api/download/tracks?${p}`)
      const data = await res.json()
      if (append) setTracks(prev => [...prev, ...(data.tracks ?? [])])
      else { setTracks(data.tracks ?? []); setOffset(0) }
      setTotal(data.total ?? 0)
      setHasMore((data.tracks?.length ?? 0) === LIMIT)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetch_(q, statusTab, sort, minPlays, 0) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fetch_(q, statusTab, sort, minPlays, 0), 300)
  }, [q, statusTab, sort, minPlays, fetch_])

  async function loadMore() {
    const next = offset + LIMIT; setOffset(next)
    await fetch_(q, statusTab, sort, minPlays, next, true)
  }

  return (
    <>
      <FilterBar q={q} onQ={setQ} tabs={TRACK_STATUS_TABS} activeTab={statusTab} onTab={setStatusTab}
        sortOptions={TRACK_SORT} sort={sort} onSort={setSort}
        minPlays={minPlays} onMinPlays={setMinPlays} showMinPlays={true} />
      <p className="text-xs text-white/30 mb-4">{total.toLocaleString()} tracks</p>

      {loading && tracks.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">Loading…</div>
      ) : tracks.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">No tracks found</div>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 overflow-hidden">
            {tracks.map((track, i) => (
              <div key={track.id}>
                <div
                  onClick={() => setExpanded(expanded === track.id ? null : track.id)}
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-white/5 ${i > 0 ? 'border-t border-white/5' : ''}`}
                >
                  <TrackStatusDot status={track.downloadStatus} hasFile={!!track.localFilePath} />
                  <div className="w-8 h-8 rounded overflow-hidden bg-white/5 relative shrink-0">
                    {track.albumImageUrl
                      ? <Image src={track.albumImageUrl} alt={track.albumName} fill className="object-cover" sizes="32px" unoptimized />
                      : <div className="w-full h-full flex items-center justify-center text-white/10 text-xs">♪</div>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{track.name}</p>
                    <p className="text-xs text-white/40 truncate">{track.artistName} · {track.albumName}</p>
                  </div>
                  <div className="text-right shrink-0">
                    {track.playCount > 0 && <p className="text-xs text-white/50">{track.playCount.toLocaleString()} plays</p>}
                    <p className="text-xs text-white/25">{fmt(track.durationMs)}</p>
                  </div>
                </div>
                {expanded === track.id && (
                  <div className="px-4 py-3 bg-white/3 border-t border-white/5 text-xs text-white/50 space-y-1">
                    <p><span className="text-white/30">Status:</span> {track.localFilePath ? <span className="text-green-400">Downloaded</span> : <span className="text-yellow-400">{track.downloadStatus}</span>}</p>
                    {track.localFilePath && <p className="font-mono text-white/30 break-all">{track.localFilePath}</p>}
                    {track.spotifyId && <p><span className="text-white/30">Spotify ID:</span> {track.spotifyId}</p>}
                    {track.trackNumber && <p><span className="text-white/30">Track:</span> {track.discNumber && track.discNumber > 1 ? `${track.discNumber}-` : ''}{track.trackNumber}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center mt-8">
              <button onClick={loadMore} disabled={loading}
                className="px-6 py-2.5 text-sm rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors">
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Saved Albums view ──────────────────────────────────────────────────────

const SAVED_SORT = [
  { key: 'added', label: 'Recently saved' },
  { key: 'az', label: 'A–Z' },
  { key: 'artist', label: 'By artist' },
]

const SAVED_STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'missing', label: 'Not downloaded' },
  { key: 'partial', label: '< 50% downloaded' },
  { key: 'complete', label: '≥ 50% downloaded' },
]

 function SavedAlbumsView({
   selectedAlbum,
   onSelectAlbum,
   onQueueChange,
   urlListSpotifyIds = new Set<string>(),
   onToggleUrlList,
 }: {
   selectedAlbum: Album | null
   onSelectAlbum: (a: Album | null) => void
   onQueueChange: (id: number, s: 'queued' | 'skipped' | null) => void
   urlListSpotifyIds?: Set<string>
   onToggleUrlList?: (album: Album) => void
 }) {
  const [albums, setAlbums] = useState<SavedAlbum[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [q, setQ] = useState('')
  const [statusTab, setStatusTab] = useState('all')
  const [sort, setSort] = useState('added')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (query: string, off: number, append = false) => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams({ q: query, limit: String(LIMIT), offset: String(off) })
      const res = await fetch(`/api/spotify/saved-albums?${p}`)
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load saved albums')
        if (!append) setAlbums([])
        return
      }
      if (append) setAlbums(prev => [...prev, ...(data.albums ?? [])])
      else { setAlbums(data.albums ?? []); setOffset(0) }
      setTotal(data.total ?? 0)
      setHasMore(data.hasMore ?? false)
    } catch (e) {
      setError(String(e))
      if (!append) setAlbums([])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetch_('', 0) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => fetch_(q, 0), 300)
  }, [q, fetch_])

  async function loadMore() {
    const next = offset + LIMIT; setOffset(next)
    await fetch_(q, next, true)
  }

  const year = (d: string | null) => d?.slice(0, 4) ?? null

  function dlPct(a: SavedAlbum) {
    const total = a.trackCount || a.totalTracks
    return total > 0 ? a.downloadedTracks / total : 0
  }

  let filtered = albums
  if (statusTab === 'missing') filtered = albums.filter(a => a.downloadedTracks === 0)
  else if (statusTab === 'partial') filtered = albums.filter(a => dlPct(a) < 0.5)
  else if (statusTab === 'complete') filtered = albums.filter(a => dlPct(a) >= 0.5)

  if (sort === 'az') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  else if (sort === 'artist') filtered = [...filtered].sort((a, b) => a.artistName.localeCompare(b.artistName))

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm mb-2">{error}</p>
        {error.includes('not connected') && (
          <p className="text-white/40 text-xs">Connect your Spotify account on the home page to view saved albums.</p>
        )}
      </div>
    )
  }

  function albumToLocal(a: SavedAlbum): Album | null {
    if (!a.localId) return null
    return {
      id: a.localId,
      name: a.name,
      artistName: a.artistName,
      spotifyId: a.spotifyId,
      imageUrl: a.imageUrl,
      releaseDate: a.releaseDate,
      albumType: a.albumType,
      totalTracks: a.totalTracks,
      queueStatus: (a.queueStatus as 'queued' | 'skipped' | null) ?? null,
      trackCount: a.trackCount,
      downloadedTracks: a.downloadedTracks,
      pendingTracks: a.pendingTracks,
      playCount: a.playCount,
      duplicateCount: 0,
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <input
          className="flex-1 min-w-48 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-white/30"
          placeholder="Search saved albums…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="flex bg-white/5 rounded-lg p-0.5">
          {SAVED_STATUS_TABS.map(tab => (
            <button key={tab.key} onClick={() => setStatusTab(tab.key)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${statusTab === tab.key ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <select value={sort} onChange={e => setSort(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-white/30">
          {SAVED_SORT.map(o => <option key={o.key} value={o.key} className="bg-gray-900">{o.label}</option>)}
        </select>
      </div>

      <p className="text-xs text-white/30 mb-4">
        {total.toLocaleString()} saved albums on Spotify
        {statusTab !== 'all' && ` · showing ${filtered.length}`}
      </p>

      {loading && albums.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">Loading saved albums from Spotify…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-white/30 py-20 text-sm">No albums found</div>
      ) : (
        <>
          <div className={`grid gap-4 ${selectedAlbum ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'}`}>
            {filtered.map(album => {
              const local = albumToLocal(album)
              return (
                <div key={album.spotifyId}
                  onClick={() => local ? onSelectAlbum(selectedAlbum?.id === local.id ? null : local) : undefined}
                  className={`rounded-xl bg-white/5 border transition-all p-3 flex flex-col ${
                    local ? 'cursor-pointer' : ''
                  } ${
                    selectedAlbum && local && selectedAlbum.id === local.id ? 'border-white/40 ring-1 ring-white/20'
                    : album.downloadedTracks > 0 && album.downloadedTracks >= (album.trackCount || album.totalTracks) ? 'border-green-500/20 hover:border-green-500/40'
                    : album.downloadedTracks > 0 ? 'border-yellow-500/20 hover:border-yellow-500/40'
                    : 'border-white/10 hover:border-white/25'
                  }`}>
                  <div className="aspect-square rounded-lg overflow-hidden bg-white/5 mb-3 relative">
                    {album.imageUrl ? <Image src={album.imageUrl} alt={album.name} fill className="object-cover" sizes="200px" unoptimized />
                      : <div className="w-full h-full flex items-center justify-center text-white/10 text-3xl">♪</div>}
                    {(() => {
                      const total = album.trackCount || album.totalTracks
                      const pct = total > 0 ? Math.round((album.downloadedTracks / total) * 100) : 0
                      if (pct >= 100) return (
                        <div className="absolute top-1.5 left-1.5 bg-green-600/90 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                          Downloaded
                        </div>
                      )
                      if (pct > 0) return (
                        <div className="absolute top-1.5 left-1.5 bg-yellow-600/90 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                          {pct}%
                        </div>
                      )
                      return null
                    })()}
                    {album.playCount > 0 && (
                      <div className="absolute bottom-1 right-1 bg-black/70 text-white/80 text-xs px-1.5 py-0.5 rounded">
                        {album.playCount.toLocaleString()} plays
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate leading-tight">{album.name}</p>
                    <p className="text-xs text-white/50 truncate mt-0.5">{album.artistName}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {year(album.releaseDate) && <span className="text-xs text-white/30">{year(album.releaseDate)}</span>}
                      <span className="text-xs text-white/20">{album.totalTracks} tracks</span>
                    </div>
                  </div>
                  <DownloadBar downloaded={album.downloadedTracks} total={album.trackCount || album.totalTracks} />
                  {local && (
                    <div onClick={e => e.stopPropagation()}>
                      <QueueButton status={local.queueStatus} pendingTracks={local.pendingTracks}
                        onChange={s => onQueueChange(local.id, s)} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {hasMore && (
            <div className="flex justify-center mt-8">
              <button onClick={loadMore} disabled={loading}
                className="px-6 py-2.5 text-sm rounded-lg bg-white/10 hover:bg-white/15 disabled:opacity-50 transition-colors">
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function DownloadPage() {
  const [source, setSource] = useState<'listened' | 'saved'>('listened')
  const [view, setView] = useState<'albums' | 'artists' | 'tracks'>('albums')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportInfo, setExportInfo] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null)
  const [albums, setAlbums] = useState<Map<number, Album>>(new Map())
  const [urlList, setUrlList] = useState<Map<string, UrlListEntry>>(new Map())

  useEffect(() => { setUrlList(loadUrlList()) }, [])

  const fetchSummary = useCallback(async () => {
    const queuedRes = await fetch('/api/download/albums?status=queued&limit=1&offset=0')
    const queued = await queuedRes.json()
    const csvRes = await fetch('/api/download/export-csv', { method: 'HEAD' }).catch(() => null)
    const queuedTracks = csvRes ? parseInt(csvRes.headers.get('X-Track-Count') ?? '0') : 0
    setSummary({ queuedAlbums: queued.total ?? 0, queuedTracks })
  }, [])

  useEffect(() => { fetchSummary() }, [fetchSummary])

  function toggleUrlList(album: Album) {
    if (!album.spotifyId) return
    setUrlList(prev => {
      const next = new Map(prev)
      if (next.has(album.spotifyId)) next.delete(album.spotifyId)
      else next.set(album.spotifyId, { spotifyId: album.spotifyId, artistName: album.artistName, albumName: album.name })
      saveUrlList(next)
      return next
    })
  }

  function clearUrlList() {
    setUrlList(new Map())
    saveUrlList(new Map())
  }

  function exportSldlUrlListCsv() {
    if (urlList.size === 0) return
    const header = 'Artist,Album,Spotify URL'
    const rows = [...urlList.values()].map(e =>
      [escapeCsv(e.artistName), escapeCsv(e.albumName), escapeCsv(`https://open.spotify.com/album/${e.spotifyId}`)].join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'sldl-spotify-albums.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function setQueueStatus(albumId: number, status: 'queued' | 'skipped' | null) {
    await fetch(`/api/download/albums/${albumId}/queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setAlbums(prev => { const next = new Map(prev); const a = next.get(albumId); if (a) next.set(albumId, { ...a, queueStatus: status }); return next })
    if (selectedAlbum?.id === albumId) setSelectedAlbum(prev => prev ? { ...prev, queueStatus: status } : prev)
    setTimeout(fetchSummary, 200)
  }

  async function exportCsv() {
    setExporting(true); setExportInfo(null)
    try {
      const res = await fetch('/api/download/export-csv')
      const trackCount = res.headers.get('X-Track-Count')
      const filtered = res.headers.get('X-Queue-Filtered') === 'true'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = filtered ? 'sldl-queued.csv' : 'sldl-all-pending.csv'; a.click()
      URL.revokeObjectURL(url)
      setExportInfo(`${Number(trackCount).toLocaleString()} tracks${filtered ? ' (queued only)' : ' (all pending)'}`)
    } finally { setExporting(false) }
  }

  const [clearing, setClearing] = useState(false)

  async function clearQueue() {
    if (!summary || summary.queuedAlbums === 0) return
    if (!confirm(`Clear all ${summary.queuedAlbums} queued albums?`)) return
    setClearing(true)
    try {
      await fetch('/api/download/albums/clear-queue', { method: 'POST' })
      await fetchSummary()
    } finally { setClearing(false) }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-dark-surface via-dark-surfaceHover to-surface-800 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-black/60 backdrop-blur border-b border-white/10 px-6 py-4">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-lg font-semibold">Download Queue</h1>
            </div>
            {/* Source toggle */}
            <div className="flex bg-white/5 rounded-lg p-0.5">
              {SOURCE_TABS.map(tab => (
                <button key={tab.key} onClick={() => { setSource(tab.key as typeof source); setSelectedAlbum(null) }}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${source === tab.key ? 'bg-green-600/80 text-white font-medium' : 'text-white/40 hover:text-white/70'}`}>
                  {tab.label}
                </button>
              ))}
            </div>
            {/* View tabs (only for listened mode) */}
            {source === 'listened' && (
              <div className="flex bg-white/5 rounded-lg p-0.5">
                {VIEW_TABS.map(tab => (
                  <button key={tab.key} onClick={() => { setView(tab.key as typeof view); setSelectedAlbum(null) }}
                    className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === tab.key ? 'bg-white/15 text-white font-medium' : 'text-white/40 hover:text-white/70'}`}>
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {summary && summary.queuedAlbums > 0 && (
              <>
                <div className="text-right text-sm">
                  <p className="text-green-400 font-medium">{summary.queuedAlbums.toLocaleString()} albums queued</p>
                  <p className="text-white/40 text-xs">{summary.queuedTracks.toLocaleString()} tracks to download</p>
                </div>
                <button onClick={clearQueue} disabled={clearing}
                  className="px-3 py-2 text-sm rounded-lg bg-white/5 text-white/50 hover:bg-red-500/15 hover:text-red-400 border border-white/10 hover:border-red-500/30 disabled:opacity-50 transition-colors">
                  {clearing ? 'Clearing…' : 'Clear queue'}
                </button>
              </>
            )}
            {view === 'albums' && urlList.size > 0 && (
              <>
                <button
                  type="button"
                  onClick={clearUrlList}
                  className="px-3 py-2 text-sm rounded-lg bg-white/5 text-white/50 hover:bg-red-500/15 hover:text-red-400 border border-white/10 hover:border-red-500/30 transition-colors"
                  title="Clear sldl URL list"
                >
                  Clear list
                </button>
                <button
                  type="button"
                  onClick={exportSldlUrlListCsv}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
                >
                  Export sldl URLs ({urlList.size})
                </button>
              </>
            )}
            <button onClick={exportCsv} disabled={exporting}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 transition-colors">
              {exporting ? 'Generating…' : 'Export CSV'}
            </button>
          </div>
        </div>
        {view === 'albums' && urlList.size > 0 && (
          <p className="text-xs text-blue-400/90 text-center mt-1">
            {urlList.size} album{urlList.size !== 1 ? 's' : ''} in sldl list — use &quot;+ sldl list&quot; on albums to add
          </p>
        )}
        {exportInfo && <p className="text-xs text-green-400/80 text-center mt-2">Downloaded {exportInfo}</p>}
      </div>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        {source === 'saved' ? (
          <SavedAlbumsView
            selectedAlbum={selectedAlbum}
            onSelectAlbum={setSelectedAlbum}
            onQueueChange={setQueueStatus}
            urlListSpotifyIds={new Set(urlList.keys())}
            onToggleUrlList={toggleUrlList}
          />
        ) : (
          <>
            {view === 'albums' && (
              <AlbumsView
                selectedAlbum={selectedAlbum}
                onSelectAlbum={setSelectedAlbum}
                onQueueChange={setQueueStatus}
                urlListSpotifyIds={new Set(urlList.keys())}
                onToggleUrlList={toggleUrlList}
              />
            )}
            {view === 'artists' && <ArtistsView />}
            {view === 'tracks' && <TracksView />}
          </>
        )}
      </div>

      {selectedAlbum && (source === 'saved' || view === 'albums') && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setSelectedAlbum(null)} />
          <AlbumDetailPanel
            album={selectedAlbum}
            onClose={() => setSelectedAlbum(null)}
            onQueueChange={s => setQueueStatus(selectedAlbum.id, s)}
          />
        </>
      )}
    </div>
  )
}
