import { readFileSync, writeFileSync } from "node:fs";
import type { SchemaModel } from "./model.js";

/**
 * `composer.lock.json` (spec §2): the generated schema model, reviewable and diffable
 * like a lockfile. Keys are sorted so diffs stay small; `generatedAt` is excluded from
 * the comparison when deciding whether to rewrite.
 */
export function writeLockfile(path: string, model: SchemaModel): void {
  writeFileSync(path, stableStringify(model) + "\n");
}

export function readLockfile(path: string): SchemaModel {
  const m = JSON.parse(readFileSync(path, "utf8")) as SchemaModel;
  if (m.version !== 1) throw new Error(`unsupported lockfile version ${m.version}`);
  return m;
}

/** True when the live schema no longer matches the lockfile (regenerate it). */
export function isStale(lock: SchemaModel, liveFingerprint: string): boolean {
  return lock.fingerprint !== liveFingerprint;
}

function stableStringify(v: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => typeof x !== "object" || x === null)) return JSON.stringify(v);
    return `[\n${v.map((x) => pad + "  " + stableStringify(x, indent + 2)).join(",\n")}\n${pad}]`;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return "{}";
    const ordered = keys.includes("columnOrder") || keys.includes("version") ? keys : keys.sort();
    return `{\n${ordered.map((k) => `${pad}  ${JSON.stringify(k)}: ${stableStringify((v as Record<string, unknown>)[k], indent + 2)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(v);
}
