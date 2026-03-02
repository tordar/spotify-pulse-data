'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'

// ── Types ──────────────────────────────────────────────────────────────────

interface Album {
  id: number; name: string; artistName: string; imageUrl: string | null
  releaseDate: string | null; albumType: string | null; totalTracks: number
  queueStatus: 'queued' | 'skipped' | null
  trackCount: number; downloadedTracks: number; pendingTracks: number; playCount: number
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

// ── Album detail panel ─────────────────────────────────────────────────────

function AlbumDetailPanel({ album, onClose, onQueueChange }: {
  album: Album; onClose: () => void
  onQueueChange: (s: 'queued' | 'skipped' | null) => void
}) {
  const [tracks, setTracks] = useState<AlbumTrack[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/download/albums/${album.id}/tracks`)
      .then(r => r.json()).then(d => setTracks(d.tracks ?? []))
      .finally(() => setLoading(false))
  }, [album.id])

  const discs = [...new Set(tracks.map(t => t.discNumber ?? 1))].sort((a, b) => a - b)
  const isMultiDisc = discs.length > 1
  const downloaded = tracks.filter(t => t.localFilePath).length
  const missing = tracks.filter(t => !t.localFilePath && t.downloadStatus !== 'skipped').length

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-gray-950 border-l border-white/10 z-20 flex flex-col shadow-2xl">
      <div className="flex items-start gap-3 p-4 border-b border-white/10">
        <div className="w-16 h-16 rounded-lg overflow-hidden bg-white/5 relative shrink-0">
          {album.imageUrl ? <Image src={album.imageUrl} alt={album.name} fill className="object-cover" sizes="64px" unoptimized /> : <div className="w-full h-full flex items-center justify-center text-white/10 text-2xl">♪</div>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{album.name}</p>
          <p className="text-sm text-white/50 truncate">{album.artistName}</p>
          <p className="text-xs text-white/30 mt-0.5">{album.releaseDate?.slice(0, 4)} · {album.playCount > 0 ? `${album.playCount.toLocaleString()} plays` : 'No plays'}</p>
          <div className="flex gap-3 text-xs mt-1.5">
            <span className="text-green-400">{downloaded} downloaded</span>
            {missing > 0 && <span className="text-yellow-400">{missing} missing</span>}
          </div>
        </div>
        <button onClick={onClose} className="text-white/30 hover:text-white/70 text-xl shrink-0 mt-0.5">✕</button>
      </div>
      <div className="px-4 py-3 border-b border-white/10">
        <QueueButton status={album.queueStatus} pendingTracks={album.pendingTracks} onChange={onQueueChange} />
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? <div className="p-6 text-center text-white/30 text-sm">Loading tracks…</div> : (
          <div className="py-2">
            {discs.map(disc => (
              <div key={disc}>
                {isMultiDisc && <p className="px-4 py-2 text-xs font-semibold text-white/30 uppercase tracking-wider">Disc {disc}</p>}
                {tracks.filter(t => (t.discNumber ?? 1) === disc).map(track => (
                  <div key={track.id} className="px-4 py-2.5 hover:bg-white/5 transition-colors">
                    <div className="flex items-start gap-3">
                      <span className="text-xs text-white/25 w-5 text-right shrink-0 mt-0.5">{track.trackNumber ?? '–'}</span>
                      <TrackStatusDot status={track.downloadStatus} hasFile={!!track.localFilePath} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={`text-sm truncate ${track.localFilePath ? 'text-white' : 'text-white/50'}`}>{track.name}</p>
                          <span className="text-xs text-white/25 shrink-0">{fmt(track.durationMs)}</span>
                        </div>
                        {track.playCount > 0 && <p className="text-xs text-white/30 mt-0.5">{track.playCount.toLocaleString()} plays</p>}
                        {track.localFilePath && <p className="text-xs text-white/25 font-mono truncate mt-0.5" title={track.localFilePath}>{track.localFilePath.split('/').slice(-3).join('/')}</p>}
                        {!track.localFilePath && track.downloadStatus !== 'skipped' && <p className="text-xs text-yellow-500/50 mt-0.5">Missing</p>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-white/10 flex gap-4 text-xs text-white/30">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" /> Downloaded</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-500/50" /> Missing</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-white/10" /> Pending</span>
      </div>
    </div>
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

function AlbumsView({ selectedAlbum, onSelectAlbum, onQueueChange }: {
  selectedAlbum: Album | null
  onSelectAlbum: (a: Album | null) => void
  onQueueChange: (id: number, s: 'queued' | 'skipped' | null) => void
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetch_ = useCallback(async (query: string, status: string, sortBy: string, mp: number, off: number, append = false) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ q: query, status, sort: sortBy, minPlays: String(mp), limit: String(LIMIT), offset: String(off) })
      const res = await fetch(`/api/download/albums?${p}`)
      const data = await res.json()
      if (append) setAlbums(prev => [...prev, ...(data.albums ?? [])])
      else { setAlbums(data.albums ?? []); setOffset(0) }
      setTotal(data.total ?? 0)
      setHasMore((data.albums?.length ?? 0) === LIMIT)
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

  const year = (d: string | null) => d?.slice(0, 4) ?? null

  return (
    <>
      <FilterBar q={q} onQ={setQ} tabs={STATUS_TABS} activeTab={statusTab} onTab={setStatusTab}
        sortOptions={ALBUM_SORT} sort={sort} onSort={setSort}
        minPlays={minPlays} onMinPlays={setMinPlays} showMinPlays={true} />
      <p className="text-xs text-white/30 mb-4">{total.toLocaleString()} albums</p>

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
                <div onClick={e => e.stopPropagation()}>
                  <QueueButton status={album.queueStatus} pendingTracks={album.pendingTracks}
                    onChange={s => onQueueChange(album.id, s)} />
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

// ── Main page ──────────────────────────────────────────────────────────────

export default function DownloadPage() {
  const [view, setView] = useState<'albums' | 'artists' | 'tracks'>('albums')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportInfo, setExportInfo] = useState<string | null>(null)
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null)
  const [albums, setAlbums] = useState<Map<number, Album>>(new Map())

  const fetchSummary = useCallback(async () => {
    const queuedRes = await fetch('/api/download/albums?status=queued&limit=1&offset=0')
    const queued = await queuedRes.json()
    const csvRes = await fetch('/api/download/export-csv', { method: 'HEAD' }).catch(() => null)
    const queuedTracks = csvRes ? parseInt(csvRes.headers.get('X-Track-Count') ?? '0') : 0
    setSummary({ queuedAlbums: queued.total ?? 0, queuedTracks })
  }, [])

  useEffect(() => { fetchSummary() }, [fetchSummary])

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-dark-surface via-dark-surfaceHover to-surface-800 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-black/60 backdrop-blur border-b border-white/10 px-6 py-4">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-lg font-semibold">Download Queue</h1>
            </div>
            {/* View tabs */}
            <div className="flex bg-white/5 rounded-lg p-0.5">
              {VIEW_TABS.map(tab => (
                <button key={tab.key} onClick={() => { setView(tab.key as typeof view); setSelectedAlbum(null) }}
                  className={`px-4 py-1.5 text-sm rounded-md transition-colors ${view === tab.key ? 'bg-white/15 text-white font-medium' : 'text-white/40 hover:text-white/70'}`}>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {summary && (
              <div className="text-right text-sm">
                <p className="text-green-400 font-medium">{summary.queuedAlbums.toLocaleString()} albums queued</p>
                <p className="text-white/40 text-xs">{summary.queuedTracks.toLocaleString()} tracks to download</p>
              </div>
            )}
            <button onClick={exportCsv} disabled={exporting}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 transition-colors">
              {exporting ? 'Generating…' : 'Export CSV'}
            </button>
          </div>
        </div>
        {exportInfo && <p className="text-xs text-green-400/80 text-center mt-2">Downloaded {exportInfo}</p>}
      </div>

      <div className="max-w-screen-xl mx-auto px-6 py-6">
        {view === 'albums' && (
          <AlbumsView
            selectedAlbum={selectedAlbum}
            onSelectAlbum={setSelectedAlbum}
            onQueueChange={setQueueStatus}
          />
        )}
        {view === 'artists' && <ArtistsView />}
        {view === 'tracks' && <TracksView />}
      </div>

      {selectedAlbum && view === 'albums' && (
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
