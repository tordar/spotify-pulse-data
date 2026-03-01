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
