import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Migrations are idempotent: applyD1Migrations skips those already applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
