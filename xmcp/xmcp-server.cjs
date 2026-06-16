#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.XMCP_PORT || 3011);
const KEY_PATH = process.env.XMCP_KEY_PATH || '/opt/ava/mach6/.mcp/xmcp_api_key';
let API_KEY = process.env.XMCP_API_KEY || null;
if (!API_KEY) {
  try {
    API_KEY = fs.readFileSync(KEY_PATH, 'utf8').trim();
  } catch (e) {
    console.warn('xmcp: failed to read API key from file:', e.message);
    API_KEY = null;
  }
}

// Simple in-memory rate limiter per IP
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT = 60; // requests per window
const clients = new Map();
function allowRequest(ip) {
  const now = Date.now();
  const rec = clients.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > RATE_WINDOW_MS) { rec.ts = now; rec.count = 0; }
  rec.count += 1;
  clients.set(ip, rec);
  return rec.count <= RATE_LIMIT;
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!allowRequest(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

  // Origin auth header expected from Cloudflare Tunnel
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${API_KEY}`) {
    console.warn(`[xmcp] unauthorized request from ${ip} headers=${JSON.stringify(req.headers)}`);
    return unauthorized(res);
  }

  // Normalize path (support /xmcp/v1/* or /bind endpoints)
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname.replace(/^\/xmcp\/v1/, '') || url.pathname;

  if (req.method === 'POST' && (p === '/bind' || url.pathname === '/xmcp/v1/bind')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const obj = JSON.parse(body || '{}');
        console.info('[xmcp] bind', obj);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end('bad'); }
    });
    return;
  }

  if (req.method === 'POST' && (p === '/outbound' || url.pathname === '/xmcp/v1/outbound')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      console.info('[xmcp] outbound request', body.slice(0, 200));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'GET' && (p === '/health' || url.pathname === '/xmcp/v1/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.info(`xMCP server listening on ${PORT}`));
