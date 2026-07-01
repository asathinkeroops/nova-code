import type { ToolDefinition, ToolHandler } from "@nova/core";

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): this {
    if (this.handlers.has(handler.definition.name)) {
      throw new Error(`Tool already registered: ${handler.definition.name}`);
    }
    this.handlers.set(handler.definition.name, handler);
    return this;
  }

  registerAll(handlers: ToolHandler[]): this {
    for (const h of handlers) this.register(h);
    return this;
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** Remove a registered tool by name. Returns true if one was present. */
  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  list(): ToolHandler[] {
    return Array.from(this.handlers.values());
  }

  definitions(): ToolDefinition[] {
    return this.list().map((h) => h.definition);
  }
}
