'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

interface CatalogTrack {
  id: number
  trackName: string
  artistName: string
  albumName: string
  durationMs: number
  localFilePath: string
  displayPath: string
  spotifyId: string | null
}

interface SearchResult {
  id: number
  trackName: string
  artistName: string
  albumName: string
  durationMs: number
  spotifyId: string | null
  hasFile: boolean
  playCount: number
}

function fmt(ms: number) {
  if (!ms) return '?:??'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MappingPage() {
  const [tracks, setTracks] = useState<CatalogTrack[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)

  const [selected, setSelected] = useState<CatalogTrack | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const LIMIT = 50
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchUnmatched = useCallback(async (q: string, off: number) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/mapping/unmatched?limit=${LIMIT}&offset=${off}&q=${encodeURIComponent(q)}`)
      const data = await res.json()
      setTracks(data.tracks ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUnmatched(filter, offset)
  }, [fetchUnmatched, filter, offset])

  // Auto-populate search with selected track info
  useEffect(() => {
    if (selected) {
      setSearchQuery(`${selected.trackName} ${selected.artistName}`)
      setSearchResults([])
    }
  }, [selected])

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/mapping/search?q=${encodeURIComponent(searchQuery)}`)
        const data = await res.json()
        setSearchResults(data.tracks ?? [])
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [searchQuery])

  async function linkTo(target: SearchResult) {
    if (!selected) return
    const res = await fetch('/api/mapping/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogTrackId: selected.id, targetTrackId: target.id }),
    })
    const data = await res.json()
    if (data.ok) {
      setMessage({ text: `Linked "${selected.trackName}" → "${target.trackName}" (${target.playCount} plays)`, ok: true })
      setTracks(prev => prev.filter(t => t.id !== selected.id))
      setTotal(prev => prev - 1)
      setSelected(null)
      setSearchResults([])
    } else {
      setMessage({ text: `Error: ${data.error}`, ok: false })
    }
  }

  async function skip() {
    if (!selected) return
    const res = await fetch('/api/mapping/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogTrackId: selected.id, skip: true }),
    })
    const data = await res.json()
    if (data.ok) {
      setMessage({ text: `Marked "${selected.trackName}" as catalog-only (not in Spotify history)`, ok: true })
      setTracks(prev => prev.filter(t => t.id !== selected.id))
      setTotal(prev => prev - 1)
      setSelected(null)
    } else {
      setMessage({ text: `Error: ${data.error}`, ok: false })
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Local File Mapping</h1>
          <p className="text-sm text-white/50 mt-0.5">
            {total.toLocaleString()} local files with no listening history — link them to Spotify tracks or mark as catalog-only
          </p>
        </div>
        <a href="/" className="text-sm text-white/40 hover:text-white transition-colors">← Back</a>
      </div>

      {message && (
        <div
          className={`mx-6 mt-4 px-4 py-2.5 rounded-lg text-sm cursor-pointer ${message.ok ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'}`}
          onClick={() => setMessage(null)}
        >
          {message.text}
        </div>
      )}

      <div className="flex h-[calc(100vh-5rem)] overflow-hidden">

        {/* LEFT — unmatched catalog tracks */}
        <div className="w-1/2 border-r border-white/10 flex flex-col">
          <div className="p-4 border-b border-white/10">
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-white/30"
              placeholder="Filter by artist / album / track…"
              value={filter}
              onChange={e => { setFilter(e.target.value); setOffset(0) }}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="p-6 text-center text-white/30 text-sm">Loading…</div>
            )}
            {!loading && tracks.length === 0 && (
              <div className="p-6 text-center text-white/30 text-sm">
                {filter ? 'No matches for that filter.' : '🎉 All files are mapped!'}
              </div>
            )}
            {tracks.map(track => (
              <div
                key={track.id}
                onClick={() => setSelected(track)}
                className={`px-4 py-3 border-b border-white/5 cursor-pointer transition-colors ${selected?.id === track.id ? 'bg-white/10' : 'hover:bg-white/5'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{track.trackName}</p>
                    <p className="text-xs text-white/50 truncate">{track.artistName} · {track.albumName}</p>
                    <p className="text-xs text-white/30 truncate mt-0.5 font-mono">{track.displayPath}</p>
                  </div>
                  <span className="text-xs text-white/30 shrink-0 mt-0.5">{fmt(track.durationMs)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {total > LIMIT && (
            <div className="p-3 border-t border-white/10 flex items-center justify-between text-sm text-white/50">
              <span>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}</span>
              <div className="flex gap-2">
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset(o => Math.max(0, o - LIMIT))}
                  className="px-3 py-1 rounded bg-white/10 disabled:opacity-30 hover:bg-white/20 transition-colors"
                >Prev</button>
                <button
                  disabled={offset + LIMIT >= total}
                  onClick={() => setOffset(o => o + LIMIT)}
                  className="px-3 py-1 rounded bg-white/10 disabled:opacity-30 hover:bg-white/20 transition-colors"
                >Next</button>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT — search & link panel */}
        <div className="w-1/2 flex flex-col">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-white/20 text-sm">
              ← Select a file to map it
            </div>
          ) : (
            <>
              {/* Selected file info */}
              <div className="p-4 border-b border-white/10 bg-white/5">
                <p className="text-xs text-white/40 mb-1">MAPPING FILE</p>
                <p className="font-semibold">{selected.trackName}</p>
                <p className="text-sm text-white/60">{selected.artistName} · {selected.albumName}</p>
                <p className="text-xs text-white/30 font-mono mt-1 truncate">{selected.localFilePath}</p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={skip}
                    className="px-3 py-1.5 text-xs rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    Mark as catalog-only (not in Spotify)
                  </button>
                  <button
                    onClick={() => setSelected(null)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              {/* Search */}
              <div className="p-4 border-b border-white/10">
                <p className="text-xs text-white/40 mb-2">SEARCH SPOTIFY HISTORY TRACKS</p>
                <input
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-white/30"
                  placeholder="Search by track name, artist or album…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>

              {/* Search results */}
              <div className="flex-1 overflow-y-auto">
                {searching && (
                  <div className="p-4 text-center text-white/30 text-sm">Searching…</div>
                )}
                {!searching && searchQuery && searchResults.length === 0 && (
                  <div className="p-4 text-center text-white/30 text-sm">No matching tracks found</div>
                )}
                {searchResults.map(result => (
                  <div
                    key={result.id}
                    className="px-4 py-3 border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors group"
                    onClick={() => linkTo(result)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm truncate">{result.trackName}</p>
                          {result.hasFile && (
                            <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded shrink-0">has file</span>
                          )}
                        </div>
                        <p className="text-xs text-white/50 truncate">{result.artistName} · {result.albumName}</p>
                        <p className="text-xs text-white/30 mt-0.5">{result.playCount.toLocaleString()} plays</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-xs text-white/30">{fmt(result.durationMs)}</span>
                        <span className="text-xs text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity">Link →</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
