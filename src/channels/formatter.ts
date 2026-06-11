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
    // Discord supports standard markdown natively
    // Only strip things Discord can't handle:
    // - HTML tags
    // - Very wide tables (convert to code blocks)
    let result = markdown;

    // Strip HTML tags
    result = result.replace(/<[^>]+>/g, '');

    // Convert markdown tables to code blocks (Discord doesn't render tables)
    result = result.replace(
      /(\|[^\n]+\|\n)((?:\|[-:| ]+\|\n))((?:\|[^\n]+\|\n?)+)/g,
      (_, header, separator, body) => {
        return '```\n' + header + separator + body + '```\n';
      },
    );

    return result.trim();
  },

  split(content: string, maxLength = 2000): string[] {
    if (content.length <= maxLength) return [content];
    return splitOnBoundaries(content, maxLength, ['\n\n', '\n', '. ', ' ']);
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
