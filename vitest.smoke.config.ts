import { defineConfig } from "vitest/config";

/** Live Otari smoke test: `npx vitest --run -c vitest.smoke.config.ts` (needs OTARI_API_KEY). */
export default defineConfig({
  test: {
    include: ["scripts/otari-smoke.ts"],
    env: { DATABASE_URL: "pglite:memory" },
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
