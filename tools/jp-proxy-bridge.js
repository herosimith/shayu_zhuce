#!/usr/bin/env node
'use strict';

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');
const { SocksClient } = require('socks');

const HOST = process.env.JP_PROXY_BRIDGE_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.JP_PROXY_BRIDGE_PORT) || 18790));
const UPSTREAM_URL = process.env.JP_PROXY_UPSTREAM_URL || '';
const CONNECT_TIMEOUT_MS = Math.max(3000, Number(process.env.JP_PROXY_BRIDGE_CONNECT_TIMEOUT_MS) || 20000);
const SOCKET_IDLE_TIMEOUT_MS = Math.max(30000, Number(process.env.JP_PROXY_BRIDGE_IDLE_TIMEOUT_MS) || 180000);

function closeSocket(socket) {
  if (!socket || socket.destroyed) return;
  socket.destroy();
}

function parseUpstreamProxy(urlText = '') {
  const raw = String(urlText || '').trim();
  if (!raw) {
    throw new Error('JP_PROXY_UPSTREAM_URL is required.');
  }
  const normalizedRaw = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : normalizeColonUpstreamProxy(raw);
  const parsed = new URL(normalizedRaw);
  const protocol = parsed.protocol.replace(/:$/g, '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) {
    throw new Error('Only http/https/socks5/socks5h upstream proxy is supported.');
  }
  const host = String(parsed.hostname || '').trim();
  const port = Number.parseInt(String(parsed.port || ''), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid upstream host or port.');
  }
  return {
    protocol,
    host,
    port,
    username: parsed.username ? decodeURIComponent(parsed.username) : '',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
  };
}

function normalizeColonUpstreamProxy(raw = '') {
  const parts = String(raw || '').trim().split(':');
  if (parts.length < 4) {
    return raw;
  }
  const host = parts.shift().trim();
  const port = parts.shift().trim();
  const username = parts.shift().trim();
  const password = parts.join(':').trim();
  if (!host || !/^\d{1,5}$/.test(port) || !username) {
    return raw;
  }
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

function parseHostPort(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    const host = raw.slice(1, end);
    const port = Number.parseInt(raw.slice(end + 2), 10);
    return host && Number.isInteger(port) ? { host, port } : null;
  }
  const index = raw.lastIndexOf(':');
  if (index <= 0) return null;
  const host = raw.slice(0, index).trim();
  const port = Number.parseInt(raw.slice(index + 1), 10);
  return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

async function connectViaSocks5(upstream, target) {
  const result = await SocksClient.createConnection({
    command: 'connect',
    timeout: CONNECT_TIMEOUT_MS,
    proxy: {
      host: upstream.host,
      port: upstream.port,
      type: 5,
      userId: upstream.username || undefined,
      password: upstream.password || undefined,
    },
    destination: {
      host: target.host,
      port: target.port,
    },
  });
  const socket = result.socket;
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
  return socket;
}

function buildProxyAuthorizationHeader(upstream) {
  if (!upstream?.username && !upstream?.password) {
    return '';
  }
  return `Basic ${Buffer.from(`${upstream.username || ''}:${upstream.password || ''}`).toString('base64')}`;
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      closeSocket(socket);
      reject(new Error(`TCP connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
    });
    const timer = setTimeout(() => {
      closeSocket(socket);
      reject(new Error(`TLS connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readHttpHeaders(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`HTTP proxy CONNECT response timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onEnd() {
      cleanup();
      reject(new Error('HTTP proxy closed before CONNECT response.'));
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      cleanup();
      const headerBuffer = buffer.subarray(0, headerEnd + 4);
      const rest = buffer.subarray(headerEnd + 4);
      resolve({
        headers: headerBuffer.toString('latin1'),
        rest,
      });
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

async function connectViaHttpProxy(upstream, target) {
  const socket = upstream.protocol === 'https'
    ? await connectTls(upstream.host, upstream.port)
    : await connectTcp(upstream.host, upstream.port);
  const authHeader = buildProxyAuthorizationHeader(upstream);
  socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\n`);
  socket.write(`Host: ${target.host}:${target.port}\r\n`);
  if (authHeader) {
    socket.write(`Proxy-Authorization: ${authHeader}\r\n`);
  }
  socket.write('Proxy-Connection: keep-alive\r\n\r\n');
  const response = await readHttpHeaders(socket);
  const statusLine = String(response.headers || '').split(/\r\n/)[0] || '';
  if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d\b/i.test(statusLine)) {
    closeSocket(socket);
    throw new Error(`HTTP upstream CONNECT failed: ${statusLine || 'empty response'}`);
  }
  if (response.rest?.length) {
    socket.unshift(response.rest);
  }
  return socket;
}

async function connectViaUpstream(upstream, target) {
  if (upstream.protocol === 'socks5' || upstream.protocol === 'socks5h') {
    return connectViaSocks5(upstream, target);
  }
  return connectViaHttpProxy(upstream, target);
}

const upstream = parseUpstreamProxy(UPSTREAM_URL);

const server = http.createServer((req, res) => {
  (async () => {
    let targetUrl = null;
    try {
      targetUrl = new URL(req.url || '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('absolute proxy URL required\n');
      return;
    }
    if (!/^https?:$/i.test(targetUrl.protocol)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unsupported protocol\n');
      return;
    }
    const target = {
      host: targetUrl.hostname,
      port: Number(targetUrl.port) || (targetUrl.protocol === 'https:' ? 443 : 80),
    };
    const upstreamSocket = await connectViaUpstream(upstream, target);
    upstreamSocket.on('error', () => closeSocket(req.socket));
    req.socket.on('error', () => closeSocket(upstreamSocket));
    upstreamSocket.write(`${req.method} ${targetUrl.pathname || '/'}${targetUrl.search || ''} HTTP/${req.httpVersion}\r\n`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (/^proxy-/i.test(key)) continue;
      upstreamSocket.write(`${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
    }
    upstreamSocket.write('\r\n');
    req.pipe(upstreamSocket);
    upstreamSocket.pipe(res);
  })().catch((error) => {
    console.error(`[jp-proxy-bridge] HTTP ${req.method} ${req.url || ''} failed: ${error?.message || error}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`${error?.message || error}\n`);
  });
});

server.on('connect', async (req, clientSocket, head) => {
  const target = parseHostPort(req.url || '');
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  try {
    const upstreamSocket = await connectViaUpstream(upstream, target);
    clientSocket.on('error', () => closeSocket(upstreamSocket));
    upstreamSocket.on('error', () => closeSocket(clientSocket));
    clientSocket.on('timeout', () => closeSocket(upstreamSocket));
    upstreamSocket.on('timeout', () => closeSocket(clientSocket));
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: GuJumpgateJPBridge\r\n\r\n');
    if (head?.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  } catch (error) {
    console.error(`[jp-proxy-bridge] CONNECT ${target.host}:${target.port} failed: ${error?.message || error}`);
    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${error?.message || error}\n`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[jp-proxy-bridge] listening on http://${HOST}:${PORT}, upstream=${upstream.protocol}://${upstream.host}:${upstream.port}`);
});
