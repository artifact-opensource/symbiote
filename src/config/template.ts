// Symbiote — Canonical symbiote.json template (config version 2).
// Used by the setup wizard and by `symbiote upgrade`, so fresh and upgraded installs share one shape.

export const CONFIG_VERSION = 2;
export const SCHEMA_REF = './symbiote.schema.json';

/** Provider id -> environment variable holding its API key. */
export const PROVIDER_ENV: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
};

export interface TemplateInput {
  name?: string;
  emoji?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  ownerIds?: string[];
  apiHost?: string;
  apiPort?: number;
  webHost?: string;
  webPort?: number;
  discord?: { enabled?: boolean; botId?: string };
  whatsapp?: { enabled?: boolean; phoneNumber?: string; authDir?: string };
}

const envRef = (name: string): string => `\${${name}}`;

/** Build the complete, ordered config with every stub present. */
export function buildConfigTemplate(input: TemplateInput = {}): Record<string, any> {
  const apiHost = input.apiHost ?? '127.0.0.1';
  const webHost = input.webHost ?? '127.0.0.1';
  const apiPort = input.apiPort ?? 3006;
  const webPort = input.webPort ?? 3009;
  const ownerIds = [...new Set((input.ownerIds ?? []).map(String).filter(Boolean))];
  const discordOn = input.discord?.enabled === true;
  const whatsappOn = input.whatsapp?.enabled === true;

  const policy = (senders: string[]) => ({
    dmPolicy: 'allowlist',
    groupPolicy: 'mention-only',
    requireMention: true,
    allowedSenders: senders,
    allowedGroups: [] as string[],
    ownerIds,
  });

  return {
    $schema: SCHEMA_REF,
    configVersion: CONFIG_VERSION,

    name: input.name ?? 'Symbiote',
    emoji: input.emoji ?? '🤖',

    defaultProvider: input.provider ?? 'openrouter',
    defaultModel: input.model ?? 'openrouter/free',
    fallbackProviders: [],
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 8192,
    maxIterations: input.maxIterations ?? 50,
    adaptiveTemperature: { adaptive: false, default: 0.5, logChanges: false },

    workspace: '.',
    sessionsDir: '.sessions',
    ownerIds,

    apiHost,
    apiPort,
    webHost,
    webPort,
    allowedOrigins: [`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`],

    toolProgress: true,
    tools: { enabled: true },
    timeouts: { llmRequestMs: 900_000 },
    heartbeat: {
      activeIntervalMin: 30,
      idleIntervalMin: 120,
      sleepingIntervalMin: 360,
      quietHoursStart: 23,
      quietHoursEnd: 8,
    },

    providers: {
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: envRef(PROVIDER_ENV.openrouter), timeoutMs: 600_000 },
      anthropic: { apiKey: envRef(PROVIDER_ENV.anthropic) },
      openai: { apiKey: envRef(PROVIDER_ENV.openai) },
      gemini: { apiKey: envRef(PROVIDER_ENV.gemini) },
      groq: { baseUrl: 'https://api.groq.com/openai', apiKey: envRef(PROVIDER_ENV.groq) },
      xai: { apiKey: envRef(PROVIDER_ENV.xai) },
      nvidia: { apiKey: envRef(PROVIDER_ENV.nvidia) },
      'github-copilot': {},
      ollama: { baseUrl: 'http://127.0.0.1:11434' },
      gladius: { baseUrl: 'http://127.0.0.1:8741' },
    },

    discord: {
      enabled: discordOn,
      token: envRef('DISCORD_BOT_TOKEN'),
      botId: input.discord?.botId || envRef('DISCORD_CLIENT_ID'),
      policy: policy(ownerIds.filter(id => !id.includes('@'))),
    },
    whatsapp: {
      enabled: whatsappOn,
      authDir: input.whatsapp?.authDir ?? '~/.symbiote/whatsapp-auth',
      ...(input.whatsapp?.phoneNumber ? { phoneNumber: input.whatsapp.phoneNumber } : {}),
      autoRead: true,
      markOnline: true,
      policy: policy(ownerIds.filter(id => id.includes('@'))),
    },

    orchestrator: { enabled: false },
  };
}
