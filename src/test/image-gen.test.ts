import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageGenTool } from '../tools/builtin/image_gen.js';
import { validateSvg } from '../security/safe-svg.js';

test('image_gen locally composes and saves a validated SVG sample', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-image-gen-'));
  try {
    const result = JSON.parse(await createImageGenTool(outputDirectory).execute({
      prompt: 'A quiet forest valley at sunrise',
      style: 'Layered editorial illustration',
      size: '640x480',
    })) as { status: string; path: string; format: string; local: boolean };
    assert.equal(result.status, 'success');
    assert.equal(result.format, 'SVG');
    assert.equal(result.local, true);
    const markup = fs.readFileSync(result.path, 'utf8');
    assert.match(markup, /<svg\b/);
    assert.match(markup, /forest valley/i);
    assert.equal(validateSvg(markup), markup);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('image_gen rejects executable SVG content before writing it', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-image-gen-unsafe-'));
  try {
    const tool = createImageGenTool(outputDirectory);
    await assert.rejects(() => tool.execute({
      prompt: 'unsafe',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    }), /unsupported or executable/);
    assert.equal(fs.readdirSync(outputDirectory).length, 0);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
