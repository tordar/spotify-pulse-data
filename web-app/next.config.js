const { resolve } = require('path')
const { existsSync, readFileSync } = require('fs')

// Load .env.local from repo root so Spotify creds are available to the web-app
const rootEnvLocal = resolve(__dirname, '..', '.env.local')
if (existsSync(rootEnvLocal)) {
  for (const line of readFileSync(rootEnvLocal, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i.scdn.co',
        port: '',
        pathname: '/image/**',
      },
    ],
  },
  // Keep large client-side packages out of serverless function bundles
  serverExternalPackages: [
    'highcharts',
    'highcharts-react-official',
    'cal-heatmap',
  ],
}

module.exports = nextConfig
