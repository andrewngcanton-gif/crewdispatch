// catalog.ts — parse the public `cmdc --list-models` output.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` parseListModelsCatalog.
//
// The catalog of this provider comes from its OWN official CLI. A list command
// cannot submit a prompt, so the probe is read-only. Nothing here hardcodes a
// model id or a default: the advertised default is only ever an id the CLI itself
// published.
import { MODEL_TOKEN_RE } from "./argv";

export interface ModelCatalog {
  models: string[];
  defaultModel: string | null;
  /** Strict evidence only: the row's price/tag column is the standalone token FREE. */
  freeModels: string[];
}

/** The CLI's own "this is the default model" marker, matched as a whole word. */
const DEFAULT_MARKER_RE = /\bdefault\b/i;
const FOOTER_STOP_RE = /^(pass the full id|docs:|usage:|options:|flags:)/i;
const INLINE_LIST_RE = /^(currently supported|available models|models)\s*:/i;
const COLUMNAR_HEADER_RE = /^available models\b/i;
const COLUMN_ROW_RE = /^(\S+)\s{2,}(.*)$/;

/**
 * Parse `cmdc --list-models` output into `{ models, defaultModel }`.
 *
 * Tolerates the shapes the official CLI has used: an "Available models · N
 * models" header with `<id><2+ spaces><description>` rows (the current shape,
 * where the description may end in the CLI's `(default)` marker), one id per
 * line, an inline "Models: a, b" list, a JSON array of ids or of
 * {id|model|name} objects (an object may carry `default: true`), or a JSON object
 * with a models/items/data array.
 *
 * Once the columnar header is seen only the row shape is accepted, so a
 * single-word category header ("Open Source") can never be mistaken for an id.
 * The parse stops at the CLI's usage/docs footer so a separate
 * "Decision models (headless only)" section is not folded in.
 *
 * Returns null when nothing parseable was found — never a guess.
 */
export function parseListModelsCatalog(raw: unknown): ModelCatalog | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  const models: string[] = [];
  const freeModels: string[] = [];
  let defaultModel: string | null = null;

  const push = (id: unknown, isDefault: boolean, isFree = false): void => {
    if (typeof id !== "string") return;
    const v = id.trim();
    if (!v || !MODEL_TOKEN_RE.test(v)) return;
    if (!models.includes(v)) models.push(v);
    if (isDefault && !defaultModel) defaultModel = v;
    if (isFree && !freeModels.includes(v)) freeModels.push(v);
  };
  const markerOf = (desc: unknown): boolean => typeof desc === "string" && DEFAULT_MARKER_RE.test(desc);
  const freeTagOf = (value: unknown): boolean => typeof value === "string" && value.trim() === "FREE";

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(text);
      let arr: unknown = null;
      if (Array.isArray(j)) arr = j;
      else if (j && typeof j === "object") {
        const o = j as Record<string, unknown>;
        arr = Array.isArray(o.models) ? o.models : Array.isArray(o.items) ? o.items : Array.isArray(o.data) ? o.data : null;
      }
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (typeof e === "string") push(e, false);
          else if (e && typeof e === "object" && !Array.isArray(e)) {
            const o = e as Record<string, unknown>;
            const desc = typeof o.description === "string" ? o.description : typeof o.desc === "string" ? o.desc : "";
            const priceTag = typeof o.price === "string" ? o.price : typeof o.tag === "string" ? o.tag : "";
            push(o.id ?? o.model ?? o.name ?? o.slug, o.default === true || markerOf(desc), o.free === true || freeTagOf(priceTag));
          }
        }
        if (models.length) return { models, defaultModel, freeModels };
      }
    } catch {
      /* not JSON: fall through to the line parser */
    }
  }

  let columnar = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (FOOTER_STOP_RE.test(t)) break;
    if (INLINE_LIST_RE.test(t)) {
      const body = t
        .slice(t.indexOf(":") + 1)
        .trim()
        .replace(/^\(/, "")
        .replace(/\)$/, "");
      for (const piece of body.split(",")) push(piece.trim().split(/\s+/)[0], false);
      continue;
    }
    if (COLUMNAR_HEADER_RE.test(t)) {
      columnar = true;
      continue;
    }
    const m = COLUMN_ROW_RE.exec(t);
    if (m) {
      const detail = m[2] ?? "";
      const priceTag = detail.trim().split(/\s+/, 1)[0] ?? "";
      push(m[1], markerOf(detail), freeTagOf(priceTag));
      continue;
    }
    // A bare token is an id line ONLY outside the columnar listing; inside it a
    // bare word is a category header.
    if (!columnar && /^\S+$/.test(t)) {
      push(t.replace(/^[*•-]+/, ""), false);
      continue;
    }
  }
  return models.length ? { models, defaultModel, freeModels } : null;
}

/** Compatibility wrapper: the id array only, or null. */
export function parseListModelsOutput(raw: unknown): string[] | null {
  const catalog = parseListModelsCatalog(raw);
  return catalog ? catalog.models : null;
}
