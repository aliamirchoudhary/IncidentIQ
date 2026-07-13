import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: {
      BASE_URL: process.env.BASE_URL ?? "https://core-api.aliamirchoudhary.workers.dev",
      AUTH_TOKEN: process.env.AUTH_TOKEN ?? "e4c45de1-442f-4cf5-828e-c2858d1b8e7f",
    },
  },
});
