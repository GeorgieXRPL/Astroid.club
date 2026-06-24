import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@server': new URL('./server', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'),
      '@shared': new URL('./shared', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'),
      '@config': new URL('./config', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'server/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'shell', 'arena'],
    globals: false,
  },
});
