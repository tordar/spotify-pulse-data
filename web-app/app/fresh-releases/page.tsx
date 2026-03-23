'use client'

import { useState, useEffect } from 'react'
import { Music } from 'lucide-react'
import SpotifyStatsLayout from '../../components/SpotifyStatsLayout'

interface FreshRelease {
  id: string
  artist_name: string
  artist_mbid: string
  title: string
  release_date: string
  primary_type: string | null
  caa_release_mbid: string | null
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00Z')
  const today = new Date()
  today.setUTCHours(12, 0, 0, 0)
  const diff = Math.round((date.getTime() - today.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff > 1 && diff <= 6) return `in ${diff} days`
  if (diff >= 7 && diff < 14) return 'next week'
  if (diff >= 14) return `in ${Math.round(diff / 7)} weeks`
  if (diff < 0 && diff >= -6) return `${Math.abs(diff)} days ago`
  if (diff < -6 && diff >= -13) return 'last week'
  return `${Math.round(Math.abs(diff) / 7)} weeks ago`
}

function formatDisplayDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-')
  if (!month) return year
  if (!day) return new Date(`${year}-${month}-01`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const TYPE_COLORS: Record<string, string> = {
  Album: 'bg-blue-500/20 text-blue-300',
  Single: 'bg-purple-500/20 text-purple-300',
  EP: 'bg-green-500/20 text-green-300',
}

export default function FreshReleasesPage() {
  const [releases, setReleases] = useState<FreshRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'upcoming' | 'recent'>('upcoming')
  const [imgErrors, setImgErrors] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/data/fresh-releases')
      .then(r => r.json())
      .then(data => {
        setReleases(data.releases ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const today = new Date().toISOString().split('T')[0]

  const upcoming = releases
    .filter(r => r.release_date >= today)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))

  const recent = releases
    .filter(r => r.release_date < today)
    .sort((a, b) => b.release_date.localeCompare(a.release_date))

  const displayed = tab === 'upcoming' ? upcoming : recent

  return (
    <SpotifyStatsLayout
      title="New Releases"
      description="Upcoming and recent releases from your most-listened artists"
      currentPage="releases"
    >
      {/* Tabs */}
      <div className="flex justify-center mb-8">
        <div className="flex border border-white/10 rounded-md overflow-hidden bg-card/40 backdrop-blur-sm">
          {(['upcoming', 'recent'] as const).map((t, idx) => {
            const count = t === 'upcoming' ? upcoming.length : recent.length
            const isActive = tab === t
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-2 px-4 py-2 text-sm capitalize transition-colors ${idx > 0 ? 'border-l border-white/10' : ''} ${
                  isActive
                    ? 'bg-primary/20 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-surface-800/30'
                }`}
              >
                {t}
                {!loading && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-primary/20' : 'bg-white/10'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 animate-pulse">
              <div className="aspect-square rounded-md bg-surface-800/50" />
              <div className="h-3 bg-surface-800/50 rounded w-3/4" />
              <div className="h-3 bg-surface-800/30 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center text-muted-foreground py-20">
          <Music className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No {tab} releases found.</p>
          {releases.length === 0 && (
            <p className="text-xs mt-2 opacity-60">Run <code className="font-mono">npm run db:fetch-upcoming-releases</code> to sync release data.</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {displayed.map(release => (
            <div key={release.id} className="flex flex-col gap-2 group">
              <div className="relative aspect-square rounded-md overflow-hidden bg-surface-800/50">
                {imgErrors.has(release.id) ? (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-8 h-8 text-muted-foreground/20" />
                  </div>
                ) : (
                  <img
                    src={`https://coverartarchive.org/release/${release.caa_release_mbid ?? release.id}/front-250`}
                    alt={release.title}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                    onError={() => setImgErrors(prev => new Set(prev).add(release.id))}
                  />
                )}
                {release.primary_type && (
                  <span className={`absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_COLORS[release.primary_type] ?? 'bg-white/10 text-white/70'}`}>
                    {release.primary_type}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate leading-snug">{release.title}</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{release.artist_name}</p>
                <p className="text-xs mt-1" title={formatDisplayDate(release.release_date)}>
                  <span className="text-primary/70">{formatRelativeDate(release.release_date)}</span>
                  <span className="text-muted-foreground/50 ml-1">· {formatDisplayDate(release.release_date)}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </SpotifyStatsLayout>
  )
}
