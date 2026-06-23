import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "./ui/store.js";

/**
 * Per-session persistence for inline timeline cards (slash-command output,
 * error reports, compaction notices, …). Cards are display-only — they never
 * enter `messages.jsonl` or the model context — but they should survive a
 * `/resume` or a session switch so the conversation timeline reads the same
 * after a restart as it did live.
 *
 * Unlike `display-sidecar.jsonl` (which overrides how *existing* messages
 * render), this file holds standalone cards keyed by their `anchor` (the
 * message index they render after). Stored as append-only JSONL next to
 * `messages.jsonl`:
 *
 *  - `card`: one pushed card, persisted verbatim.
 *  - `cleared`: a tombstone — on load it resets the accumulated card list to
 *    empty. Emitted on compaction, where every prior card's anchor points into
 *    pre-compaction message indices and is therefore meaningless. Keeping the
 *    file append-only (rather than rewriting it) preserves the same "recording
 *    never rewrites" property the rest of the session dir relies on.
 */

const FILENAME = "cards.jsonl";

type CardRecord = { kind: "card"; card: Card } | { kind: "cleared" };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export function cardsPath(sessionDir: string): string {
  return join(sessionDir, FILENAME);
}

/** Validate one persisted card; null on any shape mismatch. */
function asCard(value: unknown): Card | null {
  if (!isObj(value)) return null;
  if (typeof value.id !== "number") return null;
  if (typeof value.anchor !== "number") return null;
  if (value.kind !== "info" && value.kind !== "warn" && value.kind !== "error") return null;
  if (typeof value.text !== "string") return null;
  if (value.title !== undefined && typeof value.title !== "string") return null;
  const card: Card = { id: value.id, anchor: value.anchor, kind: value.kind, text: value.text };
  if (typeof value.title === "string") card.title = value.title;
  return card;
}

/**
 * Read the cards file in order. Missing file → empty list. Malformed lines are
 * skipped rather than fatal — a corrupt card must never block resuming a
 * session. A `cleared` tombstone resets the accumulated list, so only cards
 * appended after the last compaction survive.
 */
export async function loadCards(sessionDir: string): Promise<Card[]> {
  let raw: string;
  try {
    raw = await readFile(cardsPath(sessionDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let cards: Card[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    if (parsed.kind === "cleared") {
      cards = [];
      continue;
    }
    if (parsed.kind === "card") {
      const card = asCard(parsed.card);
      if (card) cards.push(card);
    }
  }
  return cards;
}

/** Append one pushed card. */
export async function appendCard(sessionDir: string, card: Card): Promise<void> {
  const rec: CardRecord = { kind: "card", card };
  await appendFile(cardsPath(sessionDir), JSON.stringify(rec) + "\n", "utf8");
}

/** Append a tombstone that resets the persisted card list (used on compaction). */
export async function appendCardsCleared(sessionDir: string): Promise<void> {
  const rec: CardRecord = { kind: "cleared" };
  await appendFile(cardsPath(sessionDir), JSON.stringify(rec) + "\n", "utf8");
}
