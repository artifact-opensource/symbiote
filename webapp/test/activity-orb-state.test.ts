import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getActivityFromStatus,
  getActivityLabel,
  getActivityOrbState,
  getLoadingOrbState,
  getToolActivity,
  isAgentActivity,
} from '../src/components/activity-orb-state.js';
import { STATE_TO_MODE } from 'thinking-orbs';

test('agent phases map to their intended spherical orb animations', () => {
  assert.equal(getActivityOrbState('thinking'), 'solving');
  assert.equal(getActivityOrbState('reasoning'), 'weaving');
  assert.equal(getActivityOrbState('responding'), 'composing');
  assert.equal(getActivityOrbState('executing'), 'working');
  assert.equal(getActivityOrbState('recalling'), 'weaving');
  assert.equal(getActivityOrbState('reading'), 'searching');
  assert.equal(getActivityOrbState('editing'), 'shaping');
  assert.equal(getActivityOrbState('browsing'), 'connecting');
  assert.equal(getActivityOrbState('listening'), 'listening');
  assert.equal(getActivityFromStatus('Thinking'), 'thinking');
  assert.equal(getActivityFromStatus('Reasoning'), 'reasoning');
  assert.equal(getActivityFromStatus('Writing response'), 'responding');
  assert.equal(getActivityFromStatus('Executing read'), 'executing');
  assert.equal(getActivityFromStatus('Executing', 'read'), 'reading');
});

test('loading indicators use the package circular-ring animation', () => {
  assert.equal(STATE_TO_MODE[getLoadingOrbState()], 'ring');
});

test('Discord tool activity categories have matching chat orb states and labels', () => {
  assert.deepEqual(getToolActivity('exec'), { activity: 'executing', label: 'Running command' });
  assert.deepEqual(getToolActivity('comb_recall'), { activity: 'recalling', label: 'Recalling memory' });
  assert.deepEqual(getToolActivity('memory_search'), { activity: 'searching', label: 'Searching memory' });
  assert.deepEqual(getToolActivity('write'), { activity: 'writing', label: 'Writing files' });
  assert.deepEqual(getToolActivity('unmapped_tool'), { activity: 'executing', label: 'unmapped tool' });
  assert.equal(getActivityLabel('reasoning'), 'Reasoning');
  assert.equal(isAgentActivity('browsing'), true);
  assert.equal(isAgentActivity('unknown'), false);
});

test('every agent activity and loading state resolves to a shipped orb animation', () => {
  const activities = [
    'thinking', 'reasoning', 'responding', 'reading', 'writing', 'editing',
    'executing', 'searching', 'browsing', 'analyzing', 'generating',
    'recalling', 'staging', 'spawning', 'speaking', 'listening', 'reacting',
  ] as const;

  for (const activity of activities) {
    const state = getActivityOrbState(activity);
    assert.ok(STATE_TO_MODE[state], `${activity} should map to a shipped animation`);
  }

  assert.ok(STATE_TO_MODE[getLoadingOrbState()], 'loading should map to a shipped animation');
});
