// Symbiote — Tool registry: register, lookup, dispatch, convert to provider format

import type { ToolDef } from '../providers/types.js';
import type { ToolDefinition, ToolExecuteOptions, ToolExecutionOutput } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Convert all registered tools to provider-format ToolDefs */
  toProviderFormat(): ToolDef[] {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Execute a tool by name */
  async execute(name: string, input: Record<string, unknown>, options?: ToolExecuteOptions): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    try {
      return await tool.execute(input, options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg });
    }
  }

  async executeWithImages(name: string, input: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolExecutionOutput> {
    const tool = this.tools.get(name);
    if (!tool) return { text: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true };
    try {
      if (tool.executeWithImages) return await tool.executeWithImages(input, options);
      return { text: await tool.execute(input, options) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: JSON.stringify({ error: msg }), isError: true };
    }
  }
}

/** Create a registry with all builtin tools pre-registered */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Lazy import to avoid circular deps — tools register themselves
  return registry;
}
