// Symbiote — Web Browser Tools
// 14 tools powered by Playwright via Python sidecar process.
// Browser launches lazily on first call, closes after 5min idle.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../types.js';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

// ── Sidecar management ──────────────────────────────────────────────

let sidecar: ChildProcess | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let requestId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let buffer = '';

function ensureSidecar(): ChildProcess {
  if (sidecar && !sidecar.killed) {
    resetIdle();
    return sidecar;
  }

  const sidecarPath = resolve(__dirname_esm, '..', '..', 'src', 'web', 'browser-sidecar.py');

  sidecar = spawn('python3', [sidecarPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  sidecar.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      } catch { /* ignore non-JSON lines */ }
    }
  });

  sidecar.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error('[symbiote:web] ' + text);
  });

  sidecar.on('exit', (code) => {
    console.log('[symbiote:web] sidecar exited (code ' + code + ')');
    sidecar = null;
    for (const [id, p] of pending) {
      p.reject(new Error('Sidecar process exited'));
      pending.delete(id);
    }
  });

  resetIdle();
  return sidecar;
}

function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sidecar && !sidecar.killed) {
      sidecar.kill();
      sidecar = null;
      console.log('[symbiote:web] sidecar closed (idle timeout)');
    }
  }, 5 * 60 * 1000);
}

function rpc(method: string, params: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('RPC timeout: ' + method));
    }, 30_000);

    pending.set(id, {
      resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
      reject: (e: any) => { clearTimeout(timeout); reject(e); },
    });

    const proc = ensureSidecar();
    const msg = JSON.stringify({ id, method, params }) + '\n';
    proc.stdin!.write(msg);
  });
}

process.on('SIGTERM', () => { if (sidecar && !sidecar.killed) sidecar.kill(); });
process.on('SIGINT', () => { if (sidecar && !sidecar.killed) sidecar.kill(); });

// ── Tool definitions ─────────────────────────────────────────────────

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Navigate to a URL and return the page title, extracted text content, and a screenshot. Use this to visit any webpage.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to' },
      profile: { type: 'string', description: 'Browser profile name (default: "default")' },
    },
    required: ['url'],
  },
  async execute(input) {
    const result = await rpc('browse', { url: input.url as string, profile: input.profile as string });
    return '**' + result.title + '**\n' + result.url + '\n\n' + result.text;
  },
};

export const webClickTool: ToolDefinition = {
  name: 'web_click',
  description: 'Click an element on the current page by CSS selector or text content.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector or text to match (e.g. "button.submit" or "text=Sign In")' },
    },
    required: ['selector'],
  },
  async execute(input) {
    const result = await rpc('click', { selector: input.selector as string });
    return 'Clicked. Now on: **' + result.title + '**\n' + result.url + '\n\n' + result.text;
  },
};

export const webTypeTool: ToolDefinition = {
  name: 'web_type',
  description: 'Type text into an input field on the current page.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the input field' },
      text: { type: 'string', description: 'Text to type' },
      clear: { type: 'boolean', description: 'Clear field before typing (default: true)' },
    },
    required: ['selector', 'text'],
  },
  async execute(input) {
    const result = await rpc('type', {
      selector: input.selector as string,
      text: input.text as string,
      clear: input.clear !== false,
    });
    return 'Typed into ' + input.selector + '. Page: **' + result.title + '**';
  },
};

export const webScreenshotTool: ToolDefinition = {
  name: 'web_screenshot',
  description: 'Take a screenshot of the current page. Returns the file path.',
  parameters: {
    type: 'object',
    properties: {
      full_page: { type: 'boolean', description: 'Capture full page or just viewport (default: viewport)' },
    },
  },
  async execute(input) {
    const result = await rpc('screenshot', { full_page: input.full_page === true });
    return 'Screenshot saved: ' + result.path + ' (' + result.width + 'x' + result.height + ')';
  },
};

export const webExtractTool: ToolDefinition = {
  name: 'web_extract',
  description: 'Extract text content from specific elements on the current page using a CSS selector.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector to extract from (omit for full page text)' },
    },
  },
  async execute(input) {
    const result = await rpc('extract', { selector: input.selector as string });
    return result.text;
  },
};

export const webScrollTool: ToolDefinition = {
  name: 'web_scroll',
  description: 'Scroll the current page up, down, or to a specific element.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', description: '"up", "down", or "to" (scroll to element)' },
      selector: { type: 'string', description: 'CSS selector to scroll to (when direction="to")' },
      amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
    },
    required: ['direction'],
  },
  async execute(input) {
    const result = await rpc('scroll', {
      direction: input.direction as string,
      selector: input.selector as string,
      amount: input.amount as number,
    });
    return 'Scrolled ' + input.direction + '. Position: ' + result.scroll_y + 'px / ' + result.page_height + 'px';
  },
};

export const webWaitTool: ToolDefinition = {
  name: 'web_wait',
  description: 'Wait for an element to appear, a navigation to complete, or a fixed timeout.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
    },
  },
  async execute(input) {
    const result = await rpc('wait', {
      selector: input.selector as string,
      timeout: input.timeout as number,
    });
    return result.found ? 'Element found: ' + input.selector : 'Timeout waiting for ' + input.selector;
  },
};

export const webSessionTool: ToolDefinition = {
  name: 'web_session',
  description: 'Switch browser profile. Each profile has its own cookies, localStorage, and browsing history.',
  parameters: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'Profile name (e.g. "ali", "ava", "default")' },
    },
    required: ['profile'],
  },
  async execute(input) {
    const result = await rpc('session', { profile: input.profile as string });
    return 'Switched to profile: ' + result.profile;
  },
};

export const webTabOpenTool: ToolDefinition = {
  name: 'web_tab_open',
  description: 'Open a new browser tab, optionally navigating to a URL.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open in new tab (optional)' },
    },
  },
  async execute(input) {
    const result = await rpc('tab_open', { url: input.url as string });
    return 'New tab opened (' + result.tab_count + ' tabs). ' + (result.url ? 'Navigated to: ' + result.url : 'Blank tab.');
  },
};

export const webTabSwitchTool: ToolDefinition = {
  name: 'web_tab_switch',
  description: 'Switch to a different browser tab by index.',
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'number', description: 'Tab index (0-based)' },
    },
    required: ['index'],
  },
  async execute(input) {
    const result = await rpc('tab_switch', { index: input.index as number });
    return 'Switched to tab ' + input.index + ': **' + result.title + '** (' + result.url + ')';
  },
};

export const webTabCloseTool: ToolDefinition = {
  name: 'web_tab_close',
  description: 'Close the current browser tab.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const result = await rpc('tab_close', {});
    return 'Tab closed. ' + result.tab_count + ' tabs remaining.';
  },
};

export const webTabsTool: ToolDefinition = {
  name: 'web_tabs',
  description: 'List all open browser tabs with their titles and URLs.',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const result = await rpc('tabs', {});
    const lines = result.tabs.map((t: any, i: number) =>
      (t.active ? '→' : ' ') + ' [' + i + '] ' + t.title + ' — ' + t.url
    );
    return result.tabs.length + ' tabs:\n' + lines.join('\n');
  },
};

export const webDownloadTool: ToolDefinition = {
  name: 'web_download',
  description: 'Download a file from the current page or a URL. Saves to ~/.symbiote/downloads/',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Direct URL to download (optional)' },
      filename: { type: 'string', description: 'Save as filename (optional)' },
    },
  },
  async execute(input) {
    const result = await rpc('download', { url: input.url as string, filename: input.filename as string });
    return 'Downloaded: ' + result.path + ' (' + result.size + ' bytes)';
  },
};

export const webUploadTool: ToolDefinition = {
  name: 'web_upload',
  description: 'Upload a file to a file input element on the current page.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the file input element' },
      file_path: { type: 'string', description: 'Path to the file to upload' },
    },
    required: ['selector', 'file_path'],
  },
  async execute(input) {
    const result = await rpc('upload', {
      selector: input.selector as string,
      file_path: input.file_path as string,
    });
    return 'Uploaded ' + result.filename + ' to ' + input.selector;
  },
};

// ── Export all tools ──────────────────────────────────────────────────

export const webTools: ToolDefinition[] = [
  webBrowseTool, webClickTool, webTypeTool, webScreenshotTool,
  webExtractTool, webScrollTool, webWaitTool, webSessionTool,
  webTabOpenTool, webTabSwitchTool, webTabCloseTool, webTabsTool,
  webDownloadTool, webUploadTool,
];
