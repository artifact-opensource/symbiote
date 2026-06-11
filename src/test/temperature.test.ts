// Symbiote — ATM (Adaptive Temperature Modulation) Tests
// Heuristic classifier + temperature resolution tests

import { classifyTask, getTemperature, DEFAULT_TEMP_PROFILE } from '../agent/temperature.js';
import type { TaskCategory, TemperatureConfig } from '../agent/temperature.js';
import type { Message } from '../providers/types.js';

// ─── Test Helpers ───

let passed = 0;
let failed = 0;

function msg(role: 'user' | 'assistant' | 'system', content: string): Message {
  return { role, content };
}

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Classifier Tests: Keyword-based ───

console.log('\n🔬 ATM Classifier — Keyword-based Classification\n');

// Code generation
assertEqual(
  classifyTask([msg('user', 'Write a Python function that sorts a list')]),
  'code_generation',
  'code_generation: "Write a Python function..."',
);

assertEqual(
  classifyTask([msg('user', 'Create a TypeScript class for handling WebSocket connections')]),
  'code_generation',
  'code_generation: "Create a TypeScript class..."',
);

assertEqual(
  classifyTask([msg('user', 'Implement the login handler')]),
  'code_generation',
  'code_generation: "Implement the login handler"',
);

assertEqual(
  classifyTask([msg('user', 'Build a function that validates email addresses')]),
  'code_generation',
  'code_generation: "Build a function..."',
);

// Code review
assertEqual(
  classifyTask([msg('user', 'Review this code for bugs')]),
  'code_review',
  'code_review: "Review this code..."',
);

assertEqual(
  classifyTask([msg('user', 'Debug this function')]),
  'code_review',
  'code_review: "Debug this function"',
);

assertEqual(
  classifyTask([msg('user', 'What\'s wrong with this code?')]),
  'code_review',
  'code_review: "What\'s wrong with..."',
);

assertEqual(
  classifyTask([msg('user', 'Refactor the authentication module')]),
  'code_review',
  'code_review: "Refactor..."',
);

// Creative writing
assertEqual(
  classifyTask([msg('user', 'Write an article about AI consciousness')]),
  'creative_writing',
  'creative_writing: "Write an article..."',
);

assertEqual(
  classifyTask([msg('user', 'Draft a blog post about distributed systems')]),
  'creative_writing',
  'creative_writing: "Draft a blog post..."',
);

assertEqual(
  classifyTask([msg('user', 'Come up with a name for the project')]),
  'creative_writing',
  'creative_writing: "Come up with a name..."',
);

// Analysis
assertEqual(
  classifyTask([msg('user', 'Analyze the performance data from the benchmark')]),
  'analysis',
  'analysis: "Analyze the performance data..."',
);

assertEqual(
  classifyTask([msg('user', 'Calculate the total cost of running 3 servers for a year')]),
  'analysis',
  'analysis: "Calculate the total cost..."',
);

assertEqual(
  classifyTask([msg('user', 'Compare the benchmark results')]),
  'analysis',
  'analysis: "Compare the benchmark results"',
);

// Planning
assertEqual(
  classifyTask([msg('user', 'Design the system architecture for our new API')]),
  'planning',
  'planning: "Design the system architecture..."',
);

assertEqual(
  classifyTask([msg('user', 'Create a roadmap for Q3')]),
  'planning',
  'planning: "Create a roadmap..."',
);

assertEqual(
  classifyTask([msg('user', 'How should we structure the microservices?')]),
  'planning',
  'planning: "How should we structure..."',
);

// Search/Research
assertEqual(
  classifyTask([msg('user', 'Search for information about WebSocket protocols')]),
  'search_research',
  'search_research: "Search for information..."',
);

assertEqual(
  classifyTask([msg('user', 'What is the difference between TCP and UDP?')]),
  'search_research',
  'search_research: "What is..."',
);

assertEqual(
  classifyTask([msg('user', 'Tell me about Kubernetes networking')]),
  'search_research',
  'search_research: "Tell me about..."',
);

// System ops
assertEqual(
  classifyTask([msg('user', 'Run the command npm install')]),
  'system_ops',
  'system_ops: "Run the command..."',
);

assertEqual(
  classifyTask([msg('user', 'Deploy the service to production')]),
  'system_ops',
  'system_ops: "Deploy the service..."',
);

assertEqual(
  classifyTask([msg('user', 'Check the status of the nginx service')]),
  'system_ops',
  'system_ops: "Check the status..."',
);

assertEqual(
  classifyTask([msg('user', 'git push origin main')]),
  'system_ops',
  'system_ops: "git push..."',
);

// Conversation
assertEqual(
  classifyTask([msg('user', 'What do you think about the new design?')]),
  'conversation',
  'conversation: "What do you think..."',
);

assertEqual(
  classifyTask([msg('user', 'Hey, how are you doing today?')]),
  'conversation',
  'conversation: "Hey, how are you..."',
);

assertEqual(
  classifyTask([msg('user', 'Thanks for the help!')]),
  'conversation',
  'conversation: "Thanks..."',
);

// Unknown fallback
assertEqual(
  classifyTask([msg('user', 'xyzzy plugh')]),
  'unknown',
  'unknown: gibberish text → fallback',
);

assertEqual(
  classifyTask([]),
  'unknown',
  'unknown: empty messages → fallback',
);

// ─── Classifier Tests: Tool-based ───

console.log('\n🔬 ATM Classifier — Tool-based Classification\n');

assertEqual(
  classifyTask([msg('user', 'Do the thing')], ['exec', 'read']),
  'system_ops',
  'tool-based: exec + read → system_ops',
);

assertEqual(
  classifyTask([msg('user', 'Find out about that')], ['web_fetch']),
  'search_research',
  'tool-based: web_fetch → search_research',
);

assertEqual(
  classifyTask([msg('user', 'Search memory')], ['memory_search', 'memory_search']),
  'search_research',
  'tool-based: memory_search × 2 → search_research',
);

assertEqual(
  classifyTask([msg('user', 'Talk to them')], ['message']),
  'conversation',
  'tool-based: message → conversation',
);

assertEqual(
  classifyTask([msg('user', 'Create the agent')], ['spawn']),
  'planning',
  'tool-based: spawn → planning',
);

// Tool-based takes priority over keywords
assertEqual(
  classifyTask([msg('user', 'Write a Python function that sorts')], ['exec', 'write']),
  'system_ops',
  'tool-based priority: keyword=code_gen but tools=system_ops → system_ops wins',
);

// ─── Temperature Resolution Tests ───

console.log('\n🔬 ATM Temperature Resolution\n');

const enabledConfig: TemperatureConfig = { enabled: true };
const disabledConfig: TemperatureConfig = { enabled: false, defaultTemp: 0.7 };
const customConfig: TemperatureConfig = {
  enabled: true,
  profile: { code_generation: 0.1, creative_writing: 0.95 },
};

// Default profile when enabled
assertEqual(
  getTemperature('code_generation', enabledConfig),
  DEFAULT_TEMP_PROFILE.code_generation,
  'enabled, no override: code_generation → 0.3',
);

assertEqual(
  getTemperature('creative_writing', enabledConfig),
  DEFAULT_TEMP_PROFILE.creative_writing,
  'enabled, no override: creative_writing → 0.8',
);

assertEqual(
  getTemperature('system_ops', enabledConfig),
  DEFAULT_TEMP_PROFILE.system_ops,
  'enabled, no override: system_ops → 0.15',
);

// Disabled — returns defaultTemp
assertEqual(
  getTemperature('code_generation', disabledConfig),
  0.7,
  'disabled: returns defaultTemp (0.7)',
);

assertEqual(
  getTemperature('creative_writing', disabledConfig),
  0.7,
  'disabled: returns defaultTemp regardless of category',
);

// Custom profile overrides
assertEqual(
  getTemperature('code_generation', customConfig),
  0.1,
  'custom profile: code_generation → 0.1 (overridden)',
);

assertEqual(
  getTemperature('creative_writing', customConfig),
  0.95,
  'custom profile: creative_writing → 0.95 (overridden)',
);

assertEqual(
  getTemperature('conversation', customConfig),
  DEFAULT_TEMP_PROFILE.conversation,
  'custom profile: conversation → 0.6 (not overridden, uses default)',
);

// Clamping
const extremeConfig: TemperatureConfig = {
  enabled: true,
  profile: { code_generation: -0.5, creative_writing: 5.0 },
};

assertEqual(
  getTemperature('code_generation', extremeConfig),
  0,
  'clamping: negative → 0',
);

assertEqual(
  getTemperature('creative_writing', extremeConfig),
  2,
  'clamping: >2 → 2',
);

// Disabled with no defaultTemp
const disabledNoDefault: TemperatureConfig = { enabled: false };
assertEqual(
  getTemperature('code_generation', disabledNoDefault),
  DEFAULT_TEMP_PROFILE.unknown,
  'disabled, no defaultTemp: falls back to unknown profile (0.5)',
);

// ─── Edge Cases ───

console.log('\n🔬 ATM Edge Cases\n');

// System warning messages should be skipped
assertEqual(
  classifyTask([
    msg('user', 'Write a Python function'),
    msg('assistant', 'Sure...'),
    msg('user', '⚠️ SYSTEM WARNING: Iteration budget low'),
  ]),
  'code_generation',
  'edge: system warnings skipped, finds real user message',
);

// Multiple user messages — uses last real one
assertEqual(
  classifyTask([
    msg('user', 'Write a Python function'),
    msg('assistant', 'Here it is...'),
    msg('user', 'Thanks!'),
  ]),
  'conversation',
  'edge: multiple user msgs → uses last one',
);

// Only system messages
assertEqual(
  classifyTask([msg('system', 'You are an assistant')]),
  'unknown',
  'edge: only system messages → unknown',
);

// ─── Summary ───

console.log(`\n${'─'.repeat(50)}`);
console.log(`ATM Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED');
}
