/**
 * Symbiote — Outbound Formatter
 * 
 * Converts agent markdown output to platform-native formatting.
 * Each platform has its own dialect. We preserve intent, not syntax.
 */

import type { ChannelCapabilities, OutboundFormatter } from './types.js';

// ─── Discord Formatter ─────────────────────────────────────────────────────

const discordFormatter: OutboundFormatter = {
  format(markdown: string): string {
    return markdown.trim();
  },

  split(content: string, maxLength = 2000): string[] {
    return splitDiscordMarkdown(content, maxLength);
  },
};

// ─── WhatsApp Formatter ────────────────────────────────────────────────────

const whatsappFormatter: OutboundFormatter = {
  format(markdown: string): string {
    let result = markdown;

    // Convert headers to bold (WhatsApp has no headers)
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Standard markdown bold **text** → WhatsApp *text*
    // But preserve **text** that's already WhatsApp bold
    result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Markdown italic _text_ stays as is (WhatsApp uses _ too)
    // But convert *text* single asterisk italic to _text_
    // Actually markdown italic is *text* or _text_, both work in WA

    // Strikethrough ~~text~~ → ~text~
    result = result.replace(/~~(.+?)~~/g, '~$1~');

    // Code blocks stay as ``` (WhatsApp supports them)
    // Inline code `text` stays (WhatsApp supports it)

    // Strip HTML
    result = result.replace(/<[^>]+>/g, '');

    // Convert markdown links [text](url) → text: url
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');

    // Convert tables to bullet lists
    result = result.replace(
      /(\|[^\n]+\|\n)((?:\|[-:| ]+\|\n))((?:\|[^\n]+\|\n?)+)/g,
      (_, header, _sep, body) => {
        const headerCells = parsePipeRow(header);
        const rows = body.trim().split('\n').map(parsePipeRow);
        return rows.map((row: string[]) =>
          '• ' + row.map((cell: string, i: number) =>
            headerCells[i] ? `*${headerCells[i]}:* ${cell}` : cell
          ).join(', ')
        ).join('\n') + '\n';
      },
    );

    // Strip image markdown ![alt](url) → url
    result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2');

    return result.trim();
  },

  split(content: string, maxLength = 4096): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n\n', '\n', '. ', ' ']);
  },
};

// ─── Telegram Formatter ────────────────────────────────────────────────────

const telegramFormatter: OutboundFormatter = {
  format(markdown: string): string {
    // Telegram MarkdownV2 requires escaping special chars outside entities
    // Simpler approach: convert to Telegram HTML
    let result = markdown;

    // Headers → bold
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

    // Bold
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

    // Italic
    result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i>$1</i>');
    result = result.replace(/(?<!_)_([^_]+?)_(?!_)/g, '<i>$1</i>');

    // Strikethrough
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Code blocks
    result = result.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code
    result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Escape remaining HTML-sensitive chars in non-tag content
    // (only & < > that aren't part of our tags)
    // This is intentionally light — Telegram's parser is forgiving

    return result.trim();
  },

  split(content: string, maxLength = 4096): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n\n', '\n', '. ', ' ']);
  },
};

// ─── Slack Formatter ───────────────────────────────────────────────────────

const slackFormatter: OutboundFormatter = {
  format(markdown: string): string {
    let result = markdown;

    // Headers → bold
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Bold **text** → *text*
    result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Italic _text_ stays
    // Strikethrough ~~text~~ → ~text~
    result = result.replace(/~~(.+?)~~/g, '~$1~');

    // Links [text](url) → <url|text>
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    // Code blocks stay as ```
    // Inline code stays as `

    return result.trim();
  },

  split(content: string, maxLength = 3000): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n\n', '\n', '. ', ' ']);
  },
};

// ─── IRC Formatter ─────────────────────────────────────────────────────────

const ircFormatter: OutboundFormatter = {
  format(markdown: string): string {
    let result = markdown;

    // Strip all formatting — IRC clients don't render markdown
    result = result.replace(/\*\*(.+?)\*\*/g, '$1');
    result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1');
    result = result.replace(/~~(.+?)~~/g, '$1');
    result = result.replace(/`([^`]+)`/g, '$1');
    result = result.replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```\w*\n?/g, '').replace(/```/g, '');
    });

    // Strip headers
    result = result.replace(/^#{1,6}\s+/gm, '');

    // Convert links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    // Strip HTML
    result = result.replace(/<[^>]+>/g, '');

    return result.trim();
  },

  split(content: string, maxLength = 450): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n', '. ', ' ']);
  },
};

// ─── Plain Formatter (fallback) ────────────────────────────────────────────

const plainFormatter: OutboundFormatter = {
  format(markdown: string): string {
    return stripMarkdown(markdown);
  },
  split(content: string, maxLength = 4096): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n\n', '\n', '. ', ' ']);
  },
};

// ─── Formatter Registry ────────────────────────────────────────────────────

const FORMATTERS: Record<string, OutboundFormatter> = {
  markdown: discordFormatter,         // Discord uses standard markdown
  html: telegramFormatter,            // Telegram uses HTML
  whatsapp: whatsappFormatter,
  'slack-mrkdwn': slackFormatter,
  plain: plainFormatter,
};

/**
 * Get the appropriate formatter for a channel's capabilities.
 */
export function getFormatter(capabilities: ChannelCapabilities): OutboundFormatter {
  return FORMATTERS[capabilities.formatting] ?? plainFormatter;
}

/**
 * Format and split a message for a specific channel.
 */
export function formatForChannel(
  markdown: string,
  capabilities: ChannelCapabilities,
): string[] {
  const formatter = getFormatter(capabilities);
  const formatted = formatter.format(markdown, capabilities);
  return formatter.split(formatted, capabilities.maxMessageLength);
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function parsePipeRow(row: string): string[] {
  return row
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0);
}

function splitDiscordMarkdown(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  if (maxLength < 16) return splitOnBoundaries(text, maxLength, ['\n', ' ']);

  const chunks: string[] = [];
  let remaining = text;
  let openFence: { marker: string; language: string } | null = null;

  while (remaining.length + (openFence ? openFence.marker.length + openFence.language.length + 1 : 0) > maxLength) {
    let prefix = openFence ? `${openFence.marker}${openFence.language}\n` : '';
    const closingLength = openFence ? openFence.marker.length + 1 : 4;
    if (prefix.length + closingLength >= maxLength && openFence) {
      prefix = `${openFence.marker}\n`;
    }
    const bodyLimit = maxLength - prefix.length - closingLength;
    if (bodyLimit < 1) throw new RangeError('Discord message limit is too small to preserve a code fence.');
    const searchArea = remaining.slice(0, bodyLimit);
    let splitAt = -1;
    for (const boundary of ['\n\n', '\n', '. ', ' ']) {
      const lastIndex = searchArea.lastIndexOf(boundary);
      if (lastIndex > bodyLimit * 0.3) {
        splitAt = lastIndex + boundary.length;
        break;
      }
    }
    if (splitAt <= 0) splitAt = bodyLimit;
    if (splitAt < remaining.length
      && splitAt > 0
      && remaining.charCodeAt(splitAt - 1) >= 0xd800
      && remaining.charCodeAt(splitAt - 1) <= 0xdbff) {
      splitAt--;
    }

    const part = remaining.slice(0, splitAt).trimEnd();
    for (const line of part.split('\n')) {
      const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!match) continue;
      if (!openFence) {
        openFence = { marker: match[1], language: match[2].trim() };
      } else if (match[1][0] === openFence.marker[0] && match[1].length >= openFence.marker.length) {
        openFence = null;
      }
    }

    chunks.push(`${prefix}${part}${openFence ? `${part.endsWith('\n') ? '' : '\n'}${openFence.marker}` : ''}`);
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    const prefix = openFence ? `${openFence.marker}${openFence.language}\n` : '';
    chunks.push(`${prefix}${remaining}`);
  }
  return chunks;
}

function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/^#{1,6}\s+/gm, '');
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1');
  result = result.replace(/~~(.+?)~~/g, '$1');
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').replace(/```/g, ''));
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  result = result.replace(/<[^>]+>/g, '');
  return result.trim();
}

/**
 * Split text on natural boundaries (paragraphs, sentences, words)
 * without breaking mid-word or mid-code-block.
 */
function splitOnBoundaries(text: string, maxLength: number, boundaries: string[]): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = -1;

    // Try each boundary type in order of preference
    for (const boundary of boundaries) {
      const searchArea = remaining.slice(0, maxLength);
      const lastIdx = searchArea.lastIndexOf(boundary);
      if (lastIdx > maxLength * 0.3) { // Don't split too early
        splitAt = lastIdx + boundary.length;
        break;
      }
    }

    // Fallback: hard split at maxLength
    if (splitAt <= 0) splitAt = maxLength;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
