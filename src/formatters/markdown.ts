// Symbiote — Per-Channel Markdown Formatter (fixes Pain #17)
// Convert markdown to channel-safe formats

export type OutputFormat = 'whatsapp' | 'discord' | 'plain' | 'markdown';

/**
 * Format markdown content for a specific channel.
 */
export function formatForChannel(content: string, format: OutputFormat): string {
  switch (format) {
    case 'whatsapp': return toWhatsApp(content);
    case 'discord': return toDiscord(content);
    case 'plain': return toPlain(content);
    case 'markdown': return content;
  }
}

/** WhatsApp: no tables, no headers, limited markdown */
function toWhatsApp(md: string): string {
  let text = md;

  // Headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Tables → bullet lists
  text = convertTablesToBullets(text);

  // Code blocks: keep backticks (WhatsApp supports ```)
  // Horizontal rules → blank line
  text = text.replace(/^---+$/gm, '');

  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Images: ![alt](url) → [Image: alt]
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[Image: $1]');

  return text.trim();
}

/** Discord: tables → code blocks, mostly fine */
function toDiscord(md: string): string {
  let text = md;

  // Tables → code blocks
  text = convertTablesToCodeBlocks(text);

  // Suppress link embeds for multiple URLs
  text = text.replace(/(https?:\/\/\S+)/g, '<$1>');

  return text.trim();
}

/** Plain: strip all markdown */
function toPlain(md: string): string {
  let text = md;

  // Headers
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Bold/italic
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');
  // Code
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''));
  text = text.replace(/`(.+?)`/g, '$1');
  // Links
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Images
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Tables
  text = convertTablesToBullets(text);
  // HRs
  text = text.replace(/^---+$/gm, '');
  // Blockquotes
  text = text.replace(/^>\s?/gm, '');

  return text.trim();
}

/** Convert markdown tables to bullet lists */
function convertTablesToBullets(text: string): string {
  return text.replace(/(?:^\|.+\|$\n?)+/gm, (table) => {
    const rows = table.trim().split('\n').filter(r => !r.match(/^\|[\s\-:|]+\|$/));
    if (rows.length === 0) return table;

    const headers = rows[0].split('|').map(c => c.trim()).filter(Boolean);
    const dataRows = rows.slice(1);

    return dataRows.map(row => {
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      const parts = cells.map((cell, i) => headers[i] ? `${headers[i]}: ${cell}` : cell);
      return `• ${parts.join(' | ')}`;
    }).join('\n') + '\n';
  });
}

/** Convert markdown tables to code blocks (for Discord) */
function convertTablesToCodeBlocks(text: string): string {
  return text.replace(/(?:^\|.+\|$\n?)+/gm, (table) => {
    return '```\n' + table.trim() + '\n```\n';
  });
}
