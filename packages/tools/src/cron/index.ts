import type { ToolHandler } from "@nova/core";
import type { CronStore } from "./store.js";
import { createCronTool } from "./create.js";
import { listCronTool } from "./list.js";
import { deleteCronTool } from "./delete.js";

export { createCronTool, listCronTool, deleteCronTool };

export function createCronTools(store: CronStore): ToolHandler[] {
  return [createCronTool(store), listCronTool(store), deleteCronTool(store)];
}
