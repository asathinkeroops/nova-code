import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import {
  createLogger,
  DEFAULT_CONFIG_PATH,
  loadSettings,
  mcpServerSchema,
  type McpServerConfig,
} from "@nova/base";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";
import { buildMcpManager } from "./mcp.js";
import { FileOAuthStore, openBrowser, startCallbackServer } from "./mcp-oauth.js";

/** How long to wait for the browser redirect before giving up the loopback. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/**
 * `nova mcp` — a Claude Code–compatible CLI for managing MCP servers straight
 * from the shell, without opening the REPL. It edits `servers` under `mcp` in
 * `~/.nova/nova.config.json` in place, preserving every other config key.
 *
 * Subcommands mirror `claude mcp`:
 *   nova mcp add [-t <transport>] [-e K=V]... [-H "H: v"]... <name> <cmd|url> [args...]
 *   nova mcp add-json <name> '<json>'
 *   nova mcp list
 *   nova mcp get <name>
 *   nova mcp remove <name>
 *
 * Nova keeps a single global config (no local/user/project scopes), so the
 * `-s, --scope` flag from Claude Code is intentionally omitted.
 */

type RawConfig = Record<string, unknown>;

/** Read the raw config JSON (unparsed, defaults NOT applied) or {} if absent. */
async function readRawConfig(): Promise<RawConfig> {
  try {
    const text = await readFile(DEFAULT_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawConfig;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return {};
}

async function writeRawConfig(raw: RawConfig): Promise<void> {
  await mkdir(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
  await writeFile(DEFAULT_CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** Pull the `mcp.servers` map out of raw config, tolerating missing/odd shapes. */
export function readServers(raw: RawConfig): Record<string, unknown> {
  const mcp = raw.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const servers = (mcp as RawConfig).servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return servers as Record<string, unknown>;
    }
  }
  return {};
}

/** Splice a server map back into raw config, creating `mcp`/`servers` as needed. */
export function writeServers(raw: RawConfig, servers: Record<string, unknown>): RawConfig {
  const mcp =
    raw.mcp && typeof raw.mcp === "object" && !Array.isArray(raw.mcp)
      ? { ...(raw.mcp as RawConfig) }
      : {};
  mcp.servers = servers;
  return { ...raw, mcp };
}

/** Parse repeated `KEY=value` flags (`-e`) into a record. Throws on a bad pair. */
export function parsePairs(items: string[] | undefined, kind: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new Error(`invalid ${kind} "${item}" (expected KEY=value)`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** Parse repeated `Name: value` header flags (`-H`) into a record. */
export function parseHeaders(items: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const colon = item.indexOf(":");
    if (colon <= 0) throw new Error(`invalid header "${item}" (expected "Name: value")`);
    out[item.slice(0, colon).trim()] = item.slice(colon + 1).trim();
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`${red("✗")} ${message}\n`);
  process.exit(1);
}

interface AddOptions {
  transport?: string;
  env?: string[];
  header?: string[];
}

async function addServer(
  name: string,
  commandOrUrl: string | undefined,
  args: string[],
  opts: AddOptions,
): Promise<void> {
  const transport = opts.transport ?? "stdio";
  if (!["stdio", "sse", "http"].includes(transport)) {
    fail(`invalid --transport "${transport}" (expected stdio, sse, or http)`);
  }
  if (!commandOrUrl) {
    fail(`missing ${transport === "stdio" ? "command" : "URL"} for server "${name}"`);
  }

  let server: unknown;
  try {
    if (transport === "stdio") {
      const env = parsePairs(opts.env, "env var");
      server = {
        command: commandOrUrl,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    } else {
      const headers = parseHeaders(opts.header);
      server = {
        type: transport,
        url: commandOrUrl,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
    // Validate through the same schema the runtime loads, so a bad entry fails
    // here instead of silently breaking startup.
    mcpServerSchema.parse(server);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const raw = await readRawConfig();
  const servers = readServers(raw);
  const existed = name in servers;
  servers[name] = server;
  await writeRawConfig(writeServers(raw, servers));

  const verb = existed ? "Updated" : "Added";
  process.stdout.write(
    `${green("✓")} ${verb} ${transport} MCP server ${cyan(name)} ` +
      dim(`→ ${DEFAULT_CONFIG_PATH}\n`) +
      dim(`  reconnect with /mcp (or restart nova) to use it.\n`),
  );
}

async function addJsonServer(name: string, json: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    fail(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    mcpServerSchema.parse(parsed);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const raw = await readRawConfig();
  const servers = readServers(raw);
  const existed = name in servers;
  servers[name] = parsed;
  await writeRawConfig(writeServers(raw, servers));
  process.stdout.write(
    `${green("✓")} ${existed ? "Updated" : "Added"} MCP server ${cyan(name)} ` +
      dim(`→ ${DEFAULT_CONFIG_PATH}\n`),
  );
}

/** One-line summary of a server config for `list`. */
function summarize(cfg: McpServerConfig): string {
  if (cfg.type === "stdio") {
    return `${dim("stdio")}  ${[cfg.command, ...cfg.args].join(" ")}`;
  }
  return `${dim(cfg.type)}  ${cfg.url}${cfg.oauth ? dim("  (oauth)") : ""}`;
}

async function listServers(): Promise<void> {
  const raw = await readRawConfig();
  const servers = readServers(raw);
  const names = Object.keys(servers).sort();
  if (names.length === 0) {
    process.stdout.write(dim("No MCP servers configured.\n"));
    process.stdout.write(
      dim(`Add one with \`nova mcp add\`. Config: ${DEFAULT_CONFIG_PATH}\n`),
    );
    return;
  }
  const width = Math.min(24, Math.max(...names.map((n) => n.length)));
  for (const name of names) {
    const result = mcpServerSchema.safeParse(servers[name]);
    if (!result.success) {
      process.stdout.write(`${cyan(name.padEnd(width))}  ${red("(invalid config)")}\n`);
      continue;
    }
    const cfg = result.data;
    const disabled = cfg.enabled === false ? ` ${yellow("(disabled)")}` : "";
    process.stdout.write(`${cyan(name.padEnd(width))}  ${summarize(cfg)}${disabled}\n`);
  }
}

async function getServer(name: string): Promise<void> {
  const raw = await readRawConfig();
  const servers = readServers(raw);
  if (!(name in servers)) fail(`no MCP server named "${name}"`);

  const result = mcpServerSchema.safeParse(servers[name]);
  process.stdout.write(`${bold(cyan(name))}\n`);
  if (!result.success) {
    process.stdout.write(`${red("  invalid config")} ${dim(result.error.message)}\n`);
    return;
  }
  const cfg = result.data;
  if (cfg.type === "stdio") {
    process.stdout.write(`  ${dim("transport")}  stdio\n`);
    process.stdout.write(`  ${dim("command")}    ${cfg.command}\n`);
    if (cfg.args.length > 0) process.stdout.write(`  ${dim("args")}       ${cfg.args.join(" ")}\n`);
    if (cfg.env) {
      for (const [k, v] of Object.entries(cfg.env)) {
        process.stdout.write(`  ${dim("env")}        ${k}=${v}\n`);
      }
    }
    if (cfg.cwd) process.stdout.write(`  ${dim("cwd")}        ${cfg.cwd}\n`);
  } else {
    process.stdout.write(`  ${dim("transport")}  ${cfg.type}\n`);
    process.stdout.write(`  ${dim("url")}        ${cfg.url}\n`);
    if (cfg.headers) {
      for (const [k, v] of Object.entries(cfg.headers)) {
        process.stdout.write(`  ${dim("header")}     ${k}: ${v}\n`);
      }
    }
    if (cfg.oauth) process.stdout.write(`  ${dim("oauth")}      enabled\n`);
  }
  if (cfg.enabled === false) process.stdout.write(`  ${yellow("disabled")}\n`);
}

async function removeServer(name: string): Promise<void> {
  const raw = await readRawConfig();
  const servers = readServers(raw);
  if (!(name in servers)) fail(`no MCP server named "${name}"`);
  delete servers[name];
  await writeRawConfig(writeServers(raw, servers));
  process.stdout.write(`${green("✓")} Removed MCP server ${cyan(name)}\n`);
}

/** Await the loopback redirect, rejecting once `AUTH_TIMEOUT_MS` elapses. */
function waitForCode(
  server: { waitForCode: Promise<{ code: string; state?: string }> },
): Promise<{ code: string; state?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${Math.round(AUTH_TIMEOUT_MS / 1000)}s`));
    }, AUTH_TIMEOUT_MS);
    server.waitForCode.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Drive the OAuth authorization-code + PKCE grant for `name` from the shell,
 * persisting tokens under `~/.nova/mcp-auth/` so later `nova` runs connect
 * silently. Mirrors `claude mcp login`; the interactive `/mcp` menu offers the
 * same action inside the REPL.
 */
async function loginServer(name: string): Promise<void> {
  const settings = await loadSettings();
  if (!settings.mcp.enabled) fail("MCP is disabled (settings.mcp.enabled = false).");

  const logger = createLogger({ level: "fatal", pretty: false });
  const mcp = buildMcpManager(settings, logger);
  if (!mcp) fail("no MCP servers configured (or all disabled).");
  if (!mcp.isOAuthCapable(name)) {
    fail(
      `"${name}" is not a remote server that supports OAuth — ` +
        `use --transport http/sse and add "oauth": {} to its config.`,
    );
  }

  let server: Awaited<ReturnType<typeof startCallbackServer>>;
  try {
    server = await startCallbackServer(settings);
  } catch (err) {
    const { callbackHost, callbackPort } = settings.mcp.oauth;
    fail(
      `could not start the OAuth callback server on ${callbackHost}:${callbackPort}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Free the port or change settings.mcp.oauth.callbackPort.`,
    );
  }

  try {
    let result = await mcp.authorize(name);
    if (result.status === "redirect") {
      const url = result.authorizationUrl.toString();
      openBrowser(url);
      process.stdout.write(
        `Opening your browser to authorize ${cyan(name)}…\n` +
          dim(`If it didn't open, visit:\n  ${url}\n`),
      );
      let code: { code: string; state?: string };
      try {
        code = await waitForCode(server);
      } catch (err) {
        fail(`authorization did not complete: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (result.expectedState && code.state !== result.expectedState) {
        fail("authorization rejected: state mismatch (possible CSRF). Try again.");
      }
      result = await result.complete(code.code);
    }

    if (result.status === "connected") {
      process.stdout.write(`${green("✓")} Authenticated ${cyan(name)} — tokens saved.\n`);
    } else if (result.status === "error" || result.status === "unsupported") {
      fail(`authorization failed: ${result.error}`);
    } else {
      fail("authorization did not complete.");
    }
  } finally {
    server.close();
    await mcp.close();
  }
  // Live http clients / the loopback can keep the event loop alive; exit cleanly.
  process.exit(0);
}

/** Clear a server's persisted OAuth tokens. Mirrors `claude mcp logout`. */
async function logoutServer(name: string): Promise<void> {
  const settings = await loadSettings();
  try {
    await new FileOAuthStore(name).clear();
  } catch (err) {
    fail(`could not clear tokens: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.stdout.write(`${green("✓")} Logged out ${cyan(name)} — cleared stored OAuth tokens.\n`);
  if (!(name in settings.mcp.servers)) {
    process.stdout.write(dim(`  (note: no server named "${name}" is configured)\n`));
  }
}

/**
 * Build the `mcp` subcommand tree. Attached to the root program in index.ts so
 * `nova mcp …` runs standalone (no REPL, no agent context) and exits.
 */
export function buildMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage MCP server configuration");

  mcp
    .command("add")
    .description("Add an MCP server")
    .argument("<name>", "server name")
    .argument("<commandOrUrl>", "command (stdio) or URL (http/sse)")
    .argument("[args...]", "command arguments (use -- to pass flags)")
    .option("-t, --transport <transport>", "transport: stdio (default), sse, or http", "stdio")
    .option("-e, --env <env...>", "environment variable KEY=value (stdio)")
    .option("-H, --header <header...>", 'HTTP header "Name: value" (http/sse)')
    .action((name: string, commandOrUrl: string | undefined, args: string[], opts: AddOptions) =>
      addServer(name, commandOrUrl, args, opts),
    );

  mcp
    .command("add-json")
    .description("Add an MCP server from a JSON config string")
    .argument("<name>", "server name")
    .argument("<json>", "server config as a JSON object")
    .action((name: string, json: string) => addJsonServer(name, json));

  mcp
    .command("list")
    .alias("ls")
    .description("List configured MCP servers")
    .action(() => listServers());

  mcp
    .command("get")
    .description("Show one MCP server's configuration")
    .argument("<name>", "server name")
    .action((name: string) => getServer(name));

  mcp
    .command("login")
    .description("Authenticate with a remote MCP server via OAuth")
    .argument("<name>", "server name")
    .action((name: string) => loginServer(name));

  mcp
    .command("logout")
    .description("Clear stored OAuth credentials for an MCP server")
    .argument("<name>", "server name")
    .action((name: string) => logoutServer(name));

  mcp
    .command("remove")
    .alias("rm")
    .description("Remove an MCP server")
    .argument("<name>", "server name")
    .action((name: string) => removeServer(name));

  // Bare `nova mcp` prints help rather than doing nothing.
  mcp.action(() => mcp.help());
  return mcp;
}
