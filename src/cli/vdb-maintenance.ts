import { loadConfig } from '../config/config.js';
import { getSharedVectorDB } from '../memory/vdb.js';
import { importMemoGraphSnapshots, resolveMemoGraphStorageDir } from '../memory/memograph.js';
import { ingestWorkspaceSessions } from '../tools/builtin/memory-vdb.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const workspace = process.env.SYMBIOTE_WORKSPACE ?? config.workspace;
  process.env.SYMBIOTE_WORKSPACE = workspace;
  const [action, ...args] = process.argv.slice(2);
  const database = getSharedVectorDB(workspace);

  switch (action) {
    case 'stats':
      console.log(JSON.stringify(database.stats()));
      return;
    case 'ingest':
      console.log(JSON.stringify({
        sessions: ingestWorkspaceSessions(),
        memograph: importMemoGraphSnapshots(database, resolveMemoGraphStorageDir(workspace)),
      }));
      return;
    case 'stage': {
      const text = args.join(' ').trim();
      if (!text) throw new Error('stage requires text');
      database.index({
        id: '',
        text,
        source: 'comb',
        role: 'context',
        timestamp: Date.now(),
        sessionId: 'pulse',
      });
      console.log('Memory staged in VDB.');
      return;
    }
    default:
      throw new Error('Usage: vdb-maintenance <stats|ingest|stage> [text]');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});