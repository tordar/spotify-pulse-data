'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export type PlaybackSource = 'spotify' | 'navidrome' | 'other'

export interface PlaybackNowPlaying {
  track_name: string
  artist_name: string
  release_name: string | null
  duration_ms: number | null
  cover_art_url: string | null
  source: PlaybackSource
}

type PlaybackContextValue = {
  playing: PlaybackNowPlaying | null
  error: string | null
  loading: boolean
  refetch: () => void
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined)

const POLL_INTERVAL_MS = 10000

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [playing, setPlaying] = useState<PlaybackNowPlaying | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchPlayback = useCallback(async () => {
    try {
      const res = await fetch('/api/lb/playing-now', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load playback')
        setPlaying(null)
        return
      }
      setError(null)
      setPlaying(data.playing ?? null)
    } catch {
      setError('Failed to load playback')
      setPlaying(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPlayback()
    const interval = setInterval(fetchPlayback, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchPlayback])

  return (
    <PlaybackContext.Provider value={{ playing, error, loading, refetch: fetchPlayback }}>
      {children}
    </PlaybackContext.Provider>
  )
}

export function usePlayback() {
  const ctx = useContext(PlaybackContext)
  if (ctx === undefined) {
    throw new Error('usePlayback must be used within a PlaybackProvider')
  }
  return ctx
}
