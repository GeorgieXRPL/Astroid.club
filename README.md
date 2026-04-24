# Astroid Club

> The community home for `$ASTROID` holders. Coming soon.

Live at **[astroid.club](https://astroid.club)** (once DNS is pointed).

## What this is

Astroid Club sits alongside the mission site in the Astroid family:

| Surface | Domain | Audience | Status |
| --- | --- | --- | --- |
| Mission site | `astroid.space` | Anyone (charity-first, kid-safe) | Live |
| The Club | `astroid.club` | `$ASTROID` token holders | This repo · coming-soon page only |

This repo contains a single-page coming-soon landing site. There is no waitlist form yet, no email capture, no wallet connect, no API. When the waitlist actually opens we will layer those in as a follow-up.

## Compliance guardrails (please read before editing copy)

The Club sits closer to investment-talk territory than `astroid.space` does, by virtue of being for token holders. To keep the project safe, every user-facing string lives in [`app/lib/branding.ts`](app/lib/branding.ts), and the rules at the top of that file are not optional:

1. No price talk. No "moon", no "100x", no implied future token value.
2. No promises to holders. "Holders are invited" is fine. "Holders will receive X" is not.
3. No St. Jude / ALSAC mentions on this domain. Charity messaging lives at `astroid.space/charity`. Footer link to `astroid.space` is fine; co-branding with the hospital is not.
4. No financial advice, ever.
5. The waitlist is "opening soon". No fake form, no fake countdown, no email capture in v1.

A compliance review of this site is a single-file diff of [`app/lib/branding.ts`](app/lib/branding.ts).

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript** strict mode
- **Tailwind CSS 4** with theme variables lifted from `astroid.space` so the family reads as one visual system
- **No** `react-three-fiber`, **no** Solana SDK, **no** Supabase in v1 - the page is fully static. The CSS-gradient starfield in [`app/globals.css`](app/globals.css) is the same recipe `.space` uses as a base layer.

## Getting started

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

No environment variables are required for v1. See [`.env.example`](.env.example) for the variables we will need when the waitlist opens.

## Files

```
app/
  globals.css         CSS theme + starfield (synced with astroid.space)
  layout.tsx          Root layout, fonts, metadata, OG tags
  page.tsx            The single landing page (header, hero, teases,
                      waitlist tease, family strip, footer - all inline)
  lib/
    branding.ts       Single source of truth for every user-facing string
proxy.ts              Security headers (HSTS, CSP, COOP, CORP, X-Frame, etc.)
next.config.ts        reactStrictMode, poweredByHeader off, Turbopack root pin
```

## Deploy

We host the family on Vercel and use Cloudflare for DNS. To put this site on `astroid.club`:

1. Create a new Vercel project from this repo. Framework preset: Next.js. No env vars needed for v1.
2. In Vercel, add the custom domain `astroid.club` (and optionally `www.astroid.club`).
3. In Cloudflare DNS for `astroid.club`:
   - Apex `astroid.club` → CNAME to `cname.vercel-dns.com` (Cloudflare allows CNAME flattening at apex), or use Vercel's recommended A record set.
   - `www` → CNAME to `cname.vercel-dns.com`.
   - Set both records to **DNS only** (grey cloud) for the initial cert provisioning. After Vercel issues the certificate, you can flip to **Proxied** (orange cloud) if you want Cloudflare features in front of it - but check that the CSP in `proxy.ts` is still happy with whatever you enable.
4. Push to `main`. Vercel auto-deploys.

## When the waitlist opens

That's a follow-up. The plan is:

- Add a `WaitlistForm` client component to replace the static `WaitlistTease` panel in [`app/page.tsx`](app/page.tsx).
- Add `app/api/waitlist/join/route.ts` with Zod validation, honeypot, per-IP rate limit.
- Add a `club_waitlist` table in a new (isolated) Supabase project, with RLS enabled and no public policies.
- Optional: paste-an-address Solana balance check via `@solana/web3.js` to badge entries as `verified_holder = true`. Read-only, no signing, no custody - this stays a "thanks for being a holder" badge, not a contractual benefit.
- Loosen `connect-src` in [`proxy.ts`](proxy.ts) accordingly.

None of that ships in v1.

## License

All rights reserved.
