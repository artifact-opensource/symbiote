import type { ToolDefinition } from '../types.js';

export const registerTool: ToolDefinition = {
  name: 'register',
  description: 'Register a new tool definition into the tool registry at runtime.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool name.' },
      description: { type: 'string', description: 'Tool description.' },
    },
    required: ['name', 'description'],
  },
  idempotency: {
    class: 'irreversible',
    irreversibleReason: 'Tool registration modifies the runtime tool registry. Once registered, a tool definition persists for the lifetime of the daemon process and cannot be unregistered without restart.',
    idempotencyKey: (input) => `register:${String(input.name ?? '')}`,
  },
  async execute(input) {
    return `Tool registration placeholder: ${input.name}`;
  },
};
