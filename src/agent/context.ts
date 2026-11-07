// Symbiote — Context window management (truncation)

import type { Message, ContentBlock } from '../providers/types.js';

/** Conservative token estimate for mixed prose, code, and structured content. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function messageSize(msg: Message): number {
  const contentSize = typeof msg.content === 'string'
    ? estimateTokens(msg.content)
    : msg.content.reduce((sum, block) => {
      if (block.type === 'image') return sum + 2_048;
      if (block.text) return sum + estimateTokens(block.text);
      if (block.content) return sum + estimateTokens(block.content);
      if (block.input) return sum + estimateTokens(JSON.stringify(block.input));
      return sum + 50;
    }, 0);
  const toolCallsSize = msg.tool_calls?.reduce(
    (sum, call) => sum + estimateTokens(JSON.stringify(call)),
    0,
  ) ?? 0;
  return contentSize + toolCallsSize;
}

// ── Tool pair detection (handles BOTH internal OpenAI-style and Anthropic-native formats) ──

/** Check if message is an assistant requesting tool calls (OpenAI-style: tool_calls array) */
function hasToolCalls(msg: Message): boolean {
  if (msg.role === 'assistant' && msg.tool_calls?.length) return true;
  return false;
}

/** Check if message is a tool result (OpenAI-style: role=tool with tool_call_id) */
function isToolResult(msg: Message): boolean {
  return msg.role === 'tool' && !!msg.tool_call_id;
}

/** Check if a message contains Anthropic-native tool_use blocks */
function hasToolUseBlocks(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b: ContentBlock) => b.type === 'tool_use');
}

/** Check if a message contains Anthropic-native tool_result blocks */
function hasToolResultBlocks(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b: ContentBlock) => b.type === 'tool_result');
}

/** Get tool call IDs from a message (OpenAI-style tool_calls or Anthropic-native tool_use blocks) */
function getToolCallIds(msg: Message): Set<string> {
  const ids = new Set<string>();
  // OpenAI-style
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) ids.add(tc.id);
  }
  // Anthropic-native
  if (typeof msg.content !== 'string') {
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.id) ids.add(b.id);
    }
  }
  return ids;
}

/** Get tool_use_ids referenced by this message (OpenAI-style tool_call_id or Anthropic-native tool_result blocks) */
function getToolResultRefs(msg: Message): Set<string> {
  const ids = new Set<string>();
  // OpenAI-style
  if (msg.tool_call_id) ids.add(msg.tool_call_id);
  // Anthropic-native
  if (typeof msg.content !== 'string') {
    for (const b of msg.content) {
      if (b.type === 'tool_result' && b.tool_use_id) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

/** Check if message is any kind of tool-call-making message */
function isToolCallMsg(msg: Message): boolean {
  return hasToolCalls(msg) || hasToolUseBlocks(msg);
}

/** Check if message is any kind of tool-result message */
function isToolResultMsg(msg: Message): boolean {
  return isToolResult(msg) || hasToolResultBlocks(msg);
}

/**
 * Truncate message history to fit within a token budget.
 * Strategy: keep system prompt + last N messages, drop oldest first.
 * CRITICAL: tool_use/tool_result messages must stay paired.
 */
export function truncateContext(messages: Message[], maxTokens: number): Message[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new RangeError('Context token budget must be a non-negative safe integer.');
  }

  const total = messages.reduce((sum, m) => sum + messageSize(m), 0);
  if (total <= maxTokens) return messages;

  const system = messages.filter(m => m.role === 'system');
  const rest = messages.filter(m => m.role !== 'system');

  let budget = maxTokens - system.reduce((s, m) => s + messageSize(m), 0);
  if (budget < 0) {
    throw new RangeError('System messages exceed the available model context window.');
  }

  // Build keep-set walking from newest to oldest
  const keepFlags = new Array(rest.length).fill(false);
  let latestUserIndex = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].role === 'user') {
      latestUserIndex = i;
      break;
    }
  }

  if (latestUserIndex >= 0) {
    const size = messageSize(rest[latestUserIndex]);
    if (size > budget) {
      rest[latestUserIndex] = fitLatestUserMessage(rest[latestUserIndex], budget);
      budget -= messageSize(rest[latestUserIndex]);
    } else {
      budget -= size;
    }
    keepFlags[latestUserIndex] = true;
  }

  for (let i = rest.length - 1; i >= 0; i--) {
    if (i === latestUserIndex) continue;
    const size = messageSize(rest[i]);
    if (budget - size < 0) break;
    budget -= size;
    keepFlags[i] = true;
  }

  // Integrity pass: ensure tool pairs are complete
  let changed = true;
  while (changed) {
    changed = false;

    for (let i = 0; i < rest.length; i++) {
      if (!keepFlags[i]) continue;

      // If this is a tool result, find its matching tool call (search backward)
      if (isToolResultMsg(rest[i])) {
        const refs = getToolResultRefs(rest[i]);
        for (let j = i - 1; j >= 0; j--) {
          if (isToolCallMsg(rest[j])) {
            const callIds = getToolCallIds(rest[j]);
            if ([...refs].some(r => callIds.has(r))) {
              if (!keepFlags[j]) {
                keepFlags[j] = true;
                budget -= messageSize(rest[j]);
                changed = true;
              }
              break;
            }
          }
        }
      }

      // If this is a tool call, find its matching result (search forward)
      if (isToolCallMsg(rest[i])) {
        const callIds = getToolCallIds(rest[i]);
        // There may be MULTIPLE tool results for one assistant message (parallel calls)
        for (let j = i + 1; j < rest.length; j++) {
          if (isToolResultMsg(rest[j])) {
            const refs = getToolResultRefs(rest[j]);
            if ([...callIds].some(c => refs.has(c))) {
              if (!keepFlags[j]) {
                keepFlags[j] = true;
                budget -= messageSize(rest[j]);
                changed = true;
              }
              // Don't break — there may be more results for this tool call batch
            }
          } else if (rest[j].role === 'assistant') {
            break; // Next assistant turn, stop searching
          }
        }
      }
    }
  }

  // Over budget after pairing — drop oldest complete groups
  if (budget < 0) {
    for (let i = 0; i < rest.length && budget < 0; i++) {
      if (i === latestUserIndex) continue;
      if (!keepFlags[i]) continue;
      if (!wouldOrphan(rest, keepFlags, i)) {
        keepFlags[i] = false;
        budget += messageSize(rest[i]);
      }
    }
  }

  const kept = rest.filter((_, i) => keepFlags[i]);
  if (latestUserIndex >= 0 && !keepFlags[latestUserIndex]) {
    throw new Error('Context trimming unexpectedly discarded the latest user message.');
  }

  // Final safety: strip any leading tool results (orphaned)
  while (kept.length > 0 && isToolResultMsg(kept[0])) {
    kept.shift();
  }

  const result = [...system, ...kept];
  if (result.reduce((sum, message) => sum + messageSize(message), 0) > maxTokens) {
    throw new RangeError('Conversation context cannot fit the model window without dropping the latest user message.');
  }
  return result;
}

function fitLatestUserMessage(message: Message, budget: number): Message {
  if (typeof message.content !== 'string') {
    throw new RangeError('The latest user message contains non-text content that cannot safely fit the model context window.');
  }

  const maxCharacters = budget * 3;
  const marker = '\n[Middle of latest message omitted to fit model context]\n';
  if (maxCharacters <= marker.length) {
    throw new RangeError('The latest user message cannot fit in the remaining model context window.');
  }

  const available = maxCharacters - marker.length;
  let headLength = Math.ceil(available * 0.65);
  let tailLength = available - headLength;
  if (headLength > 0
    && message.content.charCodeAt(headLength - 1) >= 0xd800
    && message.content.charCodeAt(headLength - 1) <= 0xdbff) {
    headLength--;
    tailLength++;
  }
  if (tailLength > 0) {
    const tailStart = message.content.length - tailLength;
    if (message.content.charCodeAt(tailStart) >= 0xdc00
      && message.content.charCodeAt(tailStart) <= 0xdfff) {
      tailLength--;
    }
  }

  return {
    ...message,
    content: `${message.content.slice(0, headLength)}${marker}${message.content.slice(-tailLength)}`,
  };
}

/** Check if dropping message at index would orphan a tool pair */
function wouldOrphan(msgs: Message[], flags: boolean[], dropIdx: number): boolean {
  const msg = msgs[dropIdx];

  if (isToolCallMsg(msg)) {
    const callIds = getToolCallIds(msg);
    for (let j = dropIdx + 1; j < msgs.length; j++) {
      if (!flags[j]) continue;
      if (isToolResultMsg(msgs[j])) {
        const refs = getToolResultRefs(msgs[j]);
        if ([...callIds].some(c => refs.has(c))) return true;
      }
    }
  }

  if (isToolResultMsg(msg)) {
    const refs = getToolResultRefs(msg);
    for (let j = dropIdx - 1; j >= 0; j--) {
      if (!flags[j]) continue;
      if (isToolCallMsg(msgs[j])) {
        const callIds = getToolCallIds(msgs[j]);
        if ([...refs].some(r => callIds.has(r))) return true;
      }
    }
  }

  return false;
}
