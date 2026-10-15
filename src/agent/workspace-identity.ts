import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceIdentity {
  agentName: string;
  agentEmoji: string;
  ownerName: string;
  soulContent: string;
  agentsContent: string;
  agentInstructions: string;
}

export interface WorkspaceIdentityUpdate {
  name: string;
  emoji: string;
  soulContent?: string;
  agentsContent?: string;
  instructions: string;
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function readField(contents: string, field: 'Name' | 'Emoji'): string | undefined {
  const match = contents.match(new RegExp(`^\\s*-\\s*\\*{0,2}${field}:?\\*{0,2}\\s*(.*?)\\s*$`, 'im'));
  return match?.[1]?.trim() || undefined;
}

function updateField(contents: string, field: 'Name' | 'Emoji', value: string): string {
  const expression = new RegExp(`^(\\s*-\\s*\\*{0,2}${field}:?\\*{0,2}\\s*).*$`, 'im');
  if (expression.test(contents)) return contents.replace(expression, `$1${value}`);
  return `${contents.trimEnd()}\n- ${field}: ${value}\n`;
}

export function readWorkspaceIdentity(workspace: string, fallbackName = 'Agent', fallbackEmoji = '🤖'): WorkspaceIdentity {
  const agents = readText(path.join(workspace, 'AGENTS.md'));
  const identity = readText(path.join(workspace, 'IDENTITY.md'));
  const soul = readText(path.join(workspace, 'SOUL.md'));
  const user = readText(path.join(workspace, 'USER.md'));
  return {
    agentName: readField(agents, 'Name') ?? readField(identity, 'Name') ?? readField(soul, 'Name') ?? fallbackName,
    agentEmoji: readField(identity, 'Emoji') ?? readField(soul, 'Emoji') ?? fallbackEmoji,
    ownerName: readField(user, 'Name') ?? 'Owner',
    soulContent: soul,
    agentsContent: agents,
    agentInstructions: readText(path.join(workspace, 'AGENT_INSTRUCTIONS.md')).trim(),
  };
}

export function updateWorkspaceIdentity(workspace: string, update: WorkspaceIdentityUpdate): WorkspaceIdentity {
  const soulPath = path.join(workspace, 'SOUL.md');
  let soul = update.soulContent ?? readText(soulPath);
  if (!soul) soul = '# Soul\n';
  soul = updateField(updateField(soul, 'Name', update.name), 'Emoji', update.emoji);
  fs.writeFileSync(soulPath, soul, 'utf8');

  const identityPath = path.join(workspace, 'IDENTITY.md');
  if (fs.existsSync(identityPath)) {
    let identity = readText(identityPath);
    identity = updateField(updateField(identity, 'Name', update.name), 'Emoji', update.emoji);
    fs.writeFileSync(identityPath, identity, 'utf8');
  }

  const agentsPath = path.join(workspace, 'AGENTS.md');
  const agents = updateField(update.agentsContent ?? readText(agentsPath), 'Name', update.name);
  fs.writeFileSync(agentsPath, agents, 'utf8');
  fs.writeFileSync(path.join(workspace, 'AGENT_INSTRUCTIONS.md'), update.instructions.trim(), 'utf8');
  return readWorkspaceIdentity(workspace, update.name, update.emoji);
}
