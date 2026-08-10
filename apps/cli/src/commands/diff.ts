import { execFileSync } from "node:child_process";

import { ACCENT_HEX, bold, diffSign, dim, green, yellow, red } from "../colors.js";
import type { CliContext } from "../context.js";
import { t } from "../i18n/index.js";
import { highlightContent } from "../ui/diff.js";
import { pickerArrow, type ViewerLine } from "../ui/picker.js";
import { overlayNotice } from "./overlay-notice.js";

const TITLE = "/diff";

/** Run a git subcommand in `cwd`, capturing stdout. Throws on non-zero exit. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // Diffs can be large; allow up to 64 MiB before bailing out.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Like {@link git}, but returns the captured stdout even when git exits non-zero. */
function gitSoft(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    return typeof out === "string" ? out : "";
  }
}

interface Change {
  /** Path relative to the repo, as git reports it. */
  path: string;
  /** Staged status letter (porcelain X), or " " if none. */
  x: string;
  /** Worktree status letter (porcelain Y), or " " if none. */
  y: string;
  untracked: boolean;
}

/** Parse `git status --porcelain` into one {@link Change} per file. */
function collectChanges(cwd: string, pathspec: string): Change[] {
  const args = ["-c", "core.quotePath=false", "status", "--porcelain=v1"];
  if (pathspec) args.push("--", pathspec);
  const out = git(cwd, args);

  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    let path = line.slice(3);
    // Renames/copies are reported as "old -> new"; key off the new path.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    changes.push({ path, x, y, untracked: x === "?" });
  }
  return changes;
}

/** Per-file added/removed line counts, summed across staged + unstaged. */
function numstat(cwd: string, pathspec: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  const tail = pathspec ? ["--", pathspec] : [];
  const absorb = (out: string): void => {
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [a, d, ...rest] = line.split("\t");
      const p = rest.join("\t");
      if (!p) continue;
      const adds = a === "-" ? 0 : Number(a) || 0;
      const dels = d === "-" ? 0 : Number(d) || 0;
      const prev = map.get(p) ?? [0, 0];
      map.set(p, [prev[0] + adds, prev[1] + dels]);
    }
  };
  absorb(gitSoft(cwd, ["diff", "--staged", "--numstat", ...tail]));
  absorb(gitSoft(cwd, ["diff", "--numstat", ...tail]));
  return map;
}

/** A short, git-status-style status code: X (staged) in green, Y (worktree) in yellow. */
function statusCode(c: Change): string {
  if (c.untracked) return dim("??");
  const xc = c.x === " " ? " " : green(c.x);
  const yc = c.y === " " ? " " : yellow(c.y);
  return `${xc}${yc}`;
}

/** A human description of a change's state, e.g. "staged modified · unstaged" or "untracked". */
function statusLabel(c: Change): string {
  if (c.untracked) return dim(t.diff.untracked);
  const parts: string[] = [];
  if (c.x !== " ") parts.push(green(t.diff.staged(t.diff.statusWord(c.x))));
  if (c.y !== " ") parts.push(yellow(t.diff.unstaged(t.diff.statusWord(c.y))));
  return parts.join(dim(" · "));
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Drop the noise git prints above the hunks — the filename is in the header. */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ")
  );
}

type RowKind = "context" | "add" | "del" | "nonl";
interface Row {
  kind: RowKind;
  /** Raw content with the leading +/-/space stripped. */
  content: string;
  /** Line number to show in the gutter (new-file for context/add, old for del). */
  no: number | null;
}

/**
 * Turn a unified diff into rendered {@link ViewerLine}s matching the in-app diff
 * style (see ui/diff.ts): a dim line-number gutter outside a full-width add/
 * remove tint, a coloured +/- sign, and syntax-highlighted code. Highlighting is
 * done per hunk — a hunk's context+adds are a contiguous slice of the new file
 * (and context+dels of the old), so each side highlights with correct context.
 */
function buildDiffLines(diff: string, path: string): ViewerLine[] {
  const raw = diff.split("\n");

  // Width of the gutter is driven by the largest line number any hunk reaches.
  let maxNo = 0;
  for (const line of raw) {
    const m = HUNK_RE.exec(line);
    if (m) maxNo = Math.max(maxNo, Number(m[2]) || 0);
  }
  const gutterW = Math.max(3, String(maxNo + raw.length).length);
  const gutter = (n: number | null): string =>
    dim((n === null ? "" : String(n)).padStart(gutterW, " ")) + " ";

  const out: ViewerLine[] = [];

  // Flush a buffered hunk: highlight each side once, then emit styled rows.
  let buf: Row[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const newSrc = buf.filter((r) => r.kind === "context" || r.kind === "add").map((r) => r.content);
    const oldSrc = buf.filter((r) => r.kind === "context" || r.kind === "del").map((r) => r.content);
    const hNew = newSrc.length ? highlightContent(newSrc.join("\n"), path).split("\n") : [];
    const hOld = oldSrc.length ? highlightContent(oldSrc.join("\n"), path).split("\n") : [];
    let ni = 0;
    let oi = 0;
    for (const r of buf) {
      if (r.kind === "nonl") {
        out.push({ gutter: gutter(null), text: dim(r.content) });
        continue;
      }
      let code: string;
      if (r.kind === "context") {
        code = hNew[ni++] ?? r.content;
        oi++;
      } else if (r.kind === "add") {
        code = hNew[ni++] ?? r.content;
      } else {
        code = hOld[oi++] ?? r.content;
      }
      const g = gutter(r.no);
      if (r.kind === "add") out.push({ gutter: g, text: ` ${diffSign("add")} ${code}`, bg: "add" });
      else if (r.kind === "del") out.push({ gutter: g, text: ` ${diffSign("del")} ${code}`, bg: "del" });
      else out.push({ gutter: g, text: `   ${code}` });
    }
    buf = [];
  };

  let oldNo = 0;
  let newNo = 0;
  for (const line of raw) {
    if (isFileHeader(line)) continue;
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      flush();
      oldNo = Number(hunk[1]) || 0;
      newNo = Number(hunk[2]) || 0;
      // Drop the numeric `@@ … @@` — the gutter already shows line numbers.
      // Keep git's trailing section context (the enclosing function, if any) as
      // a dim divider; between hunks, show a faint gap marker even without it.
      const section = (hunk[3] ?? "").trim();
      const blankGutter = dim(" ".repeat(gutterW)) + " ";
      if (out.length > 0) {
        out.push({ gutter: blankGutter, text: dim(section ? `⋯ ${section}` : "⋯") });
      } else if (section) {
        out.push({ gutter: blankGutter, text: dim(`⋯ ${section}`) });
      }
      continue;
    }
    const sign = line[0] ?? " ";
    if (sign === "+") {
      buf.push({ kind: "add", content: line.slice(1), no: newNo });
      newNo++;
    } else if (sign === "-") {
      buf.push({ kind: "del", content: line.slice(1), no: oldNo });
      oldNo++;
    } else if (sign === "\\") {
      buf.push({ kind: "nonl", content: line, no: null });
    } else {
      buf.push({ kind: "context", content: line ? line.slice(1) : "", no: line ? newNo : null });
      oldNo++;
      newNo++;
    }
  }
  flush();
  return out;
}

/** The full diff for a single file — combined staged + unstaged for tracked files. */
function fileDiff(cwd: string, change: Change): string {
  if (change.untracked) {
    // `--no-index` exits 1 when the files differ; keep its stdout anyway.
    return gitSoft(cwd, ["diff", "--no-index", "--", "/dev/null", change.path]).trimEnd();
  }
  // Prefer a single diff against HEAD (captures staged + unstaged together);
  // fall back to concatenating both when there is no HEAD yet (pre-first-commit).
  try {
    return git(cwd, ["diff", "HEAD", "--", change.path]).trimEnd();
  } catch {
    return [
      gitSoft(cwd, ["diff", "--staged", "--", change.path]),
      gitSoft(cwd, ["diff", "--", change.path]),
    ]
      .map((s) => s.trimEnd())
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * Show every uncommitted change in the working tree as an interactive modal:
 * first a list of changed files, then a scrollable per-file diff viewer. The
 * two loop — viewing a file returns to the list — until the list is dismissed.
 * Read-only; it never touches the agent or the index. An optional pathspec
 * argument narrows the set of files.
 */
export async function handleDiff(ctx: CliContext, args: string): Promise<void> {
  const cwd = ctx.workspace;

  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    ctx.screen.card(dim(t.diff.notGitRepo), { title: TITLE, kind: "warn" });
    return;
  }

  const pathspec = args.trim();

  let changes: Change[];
  let counts: Map<string, [number, number]>;
  try {
    changes = collectChanges(cwd, pathspec);
    counts = numstat(cwd, pathspec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.screen.card(msg, { title: TITLE, kind: "error" });
    return;
  }

  if (changes.length === 0) {
    const scope = pathspec ? t.diff.matchingScope(pathspec) : "";
    await overlayNotice(ctx, TITLE, [dim(t.diff.cleanTree(scope))]);
    return;
  }

  const pathWidth = Math.min(48, Math.max(...changes.map((c) => c.path.length)));

  let cursor = 0;
  for (;;) {
    const pick = await ctx.screen.pickOne<Change>({
      items: changes,
      header: dim(t.diff.changedFiles(changes.length)),
      footer: dim(t.diff.listFooter),
      pageSize: 12,
      initialIndex: cursor,
      render: (c, selected) => {
        const [adds, dels] = counts.get(c.path) ?? [0, 0];
        const stat = adds || dels ? dim(`  ${green(`+${adds}`)} ${red(`-${dels}`)}`) : "";
        const name = c.path.padEnd(pathWidth, " ");
        return `${pickerArrow(selected)} ${statusCode(c)}  ${name}  ${statusLabel(c)}${stat}`;
      },
      border: false,
      topRuleColor: ACCENT_HEX,
    });
    if (!pick) break;
    cursor = Math.max(0, changes.indexOf(pick));

    const diff = fileDiff(cwd, pick);
    const lines: Array<string | ViewerLine> = diff
      ? buildDiffLines(diff, pick.path)
      : [dim(t.diff.noTextualDiff)];
    await ctx.screen.viewer({
      lines,
      header: `${bold(pick.path)}  ${statusLabel(pick)}`,
      footer: dim(t.diff.viewerFooter),
      pageSize: 24,
      border: false,
      topRuleColor: ACCENT_HEX,
    });
  }
}
