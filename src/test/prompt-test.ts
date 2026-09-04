// Quick test: does buildSystemPrompt load workspace .md files?
import { buildSystemPrompt } from '../agent/system-prompt.js';

const prompt = buildSystemPrompt({
  workspace: '/path/to/workspace',
  tools: ['read', 'write', 'exec', 'edit'],
  channel: 'whatsapp',
  chatType: 'direct',
  senderId: '1234567890',
});

console.log(`Prompt length: ${prompt.length} chars`);
console.log('');

// Check for key content from each file
const checks = [
  ['SOUL.md',       'genuinely helpful'],
  ['IDENTITY.md',   'AVA'],
  ['USER.md',       'Ali Shakil'],
  ['AGENTS.md',     'COMB'],
  ['TOOLS.md',      'HEKTOR'],
  ['HEARTBEAT.md',  'HEARTBEAT_OK'],
  ['WORKFLOW_AUTO.md', 'Phoenix'],
  ['Today memory',  '2026-02-22'],
  ['Runtime',       'whatsapp'],
  ['Tools',         'read, write, exec, edit'],
];

for (const [label, needle] of checks) {
  const found = prompt.includes(needle);
  console.log(`${found ? '✅' : '❌'} ${label}: ${found ? 'loaded' : 'MISSING'} (searching: "${needle}")`);
}

console.log(`\n── First 500 chars ──\n${prompt.slice(0, 500)}`);
console.log(`\n── Sections found ──`);
const sections = prompt.match(/^## .+$/gm) ?? [];
sections.forEach(s => console.log(`  ${s}`));
