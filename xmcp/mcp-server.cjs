#!/usr/bin/env node
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MCP_PORT || 3010);
const KEY_PATH = process.env.MCP_KEY_PATH || '/opt/ava/mach6/.mcp/xmcp_api_key';
let API_KEY = null;
try { API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim(); } catch (e) { console.error('mcp: failed to read API key:', e.message); process.exit(1); }

const server = http.createServer((req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'MCP', host: os.hostname(), pid: process.pid }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.info(`MCP server listening on ${PORT}`));
