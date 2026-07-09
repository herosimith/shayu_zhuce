#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const HOST = process.env.EXTERNAL_REDEEM_PROXY_HOST || '127.0.0.1';
const PORT = Math.max(1, Math.min(65535, Number(process.env.EXTERNAL_REDEEM_PROXY_PORT) || 18789));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.EXTERNAL_REDEEM_PROXY_TIMEOUT_MS) || 30000);
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.EXTERNAL_REDEEM_PROXY_MAX_BODY_BYTES) || 2 * 1024 * 1024);
const SQLITE3_BIN = process.env.SQLITE3_BIN || 'sqlite3';
const SQLITE_TIMEOUT_MS = Math.max(3000, Number(process.env.EXTERNAL_REDEEM_SQLITE_TIMEOUT_MS) || 10000);
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'external-redeem-records.sqlite3');
const DB_PATH = path.resolve(process.env.EXTERNAL_REDEEM_DB_PATH || DEFAULT_DB_PATH);
const ALLOWED_UPSTREAM_PATHS = new Set([
  '/api/external/cdkey-redeems',
  '/api/external/cdkey-redeems/status',
]);
let sqliteReadyPromise = null;

function isAllowedOrigin(origin = '') {
  const value = String(origin || '').trim();
  if (!value) return true;
  return /^chrome-extension:\/\//i.test(value)
    || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(value);
}

function buildCorsHeaders(origin = '') {
  return {
    'access-control-allow-origin': origin && isAllowedOrigin(origin) ? origin : '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'accept,content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function writeJson(res, statusCode, payload, origin = '') {
  res.writeHead(statusCode, {
    ...buildCorsHeaders(origin),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sqlQuote(value) {
  if (value === undefined || value === null) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlInt(value) {
  if (value === undefined || value === null || value === '') return 'NULL';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : 'NULL';
}

function sqlBool(value) {
  if (value === undefined || value === null || value === '') return 'NULL';
  return value === true || value === 1 || value === '1' ? '1' : '0';
}

function runSql(sql, options = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const args = options.json ? ['-json', DB_PATH, sql] : [DB_PATH, sql];
    execFile(SQLITE3_BIN, args, { timeout: SQLITE_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || String(error)).trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function ensureSqliteReady() {
  if (!sqliteReadyPromise) {
    sqliteReadyPromise = runSql(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS email_redeem_records (
  email TEXT PRIMARY KEY,
  access_token_preview TEXT,
  access_token_length INTEGER,
  qualified INTEGER,
  token_ok INTEGER,
  eligible INTEGER,
  check_status INTEGER,
  check_reason TEXT,
  coupon_state TEXT,
  promo_id TEXT,
  plan_type TEXT,
  account_id TEXT,
  cdk TEXT,
  task_id TEXT,
  redeem_status TEXT,
  display_status TEXT,
  accepted INTEGER,
  transaction_id TEXT,
  transaction_status TEXT,
  reason TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_redeem_records_updated_at ON email_redeem_records(updated_at);
CREATE INDEX IF NOT EXISTS idx_email_redeem_records_cdk ON email_redeem_records(cdk);
`).catch((error) => {
      sqliteReadyPromise = null;
      throw error;
    });
  }
  return sqliteReadyPromise;
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeCdkey(value = '') {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeRecord(input = {}) {
  const now = new Date().toISOString();
  const check = input.accessTokenCheck && typeof input.accessTokenCheck === 'object'
    ? input.accessTokenCheck
    : {};
  const email = normalizeEmail(input.email || check.email);
  if (!email) {
    const error = new Error('email 不能为空');
    error.statusCode = 400;
    throw error;
  }

  return {
    email,
    accessTokenPreview: String(input.accessTokenPreview || input.access_token_preview || '').trim() || null,
    accessTokenLength: input.accessTokenLength ?? input.access_token_length ?? null,
    qualified: input.qualified ?? check.qualified ?? null,
    tokenOk: input.tokenOk ?? input.token_ok ?? check.tokenOk ?? null,
    eligible: input.eligible ?? check.eligible ?? null,
    checkStatus: input.checkStatus ?? input.check_status ?? check.status ?? null,
    checkReason: String(input.checkReason || input.check_reason || check.reason || '').trim() || null,
    couponState: String(input.couponState || input.coupon_state || check.couponState || '').trim() || null,
    promoId: String(input.promoId || input.promo_id || check.promoId || '').trim() || null,
    planType: String(input.planType || input.plan_type || check.planType || '').trim() || null,
    accountId: String(input.accountId || input.account_id || check.accountId || '').trim() || null,
    cdk: normalizeCdkey(input.cdk || input.cdkey || '') || null,
    taskId: String(input.taskId || input.task_id || '').trim() || null,
    redeemStatus: String(input.redeemStatus || input.redeem_status || input.status || '').trim().toLowerCase() || null,
    displayStatus: String(input.displayStatus || input.display_status || '').trim() || null,
    accepted: input.accepted ?? null,
    transactionId: String(input.transactionId || input.transaction_id || '').trim() || null,
    transactionStatus: String(input.transactionStatus || input.transaction_status || '').trim() || null,
    reason: String(input.reason || '').trim() || null,
    errorMessage: String(input.errorMessage || input.error_message || '').trim() || null,
    updatedAt: String(input.updatedAt || input.updated_at || now).trim() || now,
    createdAt: String(input.createdAt || input.created_at || now).trim() || now,
  };
}

function buildUpsertSql(record) {
  return `
INSERT INTO email_redeem_records (
  email, access_token_preview, access_token_length, qualified, token_ok, eligible,
  check_status, check_reason, coupon_state, promo_id, plan_type, account_id,
  cdk, task_id, redeem_status, display_status, accepted,
  transaction_id, transaction_status, reason, error_message, created_at, updated_at
) VALUES (
  ${sqlQuote(record.email)},
  ${sqlQuote(record.accessTokenPreview)},
  ${sqlInt(record.accessTokenLength)},
  ${sqlBool(record.qualified)},
  ${sqlBool(record.tokenOk)},
  ${sqlBool(record.eligible)},
  ${sqlInt(record.checkStatus)},
  ${sqlQuote(record.checkReason)},
  ${sqlQuote(record.couponState)},
  ${sqlQuote(record.promoId)},
  ${sqlQuote(record.planType)},
  ${sqlQuote(record.accountId)},
  ${sqlQuote(record.cdk)},
  ${sqlQuote(record.taskId)},
  ${sqlQuote(record.redeemStatus)},
  ${sqlQuote(record.displayStatus)},
  ${sqlBool(record.accepted)},
  ${sqlQuote(record.transactionId)},
  ${sqlQuote(record.transactionStatus)},
  ${sqlQuote(record.reason)},
  ${sqlQuote(record.errorMessage)},
  ${sqlQuote(record.createdAt)},
  ${sqlQuote(record.updatedAt)}
)
ON CONFLICT(email) DO UPDATE SET
  access_token_preview = COALESCE(excluded.access_token_preview, email_redeem_records.access_token_preview),
  access_token_length = COALESCE(excluded.access_token_length, email_redeem_records.access_token_length),
  qualified = COALESCE(excluded.qualified, email_redeem_records.qualified),
  token_ok = COALESCE(excluded.token_ok, email_redeem_records.token_ok),
  eligible = COALESCE(excluded.eligible, email_redeem_records.eligible),
  check_status = COALESCE(excluded.check_status, email_redeem_records.check_status),
  check_reason = COALESCE(excluded.check_reason, email_redeem_records.check_reason),
  coupon_state = COALESCE(excluded.coupon_state, email_redeem_records.coupon_state),
  promo_id = COALESCE(excluded.promo_id, email_redeem_records.promo_id),
  plan_type = COALESCE(excluded.plan_type, email_redeem_records.plan_type),
  account_id = COALESCE(excluded.account_id, email_redeem_records.account_id),
  cdk = COALESCE(excluded.cdk, email_redeem_records.cdk),
  task_id = COALESCE(excluded.task_id, email_redeem_records.task_id),
  redeem_status = COALESCE(excluded.redeem_status, email_redeem_records.redeem_status),
  display_status = COALESCE(excluded.display_status, email_redeem_records.display_status),
  accepted = COALESCE(excluded.accepted, email_redeem_records.accepted),
  transaction_id = COALESCE(excluded.transaction_id, email_redeem_records.transaction_id),
  transaction_status = COALESCE(excluded.transaction_status, email_redeem_records.transaction_status),
  reason = CASE
    WHEN lower(COALESCE(excluded.redeem_status, '')) = 'success'
      OR lower(COALESCE(excluded.transaction_status, '')) = 'paid'
      OR excluded.display_status LIKE '%成功%'
    THEN excluded.reason
    ELSE COALESCE(excluded.reason, email_redeem_records.reason)
  END,
  error_message = CASE
    WHEN lower(COALESCE(excluded.redeem_status, '')) = 'success'
      OR lower(COALESCE(excluded.transaction_status, '')) = 'paid'
      OR excluded.display_status LIKE '%成功%'
    THEN excluded.error_message
    ELSE COALESCE(excluded.error_message, email_redeem_records.error_message)
  END,
  updated_at = excluded.updated_at;
`;
}

function normalizeDbRow(row = {}) {
  return {
    email: String(row.email || '').trim().toLowerCase(),
    accessTokenPreview: String(row.access_token_preview || '').trim(),
    accessTokenLength: Number(row.access_token_length) || 0,
    qualified: Number(row.qualified) === 1,
    tokenOk: Number(row.token_ok) === 1,
    eligible: Number(row.eligible) === 1,
    checkStatus: Number(row.check_status) || 0,
    checkReason: String(row.check_reason || '').trim(),
    couponState: String(row.coupon_state || '').trim(),
    promoId: String(row.promo_id || '').trim(),
    planType: String(row.plan_type || '').trim(),
    accountId: String(row.account_id || '').trim(),
    cdk: String(row.cdk || '').trim(),
    taskId: String(row.task_id || '').trim(),
    redeemStatus: String(row.redeem_status || '').trim().toLowerCase(),
    displayStatus: String(row.display_status || '').trim(),
    accepted: Number(row.accepted) === 1,
    transactionId: String(row.transaction_id || '').trim(),
    transactionStatus: String(row.transaction_status || '').trim(),
    reason: String(row.reason || '').trim(),
    errorMessage: String(row.error_message || '').trim(),
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

async function upsertRedeemRecords(records = []) {
  await ensureSqliteReady();
  const normalized = records.map((record) => normalizeRecord(record));
  if (!normalized.length) {
    return [];
  }
  await runSql(`BEGIN;
${normalized.map(buildUpsertSql).join('\n')}
COMMIT;`);
  return normalized;
}

async function readRedeemRecords(limit = 500) {
  await ensureSqliteReady();
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));
  const output = await runSql(`
SELECT * FROM email_redeem_records
ORDER BY datetime(updated_at) DESC, email ASC
LIMIT ${safeLimit};
`, { json: true });
  const rows = output ? JSON.parse(output) : [];
  return Array.isArray(rows) ? rows.map(normalizeDbRow) : [];
}

async function deleteRedeemRecords(emails = null) {
  await ensureSqliteReady();
  const list = Array.isArray(emails)
    ? emails.map(normalizeEmail).filter(Boolean)
    : [];
  if (list.length) {
    const values = list.map((email) => sqlQuote(email)).join(', ');
    await runSql(`DELETE FROM email_redeem_records WHERE email IN (${values});`);
  } else {
    await runSql('DELETE FROM email_redeem_records;');
  }
  const remaining = await runSql('SELECT COUNT(*) AS n FROM email_redeem_records;', { json: true });
  const parsed = remaining ? JSON.parse(remaining) : [];
  return Number(parsed?.[0]?.n) || 0;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过限制 ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function normalizeUpstreamUrl(rawUrl = '') {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('上游地址必须是 http/https');
  }
  if (!ALLOWED_UPSTREAM_PATHS.has(url.pathname)) {
    throw new Error(`不允许代理该路径：${url.pathname}`);
  }
  return url;
}

async function forwardExternalRedeem(payload = {}) {
  const upstreamUrl = normalizeUpstreamUrl(payload.url);
  const apiKey = String(payload.apiKey || '').trim();
  if (!apiKey) {
    const error = new Error('apiKey 不能为空');
    error.statusCode = 400;
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'GuJumpgateExternalRedeemProxy/1.0',
        'X-External-Api-Key': apiKey,
      },
      body: JSON.stringify(payload.body || {}),
      signal: controller.signal,
    });
    const bodyText = await upstreamResponse.text();
    return {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      contentType: upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
      bodyText,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleRequest(req, res) {
  const origin = String(req.headers.origin || '');
  if (!isAllowedOrigin(origin)) {
    writeJson(res, 403, { code: 10003, message: 'Origin not allowed by local proxy' }, origin);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(origin));
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    writeJson(res, 200, { ok: true, service: 'external-redeem-proxy', port: PORT, dbPath: DB_PATH }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/redeem-records') {
    try {
      const records = await readRedeemRecords(url.searchParams.get('limit') || 500);
      writeJson(res, 200, { ok: true, dbPath: DB_PATH, records }, origin);
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 10007, message: `Read sqlite records failed: ${error.message || error}`, dbPath: DB_PATH }, origin);
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/redeem-records') {
    try {
      let emails = null;
      const rawBody = await readRequestBody(req);
      if (rawBody) {
        const body = JSON.parse(rawBody);
        if (Array.isArray(body?.emails)) {
          emails = body.emails;
        } else if (body?.email) {
          emails = [body.email];
        }
      }
      const remaining = await deleteRedeemRecords(emails);
      const records = await readRedeemRecords(500);
      writeJson(res, 200, { ok: true, dbPath: DB_PATH, remaining, records }, origin);
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 10008, message: `Delete sqlite records failed: ${error.message || error}`, dbPath: DB_PATH }, origin);
    }
    return;
  }

  if (req.method !== 'POST' || !['/external-redeem', '/redeem-records'].includes(url.pathname)) {
    writeJson(res, 404, { code: 10004, message: 'Not found' }, origin);
    return;
  }

  let payload = null;
  try {
    const rawBody = await readRequestBody(req);
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    writeJson(res, 400, { code: 10001, message: `Malformed local proxy request: ${error.message}` }, origin);
    return;
  }

  if (url.pathname === '/redeem-records') {
    try {
      const records = Array.isArray(payload?.records)
        ? payload.records
        : [payload?.record || payload].filter(Boolean);
      const savedRecords = await upsertRedeemRecords(records);
      const allRecords = await readRedeemRecords(payload?.limit || 500);
      writeJson(res, 200, { ok: true, dbPath: DB_PATH, saved: savedRecords.length, records: allRecords }, origin);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      writeJson(res, statusCode, { ok: false, code: 10007, message: `Write sqlite records failed: ${error.message || error}`, dbPath: DB_PATH }, origin);
    }
    return;
  }

  try {
    const upstream = await forwardExternalRedeem(payload);
    res.writeHead(upstream.status, {
      ...buildCorsHeaders(origin),
      'content-type': upstream.contentType,
      'cache-control': 'no-store',
      'x-gujumpgate-proxy': 'external-redeem',
      'x-upstream-status': String(upstream.status),
    });
    res.end(upstream.bodyText);
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const statusCode = Number(error?.statusCode) || (aborted ? 504 : 502);
    writeJson(res, statusCode, {
      code: 10006,
      message: aborted
        ? `Local external redeem proxy timeout after ${REQUEST_TIMEOUT_MS}ms`
        : `Local external redeem proxy failed: ${error.message || error}`,
    }, origin);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    writeJson(res, 500, {
      code: 10006,
      message: `Local external redeem proxy internal error: ${error.message || error}`,
    }, String(req.headers.origin || ''));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[external-redeem-proxy] listening on http://${HOST}:${PORT}`);
});
