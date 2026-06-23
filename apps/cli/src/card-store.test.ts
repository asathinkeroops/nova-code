import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { Card } from "./ui/store.js";
import { appendCard, appendCardsCleared, cardsPath, loadCards } from "./card-store.js";

const dirs: string[] = [];
async function tmpSession(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nova-cards-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const card = (id: number, anchor: number, text: string, extra: Partial<Card> = {}): Card => ({
  id,
  anchor,
  kind: "info",
  text,
  ...extra,
});

describe("card-store", () => {
  it("returns an empty list when the file is missing", async () => {
    const dir = await tmpSession();
    expect(await loadCards(dir)).toEqual([]);
  });

  it("round-trips appended cards in order", async () => {
    const dir = await tmpSession();
    const a = card(1, -1, "first");
    const b = card(2, 3, "second", { kind: "warn", title: "/effort" });
    await appendCard(dir, a);
    await appendCard(dir, b);
    expect(await loadCards(dir)).toEqual([a, b]);
  });

  it("preserves the optional title and is omitted when absent", async () => {
    const dir = await tmpSession();
    await appendCard(dir, card(1, 0, "no title"));
    const [loaded] = await loadCards(dir);
    expect(loaded).not.toHaveProperty("title");
  });

  it("resets accumulated cards at a tombstone, keeping only later cards", async () => {
    const dir = await tmpSession();
    await appendCard(dir, card(1, 0, "pre-compact"));
    await appendCardsCleared(dir);
    await appendCard(dir, card(2, 0, "post-compact"));
    const loaded = await loadCards(dir);
    expect(loaded.map((c) => c.text)).toEqual(["post-compact"]);
  });

  it("skips malformed and invalid lines rather than throwing", async () => {
    const dir = await tmpSession();
    const good = card(1, 0, "good");
    await appendCard(dir, good);
    // Append a junk line and a structurally-invalid card record.
    await writeFile(
      cardsPath(dir),
      (await readFile(cardsPath(dir), "utf8")) +
        "not json\n" +
        JSON.stringify({ kind: "card", card: { id: "x", anchor: 0, kind: "info", text: "bad" } }) +
        "\n",
    );
    expect(await loadCards(dir)).toEqual([good]);
  });
});
