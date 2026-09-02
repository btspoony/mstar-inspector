/**
 * `t(locale, key, params?)` — server + client isomorphic lookup with
 * `{placeholder}` interpolation (plan 29 T2).
 *
 * `DictionaryKey` is the dotted-path type derived from the en dictionary
 * (`typeof en`), so a typo in a key is a compile error. A runtime miss
 * (only possible if a dictionary was mutated) returns the key itself —
 * fail-visible in the UI without crashing the page.
 */
import { en, type Dictionary } from "./en";
import { zhCN } from "./zh-CN";
import type { Locale } from "./resolve";

export const dictionaries: Record<Locale, Dictionary> = { en, zh_CN: zhCN };

type DictionaryKeyImpl<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${DictionaryKeyImpl<T[K]>}`;
}[keyof T & string];

export type DictionaryKey = DictionaryKeyImpl<Dictionary>;

function lookup(dict: Dictionary, key: DictionaryKey): string {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : key;
}

export function t(
  locale: Locale,
  key: DictionaryKey,
  params?: Record<string, string | number>,
): string {
  const template = lookup(dictionaries[locale], key);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match,
  );
}
