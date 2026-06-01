# Agent-Team Mode — Implementation Plan

## Overview

**Goal**: Add a composable "leader-worker" pattern where a leader agent can delegate work to multiple worker agents concurrently or sequentially, each with isolated context and configurable tool sets.

**Approach**: New package `@nova/agent-team` that provides a `spawnWorkers` tool handler (similar to the existing `createSubAgent`) but extended with a concurrency pool, structured output, recursion depth control, and observability. The existing loop already supports parallel tool execution via `Promise.allSettled`, so **no core loop changes are needed**.

---

## Phase 1: Core — `@nova/agent-team` package (5 new files)

### Step 1.1: Config schema (modify 1 file)

**File**: `packages/runtime/src/config.ts`

Add a new `agentTeam` section in `settingsSchema` (after the existing `subagent` section):

```ts
agentTeam: z.object({
  enabled: z.boolean().default(false),
  // Max concurrent workers (bounded semaphore pool)
  maxConcurrent: z.number().int().positive().default(6),
  // Timeout per worker independent of the parent (ms)
  timeoutMs: z.number().int().positive().default(120_000),
  // Max recursion depth (0 = spawnWorkers disallowed, 1 = one layer, etc.)
  maxDepth: z.number().int().nonnegative().default(1),
  // Default worker max turns
  maxTurns: z.number().int().positive().default(20),
  // Default worker max tokens
  maxTokens: z.number().int().positive().default(4096),
  // If non-empty, default model (otherwise inherits leader's model)
  model: z.string().min(1).optional(),
}).default({
  enabled: false,
  maxConcurrent: 6,
  timeoutMs: 120_000,
  maxDepth: 1,
  maxTurns: 20,
  maxTokens: 4096,
}),
```

**Rationale**: Follows the same pattern as the existing `subagent` config — flat object, sensible defaults, optional model.

### Step 1.2: New worker hook points (modify 1 file)

**File**: `packages/core/src/hooks.ts`

Add two advisory hooks to the `HookSpec` interface:

```ts
worker_start: {
  payload: {
    workerId: string;
    description: string;
    model: string;
  };
  decision: void;
};
worker_end: {
  payload: {
    workerId: string;
    description: string;
    ok: boolean;
    error?: string;
    durationMs: number;
    turns: number;
    usage?: { inputTokens: number; outputTokens: number };
  };
  decision: void;
};
```

**Rationale**: Purely advisory — the UI can render progress spinners/notifications, but decision hooks stay coupled to their existing loop. This follows the same pattern as `post_turn` living outside the loop in `@nova/agent`.

### Step 1.3: Create `packages/agent-team/` (new package.json + tsconfig + 5 source files)

#### 1.3.1: `packages/agent-team/package.json`

```json
{
  "name": "@nova/agent-team",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@nova/agent": "workspace:*",
    "@nova/core": "workspace:*",
    "@nova/context": "workspace:*",
    "@nova/observability": "workspace:*",
    "@nova/runtime": "workspace:*",
    "zod": "catalog:"
  }
}
```

#### 1.3.2: `packages/agent-team/tsconfig.json`

Standard package tsconfig, mirroring `packages/subagent/tsconfig.json`.

#### 1.3.3: `packages/agent-team/src/types.ts` (new)

Defines the data model:

```ts
// Configuration for a single worker
interface WorkerConfig {
  description: string;           // Short label for UI
  prompt: string;                // Worker task (self-contained)
  type?: "general-purpose" | "explore" | "plan";  // Same as createSubAgent
  model?: string;                // Override, else inherits team default
  maxTurns?: number;             // Override, else inherits team default
  maxTokens?: number;            // Override, else inherits team default
  tools?: string[];              // If set, restrict to this subset; else inherit all
  outputSchema?: z.ZodType;      // Structured schema to validate/parse final text
}

// Result from a single worker
interface WorkerResult {
  workerId: string;
  description: string;
  ok: boolean;
  error?: string;
  output?: string;               // Final assistant text
  parsed?: unknown;              // Parsed if outputSchema was provided
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

// Tool input schema
const spawnWorkersInput = z.object({
  workers: z.array(WorkerConfigSchema).min(1).max(20),
  // Aggregation strategy: should the leader see raw results or a compact summary?
  aggregation: z.enum(["individual", "summary"]).default("individual"),
});
```

**Key decisions**:
- Optional `outputSchema` enables structured output — if provided, the runner parses the final text and populates `parsed`; if parsing fails, marks as `isError: true`.
- `aggregation: "summary"` invokes a compact model call to synthesize results rather than dumping everything into the leader's context.
- `tools: string[]` restricts tools per worker — useful for read-only workers or security isolation.

#### 1.3.4: `packages/agent-team/src/pool.ts` (new)

Bounded concurrency pool with semaphore:

```ts
class WorkerPool {
  constructor(maxConcurrent: number);
  
  // Run all workers in the pool, obeying maxConcurrent
  // Respects external AbortSignal while waiting for free slots
  async runAll(
    workers: WorkerConfig[],
    spawn: (w: WorkerConfig) => Promise<WorkerResult>,
    signal?: AbortSignal,
  ): Promise<WorkerResult[]>;
}
```

Standard "acquire slot / release slot" semaphore pattern with `Promise.race([slotAvailable, signalAborted])` for graceful cancellation.

#### 1.3.5: `packages/agent-team/src/orchestrator.ts` (new)

Core orchestrator — replaces the existing `@nova/subagent` pattern but adds pooling, depth, and structured output:

```ts
interface TeamDeps extends SubAgentDeps {
  // Extras:
  getTeamSettings: () => TeamSettingsSlice;  // agentTeam from config
  hooks: HookRegistry;                       // For emitting worker_start/end
  currentDepth: number;                      // Recursion depth counter
}

function createSpawnWorkersTool(deps: TeamDeps): ToolHandler;
```

Internal logic:
1. Check `currentDepth >= maxDepth` → if so, filter `spawnWorkers` from child tool list
2. Create an agent for each worker with `worker_start` hook (same pattern as `createSubAgent`: `createAgent()` + `agent.runTurn()`)
3. Each worker wraps an `AbortController` timeout around its `agent.runTurn`
4. Dispatch workers into the bounded concurrency pool
5. Collect results, optionally run a summary model call for `aggregation: "summary"`
6. Return formatted tool result

#### 1.3.6: `packages/agent-team/src/system-prompt.ts` (new)

Worker system prompt builder, similar to `@nova/subagent/system-prompt.ts` but tailored for team workers:

```ts
function buildWorkerSystemPrompt(
  workspace: string,
  memory: MemoryBundle,
  skillsBlock: string,
  type: SubAgentType,
): string;
```

Adds guidance that this is a worker within a larger team, should produce concise, actionable results synthesizable by the leader agent.

#### 1.3.7: `packages/agent-team/src/index.ts` (new)

Public API exports:

```ts
export { createSpawnWorkersTool } from "./orchestrator.js";
export { WorkerPool } from "./pool.js";
export type { WorkerConfig, WorkerResult, TeamDeps } from "./types.js";
export { SPAWN_WORKERS_TOOL_NAME } from "./orchestrator.js";
```

---

## Phase 2: CLI Integration (modify 2 files)

### Step 2.1: Wire `spawnWorkers` into CLI context

**File**: `apps/cli/src/context.ts`

In `createContext`, after the `createSubAgentTool` registration (~line 530):

```ts
if (settings.agentTeam.enabled) {
  const teamModel = settings.agentTeam.model
    ? buildModel(settings.agentTeam.model)
    : null;
  ctx.tools.register(
    createSpawnWorkersTool({
      workspace,
      memory,
      skillsBlock,
      getModel: () => teamModel ?? ctx.model,
      getToolDefinitions: () => ctx.tools.definitions(),
      dispatch: (use, c) => ctx.dispatch(use, c),
      checkPermission: (tool, input) => ctx.checkPermission(tool, input),
      compactor: (messages) => ctx.compactor(messages),
      fileLedger,
      askUser,
      getLogger: () => ctx.logger,
      getLogDir: () => join(ctx.session.dir, "team-workers"),
      getSettings: () => ({
        maxTokens: settings.agentTeam.maxTokens,
        maxTurns: settings.agentTeam.maxTurns,
        noTranscript: ctx.noTranscript,
      }),
      getTeamSettings: () => settings.agentTeam,
      hooks: ctx.agent.hooks,  // or passed through ctx
      currentDepth: 0,
    }),
  );
}
```

### Step 2.2: Worker progress UI hooks

**File**: `apps/cli/src/hooks.ts`

Add to `registerUiHooks`:

```ts
ctx.agent.on("worker_start", ({ workerId, description }) => {
  ctx.screen.card(`worker ${description} starting…`, {
    kind: "info",
    title: `team-worker-${workerId}`,
    id: `worker-${workerId}`,
  });
});

ctx.agent.on("worker_end", ({ workerId, description, ok, error, durationMs }) => {
  const status = ok ? "done" : "failed";
  const tail = error ? ` · ${error}` : "";
  ctx.screen.updateCard(`worker-${workerId}`, {
    kind: ok ? "info" : "error",
    title: `${description} ${status} (${(durationMs / 1000).toFixed(1)}s)${tail}`,
  });
});
```

---

## Change Summary

| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | `packages/runtime/src/config.ts` | **Modify** | Add `agentTeam` config schema section |
| 2 | `packages/core/src/hooks.ts` | **Modify** | Add `worker_start`, `worker_end` advisory hooks |
| 3 | `packages/agent-team/package.json` | **New** | Package manifest |
| 4 | `packages/agent-team/tsconfig.json` | **New** | TypeScript config |
| 5 | `packages/agent-team/src/types.ts` | **New** | WorkerConfig, WorkerResult, schemas |
| 6 | `packages/agent-team/src/pool.ts` | **New** | Bounded concurrency pool (semaphore) |
| 7 | `packages/agent-team/src/orchestrator.ts` | **New** | Core spawnWorkers tool |
| 8 | `packages/agent-team/src/system-prompt.ts` | **New** | Worker system prompt |
| 9 | `packages/agent-team/src/index.ts` | **New** | Public API |
| 10 | `apps/cli/src/context.ts` | **Modify** | Register spawnWorkers tool |
| 11 | `apps/cli/src/hooks.ts` | **Modify** | Worker progress cards |

Total: **11 files** (5 modifications + 6 new)

---

## Key Design Tradeoffs

### 1. New package vs. extending existing `@nova/subagent`

**Choice**: New package `@nova/agent-team`.

**Rationale**: `createSubAgent` is single-worker, single-tool, no pooling or structured output. `agent-team` adds concurrency pools, recursion depth, structured output schemas, and result aggregation — all orthogonal concerns. Keeping them separate keeps both simple, with a unidirectional dependency (agent-team → subagent pattern but no shared code) and allows team mode to evolve independently of the sub-agent primitive.

### 2. Shared stores vs. isolated stores

**Choice**: **Shared by default**, with an optional `isolated` flag.

**Rationale**: Existing `createSubAgent` reuses the parent agent's task/todo stores (intentional simplification). Team mode follows the same default but adds an `isolated: true` option that creates a transient store per worker — critical for parallel workers that shouldn't interfere with each other's todo/task cards in the parent agent's state. Implementation: wrap `TaskStore`/`TodoStore` in proxies that redirect writes to a worker-local store.

### 3. Recursion depth vs. flat ban

**Choice**: Configurable `maxDepth` (default=1, allows one layer of teams, no grandchildren).

**Rationale**: Existing `createSubAgent` filters itself out of the tool list (no recursion). Team mode enables richer control with a *counter* that decrements on each spawn. Depth=0 completely disables spawnWorkers; depth=1 allows workers that work independently; depth=2+ enables team trees. The counter filters `spawnWorkers` from the tool list (same pattern as existing), so child workers never even see the tool.

### 4. Structured output validation

**Choice**: Optional `outputSchema` with graceful degradation.

**Rationale**: Team tasks like "analyze these 10 files" benefit from structured parsing of the final text. But if the model doesn't output valid JSON, we don't throw — we populate `output: string` and leave `parsed: undefined`, marking `ok: true` but with a warning flag. The leader agent sees the raw text regardless and can decide what to do.

### 5. Result aggregation strategy

**Choice**: `aggregation: "individual" | "summary"`.

**Rationale**: 10 workers × 2K output each = 20K of text entering the leader's context, which could overwhelm it. The `"summary"` mode makes an extra model call ("synthesize key findings from these results") and returns only the summary. The default `"individual"` keeps raw results, matching the existing `createSubAgent` behavior.

---

## Edge Cases & Risk Mitigation

| Edge case | Handling |
|-----------|----------|
| Worker timeout | Each worker has an independent `AbortController` + `setTimeout`; timed-out workers return `ok: false, error: "timeout"` and release their pool slot |
| All workers fail | Tool returns `isError: true` with a summary listing all failures |
| User abort (escape key) | External AbortSignal propagates into the pool via `Promise.race`; running workers are cancelled and return cancelled status |
| Empty workers array | Zod schema enforces `min(1)` |
| Exceeding pool capacity | Workers queue in semaphore slots; executed in FIFO order |
| Concurrency limits across turns | If other tool calls are in the same turn, `maxConcurrent` only limits workers within this `spawnWorkers` call |
| Model context window concerns | Workers inherit the parent agent's compactor; if `maxTokens` is set too low, the worker's turn limit kicks in earlier |
| Worker fails to produce text output | `lastAssistantText` guard (same pattern as `createSubAgent`) — returns `isError: true` if no text found |

---

## Architecture Invariants Check

- ✅ **Core never imports a model SDK or UI** — `worker_start`/`worker_end` are pure advisory hooks in `@nova/core`; `@nova/agent-team` sits above core
- ✅ **Dependency direction**: agent-team → agent + core + runtime ✓, never reversed
- ✅ **Hook contracts**: New worker hooks are advisory (`decision: void`), following the same pattern as existing hooks
- ✅ **Settings schema-gated**: `agentTeam` added to `packages/runtime/src/config.ts` with full defaults
- ✅ **Tool use/result pairing**: Each worker tool call produces result blocks within its own agent loop; the parent loop sees a single final tool_result through its normal `post_tool_use` flow
- ✅ **TypeScript strict + `noUncheckedIndexedAccess`**: All array accesses handle undefined

---

## Future Extensions (out of scope for initial implementation)

- **Worker-to-worker communication**: Allow workers to pass messages to each other mid-execution
- **Dynamic worker spawning**: Leader can spawn additional workers based on intermediate results
- **Worker priority/affinity**: Assign CPU/GPU priority or preferred models per worker
- **Distributed workers**: Run workers on separate machines via network transport
- **Persistent team templates**: Predefined team configurations (e.g., "code-review-team", "research-team") stored as config presets
