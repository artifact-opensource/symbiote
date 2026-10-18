import type { CuaDriverLike } from '@trycua/cua-driver';
import type { ToolDefinition, ToolImage, ToolParameter } from '../types.js';

interface NativeActionSchema {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface NativeToolInventory {
  tools?: NativeActionSchema[];
}

type ComputerUseDriver = Pick<CuaDriverLike, 'callTool' | 'isAvailable'>;

export interface ComputerUseRuntimeState {
  driver: ComputerUseDriver | null;
  actions: ReadonlySet<string>;
  error: string | null;
}

let driver: CuaDriverLike | null = null;
let initializationError: string | null = null;
let nativeActions = new Set<string>();
const baseDescription = 'Control the host desktop through the native, model-agnostic CUA Driver runtime. Screenshots are sent to the configured model for visual reasoning and are not saved in conversation history. Requires an admin session.';

function actionSummary(tool: NativeActionSchema): string {
  const schema = tool.inputSchema as {
    required?: string[];
  } | undefined;
  return `${tool.name}(${(schema?.required ?? []).join(',')})`;
}

function toToolParameter(value: unknown): ToolParameter {
  const schema = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const parameter: ToolParameter = {
    type: typeof schema.type === 'string' ? schema.type : 'object',
  };
  if (typeof schema.description === 'string') parameter.description = schema.description.slice(0, 120);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((item): item is string => typeof item === 'string');
    if (values.length === schema.enum.length) parameter.enum = values;
  }
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((item): item is string => typeof item === 'string');
    if (required.length === schema.required.length) parameter.required = required;
  }
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    parameter.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, toToolParameter(child)]),
    );
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    parameter.items = toToolParameter(schema.items);
  }
  if (typeof schema.additionalProperties === 'boolean') {
    parameter.additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    parameter.additionalProperties = toToolParameter(schema.additionalProperties);
  }
  return parameter;
}

const actionParameter = {
  type: 'string',
  description: 'Native CUA Driver action name. Use status to check runtime availability.',
  enum: ['status'],
};
const argumentsParameter: ToolParameter = {
  type: 'object',
  description: 'Input fields for the selected native action; * marks required fields in the action catalog.',
};

async function executeComputerUse(input: Record<string, unknown>, options: Parameters<ToolDefinition['execute']>[1], runtime: ComputerUseRuntimeState): Promise<string | { text: string; images: ToolImage[]; isError: boolean }> {
  const action = typeof input.action === 'string' ? input.action : '';
  if (action === 'status') {
    return JSON.stringify({
      available: runtime.driver?.isAvailable() ?? false,
      actions: runtime.actions.size,
      error: runtime.error,
    });
  }
  if (!runtime.driver?.isAvailable()) {
    return JSON.stringify({
      error: runtime.error ?? 'Native desktop-control runtime is not initialized.',
      is_error: true,
    });
  }
  if (!runtime.actions.has(action)) {
    return JSON.stringify({ error: `Unsupported native desktop action: ${action}`, is_error: true });
  }
  const args = input.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return JSON.stringify({ error: 'The arguments field must be an object.', is_error: true });
  }

  const result = await runtime.driver.callTool(action, JSON.stringify(args), options?.signal ? { signal: options.signal } : undefined);
  const images: ToolImage[] = result.images.map(image => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) {
      throw new Error(`Unsupported screenshot MIME type from desktop driver: ${image.mimeType}`);
    }
    const data = Buffer.from(image.dataBase64, 'base64');
    if (!data.length || data.length > 10 * 1024 * 1024) {
      throw new Error('Desktop screenshot is empty or exceeds the 10 MiB image limit.');
    }
    return { mimeType: image.mimeType, dataBase64: image.dataBase64 };
  });
  return { text: result.text, images, isError: result.isError };
}

export function createComputerUseTool(getRuntime: () => ComputerUseRuntimeState): ToolDefinition {
  return {
    name: 'computer_use',
    description: baseDescription,
    parameters: {
      type: 'object',
      properties: {
        action: actionParameter,
        arguments: argumentsParameter,
      },
      required: ['action', 'arguments'],
    },
    execute: async (input, options) => {
      const output = await executeComputerUse(input, options, getRuntime());
      return typeof output === 'string' ? output : output.text;
    },
    executeWithImages: async (input, options) => {
      const output = await executeComputerUse(input, options, getRuntime());
      return typeof output === 'string' ? { text: output } : output;
    },
  };
}

export const computerUseTool = createComputerUseTool(() => ({
  driver,
  actions: nativeActions,
  error: initializationError,
}));

export async function initializeComputerUseRuntime(): Promise<boolean> {
  driver = null;
  nativeActions.clear();
  initializationError = null;
  actionParameter.enum = ['status'];
  computerUseTool.description = baseDescription;
  try {
    const { CuaDriver } = await import('@trycua/cua-driver');
    const instance = CuaDriver.create({ embedded: true, claudeCodeCompatibility: false });
    if (!instance.isAvailable()) {
      throw new Error(`The native CUA Driver runtime is unavailable on ${process.platform}.`);
    }
    const inventory = JSON.parse(await instance.listToolsJson()) as NativeToolInventory;
    const tools = inventory.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error('The native CUA Driver returned an empty action catalog.');
    }
    driver = instance;
    nativeActions = new Set(tools.map(tool => tool.name));
    initializationError = null;
    actionParameter.enum = ['status', ...nativeActions];
    const argumentProperties: Record<string, ToolParameter> = {};
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      } | undefined;
      const required = new Set(schema?.required ?? []);
      for (const [name, field] of Object.entries(schema?.properties ?? {})) {
        if (!argumentProperties[name]) {
          const parameter = toToolParameter(field);
          parameter.description = `${required.has(name) ? 'Required for ' : 'Used by '}${tool.name}. ${parameter.description ?? ''}`.slice(0, 200);
          argumentProperties[name] = parameter;
        }
      }
    }
    argumentsParameter.properties = argumentProperties;
    computerUseTool.description = `${baseDescription} Supply the chosen action's fields inside arguments. Native action catalog (* marks required fields): ${tools.map(actionSummary).join('; ')}`;
    return true;
  } catch (error) {
    driver = null;
    initializationError = error instanceof Error ? error.message : String(error);
    console.error(`[computer-use] Native desktop-control initialization failed: ${initializationError}`);
    return false;
  }
}

export function shutdownComputerUseRuntime(): void {
  driver = null;
  nativeActions.clear();
  actionParameter.enum = ['status'];
  argumentsParameter.properties = undefined;
  computerUseTool.description = baseDescription;
}
