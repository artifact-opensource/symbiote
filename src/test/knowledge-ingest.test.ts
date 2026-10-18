import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContextStore } from '../agent/context-store.js';
import { VectorDB } from '../memory/vdb.js';
import { importSkillFiles } from '../memory/skills.js';

test('boot knowledge synchronization replaces changed files and removes stale chunks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-boot-knowledge-'));
  try {
    const database = new VectorDB(root);
    const context = new ContextStore(database);
    const source = 'SOUL.md';

    assert.equal(context.ingestBoot([{ source, text: 'The original agent identity emphasizes careful research.' }]), 1);
    const stableId = `boot:${encodeURIComponent(source)}:0`;
    assert.match(database.getDocument(stableId)?.text ?? '', /original agent identity/);

    assert.equal(context.ingestBoot([{ source, text: 'The revised agent identity emphasizes verified durable memory.' }]), 1);
    assert.match(database.getDocument(stableId)?.text ?? '', /revised agent identity/);
    assert.equal(database.listDocuments().filter(document => document.namespace === 'boot:context').length, 1);

    assert.equal(context.ingestBoot([]), 0);
    assert.equal(database.listDocuments().filter(document => document.namespace === 'boot:context').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skill catalog synchronization updates changed files and prunes removed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-skill-catalog-'));
  const skills = path.join(root, 'skills');
  try {
    fs.mkdirSync(path.join(skills, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(skills, 'beta'), { recursive: true });
    const alpha = path.join(skills, 'alpha', 'SKILL.md');
    const beta = path.join(skills, 'beta', 'SKILL.md');
    fs.writeFileSync(alpha, '---\nname: Alpha\n---\n\nAlpha skill describes careful mapmaking.');
    fs.writeFileSync(beta, '---\nname: Beta\n---\n\nBeta skill describes unrelated work.');

    const database = new VectorDB(root);
    const first = importSkillFiles(database, skills);
    assert.equal(first.indexed, 2);
    assert.equal(database.listDocuments().filter(document => document.namespace === 'skills:catalog').length, 2);

    fs.writeFileSync(alpha, '---\nname: Alpha\n---\n\nAlpha skill now describes verified memory mapping.');
    fs.rmSync(beta);
    const second = importSkillFiles(database, skills);
    assert.equal(second.indexed, 1);
    assert.equal(second.skipped, 0);
    assert.equal(database.getDocument('skill:alpha:SKILL.md')?.text, 'Alpha skill now describes verified memory mapping.');
    assert.equal(database.getDocument('skill:beta:SKILL.md'), undefined);
    assert.equal(database.listDocuments().filter(document => document.namespace === 'skills:catalog').length, 1);

    const third = importSkillFiles(database, skills);
    assert.equal(third.indexed, 0);
    assert.equal(third.skipped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
