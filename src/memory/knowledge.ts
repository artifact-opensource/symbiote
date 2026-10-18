import fs from 'node:fs';
import path from 'node:path';

export interface BootKnowledge {
  text: string;
  source: string;
}

export function readBootKnowledge(workspace: string, now = new Date()): BootKnowledge[] {
  const files = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'BOOTSTRAP.md', 'TOOLS.md'];
  const knowledge: BootKnowledge[] = [];

  for (const filename of files) {
    const filePath = path.join(workspace, filename);
    try {
      if (fs.existsSync(filePath)) knowledge.push({ text: fs.readFileSync(filePath, 'utf8'), source: filename });
    } catch (error) {
      console.error(`[memory] Failed to read boot knowledge ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let day = 0; day < 2; day++) {
    const date = new Date(now.getTime() - day * 86_400_000).toISOString().slice(0, 10);
    const source = `memory/${date}`;
    const filePath = path.join(workspace, 'memory', `${date}.md`);
    try {
      if (fs.existsSync(filePath)) knowledge.push({ text: fs.readFileSync(filePath, 'utf8'), source });
    } catch (error) {
      console.error(`[memory] Failed to read boot knowledge ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return knowledge;
}
