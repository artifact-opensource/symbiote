import test from 'node:test';
import assert from 'node:assert/strict';
import { cuaTools } from '../tools/builtin/web-browser.js';

test('native browser CUA exposes screenshot, pointer, keyboard, and scroll tools', () => {
  assert.deepEqual(cuaTools.map(tool => tool.name), [
    'cua_screenshot',
    'cua_click',
    'cua_move',
    'cua_type',
    'cua_press',
    'cua_scroll',
  ]);

  const click = cuaTools.find(tool => tool.name === 'cua_click')!;
  assert.deepEqual(click.parameters.required, ['x', 'y']);
  assert.match(click.description, /active browser viewport/i);
});