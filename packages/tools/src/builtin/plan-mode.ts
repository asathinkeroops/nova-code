import { z } from "zod";
import type { ToolHandler } from "@nova/core";

export const ENTER_PLAN_MODE_TOOL = "enterPlanMode";
export const EXIT_PLAN_MODE_TOOL = "exitPlanMode";

/**
 * Both plan-mode tool names. Exported so hosts can withhold them where an
 * agent-driven mode flip would be wrong — notably sub-agents, which run inside
 * the parent session and must not change ITS permission mode.
 */
export const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ENTER_PLAN_MODE_TOOL,
  EXIT_PLAN_MODE_TOOL,
]);

/** Outcome of asking the user to leave plan mode. */
export interface PlanExitDecision {
  /** True only on an explicit approval; the host must have flipped the mode off. */
  approved: boolean;
  /** Freeform text the user typed instead of approving (their revision request). */
  feedback?: string;
  /** No human answered (headless run, or the prompt was dismissed). */
  cancelled?: boolean;
}

/**
 * Host bridge for the plan-mode tools. The tools own the model-facing contract
 * (when to call, what the result text says); the host owns the permission mode
 * itself and every pixel of user-facing UI — so all copy shown to a human, and
 * the decision of what mode to return to, lives behind `requestExit`/`enter`.
 */
export interface PlanModeDeps {
  /** Whether plan mode is currently on. */
  isActive(): boolean;
  /** Turn plan mode on. Called only when `isActive()` is false. */
  enter(): void;
  /**
   * Present `plan` to the user and ask whether to leave plan mode and implement
   * it. MUST turn plan mode off itself iff it returns `approved: true` — the
   * tool never flips the mode on the exit path, so a host that prompts
   * asynchronously cannot leave the two out of sync.
   *
   * A decline with no `feedback` — and likewise a `cancelled` prompt — means
   * "stop, I'll say what's next": the tool tells the model to wait rather than
   * re-plan, and an interactive host is expected to end the turn outright
   * instead of trusting that instruction.
   */
  requestExit(plan: string): Promise<PlanExitDecision>;
}

// Deliberately NOT `.strict()`, unlike every other builtin: this tool takes no
// arguments, so its wire schema is an empty `properties` object, and a model
// that fills the void anyway (`{"reason": "..."}`, `{"input": {}}`) would have
// a correct call rejected on a key that carries no meaning either way. Strict
// mode earns its keep where an unexpected key signals a misread argument; here
// there is no argument to misread, and the cost of refusing is a wasted turn.
// Unknown keys are stripped by zod's default behavior.
const enterInputSchema = z.object({});

const exitInputSchema = z
  .object({
    plan: z
      .string()
      // `.trim()` before `.min(1)`: a whitespace-only plan passes a bare
      // `.min(1)` and then renders as nothing, which puts the user in front of
      // an approval prompt for a plan they cannot see. Rejecting it here tells
      // the model instead.
      .trim()
      .min(1)
      .describe(
        "The complete plan, as markdown: the concrete steps you will take, " +
          "which files you will change, and in what order. This is what the " +
          "user reads before approving — do not send a placeholder or a summary " +
          "of work already done.",
      ),
  })
  .strict();

function enterPlanModeTool(deps: PlanModeDeps): ToolHandler {
  return {
    definition: {
      name: ENTER_PLAN_MODE_TOOL,
      description:
        "Switch this session into plan mode (read-only) before investigating a task you should " +
        "not start changing yet. While plan mode is on, the write, edit, bash, and monitor tools " +
        "are DENIED; read, glob, grep, lsp, and the todo tools keep working. Use it when the user " +
        "asks how you would do something, asks for a plan/approach/design, or when the change is " +
        "large or risky enough that you should agree on an approach before touching files. Do NOT " +
        "use it for work the user already told you to just do. When the plan is ready, call " +
        `${EXIT_PLAN_MODE_TOOL} to ask the user to approve it.`,
      inputSchema: enterInputSchema,
    },
    async run(rawInput) {
      enterInputSchema.parse(rawInput);
      if (deps.isActive()) {
        return { output: "Plan mode is already on. Keep investigating and draft the plan." };
      }
      deps.enter();
      return {
        output:
          "Plan mode is ON (read-only): calls to write, edit, bash, and monitor will be denied " +
          "until it is turned off. Investigate the relevant code, then present a concrete " +
          `step-by-step plan and call ${EXIT_PLAN_MODE_TOOL} to ask the user to approve it.`,
      };
    },
  };
}

function exitPlanModeTool(deps: PlanModeDeps): ToolHandler {
  return {
    definition: {
      name: EXIT_PLAN_MODE_TOOL,
      description:
        "Ask the user to approve your plan and leave plan mode so you can implement it. Call this " +
        "ONLY when plan mode is on and the plan is complete — it is a request for approval, not a " +
        "way to grant yourself write access. The user sees the plan and answers: on approval plan " +
        "mode turns off and you may start implementing; if they decline with feedback, plan mode " +
        "stays on and you revise from that feedback and ask again; if they decline without " +
        "feedback, stop and wait for their next message. This is also the FIRST thing to call " +
        "when the user tells you to go ahead and implement while plan mode is still on: their " +
        "approval does not lift the mode by itself, so starting with a write, edit, or bash just " +
        "gets denied.",
      inputSchema: exitInputSchema,
    },
    async run(rawInput) {
      const input = exitInputSchema.parse(rawInput);
      if (!deps.isActive()) {
        return {
          output:
            "Plan mode is not on, so there is nothing to exit — the write, edit, and bash tools " +
            "are already available. Proceed with the work directly.",
          isError: true,
        };
      }
      const decision = await deps.requestExit(input.plan);
      if (decision.approved) {
        return {
          output:
            "The user approved the plan. Plan mode is OFF — the write, edit, bash, and monitor " +
            "tools are enabled again. Start implementing the plan you just presented.",
        };
      }
      if (decision.cancelled) {
        return {
          output:
            "No answer — plan mode is still ON and every write, edit, bash, and monitor call will " +
            "be denied. Stop here and wait for the user's next message: do not retry this tool, " +
            "guess an approval, or start implementing. The decision is theirs to give when they " +
            "are ready.",
          isError: true,
        };
      }
      const feedback = decision.feedback?.trim();
      if (!feedback) {
        // Declining without a word is the user taking the wheel, not a request
        // for another draft: they have not said what is wrong, so a rewrite
        // would be a guess. The host ends the turn here, but say so anyway —
        // this result is what the model reads at the START of the next turn,
        // and it must not resume by re-planning or re-asking on its own.
        return {
          output:
            "The user did NOT approve the plan and gave no feedback; plan mode stays ON. Stop " +
            "here and wait for their next message — do not revise the plan, call this tool " +
            "again, or start implementing.",
        };
      }
      return {
        output:
          `The user did NOT approve the plan; plan mode stays ON. Their feedback: ${feedback}` +
          " Revise the plan accordingly (still read-only) and ask again when it addresses the " +
          "feedback — do not start implementing.",
      };
    },
  };
}

/**
 * The agent-driven plan-mode pair: `enterPlanMode` (restricts this session to
 * read-only) and `exitPlanMode` (asks the user to approve the plan and lift the
 * restriction). Entering needs no confirmation because it only ever removes
 * capability; leaving always goes through `deps.requestExit`, so the model can
 * never grant itself write access on its own.
 */
export function createPlanModeTools(deps: PlanModeDeps): ToolHandler[] {
  return [enterPlanModeTool(deps), exitPlanModeTool(deps)];
}
