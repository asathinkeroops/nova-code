import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliContext } from "../context.js";
import { handleDiff } from "./diff.js";

interface Card {
  text: string;
  opts: { title?: string; kind?: string };
}

interface PickCall {
  items: unknown[];
  header?: string;
  footer?: string;
  render: (item: unknown, selected: boolean) => string;
}

interface ViewerLineObj {
  text: string;
  bg?: "add" | "del";
  gutter?: string;
}
interface ViewerCall {
  lines: Array<string | ViewerLineObj>;
  header?: string;
  footer?: string;
}

function viewerText(call: ViewerCall): string {
  return call.lines
    .map((l) => (typeof l === "string" ? l : (l.gutter ?? "") + l.text))
    .join("\n");
}

/**
 * Build a stub context. `pickResponses` is a queue: each `pickOne` call shifts
 * the next response (an index into that call's items, or null to cancel). Every
 * file-list pick is recorded in `picks`, and every diff-viewer open in
 * `viewers`, so tests can inspect what was offered.
 */
function makeCtx(
  workspace: string,
  cards: Card[],
  picks: PickCall[],
  pickResponses: Array<number | null>,
  viewers: ViewerCall[] = [],
): CliContext {
  return {
    workspace,
    screen: {
      card: (text: string, opts: Card["opts"] = {}) => cards.push({ text, opts }),
      pickOne: async (opts: PickCall) => {
        picks.push(opts);
        const choice = pickResponses.shift() ?? null;
        return choice === null ? null : (opts.items[choice] ?? null);
      },
      viewer: async (opts: ViewerCall) => {
        viewers.push(opts);
      },
    },
  } as unknown as CliContext;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
}

describe("handleDiff", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nova-diff-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when not inside a git repository", async () => {
    const cards: Card[] = [];
    await handleDiff(makeCtx(dir, cards, [], []), "");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.opts.kind).toBe("warn");
    expect(cards[0]?.text).toMatch(/not a git repository/i);
  });

  it("reports a clean working tree without opening a modal", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    const cards: Card[] = [];
    const picks: PickCall[] = [];
    await handleDiff(makeCtx(dir, cards, picks, []), "");
    expect(picks).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toMatch(/working tree clean/i);
  });

  it("lists staged, unstaged, and untracked files in the picker", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git(dir, ["add", "a.txt"]); // staged
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n"); // + unstaged
    writeFileSync(join(dir, "b.txt"), "new\n"); // untracked

    const picks: PickCall[] = [];
    // Cancel the file list immediately.
    await handleDiff(makeCtx(dir, [], picks, [null]), "");

    expect(picks).toHaveLength(1);
    const rendered = picks[0]!.items.map((it) => picks[0]!.render(it, false));
    expect(rendered.join("\n")).toContain("a.txt");
    expect(rendered.join("\n")).toContain("b.txt");
    expect(rendered.join("\n")).toMatch(/untracked/);
  });

  it("opens a per-file diff viewer when a file is selected", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

    const picks: PickCall[] = [];
    const viewers: ViewerCall[] = [];
    // First list pick: select file 0 (opens viewer); second list pick: cancel.
    await handleDiff(makeCtx(dir, [], picks, [0, null], viewers), "");

    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.header).toContain("a.txt");
    expect(viewerText(viewers[0]!)).toContain("two");
    // The added line carries an "add" background tint.
    expect(viewers[0]!.lines.some((l) => typeof l !== "string" && l.bg === "add")).toBe(true);
  });

  it("narrows the file list to a pathspec argument", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    writeFileSync(join(dir, "a.txt"), "a\nchanged\n");
    writeFileSync(join(dir, "b.txt"), "b\nchanged\n");

    const picks: PickCall[] = [];
    await handleDiff(makeCtx(dir, [], picks, [null]), "a.txt");

    expect(picks).toHaveLength(1);
    const rendered = picks[0]!.items.map((it) => picks[0]!.render(it, false)).join("\n");
    expect(rendered).toContain("a.txt");
    expect(rendered).not.toContain("b.txt");
  });
});
