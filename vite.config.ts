/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages project site: https://h3902340.github.io/tidy/
export default defineConfig({
  base: '/tidy/',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
