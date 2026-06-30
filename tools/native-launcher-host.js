#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const EXTERNAL_REDEEM_PORT = 18789;
const MULTI_PROFILE_RUNNER_PORT = 18792;
const SERVICE_WAIT_MS = 12000;

const services = {
  externalRedeemProxy: {
    script: path.join(__dirname, 'external-redeem-proxy.js'),
    healthUrl: `http://${HOST}:${EXTERNAL_REDEEM_PORT}/healthz`,
    label: 'external-redeem-proxy',
  },
  multiProfileRunner: {
    script: path.join(__dirname, 'multi-profile-runner.js'),
    healthUrl: `http://${HOST}:${MULTI_PROFILE_RUNNER_PORT}/health`,
    label: 'multi-profile-runner',
  },
};

const children = new Map();

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let offset = 0;
    function readHeader() {
      const chunk = process.stdin.read(4 - offset);
      if (!chunk) {
        process.stdin.once('readable', readHeader);
        return;
      }
      chunk.copy(header, offset);
      offset += chunk.length;
      if (offset < 4) {
        readHeader();
        return;
      }
      const length = header.readUInt32LE(0);
      if (!length || length > 1024 * 1024) {
        reject(new Error('Invalid native message length.'));
        return;
      }
      const body = Buffer.alloc(length);
      let bodyOffset = 0;
      function readBody() {
        const bodyChunk = process.stdin.read(length - bodyOffset);
        if (!bodyChunk) {
          process.stdin.once('readable', readBody);
          return;
        }
        bodyChunk.copy(body, bodyOffset);
        bodyOffset += bodyChunk.length;
        if (bodyOffset < length) {
          readBody();
          return;
        }
        try {
          resolve(JSON.parse(body.toString('utf8')));
        } catch (error) {
          reject(new Error(`Invalid native JSON: ${error.message}`));
        }
      }
      readBody();
    }
    readHeader();
  });
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function isHealthy(service) {
  try {
    const data = await requestJson(service.healthUrl);
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function waitForHealthy(service) {
  const deadline = Date.now() + SERVICE_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(service)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function ensureService(name) {
  const service = services[name];
  if (!service) {
    throw new Error(`Unknown service: ${name}`);
  }
  if (await isHealthy(service)) {
    return { name, ok: true, alreadyRunning: true };
  }
  if (!fs.existsSync(service.script)) {
    throw new Error(`Service script not found: ${service.label}`);
  }
  const child = spawn(process.execPath, [service.script], {
    cwd: PROJECT_DIR,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  children.set(name, child);
  if (!(await waitForHealthy(service))) {
    throw new Error(`${service.label} 启动后健康检查未通过。`);
  }
  return { name, ok: true, started: true };
}

async function handleMessage(message = {}) {
  const type = String(message.type || '').trim();
  if (type === 'ping') {
    return { ok: true, service: 'gujumpgate-native-launcher' };
  }
  if (type === 'ensureServices') {
    const requested = Array.isArray(message.services) && message.services.length
      ? message.services.map((item) => String(item || '').trim()).filter(Boolean)
      : Object.keys(services);
    const results = [];
    for (const name of requested) {
      results.push(await ensureService(name));
    }
    return { ok: true, results };
  }
  throw new Error(`Unsupported native launcher command: ${type || '(empty)'}`);
}

(async () => {
  try {
    const message = await readMessage();
    const response = await handleMessage(message);
    writeMessage(response);
  } catch (error) {
    writeMessage({ ok: false, message: error?.message || String(error || 'native launcher failed') });
  }
})();
