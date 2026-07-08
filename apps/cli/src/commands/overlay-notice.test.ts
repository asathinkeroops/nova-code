import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context.js";
import { overlayNotice } from "./overlay-notice.js";

interface CardCall {
  text: string;
  opts: { title?: string };
}
interface ViewerCall {
  lines: string[];
  header?: string;
  border?: boolean;
  topRuleColor?: string;
}

function makeCtx(interactive: boolean): {
  ctx: CliContext;
  cards: CardCall[];
  viewers: ViewerCall[];
} {
  const cards: CardCall[] = [];
  const viewers: ViewerCall[] = [];
  const ctx = {
    screen: {
      interactive,
      card: (text: string, opts: CardCall["opts"] = {}) => cards.push({ text, opts }),
      viewer: async (opts: ViewerCall) => {
        viewers.push(opts);
      },
    },
  } as unknown as CliContext;
  return { ctx, cards, viewers };
}

const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const setTTY = (v: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("overlayNotice", () => {
  it("opens a purple top-rule viewer on an interactive TTY", async () => {
    setTTY(true);
    const { ctx, cards, viewers } = makeCtx(true);
    await overlayNotice(ctx, "/mcp", ["nothing here"]);
    expect(cards).toHaveLength(0);
    expect(viewers).toHaveLength(1);
    expect(viewers[0]?.lines).toEqual(["nothing here"]);
    expect(viewers[0]?.border).toBe(false);
    expect(viewers[0]?.topRuleColor).toBeTruthy();
  });

  it("falls back to a card when there is no TTY to host a modal", async () => {
    setTTY(false);
    const { ctx, cards, viewers } = makeCtx(true);
    await overlayNotice(ctx, "/mcp", ["line one", "line two"]);
    expect(viewers).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe("line one\nline two");
    expect(cards[0]?.opts.title).toBe("/mcp");
  });

  it("falls back to a card in a non-interactive (headless) screen even on a TTY", async () => {
    setTTY(true);
    const { ctx, cards, viewers } = makeCtx(false);
    await overlayNotice(ctx, "/diff", ["clean"]);
    expect(viewers).toHaveLength(0);
    expect(cards).toHaveLength(1);
  });
});
