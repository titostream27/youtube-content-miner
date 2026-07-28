import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundler and load it
  // from node_modules at runtime instead.
  serverExternalPackages: ['better-sqlite3'],

  /*
   * The yt-dlp transcript provider builds temp paths at runtime and shells out to
   * a binary. The file tracer cannot prove which files those paths reach, so it
   * conservatively assumes the whole project. Nothing under these paths belongs
   * in the server output.
   */
  outputFileTracingExcludes: {
    '*': ['./data/**', './docs/**', './scripts/**', './.next/cache/**', './node_modules/.cache/**'],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'yt3.ggpht.com' },
    ],
  },
};

export default nextConfig;
