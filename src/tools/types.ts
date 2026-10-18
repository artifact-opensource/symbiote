// Symbiote — Tool type definitions

export const DEFAULT_EXEC_TIMEOUT_SECONDS = 5;

export function resolveExecTimeoutMs(timeout: unknown): number {
  if (timeout === undefined) return DEFAULT_EXEC_TIMEOUT_SECONDS * 1000;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('timeout must be a positive number of seconds.');
  }
  return timeout * 1000;
}

export type IdempotencyClass = 'read' | 'reversible_local' | 'external' | 'irreversible';

export interface IdempotencyData {
  class: IdempotencyClass;
  /** For reversible_local: description of how to reverse */
  reverseDescription?: string;
  /** For external: the external system being called */
  externalSystem?: string;
  /** For irreversible: what makes this irreversible */
  irreversibleReason?: string;
  /** Optional: custom idempotency key generator */
  idempotencyKey?: (input: Record<string, unknown>) => string;
}

export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean | string[];
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  additionalProperties?: boolean | ToolParameter;
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
  executeWithImages?: (input: Record<string, unknown>, opts?: ToolExecuteOptions) => Promise<ToolExecutionOutput>;
  idempotency?: IdempotencyData;
}

export interface ToolImage {
  mimeType: string;
  dataBase64: string;
}

export interface ToolExecutionOutput {
  text: string;
  images?: ToolImage[];
  isError?: boolean;
}

export interface ToolExecuteOptions {
  sessionId?: string;
  sessionTier?: 'admin' | 'standard' | 'restricted';
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
  googleWorkspaceAccessToken?: string;
}
