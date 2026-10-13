import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildDiscordSkillTask,
  buildDiscordSlashCommands,
  discoverDiscordSkillCommands,
} from '../channels/discord-slash-commands.js';

test('Discord skill command discovery maps known aliases and reads skill instructions', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-discord-skills-'));
  try {
    const skillDir = path.join(workspace, 'skills', 'subagents', 'research-agent');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Research Agent\nInvestigate thoroughly.');
    const monitorDir = path.join(workspace, 'skills', 'subagents', 'autonomous-monitor');
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(path.join(monitorDir, 'SKILL.md'), '# Autonomous Monitor\nMonitor the requested system.');

    const skills = discoverDiscordSkillCommands(workspace);
    assert.equal(skills.length, 2);
    const research = skills.find((skill) => skill.name === 'research');
    const monitor = skills.find((skill) => skill.name === 'monitor');
    assert.ok(research);
    assert.equal(research.skillName, 'research-agent');
    assert.match(research.instructions, /Investigate thoroughly/);
    assert.ok(monitor);
    assert.equal(monitor.skillName, 'autonomous-monitor');
    assert.ok(buildDiscordSlashCommands(skills).some((command) => command.name === 'monitor'));
    assert.match(buildDiscordSkillTask(research, 'Find the latest release'), /Find the latest release/);
    assert.match(buildDiscordSkillTask(research, 'Find the latest release'), /Investigate thoroughly/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Discord skill command discovery safely returns no skills when the directory is absent', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'symbiote-discord-no-skills-'));
  try {
    assert.deepEqual(discoverDiscordSkillCommands(workspace), []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
