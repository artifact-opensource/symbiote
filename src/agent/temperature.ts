// Symbiote — Adaptive Temperature Modulation (ATM)
// Heuristic-based task classification → dynamic per-iteration temperature control

import type { Message } from '../providers/types.js';

// ─── Task Categories ───

export type TaskCategory =
  | 'code_generation'    // Writing code, scripts → low temp (0.2-0.4)
  | 'code_review'        // Reviewing, auditing code → low temp (0.1-0.3)
  | 'analysis'           // Data analysis, math, logic → low temp (0.2-0.3)
  | 'creative_writing'   // Articles, stories, naming → high temp (0.7-0.9)
  | 'conversation'       // Chat, discussion → medium temp (0.5-0.7)
  | 'search_research'    // Looking up info, research → medium-low (0.3-0.5)
  | 'system_ops'         // File ops, shell commands → very low (0.1-0.2)
  | 'planning'           // Strategy, architecture → medium (0.5-0.6)
  | 'unknown';           // Default fallback → use config default

// ─── Default Temperature Profile ───

export const DEFAULT_TEMP_PROFILE: Record<TaskCategory, number> = {
  code_generation: 0.3,
  code_review: 0.2,
  analysis: 0.25,
  creative_writing: 0.8,
  conversation: 0.6,
  search_research: 0.4,
  system_ops: 0.15,
  planning: 0.55,
  unknown: 0.5,
};

// ─── Configuration ───

export interface TemperatureConfig {
  enabled: boolean;
  profile?: Partial<Record<TaskCategory, number>>;
  defaultTemp?: number;    // Fallback when ATM is disabled
  logChanges?: boolean;    // Log temperature adjustments to console
}

// ─── Keyword Patterns ───
// Each category has a set of regex patterns matched against the last user message.
// Ordered by specificity: more specific patterns first.

const KEYWORD_PATTERNS: Array<{ category: TaskCategory; patterns: RegExp[] }> = [
  {
    category: 'code_review',
    patterns: [
      /\breview\b.*\bcode\b/i,
      /\baudit\b.*\bcode\b/i,
      /\bcheck\b.*\bcode\b/i,
      /\bcode\b.*\breview\b/i,
      /\bfind\b.*\bbug/i,
      /\bdebug\b/i,
      /\bwhat('s|\sis)\s+wrong\b/i,
      /\bfix\b.*\b(error|bug|issue)/i,
      /\blook\s+at\b.*\bcode\b/i,
      /\brefactor\b/i,
    ],
  },
  {
    category: 'code_generation',
    patterns: [
      /\bwrite\b.*\b(function|class|method|script|code|program|module|component|handler|endpoint|api|test|spec)\b/i,
      /\bcreate\b.*\b(function|class|method|script|code|program|module|component|handler|endpoint|api|test|spec)\b/i,
      /\bimplement\b/i,
      /\bbuild\b.*\b(function|class|method|script|code|program|module|component|feature)\b/i,
      /\bgenerate\b.*\b(code|function|class|script)\b/i,
      /\badd\b.*\b(function|method|endpoint|feature|handler)\b/i,
      /\bcode\b.*\bthat\b/i,
      /```[\s\S]*```/,  // Code blocks in the message
      /\bpython\b.*\bfunction\b/i,
      /\btypescript\b.*\b(function|class|interface)\b/i,
      /\bjavascript\b.*\b(function|class)\b/i,
    ],
  },
  {
    category: 'creative_writing',
    patterns: [
      /\bwrite\b.*\b(article|essay|story|blog|post|poem|narrative|chapter|letter|email draft)\b/i,
      /\bdraft\b.*\b(article|essay|story|blog|post)\b/i,
      /\bcompose\b/i,
      /\bcreative\b/i,
      /\bbrainstorm\b.*\bname/i,
      /\bcome\s+up\s+with\b.*\bname/i,
      /\bname\b.*\b(project|product|feature|brand)\b/i,
      /\btagline\b/i,
      /\bslogan\b/i,
    ],
  },
  {
    category: 'analysis',
    patterns: [
      /\banalyze\b/i,
      /\banalysis\b/i,
      /\bcalculate\b/i,
      /\bcompute\b/i,
      /\bcompare\b.*\b(data|metrics|results|numbers|performance)\b/i,
      /\bstatistic/i,
      /\bmath\b/i,
      /\bformula\b/i,
      /\bequation\b/i,
      /\bprove\b/i,
      /\bderive\b/i,
      /\bbenchmark\b/i,
      /\bperformance\b.*\b(test|metric|data)\b/i,
    ],
  },
  {
    category: 'planning',
    patterns: [
      /\bplan\b/i,
      /\bstrateg/i,
      /\barchitect/i,
      /\bdesign\b.*\b(system|architecture|schema|database|api)\b/i,
      /\broadmap\b/i,
      /\bproposal\b/i,
      /\bscope\b/i,
      /\bbreakdown\b/i,
      /\btask\s+list\b/i,
      /\bproject\s+plan\b/i,
      /\bhow\s+should\s+(we|i)\b.*\b(build|structure|organize|approach)\b/i,
    ],
  },
  {
    category: 'search_research',
    patterns: [
      /\bsearch\b/i,
      /\bresearch\b/i,
      /\blook\s+up\b/i,
      /\bfind\b.*\b(information|info|docs|documentation|examples)\b/i,
      /\bwhat\s+is\b/i,
      /\bwho\s+is\b/i,
      /\bhow\s+does\b/i,
      /\bexplain\b.*\b(how|what|why)\b/i,
      /\btell\s+me\s+about\b/i,
    ],
  },
  {
    category: 'system_ops',
    patterns: [
      /\brun\b.*\b(command|script|shell)\b/i,
      /\bexecute\b/i,
      /\binstall\b/i,
      /\bdeploy\b/i,
      /\brestart\b/i,
      /\bkill\b.*\b(process|service)\b/i,
      /\bcheck\b.*\b(status|logs?|disk|memory|cpu)\b/i,
      /\blist\b.*\b(files?|directories|processes)\b/i,
      /\bmove\b.*\bfiles?\b/i,
      /\bcopy\b.*\bfiles?\b/i,
      /\bdelete\b.*\bfiles?\b/i,
      /\bchmod\b/i,
      /\bchown\b/i,
      /\bsudo\b/i,
      /\bgit\b.*\b(push|pull|commit|merge|rebase|checkout)\b/i,
      /\bnpm\b.*\b(install|build|publish|run)\b/i,
    ],
  },
  {
    category: 'conversation',
    patterns: [
      /\bwhat\s+do\s+you\s+think\b/i,
      /\bhow\s+are\s+you\b/i,
      /\bthanks?\b/i,
      /\bhi\b/i,
      /\bhello\b/i,
      /\bhey\b/i,
      /\bopinion\b/i,
      /\bthoughts?\b/i,
      /\bfeel\b/i,
      /\bagree\b/i,
      /\bdisagree\b/i,
    ],
  },
];

// ─── Tool-based Classification ───
// Maps tool names to task categories. When recent tool calls are present,
// they provide strong signal about what the agent is doing.

const TOOL_CATEGORY_MAP: Record<string, TaskCategory> = {
  // System ops tools
  'exec': 'system_ops',
  'process_start': 'system_ops',
  'process_poll': 'system_ops',
  'process_kill': 'system_ops',
  'process_list': 'system_ops',

  // File ops → system_ops (unless writing code, but tool signal is coarser)
  'read': 'system_ops',
  'write': 'system_ops',
  'edit': 'system_ops',

  // Research tools
  'web_fetch': 'search_research',
  'memory_search': 'search_research',

  // Memory tools
  'comb_recall': 'search_research',
  'comb_stage': 'system_ops',

  // Creative/media
  'tts': 'creative_writing',
  'image': 'analysis',

  // Communication
  'message': 'conversation',
  'typing': 'conversation',
  'presence': 'conversation',

  // Sub-agents
  'spawn': 'planning',
  'subagent_status': 'system_ops',
};

// ─── Classifier ───

/**
 * Classify the current task based on conversation messages and recent tool calls.
 * Uses heuristic keyword matching + tool-call-based inference. No LLM calls.
 *
 * Priority:
 *   1. Recent tool calls (strong signal — what the agent just DID)
 *   2. Last user message keywords (what the user ASKED for)
 *   3. 'unknown' fallback
 */
export function classifyTask(
  messages: Message[],
  recentToolCalls: string[] = [],
): TaskCategory {
  // Strategy 1: Tool-call-based classification (strongest signal)
  if (recentToolCalls.length > 0) {
    const toolCategories = recentToolCalls
      .map(tool => TOOL_CATEGORY_MAP[tool])
      .filter((c): c is TaskCategory => c !== undefined);

    if (toolCategories.length > 0) {
      // Count category frequency from recent tools
      const counts = new Map<TaskCategory, number>();
      for (const cat of toolCategories) {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }

      // Return the most frequent category
      let best: TaskCategory = toolCategories[0];
      let bestCount = 0;
      for (const [cat, count] of counts) {
        if (count > bestCount) {
          best = cat;
          bestCount = count;
        }
      }
      return best;
    }
  }

  // Strategy 2: Keyword matching on last user message
  const lastUserMsg = findLastUserMessage(messages);
  if (lastUserMsg) {
    const text = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : lastUserMsg.content
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join(' ');

    for (const { category, patterns } of KEYWORD_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return category;
        }
      }
    }
  }

  // Strategy 3: Fallback
  return 'unknown';
}

/**
 * Get the temperature for a given task category.
 * Merges default profile with user overrides.
 */
export function getTemperature(
  category: TaskCategory,
  config: TemperatureConfig,
): number {
  if (!config.enabled) {
    return config.defaultTemp ?? DEFAULT_TEMP_PROFILE.unknown;
  }

  // Merge default profile with user overrides
  const temp = config.profile?.[category] ?? DEFAULT_TEMP_PROFILE[category];

  // Clamp to valid range
  return Math.max(0, Math.min(2, temp));
}

// ─── Helpers ───

function findLastUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      // Skip system warnings injected by the runner
      const content = messages[i].content;
      if (typeof content === 'string' && content.startsWith('⚠️ SYSTEM WARNING:')) {
        continue;
      }
      return messages[i];
    }
  }
  return undefined;
}
