import {
  assertAppendOnly,
  type MessageParam,
  type ThinkingLevel,
  type ToolDefinition,
} from "@nova/core";

interface PreRequestPayload {
  system: string;
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  thinkingLevel?: ThinkingLevel;
}

interface PreRequestOverride {
  messages?: MessageParam[];
}

export type PreRequestInjector = (
  payload: PreRequestPayload,
) => PreRequestOverride | undefined | Promise<PreRequestOverride | undefined>;

/**
 * Combine every CLI-side `pre_request` injector into ONE blocking hook.
 *
 * `HookRegistry.runBlocking` is first-non-undefined-wins. With separate hooks,
 * a plan-mode notice on the first request suppresses the skills index, and a
 * model that ends its turn without a tool call never gets another request to
 * receive it — the index would simply be absent for that turn. Combining here
 * lets every injector contribute to the SAME request while preserving the
 * loop's append-only contract: the returned array is the original messages
 * plus each injector's tail additions, never a rewrite.
 *
 * Order is append order, not a winner-take-all priority. Each injector sees the
 * messages the previous ones already added, which is exactly the history the
 * model is about to receive — so a later injector's "can the model already see
 * this?" check stays correct.
 */
export function combinePreRequestInjectors(
  injectors: readonly PreRequestInjector[],
): PreRequestInjector {
  return async (payload) => {
    let current = payload.messages;
    const additions: MessageParam[] = [];

    for (const inject of injectors) {
      const result = await inject({ ...payload, messages: current });
      if (!result?.messages || result.messages === current) continue;
      // Same contract the loop enforces for a pre_request override. Throwing
      // here surfaces the bug at the injector that caused it rather than
      // letting it corrupt the replayable history.
      assertAppendOnly(current, result.messages, "a pre_request injector");
      additions.push(...result.messages.slice(current.length));
      current = result.messages;
    }

    return additions.length > 0 ? { messages: [...payload.messages, ...additions] } : undefined;
  };
}
