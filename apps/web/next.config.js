/** @type {import('next').NextConfig} */
module.exports = {
  // Dedicated staff build; Next inlines basePath into links and router calls.
  basePath: process.env.NEXT_PUBLIC_ISLA_STAFF === 'true' ? '/staff/newsletters/plunk' : '',
  transpilePackages: ['@plunk/ui'],
  output: 'standalone', // Optimized for Docker
  // Keep release builds bounded inside the existing worker cgroup.
  experimental: {cpus: 1, webpackBuildWorker: true, webpackMemoryOptimizations: true},
};
