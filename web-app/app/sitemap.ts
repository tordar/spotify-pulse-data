import { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://spotify-pulse-data.vercel.app'
  return [
    { url: base, lastModified: new Date(), changeFrequency: 'daily', priority: 1 },
    { url: `${base}/top-songs`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/top-albums`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/top-artists`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.9 },
    { url: `${base}/fresh-releases`, lastModified: new Date(), changeFrequency: 'daily', priority: 0.8 },
  ]
}
