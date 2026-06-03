/**
 * A sub-agent definition: the data behind one `type` value of the
 * `createSubAgent` tool. Three built-ins (`general-purpose`, `explore`,
 * `plan`) ship in `BUILTIN_AGENTS`; users add more by dropping markdown files
 * into `.nova/agents` / `.claude/agents` (see `loader.ts`). All of them live
 * together in an {@link AgentRegistry}.
 */
export interface AgentDefinition {
  /** Unique type key — the value passed as `createSubAgent({ type })`. */
  name: string;
  /**
   * One-line summary shown to the PARENT agent (in the tool description) and in
   * `/agents`, so it can pick the right type. This is selection metadata, not
   * the sub-agent's own instructions — that's `guidance`.
   */
  description: string;
  /** Fills the `You are a Nova sub-agent: {roleLine}.` opening line. */
  roleLine: string;
  /**
   * Extra role guidance injected into the sub-agent's system prompt, after the
   * standard isolation/report-back bullets. For built-ins this is a few
   * bullets; for custom agents it's the markdown body of the definition file.
   * May be empty.
   */
  guidance: string;
  /**
   * When true, the workspace-mutating tools (write/edit/bash) are withheld from
   * the sub-agent — both from its tool list and at the permission layer.
   */
  readOnly: boolean;
  /**
   * Optional allow-list of tool names. When present, the sub-agent's tool set
   * is intersected with it (on top of the `readOnly` filter). Omit to inherit
   * the parent's full set.
   */
  allowTools?: readonly string[];
  /** Optional model-id override. Resolved to a ModelClient by the host. */
  model?: string;
  /** Optional per-sub-agent loop limits, overriding the global subagent slice. */
  maxTurns?: number;
  maxTokens?: number;
  /** Provenance, for `/agents` listing and shadowing rules. */
  source: "builtin" | "project" | "user";
  /** Absolute path of the source .md file; undefined for built-ins. */
  path?: string;
}

const READ_ONLY_BULLET =
  "- You are READ-ONLY: you have no write/edit/bash tools and cannot modify files or run commands.";

/**
 * The three shipped sub-agent types. Their prompts/behavior reproduce the
 * previous hardcoded `explore` / `plan` / `general-purpose` exactly, now
 * expressed as registry seed data.
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "full tool access (read, write, edit, bash, …) for tasks that must change files or run commands",
    roleLine:
      "an autonomous worker spawned by a parent agent to complete ONE focused task and report back",
    guidance: "",
    readOnly: false,
    source: "builtin",
  },
  {
    name: "explore",
    description:
      "read-only retrieval. Locates code/files/usages and reports findings. Has NO write/edit/bash tools.",
    roleLine:
      "a read-only EXPLORE worker spawned by a parent agent to locate code and gather information, then report back",
    guidance: [
      READ_ONLY_BULLET,
      "- Your job is retrieval. Use grep/glob/read to find files, symbols, and usages fast. Report concrete file paths and line numbers.",
    ].join("\n"),
    readOnly: true,
    source: "builtin",
  },
  {
    name: "plan",
    description:
      "read-only planning. Investigates a task and returns a step-by-step implementation plan. Has NO write/edit/bash tools.",
    roleLine:
      "a read-only PLAN worker spawned by a parent agent to investigate a task and produce a concrete implementation plan, then report back",
    guidance: [
      READ_ONLY_BULLET,
      "- Your job is planning. Investigate the relevant code, then report a concrete step-by-step plan: which files to change, in what order, and the key tradeoffs. Do NOT implement.",
    ].join("\n"),
    readOnly: true,
    source: "builtin",
  },
];

/**
 * Holds the set of available sub-agent definitions for a session. Seeded with
 * {@link BUILTIN_AGENTS}; custom definitions are layered on via `addCustom`.
 *
 * Precedence: built-ins always win, then earlier-added customs win over later
 * ones (the loader yields project-layer defs before user-layer ones, so
 * project wins over user). A collision is reported back to the caller (for a
 * warning) rather than silently overwriting.
 *
 * Contents are mutable so `/agents reload` can refresh them in place; the
 * `createSubAgent` tool reads the registry per-invocation, so a reload takes
 * effect on the next spawn without re-registering the tool.
 */
export class AgentRegistry {
  private readonly map = new Map<string, AgentDefinition>();

  constructor(seed: readonly AgentDefinition[] = BUILTIN_AGENTS) {
    for (const d of seed) this.map.set(d.name, d);
  }

  /**
   * Layer custom definitions on top, in priority order (first wins). A name
   * already present (a built-in, or an earlier custom) is left untouched.
   * Returns the names that were skipped due to a collision.
   */
  addCustom(defs: readonly AgentDefinition[]): string[] {
    const skipped: string[] = [];
    for (const d of defs) {
      if (this.map.has(d.name)) {
        skipped.push(d.name);
        continue;
      }
      this.map.set(d.name, d);
    }
    return skipped;
  }

  /** Reset to built-ins, then layer the given custom defs (used by reload). */
  replaceCustom(defs: readonly AgentDefinition[]): string[] {
    this.map.clear();
    for (const d of BUILTIN_AGENTS) this.map.set(d.name, d);
    return this.addCustom(defs);
  }

  get(name: string): AgentDefinition | undefined {
    return this.map.get(name);
  }

  list(): AgentDefinition[] {
    return [...this.map.values()];
  }

  names(): string[] {
    return [...this.map.keys()];
  }
}
