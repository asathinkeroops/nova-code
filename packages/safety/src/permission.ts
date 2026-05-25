import type { PermissionRule } from "@nova/runtime";
import { isDangerousBash } from "@nova/runtime";

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionDecision {
  effect: PermissionEffect;
  reason: string;
  matchedRule?: PermissionRule;
}

export interface PermissionInput {
  tool: string;
  input: Record<string, unknown>;
}

export type AskCallback = (
  decision: PermissionDecision,
  input: PermissionInput,
) => Promise<"yes" | "no" | "always-allow">;

export interface PermissionConfig {
  defaultEffect: PermissionEffect;
  rules: PermissionRule[];
  ask?: AskCallback;
}

export class PermissionDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(`Permission denied for tool "${tool}": ${reason}`);
    this.name = "PermissionDeniedError";
  }
}

function matchValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected === "string" && typeof actual === "string") {
    if (expected.startsWith("/") && expected.endsWith("/") && expected.length > 2) {
      try {
        return new RegExp(expected.slice(1, -1)).test(actual);
      } catch {
        return false;
      }
    }
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null
  ) {
    return Object.entries(expected).every(([k, v]) =>
      matchValue(v, (actual as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function ruleMatches(rule: PermissionRule, req: PermissionInput): boolean {
  if (rule.tool !== req.tool && rule.tool !== "*") return false;
  if (!rule.match) return true;
  return Object.entries(rule.match).every(([k, v]) => matchValue(v, req.input[k]));
}

export class PermissionEngine {
  private runtimeAllow = new Map<string, Set<string>>();

  constructor(private readonly config: PermissionConfig) {}

  evaluate(req: PermissionInput): PermissionDecision {
    if (req.tool === "bash") {
      const cmd = (req.input as { command?: string }).command;
      if (typeof cmd === "string" && isDangerousBash(cmd)) {
        return {
          effect: "deny",
          reason: `bash command matched dangerous pattern: ${cmd}`,
        };
      }
    }

    try {
      const runtimeBucket = this.runtimeAllow.get(req.tool);
      if (runtimeBucket?.has(stableInputKey(req.input))) {
        return { effect: "allow", reason: "runtime always-allow" };
      }
      if (runtimeBucket?.has("*")) {
        return { effect: "allow", reason: "runtime always-allow-tool" };
      }

      for (const rule of this.config.rules) {
        if (ruleMatches(rule, req)) {
          return {
            effect: rule.effect,
            reason: `matched rule: ${rule.tool} → ${rule.effect}`,
            matchedRule: rule,
          };
        }
      }
      return {
        effect: this.config.defaultEffect,
        reason: `default effect: ${this.config.defaultEffect}`,
      };
    } catch (err) {
      // Any throw from match evaluation (bad regex source we didn't catch,
      // Proxy getters on the input, JSON.stringify in stableInputKey, etc.)
      // degrades to `ask` rather than crashing the turn. We deliberately
      // don't downgrade to `deny` — that would let a misconfigured rule
      // silently block tools; `ask` keeps the user in the loop.
      return {
        effect: "ask",
        reason: `permission evaluation error, fallback to ask: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async check(req: PermissionInput): Promise<PermissionDecision> {
    const decision = this.evaluate(req);
    if (decision.effect === "deny") {
      throw new PermissionDeniedError(req.tool, decision.reason);
    }
    if (decision.effect === "allow") return decision;

    if (!this.config.ask) {
      throw new PermissionDeniedError(
        req.tool,
        `tool requires confirmation but no ask callback was configured`,
      );
    }
    const answer = await this.config.ask(decision, req);
    if (answer === "no") {
      throw new PermissionDeniedError(req.tool, "user denied at prompt");
    }
    if (answer === "always-allow") {
      const bucket = this.runtimeAllow.get(req.tool) ?? new Set<string>();
      bucket.add("*");
      this.runtimeAllow.set(req.tool, bucket);
    }
    return { effect: "allow", reason: `user approved (${answer})` };
  }
}

function stableInputKey(input: Record<string, unknown>): string {
  return JSON.stringify(input, Object.keys(input).sort());
}
