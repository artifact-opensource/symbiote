// System Health Verification Tool
// Consolidated system and hardware state verification
// Single tool to replace multiple individual checks

import { read } from './read.js';
import { write } from './write.js';
import { exec } from './exec.js';
import { hardware } from './hardware.js';
import { memory_stats } from './memory.js';
import { process_list } from './process.js';
import { web_fetch } from './web-fetch.js';
import { web_browse } from './web-browser.js';

export async function systemHealthVerification(actions, options = {}) {
  const {
    include_detailed = false,
    format = 'summary',
    timeout = 30
  } = options;

  const results = {};

  for (const action of actions) {
    try {
      switch (action) {
        case 'system_state':
          results.system_state = await getSystemState(include_detailed);
          break;
        case 'hardware_summary':
          results.hardware_summary = await hardware({ kind: 'summary' });
          break;
        case 'hardware_cpu':
          results.hardware_cpu = await hardware({ kind: 'cpu' });
          break;
        case 'hardware_memory':
          results.hardware_memory = await hardware({ kind: 'memory' });
          break;
        case 'hardware_disks':
          results.hardware_disks = await hardware({ kind: 'disks' });
          break;
        case 'hardware_gpu':
          results.hardware_gpu = await hardware({ kind: 'gpu' });
          break;
        case 'hardware_network':
          results.hardware_network = await hardware({ kind: 'network' });
          break;
        case 'hardware_usb':
          results.hardware_usb = await hardware({ kind: 'usb' });
          break;
        case 'hardware_audio':
          results.hardware_audio = await hardware({ kind: 'audio' });
          break;
        case 'hardware_camera':
          results.hardware_camera = await hardware({ kind: 'camera' });
          break;
        case 'hardware_bluetooth':
          results.hardware_bluetooth = await hardware({ kind: 'bluetooth' });
          break;
        case 'hardware_displays':
          results.hardware_displays = await hardware({ kind: 'displays' });
          break;
        case 'hardware_battery':
          results.hardware_battery = await hardware({ kind: 'battery' });
          break;
        case 'hardware_sensors':
          results.hardware_sensors = await hardware({ kind: 'sensors' });
          break;
        case 'hardware_processes':
          results.hardware_processes = await hardware({ kind: 'processes' });
          break;
        case 'runtime_status':
          results.runtime_status = await getRuntimeStatus();
          break;
        case 'ports_listening':
          results.ports_listening = await getPortsListening();
          break;
        case 'gateway_status':
          results.gateway_status = await getGatewayStatus();
          break;
        case 'web_ui_status':
          results.web_ui_status = await getWebUIStatus();
          break;
        case 'n8n_status':
          results.n8n_status = await getN8nStatus();
          break;
        case 'ollama_status':
          results.ollama_status = await getOllamaStatus();
          break;
        case 'filesystem_status':
          results.filesystem_status = await getFilesystemStatus();
          break;
        case 'session_state':
          results.session_state = await getSessionState();
          break;
        case 'comb_state':
          results.comb_state = await getCombState();
          break;
        case 'memory_stats':
          results.memory_stats = await memory_stats();
          break;
        case 'vdb_status':
          results.vdb_status = await getVDBStatus();
          break;
        case 'processes_list':
          results.processes_list = await process_list();
          break;
        case 'system_logs':
          results.system_logs = await getSystemLogs();
          break;
        case 'config_status':
          results.config_status = await getConfigStatus();
          break;
        case 'services_status':
          results.services_status = await getServicesStatus();
          break;
        case 'health_checks':
          results.health_checks = await getHealthChecks();
          break;
        case 'resource_aggregator':
          results.resource_aggregator = await getResourceAggregator();
          break;
        case 'markets_status':
          results.markets_status = await getMarketsStatus();
          break;
      }
    } catch (error) {
      results[action] = { error: error.message };
    }
  }

  return format === 'json' ? JSON.stringify(results, null, 2) : formatResults(results, include_detailed);
}

async function getSystemState(detailed) {
  const info = [];
  info.push(`Hostname: ${require('os').hostname()}`);
  info.push(`Platform: ${process.platform}`);
  info.push(`Architecture: ${process.arch}`);
  info.push(`Node.js version: ${process.version}`);
  info.push(`Working directory: ${process.cwd()}`);

  if (detailed) {
    info.push(`Load average: ${require('os').loadavg()}`);
    info.push(`Process count: ${require('os').cpus().length}`);
    info.push(`Total memory: ${Math.round(require('os').totalmem() / 1024 / 1024)} MB`);
  }

  return info.join('\n');
}

async function getRuntimeStatus() {
  const status = {};

  try {
    const response = await web_fetch('http://localhost:3009/api/sessions', { maxChars: 2000 });
    status.web_ui = 'accessible';
    status.web_ui_response = 'OK';
  } catch (error) {
    status.web_ui = 'inaccessible';
    status.web_ui_error = error.message;
  }

  try {
    const response = await web_fetch('http://localhost:3007/api/v1/health', { maxChars: 2000 });
    status.gateway_api = 'accessible';
    status.gateway_api_response = 'OK';
  } catch (error) {
    status.gateway_api = 'inaccessible';
    status.gateway_api_error = error.message;
  }

  try {
    const response = await web_fetch('http://localhost:5678', { maxChars: 2000 });
    status.n8n = 'accessible';
    status.n8n_response = 'OK';
  } catch (error) {
    status.n8n = 'inaccessible';
    status.n8n_error = error.message;
  }

  try {
    const response = await web_fetch('http://localhost:11434/api/tags', { maxChars: 2000 });
    const data = JSON.parse(response);
    status.ollama = 'accessible';
    status.ollama_models = data.models?.length || 0;
    status.ollama_response = 'OK';
  } catch (error) {
    status.ollama = 'inaccessible';
    status.ollama_error = error.message;
  }

  try {
    const response = await web_fetch('http://127.0.0.1:8080/v1/models', { maxChars: 2000 });
    const data = JSON.parse(response);
    status.artifact_engine = 'accessible';
    status.artifact_engine_models = data.data?.length || 0;
    status.artifact_engine_response = 'OK';
  } catch (error) {
    status.artifact_engine = 'inaccessible';
    status.artifact_engine_error = error.message;
  }

  return status;
}

async function getPortsListening() {
  const result = await exec('netstat -an | findstr LISTENING | findstr ":3007 :3009 :5678 :8080 :11434"', { shell: 'cmd', timeout: 60 });
  return result;
}

async function getGatewayStatus() {
  const status = {};

  try {
    const response = await web_fetch('http://localhost:3007/api/v1/health', { maxChars: 2000 });
    status.api = 'accessible';
    status.api_response = 'OK';
  } catch (error) {
    status.api = 'inaccessible';
    status.api_error = error.message;
  }

  try {
    const response = await web_fetch('http://localhost:3009/api/sessions', { maxChars: 2000 });
    status.web_ui = 'accessible';
    status.web_ui_response = 'OK';
  } catch (error) {
    status.web_ui = 'inaccessible';
    status.web_ui_error = error.message;
  }

  return status;
}

async function getWebUIStatus() {
  try {
    const response = await web_fetch('http://localhost:3009/api/sessions', { maxChars: 2000 });
    return {
      status: 'accessible',
      response: 'OK',
      sessions: JSON.parse(response).length || 0
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getN8nStatus() {
  try {
    const response = await web_fetch('http://localhost:5678', { maxChars: 2000 });
    return {
      status: 'accessible',
      response: 'OK'
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getOllamaStatus() {
  try {
    const response = await web_fetch('http://localhost:11434/api/tags', { maxChars: 2000 });
    const data = JSON.parse(response);
    return {
      status: 'accessible',
      response: 'OK',
      models: data.models?.length || 0,
      model_list: data.models?.map(m => m.name) || []
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getFilesystemStatus() {
  try {
    const result = await exec('wmic logicaldisk get size,freespace /format:csv', { shell: 'powershell', timeout: 60 });
    return {
      status: 'accessible',
      output: result,
      parsed: parseDiskInfo(result)
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

function parseDiskInfo(output) {
  const lines = output.split('\n');
  const disks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('Size') || line.includes('FreeSpace')) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        disks.push({
          drive: parts[0]?.trim() || 'Unknown',
          size: parseInt(parts[1]?.replace(/,/g, '') || 0),
          freeSpace: parseInt(parts[2]?.replace(/,/g, '') || 0),
          freePercent: parseInt(parts[1]?.replace(/,/g, '')) > 0
            ? Math.round((parseInt(parts[2]?.replace(/,/g, '') || 0) / parseInt(parts[1]?.replace(/,/g, '')) * 100))
            : 0
        });
      }
    }
  }

  return disks;
}

async function getSessionState() {
  try {
    const sessionsDir = './.sessions';
    const sessions = [];

    if (require('fs').existsSync(sessionsDir)) {
      const files = require('fs').readdirSync(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const path = require('path').join(sessionsDir, file);
          const data = JSON.parse(require('fs').readFileSync(path, 'utf8'));
          sessions.push({
            id: file,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messages?.length || 0,
            provider: data.provider,
            model: data.model
          });
        }
      }
    }

    return {
      status: 'accessible',
      sessions_count: sessions.length,
      sessions: sessions,
      total_messages: sessions.reduce((sum, s) => sum + s.messageCount, 0)
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getCombState() {
  try {
    const combDir = './.comb';
    if (require('fs').existsSync(combDir)) {
      const files = require('fs').readdirSync(combDir);
      return {
        status: 'accessible',
        files_count: files.length,
        files: files
      };
    } else {
      return {
        status: 'not_found',
        message: 'No .comb directory found'
      };
    }
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getVDBStatus() {
  try {
    const vdbDir = './.vdb';
    if (require('fs').existsSync(vdbDir)) {
      const files = require('fs').readdirSync(vdbDir);
      const documentsFile = require('fs').existsSync('./.vdb/documents.jsonl') ?
        require('fs').readFileSync('./.vdb/documents.jsonl', 'utf8').split('\n').filter(line => line.trim()).length : 0;

      return {
        status: 'accessible',
        files: files,
        documents_count: documentsFile,
        directory_size: getDirectorySize('./.vdb')
      };
    } else {
      return {
        status: 'not_found',
        message: 'No .vdb directory found'
      };
    }
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

function getDirectorySize(dirPath) {
  let totalSize = 0;

  function calculateSize(path) {
    try {
      const stats = require('fs').statSync(path);
      if (stats.isDirectory()) {
        const files = require('fs').readdirSync(path);
        for (const file of files) {
          calculateSize(require('path').join(path, file));
        }
      } else {
        totalSize += stats.size;
      }
    } catch (error) {
      // ignore errors
    }
  }

  calculateSize(dirPath);
  return totalSize;
}

async function getSystemLogs() {
  const logs = {};

  // Check for recent log files
  const logPatterns = [
    './symbiote.log',
    './.sessions/health-events.jsonl'
  ];

  for (const pattern of logPatterns) {
    try {
      if (require('fs').existsSync(pattern)) {
        const stats = require('fs').statSync(pattern);
        const content = require('fs').readFileSync(pattern, 'utf8');
        logs[pattern] = {
          size: stats.size,
          lastModified: stats.mtime,
          lineCount: content.split('\n').length,
          preview: content.substring(0, 500) + (content.length > 500 ? '...' : '')
        };
      } else {
        logs[pattern] = { status: 'not_found' };
      }
    } catch (error) {
      logs[pattern] = { error: error.message };
    }
  }

  return logs;
}

async function getConfigStatus() {
  try {
    const configPath = './symbiote.json';
    if (require('fs').existsSync(configPath)) {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      return {
        status: 'accessible',
        config_version: config.configVersion,
        workspace: config.workspace,
        providers: Object.keys(config.providers || {}),
        has_api_key: !!config.apiKey,
        discord_enabled: config.discord?.enabled || false,
        whatsapp_enabled: config.whatsapp?.enabled || false
      };
    } else {
      return {
        status: 'not_found',
        message: 'No symbiote.json found'
      };
    }
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getServicesStatus() {
  const services = {};

  // Check various services
  const serviceChecks = [
    { name: 'Node.js process', check: () => process.pid },
    { name: 'Gateway daemon', check: () => checkGatewayProcess() },
    { name: 'Web UI', check: () => checkWebUIProcess() },
    { name: 'Cron jobs', check: () => checkCronJobs() }
  ];

  for (const service of serviceChecks) {
    try {
      const result = service.check();
      services[service.name] = {
        status: 'running',
        result: result
      };
    } catch (error) {
      services[service.name] = {
        status: 'stopped',
        error: error.message
      };
    }
  }

  return services;
}

function checkGatewayProcess() {
  try {
    const result = require('child_process').execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8' });
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.includes('daemon.js')) {
        return { pid: line.split(',')[0], found: true };
      }
    }
    return { pid: null, found: false };
  } catch (error) {
    return { error: error.message };
  }
}

function checkWebUIProcess() {
  try {
    const result = require('child_process').execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8' });
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.includes('web') && line.includes('server')) {
        return { pid: line.split(',')[0], found: true };
      }
    }
    return { pid: null, found: false };
  } catch (error) {
    return { error: error.message };
  }
}

function checkCronJobs() {
  try {
    const cronDir = './.agents/cron';
    if (require('fs').existsSync(cronDir)) {
      const files = require('fs').readdirSync(cronDir);
      return {
        found: true,
        jobs_file: files.includes('jobs.json'),
        file_count: files.length
      };
    }
    return { found: false };
  } catch (error) {
    return { error: error.message };
  }
}

async function getHealthChecks() {
  const health = {};

  // System resource checks
  try {
    const mem = await hardware({ kind: 'memory' });
    health.memory = {
      total: mem.memoryGB?.total || 0,
      free: mem.memoryGB?.free || 0,
      usage_percent: mem.memoryGB?.total > 0
        ? Math.round(((mem.memoryGB?.total || 0) - (mem.memoryGB?.free || 0)) / mem.memoryGB?.total * 100)
        : 0
    };
  } catch (error) {
    health.memory = { error: error.message };
  }

  // Disk space checks
  try {
    const disks = await getFilesystemStatus();
    health.disk_space = disks.parsed?.filter(d => d.freePercent < 10) || [];
    health.disk_space_warning = health.disk_space.length > 0;
  } catch (error) {
    health.disk_space = { error: error.message };
  }

  // Process count check
  try {
    const processes = await process_list();
    health.process_count = processes?.length || 0;
    health.process_count_healthy = (processes?.length || 0) < 1000; // reasonable threshold
  } catch (error) {
    health.process_count = { error: error.message };
  }

  return health;
}

async function getResourceAggregator() {
  try {
    const response = await web_fetch('http://localhost:3007/api/resource-aggregator', { maxChars: 5000 });
    return {
      status: 'accessible',
      data: response
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

async function getMarketsStatus() {
  try {
    const response = await web_fetch('http://localhost:3007/api/markets/history?symbol=BTC&interval=1h', { maxChars: 5000 });
    return {
      status: 'accessible',
      data: response
    };
  } catch (error) {
    return {
      status: 'inaccessible',
      error: error.message
    };
  }
}

function formatResults(results, detailed) {
  let output = '=== SYSTEM HEALTH VERIFICATION ===\n\n';

  for (const [category, data] of Object.entries(results)) {
    output += `--- ${category.toUpperCase()} ---\n`;

    if (data.error) {
      output += `ERROR: ${data.error}\n\n`;
      continue;
    }

    if (typeof data === 'string') {
      output += data + '\n\n';
    } else if (Array.isArray(data)) {
      output += data.map((item, index) => `${index + 1}. ${item}`).join('\n') + '\n\n';
    } else if (typeof data === 'object') {
      if (detailed) {
        output += JSON.stringify(data, null, 2) + '\n\n';
      } else {
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'object' && value !== null) {
            output += `${key}: ${JSON.stringify(value, null, 2).slice(0, 200)}...\n`;
          } else {
            output += `${key}: ${value}\n`;
          }
        }
        output += '\n';
      }
    }
  }

  return output;
}

export default systemHealthVerification;
