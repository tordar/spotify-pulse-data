'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface DayPlay {
  songName: string
  artists: string[]
  albumName: string
  msPlayed: number
}

interface DailyDay {
  date: number
  value: number
  plays?: DayPlay[]
}

interface LiveListen {
  listened_at: number
  artist_name: string
  track_name: string
  release_name: string | null
  duration_ms: number | null
}

interface TodaysListeningCardProps {
  dailyData: DailyDay[] | null | undefined
  loading: boolean
  selectedHeatmapYear: number
  formatDuration: (ms: number) => string
}

export default function TodaysListeningCard({
  dailyData,
  loading,
  selectedHeatmapYear,
  formatDuration,
}: TodaysListeningCardProps) {
  const currentYear = new Date().getFullYear()
  const [liveListens, setLiveListens] = useState<LiveListen[]>([])
  const [liveLoading, setLiveLoading] = useState(true)

  useEffect(() => {
    fetch('/api/data/live-listens')
      .then(r => r.json())
      .then(data => {
        setLiveListens(data.listens ?? [])
      })
      .catch(() => {})
      .finally(() => setLiveLoading(false))
  }, [])

  if (loading || liveLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Today&apos;s listening</CardTitle></CardHeader>
        <CardContent><p className="text-muted-foreground text-sm">Loading…</p></CardContent>
      </Card>
    )
  }

  if (selectedHeatmapYear !== currentYear) {
    return (
      <Card>
        <CardHeader><CardTitle>Today&apos;s listening</CardTitle></CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Switch to current year in Listening activity to see today.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Merge D1 data with live LB data for today
  const today = new Date()
  const todayStartUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const todayEndUtc = todayStartUtc + 86400000

  const todayEntry = dailyData?.find(d => d.date === todayStartUtc)
  const d1Plays: DayPlay[] = todayEntry?.plays ?? []
  const d1Ms = todayEntry?.value ?? 0

  // Filter live listens to today only
  const liveTodayPlays: DayPlay[] = liveListens
    .filter(l => {
      const ts = l.listened_at * 1000
      return ts >= todayStartUtc && ts < todayEndUtc
    })
    .map(l => ({
      songName: l.track_name,
      artists: [l.artist_name],
      albumName: l.release_name ?? 'Unknown Album',
      msPlayed: l.duration_ms ?? 0,
    }))

  const liveTodayMs = liveTodayPlays.reduce((sum, p) => sum + p.msPlayed, 0)

  // Combine, deduplicating by (songName + artist) — prefer D1 entries
  const d1Keys = new Set(d1Plays.map(p => `${p.songName}\0${p.artists[0]}`))
  const newLivePlays = liveTodayPlays.filter(p => !d1Keys.has(`${p.songName}\0${p.artists[0]}`))

  const allPlays = [...d1Plays, ...newLivePlays]
  const totalMs = d1Ms + newLivePlays.reduce((sum, p) => sum + p.msPlayed, 0)
  const hasLiveData = newLivePlays.length > 0

  if (totalMs === 0 && allPlays.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Today&apos;s listening</CardTitle></CardHeader>
        <CardContent><p className="text-2xl font-bold">No listening yet today</p></CardContent>
      </Card>
    )
  }

  const byArtist = new Map<string, number>()
  const uniqueSongs = new Map<string, string>()
  for (const play of allPlays) {
    const artistKey = play.artists?.join(', ') || 'Unknown'
    byArtist.set(artistKey, (byArtist.get(artistKey) ?? 0) + 1)
    const songKey = `${play.songName}\0${artistKey}`
    if (!uniqueSongs.has(songKey)) {
      uniqueSongs.set(songKey, play.artists?.length ? `${play.songName} – ${artistKey}` : play.songName)
    }
  }
  const artistList = Array.from(byArtist.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([artist, playCount]) => ({ artist, playCount }))
  const songList = Array.from(uniqueSongs.values())

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Today&apos;s listening
          {hasLiveData && (
            <span className="text-xs font-normal text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded">live</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Listening time</p>
            <p className="text-2xl font-bold">{formatDuration(totalMs)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Artists</p>
            <p className="text-2xl font-bold">{artistList.length}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Songs</p>
            <p className="text-2xl font-bold">{songList.length}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {artistList.length > 0 && (
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground mb-1">Artists</p>
              <ul className="text-sm space-y-0.5 max-h-32 overflow-y-auto">
                {artistList.map(({ artist, playCount }) => (
                  <li key={artist} className="truncate" title={artist}>
                    {artist}
                    <span className="text-muted-foreground ml-1">({playCount} plays)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {songList.length > 0 && (
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground mb-1">Songs</p>
              <ul className="text-sm space-y-0.5 max-h-32 overflow-y-auto list-disc list-inside">
                {songList.slice(0, 20).map((name) => (
                  <li key={name} className="truncate" title={name}>
                    {name}
                  </li>
                ))}
                {songList.length > 20 && (
                  <li className="text-muted-foreground">+{songList.length - 20} more</li>
                )}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
