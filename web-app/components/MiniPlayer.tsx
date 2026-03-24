'use client'

import { usePlayback, PlaybackSource } from './PlaybackContext'
import { Music2, Loader2, AlertCircle } from 'lucide-react'

const SOURCE_LABEL: Record<PlaybackSource, string> = {
  spotify: 'Spotify',
  navidrome: 'Navidrome',
  other: 'Playing',
}

const SOURCE_COLOR: Record<PlaybackSource, string> = {
  spotify: 'bg-green-500/20 text-green-400',
  navidrome: 'bg-orange-500/20 text-orange-400',
  other: 'bg-muted text-muted-foreground',
}

const fixedWrapperClass =
  'fixed bottom-4 right-4 z-50 hidden md:flex min-w-[360px] max-w-[400px] overflow-hidden rounded-lg border border-white/10 bg-card/95 shadow-lg backdrop-blur-md'
const inlineWrapperClass =
  'flex md:hidden w-full overflow-hidden rounded-lg border border-white/10 bg-card/95 shadow-lg backdrop-blur-md'

export default function MiniPlayer({ variant = 'fixed' }: { variant?: 'fixed' | 'inline' }) {
  const { playing, error, loading } = usePlayback()
  const wrapperClass = variant === 'inline' ? inlineWrapperClass : fixedWrapperClass

  if (loading && !playing && !error) {
    return (
      <div className={wrapperClass} aria-label="Now playing">
        <div className="flex items-center gap-3 px-5 py-4 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin flex-shrink-0" />
          <span className="text-base">Loading playback…</span>
        </div>
      </div>
    )
  }

  if (error && !playing) {
    return (
      <div className={`${wrapperClass} flex items-center gap-3 px-5 py-4 text-muted-foreground`} aria-label="Playback unavailable">
        <AlertCircle className="h-6 w-6 flex-shrink-0" />
        <span className="text-base truncate">Playback unavailable</span>
      </div>
    )
  }

  if (!playing) {
    return (
      <div className={`${wrapperClass} flex items-center gap-3 px-5 py-4 text-muted-foreground`} aria-label="Nothing playing">
        <Music2 className="h-6 w-6 flex-shrink-0" />
        <span className="text-base">Nothing playing</span>
      </div>
    )
  }

  return (
    <div className={`${wrapperClass} flex-col`} aria-label="Now playing">
      <div className="px-4 pt-3 pb-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Currently playing</p>
      </div>
      <div className="flex min-w-0 flex-1 items-center pl-4 pr-4 pb-4 gap-3">
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground overflow-hidden">
          {playing.cover_art_url ? (
            <img
              src={playing.cover_art_url}
              alt=""
              className="block h-16 w-16 object-cover"
              width={64}
              height={64}
            />
          ) : (
            <Music2 className="h-6 w-6" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <p className="truncate text-base font-medium text-foreground" title={playing.track_name}>
            {playing.track_name}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {playing.artist_name}
            {playing.release_name ? ` · ${playing.release_name}` : ''}
          </p>
        </div>
        <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${SOURCE_COLOR[playing.source]}`}>
          {SOURCE_LABEL[playing.source]}
        </span>
      </div>
    </div>
  )

}
