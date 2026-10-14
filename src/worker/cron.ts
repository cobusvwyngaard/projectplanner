// The scheduled handler (wrangler.jsonc: every 10 minutes).

import { purgeExpired } from "./oauth/kv";

/** Housekeeping run by the cron trigger: drop expired OAuth records. */
export async function runScheduled(env: Pick<Env, "DB">): Promise<void> {
  await purgeExpired(env.DB);
}
