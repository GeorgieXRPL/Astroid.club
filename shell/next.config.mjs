/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shell talks to the astroid.club WS server. The default points
  // at the local dev server; deployments override via env. The
  // `NEXT_PUBLIC_SITE_URL` value is consumed by `app/robots.ts`,
  // `app/sitemap.ts`, `app/opengraph-image.tsx`, and the metadata
  // block in `app/layout.tsx` so social-share previews and crawler
  // hints resolve to the live origin.
  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:4001',
    NEXT_PUBLIC_ASTROID_WS_URL: process.env.NEXT_PUBLIC_ASTROID_WS_URL ?? 'ws://localhost:3002',
    NEXT_PUBLIC_ASTROID_HTTP_URL:
      process.env.NEXT_PUBLIC_ASTROID_HTTP_URL ?? 'http://localhost:3002',
  },
  // Privy's React SDK and its transitive `x402` payments helper list
  // `@solana/kit` and the `@solana-program/*` packages as OPTIONAL peer
  // dependencies — they're only entered when Privy signs Solana
  // TRANSACTIONS via embedded wallets. We use Privy strictly for
  // external-wallet message signing, so those code paths are dead.
  //
  // We need different handling on server vs client:
  //
  //   - Server: the wallet-source-privy module is `ssr: false`, so it
  //     never executes on the server; but Webpack still tries to resolve
  //     the imports during the server bundle pass. Marking them as
  //     `commonjs` externals tells Webpack to emit a `require()` call,
  //     which Node will lazily fail if it ever runs (it never does).
  //
  //   - Client: a `commonjs` external would emit a literal `require()`
  //     in browser code, which crashes at runtime ("require is not
  //     defined"). Alias to `false` instead, which makes Webpack emit
  //     an empty module. Imports of named exports become `undefined`
  //     and only crash if the dead code path is actually reached.
  webpack: (config, { isServer }) => {
    const optionalSolanaPeers = [
      '@solana/kit',
      '@solana-program/memo',
      '@solana-program/system',
      '@solana-program/token',
      '@farcaster/mini-app-solana',
      '@abstract-foundation/agw-client',
      'permissionless',
    ];

    if (isServer) {
      const externals = config.externals ?? [];
      config.externals = [
        ...(Array.isArray(externals) ? externals : [externals]),
        ({ request }, callback) => {
          if (request && optionalSolanaPeers.includes(request)) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        },
      ];
    } else {
      config.resolve = config.resolve ?? {};
      config.resolve.alias = { ...(config.resolve.alias ?? {}) };
      for (const peer of optionalSolanaPeers) {
        config.resolve.alias[peer] = false;
      }
    }

    return config;
  },
};

export default nextConfig;
