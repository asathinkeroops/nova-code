import { z } from "zod";
import type { ToolHandler } from "@nova/core";
import type { CronStore } from "./store.js";

const inputSchema = z
  .object({
    id: z.string().min(1).describe("Id of the schedule to delete (from cronList / cronCreate)."),
  })
  .strict();

export function deleteCronTool(store: CronStore): ToolHandler {
  return {
    definition: {
      name: "cronDelete",
      description:
        "Delete a scheduled entry by id, cancelling its future runs. Returns a confirmation, " +
        "or an error if no schedule has that id.",
      inputSchema,
    },
    async run(rawInput) {
      const input = inputSchema.parse(rawInput);
      try {
        const removed = await store.delete(input.id);
        if (!removed) {
          return { output: `cronDelete failed: no schedule with id ${input.id}`, isError: true };
        }
        return { output: `deleted schedule ${input.id}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `cronDelete failed: ${msg}`, isError: true };
      }
    },
  };
}
