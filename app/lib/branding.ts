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
 */

export const branding = {
  brandName: 'Astroid Club',
  brandShort: 'astroid.club',

  // Hero
  eyebrow: 'For holders of $ASTROID · est. 2026',
  headline: 'The Club is coming.',
  headlineAccent: 'Built for the community.',
  subhead:
    'Astroid Club is the community home for $ASTROID holders. A place to gather, share, and be early to everything the Astroid family ships next - perks, drops, live events, and behind-the-scenes from the project.',

  // Waitlist tease (v1: NOT a form, just a panel)
  waitlistEyebrow: 'Doors open soon',
  waitlistTitle: 'The waitlist opens soon.',
  waitlistBody:
    'Hold $ASTROID and stay close - we are opening the doors here first. No signup form yet; we will announce when the waitlist goes live across the project channels.',
  waitlistFootnote:
    'Holding $ASTROID is not a contract, not a promise, and not an investment. It just means you are part of the community we are building this for.',

  // Tease cards - what's coming
  teases: [
    {
      tag: '01',
      title: 'A community hub',
      body:
        'A real home for the Astroid community. Conversations, builds, art, and the people behind it - somewhere that is ours, not rented from a feed.',
    },
    {
      tag: '02',
      title: 'Holder perks',
      body:
        'Small thank-yous from the project to people who hold the token. Early access to new things, occasional drops at the operator’s discretion, and surprises we are not going to ruin by listing here.',
    },
    {
      tag: '03',
      title: 'Live events',
      body:
        'AMAs, listening parties, voice gatherings, and the kind of small live moments that only really work when you know everyone in the room is part of the same community.',
    },
    {
      tag: '04',
      title: 'Behind the scenes',
      body:
        'Build notes, sketches, mascot lore, and the weird little decisions that go into shipping a kid-drawn character into a real internet project. Inside-baseball, for the people who care.',
    },
  ] as const,

  // Footer
  footer: {
    family: 'Part of the Astroid family',
    familyBlurb:
      'Astroid Club is a community space for $ASTROID holders. The mission site - charity, Name a Star, the mascot - lives at astroid.space. Different surfaces, same family.',
    links: {
      space: { label: 'astroid.space', href: 'https://astroid.space' },
      security: { label: 'security@astroid.space', href: 'mailto:security@astroid.space' },
      hello: { label: 'hello@astroid.space', href: 'mailto:hello@astroid.space' },
    },
    legal: {
      heading: 'Important',
      lines: [
        'Astroid Club is a community surface for the $ASTROID token community. Nothing on this site is an offer, solicitation, or recommendation to buy any token, and nothing here is investment, financial, legal, or tax advice.',
        '$ASTROID is a community token. Holding it is not a security interest, not a share, and does not entitle you to any contractual benefit, profit, or future asset distribution.',
        'This domain (astroid.club) does not represent or speak for any charity. Charity-related disclosures live at astroid.space/charity.',
        'The Club itself is in development. Features described above are intentions, not promises - they may change, ship later, or not ship at all.',
      ],
    },
    rights: 'All rights reserved.',
  },
} as const;

export type Branding = typeof branding;
