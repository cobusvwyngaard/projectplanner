import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: "worker" runs inside workerd with real D1, R2 and Durable
// Objects (Miniflare); "unit" runs plain functions under Node.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Fixed static files instead of dist/client, so tests do not
                // depend on whether the app has been built.
                assets: { directory: "./test/fixtures/client" },
                // These are merged over wrangler.jsonc and .dev.vars, so they
                // win whatever .dev.vars holds (test/worker/app.test.ts checks).
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  // Obvious test placeholders; real phrases are Worker secrets.
                  LOGIN_PHRASE_1: "Test Phrase One",
                  LOGIN_PHRASE_2: "test   phrase two",
                  ELEVENLABS_API_KEY: "test-placeholder-key",
                  TRANSCRIBER: "mock",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["test/worker/setup.ts"],
            testTimeout: 30_000,
            hookTimeout: 30_000,
          },
        },
        {
          test: {
            name: "unit",
            include: ["test/unit/**/*.test.ts"],
            environment: "node",
          },
        },
      ],
    },
  };
});
