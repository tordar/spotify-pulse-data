const path = require('path')

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
  // Keep large packages out of serverless function bundles to stay under Vercel's 250 MB limit.
  // better-sqlite3 is a native addon and MUST be external -- it cannot be bundled by webpack.
  serverExternalPackages: [
    'better-sqlite3',
    'highcharts',
    'highcharts-react-official',
    'cal-heatmap',
  ],
  // Allow Next.js to trace files outside the web-app directory (e.g. ../data/library.db).
  outputFileTracingRoot: path.join(__dirname, '..'),
  // Copy library.db into the Next.js output so Vercel includes it in the deployment.
  // Paths are relative to outputFileTracingRoot (the monorepo root).
  outputFileTracingIncludes: {
    '/api/**': ['data/library.db'],
  },
}

module.exports = nextConfig
