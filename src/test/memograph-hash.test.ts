import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson } from '../memory/memograph.js';

// Golden value produced by Memograph's own MemoryShard.compute_hash() for the same shard.
test('canonicalJson reproduces Memograph hashes for non-ASCII content', () => {
  const payload = {
    content: { fact: 'caf\u00e9 \u2615 \u{1F600} \x7f', 'k\u00e9y': 'v' },
    owner: 'o',
    scope: 's',
    domain: 'live',
    parent_hash: null,
    permissions: ['b', 'a'].sort(),
    version: 1,
    content_type: 'CONVERSATIONAL',
  };
  const hash = crypto.createHash('sha256').update(canonicalJson(payload), 'utf-8').digest('hex');
  assert.equal(hash, '4a844682cf4e689d9f9129f644045ae643838d4f6419969e2e54ce73962f38f3');
});

test('canonicalJson escapes like Python json.dumps', () => {
  assert.equal(canonicalJson({ b: 1, a: ['\u00e9', '\n', '"'] }), '{"a":["\\u00e9","\\n","\\""],"b":1}');
});
