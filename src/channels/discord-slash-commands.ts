import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiscordSlashCommandDefinition } from './adapters/discord.js';

export interface DiscordSkillCommand {
  name: string;
  skillName: string;
  description: string;
  instructions: string;
}

const SKILL_COMMAND_ALIASES: Record<string, string> = {
  'master-developer': 'dev',
  'research-agent': 'research',
  'autonomous-monitor': 'monitor',
};

export function discoverDiscordSkillCommands(workspace: string): DiscordSkillCommand[] {
  const skillsDir = path.join(workspace, 'skills', 'subagents');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const commands: DiscordSkillCommand[] = [];
  const usedNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const name = SKILL_COMMAND_ALIASES[entry.name]
      ?? entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || usedNames.has(name)) {
      console.warn(`[discord] Skipping skill command for "${entry.name}": invalid or duplicate command name "${name}"`);
      continue;
    }

    const instructions = fs.readFileSync(skillFile, 'utf8').trim();
    if (!instructions) continue;
    const summary = instructions
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0);
    commands.push({
      name,
      skillName: entry.name,
      description: (summary ?? `Run the ${entry.name} skill`).slice(0, 100),
      instructions,
    });
    usedNames.add(name);
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildDiscordSlashCommands(
  skills: DiscordSkillCommand[],
): DiscordSlashCommandDefinition[] {
  return [
    { name: 'commands', description: 'List available Symbiote commands' },
    {
      name: 'model',
      description: 'Set the active model',
      options: [{ name: 'model', description: 'Model identifier', required: true }],
    },
    {
      name: 'provider',
      description: 'Set the active provider',
      options: [{ name: 'provider', description: 'Provider name', required: true }],
    },
    { name: 'reset', description: 'Reset this Discord conversation' },
    { name: 'restart', description: 'Reload config and restart this conversation' },
    ...skills.map(({ name, description }) => ({
      name,
      description,
      options: [{ name: 'task', description: 'Task for this skill to complete', required: true }],
    })),
  ];
}

export function buildDiscordSkillTask(skill: DiscordSkillCommand, task: string): string {
  return `Follow the skill instructions below while completing the user's task.\n\n`
    + `## Skill: ${skill.skillName}\n${skill.instructions}\n\n`
    + `## User task\n${task}`;
}
