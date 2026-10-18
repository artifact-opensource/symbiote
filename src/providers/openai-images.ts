import type { ContentBlock } from './types.js';

export function extractOpenAIImages(content: string | ContentBlock[]): unknown[] {
  if (typeof content === 'string') return [];
  return content.flatMap(block => {
    if (block.type !== 'image' || block.source?.type !== 'base64') return [];
    return [{
      type: 'image_url',
      image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
    }];
  });
}

export function extractToolText(content: string | ContentBlock[]): string {
  return typeof content === 'string'
    ? content
    : content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
}

export function createDesktopImageMessage(images: unknown[]): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'Desktop screenshot from the completed tool action:' }, ...images],
  };
}
