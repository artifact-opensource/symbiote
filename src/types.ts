export interface Part {
  text: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  timestamp: string;
  isSimulated?: boolean;
  executedTool?: string | null;
  toolResult?: any;
  imageUrl?: string; // Generated images projected inline
}

export interface ChatSession {
  id: string;
  name: string;
  messages: Message[];
  createdAt: number;
  keywords?: string[];
}

export interface SymbiotePlugin {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon name
  active: boolean;
  accent: string; // neon color class
}

export interface SymbioteTelemetry {
  coreCohesion: number;
  thermalLevel: number;
  neuralBandwidth: number;
  connectedSymbionts: number;
  memoryEntropy: number;
  _raw?: {
    timestamp: string;
    hostname: string;
    platform: string;
    cpu: { model: string; cores: number; speed: number; load: { "1min": number; "5min": number; "15min": number; percent: number } };
    memory: { total: number; used: number; free: number; percent: number; process: { rss: number; heapTotal: number; heapUsed: number; external: number } };
    uptime: { system: number; systemFormatted: string; process: number; processFormatted: string };
    network: Record<string, { address: string; family: string; internal: boolean }[]>;
    env: { nodeVersion: string; pid: number; cwd: string };
  };
}
