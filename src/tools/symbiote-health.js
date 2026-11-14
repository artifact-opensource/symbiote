#!/usr/bin/env node
// System Health Verification Tool - Native CLI Wrapper
// Single command to run comprehensive system and hardware checks

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const ROOT = 'C:\\workspace\\symbiote';
const TOOLS_DIR = path.join(ROOT, 'src\\tools');
const TOOL_NAME = 'symbiote-health';
const DEFAULT_TIMEOUT = 60000; // 60 seconds

function checkFileExists(path) {
  try {
    return fs.statSync(path).size > 0;
  } catch {
    return false;
  }
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    execSync(command, {
      encoding: 'utf8',
      timeout: options.timeout || DEFAULT_TIMEOUT,
      maxBuffer: 1024 * 1024,
      ...options
    })
    .then(output => resolve(output))
    .catch(err => reject(new Error(`${options.command || 'command'} failed: ${err.message}`)));
  });
}

function getSystemState() {
  const info = [];
  info.push(`Hostname: ${process.platform}`);
  info.push(`Architecture: ${process.arch}`);
  info.push(`Node.js: ${process.version}`);
  info.push(`Working directory: ${process.cwd()}`);
  info.push(`Load average: ${require('os').loadavg()}`);
  info.push(`Process count: ${require('os').cpus().length}`);
  info.push(`Memory: ${Math.round(require('os').totalmem() / 1024 / 1024)} MB`);
  return info.join('\n');
}

function getHardwareInfo() {
  try {
    const result = execSync('wmic computersystem get TotalPhysicalMemory,FreePhysicalMemory /format:csv', { shell: 'cmd' });
    const [size, free] = result.split(',');
    const sizeGB = parseInt(size.replace(/,/g, '')) / 1024;
    const freeGB = parseInt(free.replace(/,/g, '')) / 1024;
    const usage = Math.round(((size - free) / size) * 100);

    return `Total RAM: ${sizeGB} GB\nFree RAM: ${freeGB} GB\nUsage: ${usage}%`;
  } catch (err) {
    return `Error getting hardware info: ${err.message}`;
  }
}

function getPortsStatus() {
  try {
    const result = execSync('netstat -an | findstr LISTENING', { shell: 'cmd', timeout: 30 });
    const lines = result.split('\n').filter(line => line.includes(':3007') ||
      line.includes(':3009') || line.includes(':5678') || line.includes(':11434'));
    return lines.join('\n');
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

function getLogsPreview() {
  const logFiles = ['symbiote.log', '.sessions/desktop-launch.log', '.sessions/health-events.jsonl'];
  let output = '=== LOG PREVIEW ===\n';

  for (const file of logFiles) {
    try {
      if (fs.existsSync(path.join(ROOT, file))) {
        const content = fs.readFileSync(path.join(ROOT, file), 'utf8').substring(0, 300);
        output += `\n--- ${file} ---\n${content}\n`;
      }
    }
  }

  return output;
}

function getCronJobs() {
  const cronDir = path.join(ROOT, '.agents', 'cron');
  if (!fs.existsSync(cronDir)) return 'Cron directory not found';

  const jobsFile = path.join(cronDir, 'jobs.json');
  if (fs.existsSync(jobsFile)) {
    try {
      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
      return `Cron jobs found: ${jobs.length}`;
    } catch (err) {
      return `Error reading jobs file: ${err.message}`;
    }
  }

  return 'No cron jobs found';
}

function getHealthSummary() {
  try {
    const status = execSync('wmic OS get caption,version,buildnumber /format:csv', { shell: 'cmd' });
    const [, version, build] = status.split(',');

    return `System: Windows ${version}\nBuild: ${build}\nTool Version: 1.0`;
  } catch (err) {
    return `Error: ${err.message}`;
  } catch {
    return 'Not available';
  }
}

function formatOutput(data, detailed = false) {
  if (typeof data === 'string') {
    return data;
  } else if (Array.isArray(data)) {
    return data.join('\n');
  } else if (typeof data === 'object') {
    if (detailed) {
      return JSON.stringify(data, null, 2);
    } else {
      let output = '';
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'object' && value !== null) {
          output += `${key}: `;
          if (Array.isArray(value)) {
            output += value.join(', ');
          } else {
            output += JSON.stringify(value).split('"')[1];
          }
        }
        return output + '\n';
      }
    }
  }
  return 'No data';
}

async function runAllChecks() {
  const results = {};

  try {
    results.system = getSystemState();
    results.hardware = getHardwareInfo();
    results.ports = getPortsStatus();
    results.logs = getLogsPreview();
    results.cron = getCronJobs();
    results.health = getHealthSummary();

    // Check if the main tool is available
    const toolPath = path.join(TOOLS_DIR, 'system_health_verification.js');
    if (checkFileExists(toolPath)) {
      results.tool = 'Available';
    } else {
      results.tool = 'Missing';
    }

    // Check if we can run the tool
    try {
      const toolResult = await execSync(`node "${toolPath}" --help`, { shell: 'cmd', timeout: 10000 });
      results.tool_status = 'functional';
    } catch (err) {
      results.tool_status = 'error: ' + err.message;
    }

  } catch (err) {
    results.error = `Critical failure: ${err.message}`;
  }

  return results;
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const detailed = args.includes('--detailed');
    const timeout = parseInt(args.find(arg => arg === '--timeout')?.split('=')[1]) || 60000;

    const results = await runAllChecks();

    console.log('\n=== SYMBIOTE SYSTEM HEALTH CHECK ===');
    console.log('\n--- SYSTEM STATE ---');
    console.log(results.system);

    console.log('\n--- HARDWARE ---');
    console.log(results.hardware);

    console.log('\n--- PORTS LISTENING ---');
    console.log(results.ports);

    console.log('\n--- LOG PREVIEW ---');
    console.log(results.logs);

    console.log('\n--- CRON STATUS ---');
    console.log(results.cron);

    console.log('\n--- HEALTH SUMMARY ---');
    console.log(results.health);

    console.log('\n--- TOOL STATUS ---');
    console.log(`Tool file: ${toolPath}`);
    console.log(`Tool status: ${results.tool_status || 'Not found'}`);

    if (detailed) {
      console.log('\n--- DETAILED RESULTS ---');
      console.log(JSON.stringify(results, null, 2));
    }

  } catch (error) {
    console.error(`\n=== SYSTEM HEALTH CHECK FAILED ===\n${err.message}\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n=== SYMBIOTE HEALTH TOOL FAILED ===\n${err.message}\n`);
  process.exit(1);
}

main();