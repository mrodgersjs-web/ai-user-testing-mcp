/**
 * SQLite FTS5 index over the catalog lock (generated artifact, never committed).
 *
 * Row set: one row per CatalogEntry PLUS one row per provenance edge, so the
 * index always covers every distinct link at every depth (row count ≥ unique
 * links), including depth-2 non-repo links.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CatalogLock } from "./types.js";

interface PreparedRow {
  run(...args: Array<string | number>): void;
}

export function buildFtsIndex(lock: CatalogLock, dbPath: string): number {
  rmSync(dbPath, { force: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE VIRTUAL TABLE links USING fts5(id UNINDEXED, name, description, categories, capabilities)",
    );
    const insert = db.prepare(
      "INSERT INTO links (id, name, description, categories, capabilities) VALUES (?, ?, ?, ?, ?)",
    ) as PreparedRow;
    let rows = 0;
    db.exec("BEGIN");
    try {
      for (const e of lock.entries) {
        insert.run(e.id, e.name, e.description, e.categories.join(" "), e.capabilities.join(" "));
        rows++;
      }
      for (const e of lock.entries) {
        for (const p of e.provenance) {
          insert.run(
            e.id,
            e.name,
            `${p.sourceCatalogId} depth-${p.depth} ${p.urlAsLinked}`,
            e.categories.join(" "),
            e.capabilities.join(" "),
          );
          rows++;
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return rows;
  } finally {
    db.close();
  }
}

export interface SearchHit {
  id: string;
  name: string;
  score: number;
}

/** BM25-ranked search; lower bm25() score = better match, so ascending order ranks best first. */
export function searchIndex(dbPath: string, query: string, limit = 10): SearchHit[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u.test(w));
  if (words.length === 0 || limit < 1) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, name, bm25(links) AS score FROM links WHERE links MATCH ? ORDER BY score ASC LIMIT ?")
      .all(words.join(" "), limit) as Array<{ id: string; name: string; score: number }>;
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), score: Number(r.score) }));
  } finally {
    db.close();
  }
}
