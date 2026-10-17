import fs from 'node:fs';
import path from 'node:path';
import { appHomeDir } from '../runtime/platform.js';

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
  avatarDataUrl?: string | null;
}

const AVATAR_PATHS = {
  png: path.join(appHomeDir(), 'agent-avatar.png'),
  jpg: path.join(appHomeDir(), 'agent-avatar.jpg'),
  webp: path.join(appHomeDir(), 'agent-avatar.webp'),
};

function saveAgentAvatar(dataUrl: string | null): void {
  if (dataUrl === null) {
    for (const avatarPath of Object.values(AVATAR_PATHS)) {
      try { fs.unlinkSync(avatarPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return;
  }

  if (dataUrl.length > 2_800_000) throw new Error('Agent avatar must be 2 MiB or smaller.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('Agent avatar must be a PNG, JPEG, or WebP image.');
  const [, mime, encoded] = match;
  const data = Buffer.from(encoded, 'base64');
  if (data.length > 2 * 1024 * 1024) throw new Error('Agent avatar must be 2 MiB or smaller.');

  const validSignature = mime === 'png'
    ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'jpeg'
      ? data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
      : data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!validSignature) throw new Error('The selected file is not a valid image of the declared type.');

  fs.mkdirSync(appHomeDir(), { recursive: true });
  const extension: keyof typeof AVATAR_PATHS = mime === 'jpeg' ? 'jpg' : mime === 'png' ? 'png' : 'webp';
  const target = AVATAR_PATHS[extension];
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, target);
  for (const [otherExtension, avatarPath] of Object.entries(AVATAR_PATHS)) {
    if (otherExtension === extension) continue;
    try { fs.unlinkSync(avatarPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export function readAgentAvatarDataUrl(): string | undefined {
  for (const [extension, avatarPath] of Object.entries(AVATAR_PATHS)) {
    if (!fs.existsSync(avatarPath)) continue;
    const mime = extension === 'jpg' ? 'jpeg' : extension;
    return `data:image/${mime};base64,${fs.readFileSync(avatarPath).toString('base64')}`;
  }
  return undefined;
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
  if (update.avatarDataUrl !== undefined) saveAgentAvatar(update.avatarDataUrl);
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
