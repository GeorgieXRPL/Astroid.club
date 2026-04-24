/**
 * @fileoverview Single source of truth for every user-facing string on
 * the Astroid Club coming-soon site.
 *
 * Why this file exists:
 *   We just spent real effort separating the Astroid project from any
 *   implied affiliation with St. Jude on astroid.space. The .club site
 *   is the holder-themed surface, so it carries different risk: it sits
 *   close to "investment talk" by virtue of being for token holders.
 *
 *   Centralizing the copy here means a compliance review is a single-
 *   file diff, not a hunt-and-peck across components.
 *
 * Editing rules (please read before changing strings):
 *   1. No price talk. No "moon", "100x", "pump", or anything that
 *      implies future token value.
 *   2. No promises to holders. "Holders are invited" is fine.
 *      "Holders will receive X" is not - that creates contractual
 *      expectation and pulls us toward unregistered-security territory.
 *   3. No St. Jude or ALSAC mentions on this domain. Charity messaging
 *      lives at astroid.space/charity. A footer link to astroid.space
 *      is fine; co-branding with the hospital is not.
 *   4. No financial advice, ever.
 *   5. The waitlist is "opening soon". No fake form, no fake countdown,
 *      no email capture in v1.
 *   6. Be sparse. The whole page should fit on one screen and feel like
 *      something is about to happen, not like an essay.
 */

export const branding = {
  brandName: 'Astroid Club',
  brandShort: 'astroid.club',

  // Hero - intentionally short. Mystery + intent, not a sales pitch.
  eyebrow: 'For holders of $ASTROID',
  headline: 'Knock, knock.',
  subhead: 'A door is about to open.',

  // Tease - one line of taxonomy, four words. Lets the imagination do
  // the work without us having to over-promise any specific feature.
  teaseLine: 'Community · Perks · Events · Lore',

  // Bottom strip
  status: 'Coming soon',
  callsign: 'Stay close — the doors open here first.',

  // Footer (deliberately minimal - the heavy disclaimers live here)
  footer: {
    family: 'Part of the Astroid family',
    space: { label: 'astroid.space', href: 'https://astroid.space' },
    hello: { label: 'hello@astroid.space', href: 'mailto:hello@astroid.space' },
    security: { label: 'security@astroid.space', href: 'mailto:security@astroid.space' },
    legal: [
      'Astroid Club is a community surface for the $ASTROID token community. Nothing on this site is an offer, solicitation, or recommendation to buy any token, and nothing here is investment, financial, legal, or tax advice.',
      '$ASTROID is a community token. Holding it is not a security interest, not a share, and does not entitle you to any contractual benefit, profit, or future asset distribution.',
      'This domain (astroid.club) does not represent or speak for any charity. Charity-related disclosures live at astroid.space/charity.',
      'The Club is in development. Anything we tease here is intent, not a promise — features may change, ship later, or not ship at all.',
    ],
    rights: 'All rights reserved.',
  },
} as const;

export type Branding = typeof branding;
