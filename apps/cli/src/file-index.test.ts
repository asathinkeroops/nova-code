import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles } from "./file-index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nova-files-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content = ""): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

describe("listWorkspaceFiles", () => {
  it("lists files relative to the root, sorted, posix-style", async () => {
    await write("a.ts");
    await write("src/b.ts");
    await write("src/nested/c.ts");
    const files = await listWorkspaceFiles(root);
    expect(files).toEqual(["a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("skips node_modules and .git", async () => {
    await write("keep.ts");
    await write("node_modules/pkg/index.js");
    await write(".git/HEAD", "ref: refs/heads/main");
    const files = await listWorkspaceFiles(root);
    expect(files).toEqual(["keep.ts"]);
  });

  it("honors .gitignore", async () => {
    await write(".gitignore", "dist/\n*.log\n");
    await write("src/app.ts");
    await write("dist/app.js");
    await write("debug.log");
    const files = await listWorkspaceFiles(root);
    expect(files).toEqual(["src/app.ts"]);
  });

  it("caps the result at the limit", async () => {
    await write("a.ts");
    await write("b.ts");
    await write("c.ts");
    const files = await listWorkspaceFiles(root, 2);
    expect(files).toHaveLength(2);
    expect(files).toEqual(["a.ts", "b.ts"]);
  });
});
