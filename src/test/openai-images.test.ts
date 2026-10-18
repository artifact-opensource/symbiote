import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopImageMessage, extractOpenAIImages, extractToolText } from '../providers/openai-images.js';

test('desktop screenshot blocks become OpenAI-compatible image_url input without entering tool text', () => {
  const content = [
    { type: 'text' as const, text: 'Screen captured.' },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'cGl4ZWxz' } },
  ];
  const images = extractOpenAIImages(content);

  assert.equal(extractToolText(content), 'Screen captured.');
  assert.deepEqual(images, [{
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,cGl4ZWxz' },
  }]);
  assert.deepEqual(createDesktopImageMessage(images), {
    role: 'user',
    content: [
      { type: 'text', text: 'Desktop screenshot from the completed tool action:' },
      ...images,
    ],
  });
});
