import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Wired up via next/font in app/layout.tsx so these fall
        // back to Inter / JetBrains Mono with the right CSS vars.
        display: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      // Match the public site's (../../Astroid.club/) palette exactly.
      colors: {
        space: {
          950: '#000814',
          900: '#001233',
          800: '#001845',
          700: '#002855',
          600: '#023e7d',
          500: '#0353a4',
        },
        cosmos: {
          DEFAULT: '#00d4ff',
          glow: 'rgba(0, 212, 255, 0.4)',
        },
        ember: {
          DEFAULT: '#ff7a45',
          glow: 'rgba(255, 122, 69, 0.4)',
        },
        ink: {
          DEFAULT: '#f5f7fa',
          muted: '#94a3b8',
        },
      },
      borderColor: {
        DEFAULT: 'rgba(255, 255, 255, 0.08)',
        bright: 'rgba(255, 255, 255, 0.16)',
      },
    },
  },
  plugins: [],
};

export default config;
