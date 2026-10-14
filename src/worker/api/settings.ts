// /api/settings: change one setting. Each key has its own rules in the
// settings registry (src/worker/settings.ts).

import { Hono } from "hono";
import { z } from "zod";
import type { SettingsMap } from "../../shared/types";
import type { AppBindings } from "../env";
import { NotFoundError } from "../lib/errors";
import { jsonBody } from "../lib/http";
import { mutate } from "../mutate/index";
import { SETTINGS, checkSetting, isSettingKey, readSettings, settingMutation } from "../settings";
import { actorOf } from "./request";

export const settingsRouter = new Hono<AppBindings>().put("/:key", async (c) => {
  const db = c.env.DB;
  const key = c.req.param("key");
  if (!isSettingKey(key)) throw new NotFoundError(`There is no setting called ${key}.`);
  const { value } = await jsonBody(c, z.strictObject({ value: SETTINGS[key].schema }));
  await checkSetting(db, key, value);
  await mutate(db, actorOf(c), await settingMutation(db, key, value));
  const settings: SettingsMap = await readSettings(db);
  return c.json({ settings });
});
