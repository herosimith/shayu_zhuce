#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOST = process.env.MULTI_PROFILE_RUNNER_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.MULTI_PROFILE_RUNNER_PORT) || 18792));
const DEFAULT_BASE_PROFILE_DIR = path.join(os.homedir(), '.gujumpgate-icloud-api', 'profiles');
const DEFAULT_EXTENSION_DIR = path.resolve(__dirname, '..');
const DEFAULT_DEBUG_PORT_START = Math.max(
  1,
  Math.min(65535, Number(process.env.MULTI_PROFILE_DEBUG_PORT_START) || 19200)
);
const DEFAULT_PROXY_BRIDGE_PORT_START = Math.max(
  1,
  Math.min(65535, Number(process.env.MULTI_PROFILE_PROXY_BRIDGE_PORT_START) || 19300)
);
const CHROME_WAIT_TIMEOUT_MS = Math.max(5000, Number(process.env.MULTI_PROFILE_CHROME_WAIT_TIMEOUT_MS) || 25000);
const CDP_CALL_TIMEOUT_MS = Math.max(3000, Number(process.env.MULTI_PROFILE_CDP_CALL_TIMEOUT_MS) || 12000);
const THREAD_SNAPSHOT_TIMEOUT_MS = Math.max(3000, Number(process.env.MULTI_PROFILE_THREAD_SNAPSHOT_TIMEOUT_MS) || 8000);
const MAX_SNAPSHOT_LOGS = Math.max(20, Math.min(200, Number(process.env.MULTI_PROFILE_MAX_SNAPSHOT_LOGS) || 80));

const runs = new Map();

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizeThreadId(value = '') {
  return normalizeString(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `thread-${Date.now()}`;
}

function normalizeProxyUrl(value = '') {
  const raw = normalizeString(value);
  if (!raw) return '';
  const colonParts = raw.split(':');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && colonParts.length >= 4) {
    const host = colonParts.shift().trim();
    const port = colonParts.shift().trim();
    const username = colonParts.shift().trim();
    const password = colonParts.join(':').trim();
    if (host && /^\d{1,5}$/.test(port) && username) {
      return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
  }
  try {
    const parsed = new URL(raw);
    const protocol = String(parsed.protocol || '').replace(/:$/g, '').trim().toLowerCase();
    if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol)) return raw;
    const host = normalizeString(parsed.hostname);
    const port = normalizeString(parsed.port);
    if (!host || !/^\d{1,5}$/.test(port)) return raw;
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';
    const auth = username || password
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
      : '';
    return `${protocol}://${auth}${host}:${port}`;
  } catch {
    return raw;
  }
}

function getProxyDisplayName(proxyUrl = '') {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const protocol = String(parsed.protocol || '').replace(/:$/g, '').toLowerCase() || 'proxy';
    const host = normalizeString(parsed.hostname);
    const port = normalizeString(parsed.port);
    return port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
  } catch {
    return 'configured-proxy';
  }
}

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(normalizeString(value));
}

function buildTaobaoVerificationUrl(email = '', queryCode = '') {
  const normalizedEmail = normalizeString(email).toLowerCase();
  const normalizedCode = normalizeString(queryCode);
  if (!normalizedEmail || !normalizedCode) return '';
  const params = new URLSearchParams({
    mail: normalizedEmail,
    pwd: normalizedCode,
    limit: '5',
  });
  return `https://assurivo.com/console/feed.php?${params.toString()}`;
}

function parseEmailPoolLine(value = '') {
  const raw = normalizeString(value);
  if (!raw) {
    return {
      email: '',
      verificationUrl: '',
      queryCode: '',
      apiMode: '',
      password: '',
      clientId: '',
      refreshToken: '',
    };
  }
  const parts = raw.split('----');
  const email = normalizeString(parts.length > 1 ? parts.shift() : raw).toLowerCase();
  const credential = normalizeString(parts.length > 0 ? parts.join('----') : '');
  if (!credential) {
    return { email, verificationUrl: '', queryCode: '', apiMode: '', password: '', clientId: '', refreshToken: '' };
  }
  const hotmailParts = credential.split('----').map((part) => normalizeString(part));
  if (hotmailParts.length >= 3 && hotmailParts[1] && hotmailParts.slice(2).join('----')) {
    return {
      email,
      verificationUrl: '',
      queryCode: '',
      apiMode: 'hotmail',
      password: hotmailParts[0] || '',
      clientId: hotmailParts[1] || '',
      refreshToken: hotmailParts.slice(2).join('----'),
    };
  }
  if (isHttpUrl(credential)) {
    try {
      const parsed = new URL(credential);
      const host = normalizeString(parsed.hostname).toLowerCase();
      const queryCode = host === 'assurivo.com' || host.endsWith('.assurivo.com')
        ? normalizeString(parsed.searchParams.get('pwd') || '')
        : '';
      return {
        email,
        verificationUrl: parsed.toString(),
        queryCode,
        apiMode: queryCode ? 'taobao' : '',
        password: '',
        clientId: '',
        refreshToken: '',
      };
    } catch {
      return { email, verificationUrl: credential, queryCode: '', apiMode: '', password: '', clientId: '', refreshToken: '' };
    }
  }
  return {
    email,
    verificationUrl: buildTaobaoVerificationUrl(email, credential),
    queryCode: credential,
    apiMode: 'taobao',
    password: '',
    clientId: '',
    refreshToken: '',
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(payload));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function findChromeExecutable(explicitPath = '') {
  const bundledChromeForTestingDir = path.join(os.homedir(), '.agent-browser', 'browsers');
  let chromeForTestingCandidates = [];
  try {
    chromeForTestingCandidates = fs.existsSync(bundledChromeForTestingDir)
      ? fs.readdirSync(bundledChromeForTestingDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(
          bundledChromeForTestingDir,
          entry.name,
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        ))
      : [];
  } catch {
    chromeForTestingCandidates = [];
  }
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    ...chromeForTestingCandidates.reverse(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].map(normalizeString).filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('未找到 Chrome 可执行文件，可设置 CHROME_PATH 后再启动 runner。');
  }
  return found;
}

function isPortOpen(port, host = HOST) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForCdp(port) {
  const deadline = Date.now() + CHROME_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待 Chrome CDP 端口 ${port} 超时。`);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || CDP_CALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP WebSocket connect timeout.'));
      }, CDP_CALL_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connect failed.'));
      };
      ws.onmessage = (event) => {
        let message = null;
        try {
          message = JSON.parse(String(event.data || '{}'));
        } catch {
          return;
        }
        if (!message.id || !this.pending.has(message.id)) return;
        const { resolve: resolveCall, reject: rejectCall, timer: callTimer } = this.pending.get(message.id);
        clearTimeout(callTimer);
        this.pending.delete(message.id);
        if (message.error) {
          rejectCall(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          resolveCall(message.result || {});
        }
      };
      ws.onclose = () => {
        for (const { reject: rejectCall, timer: callTimer } of this.pending.values()) {
          clearTimeout(callTimer);
          rejectCall(new Error('CDP WebSocket closed.'));
        }
        this.pending.clear();
      };
    });
  }

  call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not connected.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

function findExtensionIdFromProfile(profileDir, extensionDir) {
  const prefPath = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(prefPath)) {
    return '';
  }
  let prefs = null;
  try {
    prefs = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
  } catch {
    return '';
  }
  const expectedPath = fs.existsSync(extensionDir) ? fs.realpathSync(extensionDir) : extensionDir;
  const settings = prefs?.extensions?.settings || {};
  for (const [extensionId, meta] of Object.entries(settings)) {
    const loadedPath = normalizeString(meta?.path || '');
    const manifestName = normalizeString(meta?.manifest?.name || '');
    try {
      if (loadedPath && fs.existsSync(loadedPath) && fs.realpathSync(loadedPath) === expectedPath) {
        return extensionId;
      }
    } catch {}
    if (/GuJumpgate iCloud API/i.test(manifestName)) {
      return extensionId;
    }
  }
  return '';
}

function deriveUnpackedExtensionId(extensionDir) {
  const extensionPath = fs.existsSync(extensionDir) ? fs.realpathSync(extensionDir) : path.resolve(extensionDir);
  const digest = crypto.createHash('sha256').update(extensionPath).digest();
  return Array.from(digest.slice(0, 16))
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join('');
}

function getExtensionIdFromTargetUrl(url = '') {
  const match = normalizeString(url).match(/^chrome-extension:\/\/([^/]+)/i);
  return match ? normalizeString(match[1]) : '';
}

async function getBrowserTargetInfos(debugPort) {
  const version = await fetchJson(`http://${HOST}:${debugPort}/json/version`);
  const wsUrl = normalizeString(version?.webSocketDebuggerUrl || '');
  if (!wsUrl) {
    return [];
  }
  const client = new CdpClient(wsUrl);
  await client.connect();
  try {
    const result = await client.call('Target.getTargets');
    return Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  } finally {
    client.close();
  }
}

async function getExtensionId(debugPort, profileDir, extensionDir) {
  const deadline = Date.now() + CHROME_WAIT_TIMEOUT_MS;
  const derivedExtensionId = deriveUnpackedExtensionId(extensionDir);
  while (Date.now() < deadline) {
    const targetLists = [];
    try {
      const targets = await fetchJson(`http://${HOST}:${debugPort}/json/list`);
      targetLists.push(Array.isArray(targets) ? targets : []);
    } catch {}
    try {
      targetLists.push(await getBrowserTargetInfos(debugPort));
    } catch {}
    for (const targets of targetLists) {
      for (const target of Array.isArray(targets) ? targets : []) {
        const extensionId = getExtensionIdFromTargetUrl(target?.url);
        if (extensionId === derivedExtensionId) {
          return extensionId;
        }
      }
    }
    const idFromProfile = findExtensionIdFromProfile(profileDir, extensionDir);
    if (idFromProfile) {
      return idFromProfile;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return derivedExtensionId;
}

async function findOpenedExtensionTarget(debugPort, extensionId) {
  const targetUrl = `chrome-extension://${extensionId}/sidepanel/sidepanel.html`;
  const extensionPrefix = `chrome-extension://${extensionId}/`;
  const targets = await fetchJson(`http://${HOST}:${debugPort}/json/list`);
  const list = Array.isArray(targets) ? targets : [];
  return list.find((target) => {
    const url = normalizeString(target?.url);
    return url.startsWith(targetUrl) && normalizeString(target?.webSocketDebuggerUrl);
  }) || list.find((target) => {
    const url = normalizeString(target?.url);
    return url.startsWith(extensionPrefix) && normalizeString(target?.webSocketDebuggerUrl);
  }) || null;
}

async function openExtensionTarget(debugPort, extensionId) {
  const targetUrl = `chrome-extension://${extensionId}/sidepanel/sidepanel.html`;
  const endpoint = `http://${HOST}:${debugPort}/json/new?${encodeURIComponent(targetUrl)}`;
  let createdTarget = null;
  try {
    createdTarget = await fetchJson(endpoint, { method: 'PUT' });
  } catch {
    createdTarget = await fetchJson(endpoint).catch(() => null);
  }
  const deadline = Date.now() + CHROME_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const openedTarget = await findOpenedExtensionTarget(debugPort, extensionId).catch(() => null);
    if (openedTarget?.webSocketDebuggerUrl) {
      return openedTarget;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (createdTarget?.webSocketDebuggerUrl && normalizeString(createdTarget?.url).startsWith(`chrome-extension://${extensionId}/`)) {
    return createdTarget;
  }
  throw new Error(`无法打开扩展页面用于初始化线程：未找到 ${extensionId} 的 sidepanel 页面。`);
}

async function initializeThreadExtension(debugPort, extensionId, settings, autoRunPayload, options = {}) {
  const target = await openExtensionTarget(debugPort, extensionId);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.call('Runtime.enable');
    const evalResult = await client.call('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `
        (async () => {
          const settings = ${JSON.stringify(settings)};
          const autoRunPayload = ${JSON.stringify(autoRunPayload)};
          const shouldAutoStart = ${options.autoStart === false ? 'false' : 'true'};
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            if (globalThis.chrome?.storage?.local && globalThis.chrome?.storage?.session && globalThis.chrome?.runtime?.sendMessage) {
              break;
            }
            await sleep(200);
          }
          if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.storage?.session || !globalThis.chrome?.runtime?.sendMessage) {
            return {
              ok: false,
              reason: 'extension_api_unavailable',
              href: location.href,
              title: document.title || '',
              hasChrome: Boolean(globalThis.chrome),
              hasStorage: Boolean(globalThis.chrome?.storage),
              hasRuntime: Boolean(globalThis.chrome?.runtime)
            };
          }
          await chrome.storage.local.set(settings);
          await chrome.storage.session.set(settings);
          if (!shouldAutoStart) {
            return { ok: true, autoStart: false };
          }
          const response = await chrome.runtime.sendMessage({
            type: 'AUTO_RUN',
            source: 'sidepanel',
            payload: autoRunPayload
          });
          return response || { ok: true };
        })()
      `,
    });
    if (evalResult?.exceptionDetails) {
      const text = normalizeString(evalResult.exceptionDetails?.text)
        || normalizeString(evalResult.exceptionDetails?.exception?.description)
        || '初始化独立扩展线程失败。';
      throw new Error(text);
    }
    const value = evalResult?.result?.value;
    if (value && typeof value === 'object' && value.ok === false) {
      throw new Error(`初始化独立扩展线程失败：${value.reason || 'unknown'} @ ${value.href || 'unknown page'}`);
    }
  } finally {
    client.close();
  }
}

async function getFirstPageTarget(debugPort) {
  const targets = await fetchJson(`http://${HOST}:${debugPort}/json/list`, { timeoutMs: THREAD_SNAPSHOT_TIMEOUT_MS });
  const list = Array.isArray(targets) ? targets : [];
  return list.find((target) => {
    const type = normalizeString(target?.type).toLowerCase();
    const url = normalizeString(target?.url);
    return type === 'page' && !/^chrome-extension:\/\//i.test(url) && !/^devtools:\/\//i.test(url);
  }) || list.find((target) => normalizeString(target?.type).toLowerCase() === 'page') || null;
}

async function getExtensionSnapshotTarget(debugPort, extensionId) {
  const targets = await fetchJson(`http://${HOST}:${debugPort}/json/list`, { timeoutMs: THREAD_SNAPSHOT_TIMEOUT_MS });
  const list = Array.isArray(targets) ? targets : [];
  const extensionUrlPrefix = `chrome-extension://${extensionId}/`;
  return list.find((target) => {
    const url = normalizeString(target?.url);
    return url.startsWith(`${extensionUrlPrefix}sidepanel/sidepanel.html`);
  }) || list.find((target) => {
    const url = normalizeString(target?.url);
    return url.startsWith(extensionUrlPrefix);
  }) || null;
}

async function readPageSnapshot(debugPort) {
  const target = await getFirstPageTarget(debugPort);
  const targetUrl = normalizeString(target?.url);
  const targetTitle = normalizeString(target?.title);
  const targetWsUrl = normalizeString(target?.webSocketDebuggerUrl);
  if (!targetWsUrl) {
    return {
      ok: false,
      error: 'missing_page_websocket',
      url: targetUrl,
      title: targetTitle,
    };
  }
  const client = new CdpClient(targetWsUrl);
  await client.connect();
  try {
    await client.call('Runtime.enable');
    const evalResult = await client.call('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `
        (() => ({
          ok: true,
          url: location.href,
          title: document.title || '',
          readyState: document.readyState || '',
          textPreview: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 500)
        }))()
      `,
    });
    if (evalResult?.exceptionDetails) {
      throw new Error(
        normalizeString(evalResult.exceptionDetails?.text)
        || normalizeString(evalResult.exceptionDetails?.exception?.description)
        || 'page snapshot failed'
      );
    }
    return evalResult?.result?.value && typeof evalResult.result.value === 'object'
      ? evalResult.result.value
      : {
        ok: true,
        url: targetUrl,
        title: targetTitle,
        readyState: '',
        textPreview: '',
      };
  } finally {
    client.close();
  }
}

async function readExtensionStorageSnapshot(debugPort, extensionId) {
  const target = await getExtensionSnapshotTarget(debugPort, extensionId);
  const targetWsUrl = normalizeString(target?.webSocketDebuggerUrl);
  if (!targetWsUrl) {
    return { ok: false, error: 'missing_extension_websocket' };
  }
  const client = new CdpClient(targetWsUrl);
  await client.connect();
  try {
    await client.call('Runtime.enable');
    const evalResult = await client.call('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `
        (async () => {
          const keys = [
            'logs',
            'nodeStatuses',
            'currentNodeId',
            'autoRunPhase',
            'autoRunning',
            'email',
            'registrationEmailState',
            'verificationRuntimeStatus',
            'signupVerificationRuntimeStatus',
            'loginVerificationRuntimeStatus',
            'externalRedeemQueue',
            'externalRedeemEnabled',
            'externalRedeemBaseUrl',
            'externalRedeemApiKey',
            'externalRedeemCdkeyPoolText',
            'externalRedeemLastSyncAt',
            'externalRedeemLastError',
            'externalRedeemRecords',
            'externalRedeemRecordsDbPath',
            'externalRedeemRecordsLastSyncAt',
            'externalRedeemRecordsLastError'
          ];
          const sessionData = await chrome.storage.session.get(keys);
          const localData = await chrome.storage.local.get([
            'customEmailPoolEntries',
            'externalRedeemEnabled',
            'externalRedeemBaseUrl',
            'externalRedeemApiKey',
            'externalRedeemCdkeyPoolText',
            'externalRedeemQueue',
            'externalRedeemRecords',
            'externalRedeemRecordsDbPath'
          ]);
          return {
            ok: true,
            state: sessionData || {},
            persisted: {
              customEmailPoolEntries: localData?.customEmailPoolEntries || [],
              externalRedeemEnabled: Boolean(localData?.externalRedeemEnabled),
              hasExternalRedeemApiKey: Boolean(String(localData?.externalRedeemApiKey || '').trim()),
              externalRedeemBaseUrl: String(localData?.externalRedeemBaseUrl || ''),
              hasCdkeyPool: Boolean(String(localData?.externalRedeemCdkeyPoolText || '').trim()),
              cdkeyCount: String(localData?.externalRedeemCdkeyPoolText || '')
                .split(/\\r?\\n/)
                .map((line) => String(line || '').trim())
                .filter(Boolean).length,
              externalRedeemQueue: Array.isArray(localData?.externalRedeemQueue) ? localData.externalRedeemQueue : [],
              externalRedeemRecords: Array.isArray(localData?.externalRedeemRecords) ? localData.externalRedeemRecords : [],
              externalRedeemRecordsDbPath: String(localData?.externalRedeemRecordsDbPath || '')
            }
          };
        })()
      `,
    });
    if (evalResult?.exceptionDetails) {
      throw new Error(
        normalizeString(evalResult.exceptionDetails?.text)
        || normalizeString(evalResult.exceptionDetails?.exception?.description)
        || 'extension snapshot failed'
      );
    }
    return evalResult?.result?.value && typeof evalResult.result.value === 'object'
      ? evalResult.result.value
      : { ok: false, error: 'empty_extension_snapshot' };
  } finally {
    client.close();
  }
}

async function readThreadExtensionSnapshot(thread = {}) {
  const debugPort = Number(thread.debugPort) || 0;
  const extensionId = normalizeString(thread.extensionId || '');
  if (!debugPort || !extensionId) {
    return { ok: false, error: 'missing_debug_or_extension_id' };
  }
  const [pageSnapshot, extensionSnapshot] = await Promise.all([
    readPageSnapshot(debugPort).catch((error) => ({ ok: false, error: error?.message || String(error || 'page snapshot failed') })),
    readExtensionStorageSnapshot(debugPort, extensionId),
  ]);
  const value = extensionSnapshot || {};
  const logs = Array.isArray(value?.state?.logs)
    ? value.state.logs.slice(-MAX_SNAPSHOT_LOGS).map((entry) => ({
      message: normalizeString(entry?.message),
      level: normalizeString(entry?.level || 'info').toLowerCase() || 'info',
      timestamp: Number(entry?.timestamp) || Date.now(),
      step: entry?.step ?? null,
      stepKey: normalizeString(entry?.stepKey || ''),
      nodeId: normalizeString(entry?.nodeId || ''),
    })).filter((entry) => entry.message)
    : [];
  return {
    ok: value?.ok !== false,
    url: normalizeString(pageSnapshot?.url || ''),
    title: normalizeString(pageSnapshot?.title || ''),
    readyState: normalizeString(pageSnapshot?.readyState || ''),
    textPreview: normalizeString(pageSnapshot?.textPreview || ''),
    pageError: pageSnapshot?.ok === false ? normalizeString(pageSnapshot.error || '') : '',
    autoRunPhase: normalizeString(value?.state?.autoRunPhase || ''),
    autoRunning: Boolean(value?.state?.autoRunning),
    currentNodeId: normalizeString(value?.state?.currentNodeId || ''),
    verificationRuntimeStatus: value?.state?.verificationRuntimeStatus && typeof value.state.verificationRuntimeStatus === 'object'
      ? value.state.verificationRuntimeStatus
      : null,
    signupVerificationRuntimeStatus: value?.state?.signupVerificationRuntimeStatus && typeof value.state.signupVerificationRuntimeStatus === 'object'
      ? value.state.signupVerificationRuntimeStatus
      : null,
    loginVerificationRuntimeStatus: value?.state?.loginVerificationRuntimeStatus && typeof value.state.loginVerificationRuntimeStatus === 'object'
      ? value.state.loginVerificationRuntimeStatus
      : null,
    nodeStatuses: value?.state?.nodeStatuses && typeof value.state.nodeStatuses === 'object'
      ? value.state.nodeStatuses
      : {},
    email: normalizeString(value?.state?.email || value?.state?.registrationEmailState?.currentEmail || thread.email || '').toLowerCase(),
    externalRedeemEnabled: Boolean(value?.state?.externalRedeemEnabled || value?.persisted?.externalRedeemEnabled),
    hasExternalRedeemApiKey: Boolean(
      normalizeString(value?.state?.externalRedeemApiKey || '').trim()
      || value?.persisted?.hasExternalRedeemApiKey
    ),
    externalRedeemCdkeyCount: normalizeString(value?.state?.externalRedeemCdkeyPoolText || '')
      .split(/\r?\n/)
      .map((line) => normalizeString(line))
      .filter(Boolean).length || Number(value?.persisted?.cdkeyCount) || 0,
    hasCdkeyPool: Boolean(value?.persisted?.hasCdkeyPool),
    externalRedeemQueue: Array.isArray(value?.state?.externalRedeemQueue)
      ? value.state.externalRedeemQueue
      : (Array.isArray(value?.persisted?.externalRedeemQueue) ? value.persisted.externalRedeemQueue : []),
    externalRedeemLastSyncAt: Number(value?.state?.externalRedeemLastSyncAt) || 0,
    externalRedeemLastError: normalizeString(value?.state?.externalRedeemLastError || ''),
    externalRedeemRecords: Array.isArray(value?.state?.externalRedeemRecords)
      ? value.state.externalRedeemRecords
      : (Array.isArray(value?.persisted?.externalRedeemRecords) ? value.persisted.externalRedeemRecords : []),
    externalRedeemRecordsDbPath: normalizeString(value?.state?.externalRedeemRecordsDbPath || value?.persisted?.externalRedeemRecordsDbPath || ''),
    externalRedeemRecordsLastSyncAt: Number(value?.state?.externalRedeemRecordsLastSyncAt) || 0,
    externalRedeemRecordsLastError: normalizeString(value?.state?.externalRedeemRecordsLastError || ''),
    logs,
    updatedAt: Date.now(),
  };
}

async function refreshThreadSnapshot(thread = {}) {
  try {
    thread.snapshot = await readThreadExtensionSnapshot(thread);
  } catch (error) {
    thread.snapshot = {
      ok: false,
      error: error?.message || String(error || 'snapshot failed'),
      updatedAt: Date.now(),
    };
  }
  return thread.snapshot;
}

async function refreshRunSnapshots(runRecord = {}) {
  const threads = Array.isArray(runRecord.threads) ? runRecord.threads : [];
  await Promise.all(threads.map((thread) => refreshThreadSnapshot(thread)));
  runRecord.updatedAt = Date.now();
  return runRecord;
}

function spawnProxyBridge(thread, port) {
  const upstream = normalizeProxyUrl(thread.proxyUrl || '');
  if (!upstream) return null;
  const child = spawn(process.execPath, [path.join(__dirname, 'jp-proxy-bridge.js')], {
    cwd: DEFAULT_EXTENSION_DIR,
    env: {
      ...process.env,
      JP_PROXY_BRIDGE_HOST: HOST,
      JP_PROXY_BRIDGE_PORT: String(port),
      JP_PROXY_UPSTREAM_URL: upstream,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[multi-profile-runner proxy ${thread.id}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[multi-profile-runner proxy ${thread.id}] ${chunk}`));
  return child;
}

async function waitForBridge(port, threadId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`线程 ${threadId} 的本地代理桥接端口 ${port} 启动超时。`);
}

function buildThreadSettings(baseSettings = {}, thread = {}) {
  const email = normalizeString(thread.email).toLowerCase();
  const cdkey = normalizeString(thread.cdkey);
  const emailPoolEntries = (Array.isArray(thread.emailPoolEntries) ? thread.emailPoolEntries : [])
    .map((entry, index) => {
      const rawLine = normalizeString(
        entry?.raw
        || entry?.line
        || (index === 0 ? thread.raw : '')
        || entry?.email
        || (index === 0 ? email : '')
      );
      const parsedLine = parseEmailPoolLine(rawLine);
      const entryEmail = normalizeString(entry?.email || parsedLine.email || (index === 0 ? email : '')).toLowerCase();
      if (!entryEmail) return null;
      const clientId = normalizeString(entry?.clientId || entry?.client_id || parsedLine.clientId || '');
      const refreshToken = normalizeString(entry?.refreshToken || entry?.refresh_token || entry?.token || parsedLine.refreshToken || '');
      const password = normalizeString(entry?.password || parsedLine.password || '');
      const hasHotmailCredential = Boolean(clientId && refreshToken);
      const queryCode = hasHotmailCredential ? '' : normalizeString(entry?.queryCode || entry?.pwd || parsedLine.queryCode || '');
      const apiMode = hasHotmailCredential ? 'hotmail' : (queryCode ? 'taobao' : normalizeString(entry?.apiMode || parsedLine.apiMode || baseSettings?.icloudApiMode || ''));
      const verificationUrl = normalizeString(
        apiMode === 'hotmail' ? '' : (entry?.verificationUrl
        || entry?.url
        || entry?.mailUrl
        || parsedLine.verificationUrl
        || (apiMode === 'taobao' && queryCode ? buildTaobaoVerificationUrl(entryEmail, queryCode) : ''))
      );
      return {
        id: normalizeString(entry?.id) || `runner-${thread.id}-${index + 1}`,
        email: entryEmail,
        raw: rawLine || normalizeString(entry?.email || entryEmail),
        enabled: entry?.enabled !== false,
        used: Boolean(entry?.used),
        note: normalizeString(entry?.note || ''),
        apiMode,
        queryCode,
        password: apiMode === 'hotmail' ? password : '',
        clientId: apiMode === 'hotmail' ? clientId : '',
        refreshToken: apiMode === 'hotmail' ? refreshToken : '',
        verificationUrl,
        lastUsedAt: Number(entry?.lastUsedAt) || 0,
      };
    })
    .filter(Boolean);
  const normalizedEmailPoolEntries = emailPoolEntries.length
    ? emailPoolEntries
    : (() => {
      const parsedLine = parseEmailPoolLine(thread.raw || email);
      const entryEmail = normalizeString(parsedLine.email || email).toLowerCase();
      if (!entryEmail) return [];
      const fallbackHasHotmail = Boolean(parsedLine.clientId && parsedLine.refreshToken);
      return [{
        id: thread.emailEntryId || `runner-${thread.id}`,
        email: entryEmail,
        raw: thread.raw || email,
        enabled: true,
        used: false,
        note: '',
        apiMode: fallbackHasHotmail ? 'hotmail' : (parsedLine.queryCode ? 'taobao' : normalizeString(baseSettings?.icloudApiMode || parsedLine.apiMode || '')),
        queryCode: fallbackHasHotmail ? '' : parsedLine.queryCode,
        password: fallbackHasHotmail ? parsedLine.password : '',
        clientId: fallbackHasHotmail ? parsedLine.clientId : '',
        refreshToken: fallbackHasHotmail ? parsedLine.refreshToken : '',
        verificationUrl: fallbackHasHotmail ? '' : parsedLine.verificationUrl,
        lastUsedAt: 0,
      }];
    })();
  const settings = {
    ...baseSettings,
    activeFlowId: 'openai',
    panelMode: 'checkout-conversion',
    plusModeEnabled: false,
    plusPaymentMethod: 'checkout-conversion',
    signupMethod: 'email',
    phoneVerificationEnabled: false,
    mailProvider: 'icloud-api',
    emailGenerator: 'custom-pool',
    customEmailPool: normalizedEmailPoolEntries
      .filter((entry) => entry.enabled && !entry.used)
      .map((entry) => entry.email),
    customEmailPoolEntries: normalizedEmailPoolEntries,
    externalRedeemCdkeyPoolText: cdkey,
    multiThreadEnabled: false,
    multiThreadCount: 1,
    multiThreadMode: 'isolated-profile-runner',
    multiThreadRunnerThreadId: thread.id,
    multiThreadRunnerRunId: thread.runId,
  };
  delete settings.multiThreadPlans;
  delete settings.multiThreadLogs;
  delete settings.multiThreadLastError;
  return settings;
}

function createRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function startThread(runContext, rawThread, index) {
  const thread = {
    ...rawThread,
    id: normalizeThreadId(rawThread.id || `thread-${index + 1}`),
  };
  const debugPort = Number(thread.debugPort) || (runContext.debugPortStart + index);
  const proxyBridgePort = Number(thread.proxyBridgePort) || (runContext.proxyBridgePortStart + index);
  const profileDir = path.join(runContext.baseProfileDir, runContext.runId, thread.id);
  ensureDir(profileDir);

  let localProxyUrl = '';
  let proxyBridgeProcess = null;
  let chromeProcess = null;
  try {
    if (normalizeProxyUrl(thread.proxyUrl || '')) {
      proxyBridgeProcess = spawnProxyBridge(thread, proxyBridgePort);
      await waitForBridge(proxyBridgePort, thread.id);
      localProxyUrl = `http://${HOST}:${proxyBridgePort}`;
    }

    const chromeArgs = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      `--disable-extensions-except=${runContext.extensionDir}`,
      `--load-extension=${runContext.extensionDir}`,
      '--enable-extensions',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--disable-search-engine-choice-screen',
      '--disable-features=Translate,OptimizationHints,MediaRouter,DisableLoadExtensionCommandLineSwitch',
      '--window-size=1220,980',
      '--new-window',
      'about:blank',
    ];
    if (localProxyUrl) {
      chromeArgs.splice(2, 0, `--proxy-server=${localProxyUrl}`);
    }

    chromeProcess = spawn(runContext.chromePath, chromeArgs, {
      cwd: runContext.extensionDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    chromeProcess.stdout.on('data', (chunk) => process.stdout.write(`[multi-profile-runner chrome ${thread.id}] ${chunk}`));
    chromeProcess.stderr.on('data', (chunk) => process.stderr.write(`[multi-profile-runner chrome ${thread.id}] ${chunk}`));

    await waitForCdp(debugPort);
    const extensionId = await getExtensionId(debugPort, profileDir, runContext.extensionDir);
    const settings = buildThreadSettings(runContext.baseSettings, {
      ...thread,
      runId: runContext.runId,
    });
    await initializeThreadExtension(debugPort, extensionId, settings, {
      totalRuns: 1,
      autoRunSkipFailures: true,
      mode: 'restart',
    }, {
      autoStart: runContext.autoStart,
    });

    return {
      id: thread.id,
      status: 'running',
      email: normalizeString(thread.email).toLowerCase(),
      hasCdkey: Boolean(normalizeString(thread.cdkey)),
      debugPort,
      proxyBridgePort: localProxyUrl ? proxyBridgePort : 0,
      proxyDisplay: getProxyDisplayName(thread.proxyUrl || ''),
      profileDir,
      extensionId,
      chromePid: chromeProcess.pid,
      proxyBridgePid: proxyBridgeProcess?.pid || 0,
      chromeProcess,
      proxyBridgeProcess,
      startedAt: Date.now(),
    };
  } catch (error) {
    try { chromeProcess?.kill(); } catch {}
    try { proxyBridgeProcess?.kill(); } catch {}
    throw error;
  }
}

async function startRun(payload = {}) {
  const threads = Array.isArray(payload.threads) ? payload.threads : [];
  if (!threads.length) {
    throw new Error('缺少线程计划。');
  }
  const runId = normalizeThreadId(payload.runId || createRunId());
  const extensionDir = path.resolve(normalizeString(payload.extensionDir) || DEFAULT_EXTENSION_DIR);
  const baseProfileDir = path.resolve(normalizeString(payload.baseProfileDir) || DEFAULT_BASE_PROFILE_DIR);
  const chromePath = findChromeExecutable(payload.chromePath);
  const runContext = {
    runId,
    chromePath,
    extensionDir,
    baseProfileDir,
    debugPortStart: Math.max(1, Math.min(65535, Number(payload.debugPortStart) || DEFAULT_DEBUG_PORT_START)),
    proxyBridgePortStart: Math.max(1, Math.min(65535, Number(payload.proxyBridgePortStart) || DEFAULT_PROXY_BRIDGE_PORT_START)),
    baseSettings: payload.baseSettings && typeof payload.baseSettings === 'object' ? payload.baseSettings : {},
    autoStart: payload.autoStart !== false,
  };
  ensureDir(path.join(baseProfileDir, runId));

  const runRecord = {
    id: runId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'starting',
    chromePath,
    threads: [],
  };
  runs.set(runId, runRecord);

  try {
    for (let index = 0; index < threads.length; index += 1) {
      const threadResult = await startThread(runContext, threads[index], index);
      runRecord.threads.push(threadResult);
      runRecord.updatedAt = Date.now();
    }
  } catch (error) {
    runRecord.status = 'failed';
    runRecord.error = error?.message || String(error || 'start failed');
    runRecord.updatedAt = Date.now();
    for (const thread of runRecord.threads || []) {
      try { thread.chromeProcess?.kill(); } catch {}
      try { thread.proxyBridgeProcess?.kill(); } catch {}
      thread.status = 'stopped';
    }
    throw error;
  }
  runRecord.status = 'running';
  runRecord.updatedAt = Date.now();
  return sanitizeRunRecord(runRecord);
}

function sanitizeRunRecord(runRecord = {}) {
  return {
    id: runRecord.id,
    status: runRecord.status,
    startedAt: runRecord.startedAt,
    updatedAt: runRecord.updatedAt,
    error: runRecord.error || '',
    chromePath: runRecord.chromePath || '',
    threads: (Array.isArray(runRecord.threads) ? runRecord.threads : []).map((thread) => ({
      id: thread.id,
      status: thread.status,
      email: thread.email,
      hasCdkey: thread.hasCdkey,
      debugPort: thread.debugPort,
      proxyBridgePort: thread.proxyBridgePort,
      proxyDisplay: thread.proxyDisplay,
      profileDir: thread.profileDir,
      extensionId: thread.extensionId,
      chromePid: thread.chromePid,
      proxyBridgePid: thread.proxyBridgePid,
      startedAt: thread.startedAt,
      snapshot: thread.snapshot || null,
    })),
  };
}

async function stopRun(runId = '') {
  const id = normalizeThreadId(runId);
  const runRecord = runs.get(id);
  if (!runRecord) return { ok: true, stopped: false, reason: 'not_found' };
  for (const thread of runRecord.threads || []) {
    try { thread.chromeProcess?.kill(); } catch {}
    try { thread.proxyBridgeProcess?.kill(); } catch {}
    thread.status = 'stopped';
  }
  runRecord.status = 'stopped';
  return { ok: true, stopped: true, run: sanitizeRunRecord(runRecord) };
}

function stopAllRuns() {
  for (const runRecord of runs.values()) {
    for (const thread of runRecord.threads || []) {
      try { thread.chromeProcess?.kill(); } catch {}
      try { thread.proxyBridgeProcess?.kill(); } catch {}
      thread.status = 'stopped';
    }
    runRecord.status = 'stopped';
  }
}

const server = http.createServer((req, res) => {
  (async () => {
    if (req.method === 'OPTIONS') {
      writeJson(res, 200, { ok: true });
      return;
    }
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        service: 'multi-profile-runner',
        port: PORT,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/runs') {
      await Promise.all(Array.from(runs.values()).map((run) => refreshRunSnapshots(run)));
      writeJson(res, 200, {
        ok: true,
        runs: Array.from(runs.values()).map((run) => sanitizeRunRecord(run)),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      const body = await parseJsonBody(req);
      const run = await startRun(body || {});
      writeJson(res, 200, { ok: true, run });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      const body = await parseJsonBody(req);
      writeJson(res, 200, await stopRun(body?.runId || ''));
      return;
    }
    writeJson(res, 404, { ok: false, message: 'Not found.' });
  })().catch((error) => {
    writeJson(res, 500, {
      ok: false,
      message: error?.message || String(error || 'internal error'),
    });
  });
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[multi-profile-runner] ${HOST}:${PORT} 已被占用，请释放端口或设置 MULTI_PROFILE_RUNNER_PORT 后重试。`);
  } else {
    console.error(`[multi-profile-runner] server error: ${error?.message || error}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[multi-profile-runner] listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAllRuns();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
