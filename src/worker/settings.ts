// The settings registry: every setting the app knows, how a new value is
// validated, and the value used when the stored one is missing or unreadable.
// Values are stored as JSON in the settings table and written through mutate()
// (entity 'setting'), so every change is an event.

import { z } from "zod";
import type { SettingKey, SettingsMap } from "../shared/types";
import { checkLabelId, fields } from "./board/validation";
import type { Mutation } from "./mutate/index";

interface SettingSpec<K extends SettingKey> {
  /** Validates and normalises a value */
  schema: z.ZodType<SettingsMap[K]>;
  /** Used when the row is missing or its JSON does not match the schema */
  fallback: SettingsMap[K];
  /** Checks against the database (throws ValidationError) */
  check?: (db: D1Database, value: SettingsMap[K]) => Promise<void>;
}

export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_LENGTH = 50;

export const SETTINGS: { readonly [K in SettingKey]: SettingSpec<K> } = {
  stt_keyterms: {
    schema: z
      .array(
        z
          .string()
          .trim()
          .min(1, "A keyterm cannot be empty.")
          .max(MAX_KEYTERM_LENGTH, `A keyterm can be at most ${MAX_KEYTERM_LENGTH} characters.`),
      )
      .max(MAX_KEYTERMS, `There can be at most ${MAX_KEYTERMS} keyterms.`),
    fallback: [],
  },
  stt_keyterms_enabled: {
    schema: z.boolean(),
    fallback: false,
  },
  default_label_id: {
    schema: fields.labelId,
    fallback: null,
    check: (db, value) => checkLabelId(db, value),
  },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

function readOne<K extends SettingKey>(key: K, stored: ReadonlyMap<string, string>): SettingsMap[K] {
  const spec: SettingSpec<K> = SETTINGS[key];
  const json = stored.get(key);
  if (json === undefined) return spec.fallback;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return spec.fallback;
  }
  const parsed = spec.schema.safeParse(value);
  return parsed.success ? parsed.data : spec.fallback;
}

/** Every setting, with fallbacks for missing or unreadable rows. */
export async function readSettings(db: D1Database): Promise<SettingsMap> {
  const { results } = await db.prepare(`SELECT key, value_json FROM settings`).all<{ key: string; value_json: string }>();
  const stored = new Map(results.map((r) => [r.key, r.value_json]));
  return {
    stt_keyterms: readOne("stt_keyterms", stored),
    stt_keyterms_enabled: readOne("stt_keyterms_enabled", stored),
    default_label_id: readOne("default_label_id", stored),
  };
}

/** Run the database checks of a setting on an already parsed value. */
export async function checkSetting<K extends SettingKey>(db: D1Database, key: K, value: SettingsMap[K]): Promise<void> {
  const spec: SettingSpec<K> = SETTINGS[key];
  if (spec.check) await spec.check(db, value);
}

/** The mutation that stores a setting: an update, or a create when the row is missing. */
export async function settingMutation<K extends SettingKey>(
  db: D1Database,
  key: K,
  value: SettingsMap[K],
): Promise<Mutation> {
  const valueJson = JSON.stringify(value);
  const exists = await db.prepare(`SELECT 1 FROM settings WHERE key = ?`).bind(key).first();
  return exists
    ? { entity: "setting", action: "update", id: key, patch: { value_json: valueJson } }
    : { entity: "setting", action: "create", values: { key, value_json: valueJson } };
}
