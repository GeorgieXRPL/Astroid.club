import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin Turbopack root so it doesn't climb the tree and pick up a sibling
  // project's lockfile (the Astroid family lives in adjacent folders on
  // the operator's machine).
  turbopack: {
    root: path.join(__dirname),
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
