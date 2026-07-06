import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPlugins } from "./loader.js";

describe("loadPlugins", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "plugins-proj-"));
    home = await mkdtemp(join(tmpdir(), "plugins-home-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function write(path: string, content: string): Promise<void> {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  const opts = () => ({
    cwd: root,
    home,
    projectDirs: [".nova/plugins"],
    userDirs: ["~/.nova/plugins"],
  });

  it("assembles commands, agents, skills, hooks, and mcp from one plugin", async () => {
    const base = ".nova/plugins/demo";
    await write(
      `${base}/.nova-plugin/plugin.json`,
      JSON.stringify({ name: "demo", version: "1.0.0" }),
    );
    await write(`${base}/commands/hi.md`, "---\ndescription: Say hi\n---\nHello world");
    await write(
      `${base}/agents/helper.md`,
      "---\nname: helper\ndescription: A helper agent\n---\nYou help.",
    );
    await write(`${base}/skills/greet/SKILL.md`, "---\ndescription: greet\n---\ngo");
    await write(
      `${base}/hooks/hooks.json`,
      JSON.stringify({
        PostToolUse: [{ matcher: "bash", command: "${CLAUDE_PLUGIN_ROOT}/bin/log.sh" }],
      }),
    );
    await write(
      `${base}/.mcp.json`,
      JSON.stringify({ mcpServers: { local: { command: "${CLAUDE_PLUGIN_ROOT}/server.js" } } }),
    );

    const { plugins, errors } = await loadPlugins(opts());
    expect(errors).toHaveLength(0);
    expect(plugins).toHaveLength(1);
    const p = plugins[0]!;
    expect(p.manifest.name).toBe("demo");
    expect(p.source).toBe("project");

    // Commands are namespaced <plugin>:<name> with source.kind "plugin".
    expect(p.commands.map((c) => c.name)).toEqual(["demo:hi"]);
    expect(p.commands[0]!.source.kind).toBe("plugin");

    expect(p.agents.map((a) => a.name)).toEqual(["helper"]);
    expect(p.skills).toEqual([join(root, base, "skills/greet")]);
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} in hooks and mcp specs", async () => {
    const base = ".nova/plugins/demo";
    const pluginRoot = join(root, base);
    await write(`${base}/.nova-plugin/plugin.json`, JSON.stringify({ name: "demo" }));
    await write(
      `${base}/hooks/hooks.json`,
      JSON.stringify({ PostToolUse: [{ command: "${CLAUDE_PLUGIN_ROOT}/bin/log.sh" }] }),
    );
    await write(
      `${base}/.mcp.json`,
      JSON.stringify({ mcpServers: { local: { command: "${NOVA_PLUGIN_ROOT}/server.js" } } }),
    );

    const { plugins } = await loadPlugins(opts());
    const p = plugins[0]!;
    expect(p.hooks?.PostToolUse[0]!.command).toBe(join(pluginRoot, "bin/log.sh"));
    // MCP server names are namespaced <plugin>__<server>.
    const spec = p.mcpServers["demo__local"];
    expect(spec).toBeDefined();
    expect((spec as { command: string }).command).toBe(join(pluginRoot, "server.js"));
  });

  it("loads a stock Claude Code plugin (.claude-plugin fallback)", async () => {
    const base = ".nova/plugins/cc";
    await write(
      `${base}/.claude-plugin/plugin.json`,
      JSON.stringify({ name: "cc", category: "misc" }),
    );
    await write(`${base}/commands/go.md`, "---\ndescription: Go\n---\nrun");

    const { plugins, errors } = await loadPlugins(opts());
    expect(errors).toHaveLength(0);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.name).toBe("cc");
    expect(plugins[0]!.commands.map((c) => c.name)).toEqual(["cc:go"]);
  });

  it("prefers .nova-plugin over .claude-plugin when both exist", async () => {
    const base = ".nova/plugins/dual";
    await write(`${base}/.nova-plugin/plugin.json`, JSON.stringify({ name: "nova-wins" }));
    await write(`${base}/.claude-plugin/plugin.json`, JSON.stringify({ name: "claude-loses" }));

    const { plugins } = await loadPlugins(opts());
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.name).toBe("nova-wins");
  });

  it("isolates a broken manifest and still loads siblings", async () => {
    await write(".nova/plugins/broken/.nova-plugin/plugin.json", "{ not json");
    await write(".nova/plugins/ok/.nova-plugin/plugin.json", JSON.stringify({ name: "ok" }));

    const { plugins, errors } = await loadPlugins(opts());
    expect(plugins.map((p) => p.manifest.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.dir).toContain("broken");
  });

  it("skips plugins named in `disabled`", async () => {
    await write(".nova/plugins/a/.nova-plugin/plugin.json", JSON.stringify({ name: "a" }));
    await write(".nova/plugins/b/.nova-plugin/plugin.json", JSON.stringify({ name: "b" }));

    const { plugins } = await loadPlugins({ ...opts(), disabled: ["a"] });
    expect(plugins.map((p) => p.manifest.name)).toEqual(["b"]);
  });

  it("lets a project plugin shadow a same-named user plugin", async () => {
    await write(".nova/plugins/dup/.nova-plugin/plugin.json", JSON.stringify({ name: "dup" }));
    await write(".nova/plugins/dup/commands/proj.md", "---\ndescription: p\n---\nx");
    // User-layer plugin with the same name, different command.
    const userPlugin = join(home, ".nova/plugins/dup");
    await mkdir(join(userPlugin, ".nova-plugin"), { recursive: true });
    await writeFile(join(userPlugin, ".nova-plugin/plugin.json"), JSON.stringify({ name: "dup" }));
    await mkdir(join(userPlugin, "commands"), { recursive: true });
    await writeFile(join(userPlugin, "commands/user.md"), "---\ndescription: u\n---\ny");

    const { plugins } = await loadPlugins(opts());
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.source).toBe("project");
    expect(plugins[0]!.commands.map((c) => c.name)).toEqual(["dup:proj"]);
  });

  it("loads .lsp.json servers and bin/ dirs; only monitors stay ignored", async () => {
    const base = ".nova/plugins/rich";
    await write(`${base}/.nova-plugin/plugin.json`, JSON.stringify({ name: "rich" }));
    await write(
      `${base}/.lsp.json`,
      JSON.stringify([
        { languageId: "zig", command: "zls", args: ["--stdio"], extensions: ["zig"] },
      ]),
    );
    await write(`${base}/monitors/m.json`, "{}");
    await write(`${base}/bin/tool`, "#!/bin/sh\n");

    const { plugins } = await loadPlugins(opts());
    const p = plugins[0]!;
    expect(p.lspServers).toEqual([
      { languageId: "zig", command: "zls", args: ["--stdio"], extensions: ["zig"] },
    ]);
    expect(p.binDirs).toEqual([join(root, base, "bin")]);
    expect(p.ignored.map((i) => i.kind)).toEqual(["monitors"]);
  });
});
