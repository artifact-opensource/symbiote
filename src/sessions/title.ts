import type { Message } from '../providers/types.js';

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ');
}

function promptSnippet(content: Message['content']): string {
  const text = messageText(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[data]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[\s#>*-]+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  const words = sentence.split(' ').filter(Boolean).slice(0, 7);
  let snippet = words.join(' ').replace(/[\s.,;:!?-]+$/, '');
  if (snippet.length > 32) {
    const shortened = snippet.slice(0, 29).replace(/\s+\S*$/, '').replace(/\s+(?:and|or|the|of|to|a|an)$/i, '');
    snippet = `${shortened || snippet.slice(0, 29)}…`;
  }
  return snippet;
}

export function deriveConversationTitle(messages: readonly Message[]): string | undefined {
  const prompts = messages
    .filter((message): message is Message & { role: 'user' } => message.role === 'user')
    .slice(0, 2)
    .map(message => promptSnippet(message.content))
    .filter(Boolean);
  if (prompts.length < 2) return undefined;
  return `${prompts[0]} · ${prompts[1]}`.slice(0, 72).trim();
}
