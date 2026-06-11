// Symbiote — Tool type definitions

export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: Record<string, unknown>;
  properties?: Record<string, ToolParameter>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (input: Record<string, unknown>, opts?: ToolExecuteOptions) => Promise<string>;
}

export interface ToolExecuteOptions {
  sessionId?: string;
  onProgress?: (chunk: string) => void;
}
