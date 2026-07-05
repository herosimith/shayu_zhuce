// background/k12-workspace.js — K12 workspace invite helper.
(function attachK12Workspace(root, factory) {
  root.GuJumpgateK12Workspace = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createK12WorkspaceModule() {
  const DEFAULT_WORKSPACE_ID = '631e1603-06cf-4f0b-b79b-d09fbfcfe98d';
  const HISTORY_LIMIT = 80;
  const ICLOUD_API_MODE_NORMAL = 'normal';
  const ICLOUD_API_MODE_TAOBAO = 'taobao';
  const ICLOUD_API_MODE_HOTMAIL = 'hotmail';
  const ICLOUD_API_MODE_OUTLOOK_API = 'outlook-api';
  const TAOBAO_FEED_API_URL = 'https://assurivo.com/console/feed.php';
  const OUTLOOK_API_BASE_URL = 'http://query.paopaodw.com/boobar?email=';

  function normalizeString(value = '') {
    return String(value || '').trim();
  }

  function normalizeEmail(value = '') {
    return normalizeString(value).toLowerCase();
  }

  function isEmail(value = '') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
  }

  function normalizeUrl(value = '') {
    const raw = normalizeString(value);
    if (!raw) {
      return '';
    }
    try {
      const parsed = new URL(raw);
      return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : '';
    } catch {
      return '';
    }
  }

  function normalizeApiMode(value = '') {
    const normalized = normalizeString(value).toLowerCase();
    if (normalized === ICLOUD_API_MODE_OUTLOOK_API || normalized === 'outlook-api' || normalized === 'paopaodw' || normalized === 'outlook_http') {
      return ICLOUD_API_MODE_OUTLOOK_API;
    }
    if (normalized === ICLOUD_API_MODE_HOTMAIL || normalized === 'hotmail' || normalized === 'outlook' || normalized === 'microsoft' || normalized === 'graph') {
      return ICLOUD_API_MODE_HOTMAIL;
    }
    return normalized === ICLOUD_API_MODE_TAOBAO ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL;
  }

  function isTaobaoQueryCode(value = '') {
    const text = normalizeString(value);
    return Boolean(text)
      && !/^https?:\/\//i.test(text)
      && !/^[^@\s]+@[^@\s]+\.[^\s@]+$/.test(text)
      && /^[A-Za-z0-9_-]{6,}$/.test(text);
  }

  function buildTaobaoVerificationUrl(email = '', queryCode = '') {
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = normalizeString(queryCode);
    if (!normalizedEmail || !normalizedCode) {
      return '';
    }
    const params = new URLSearchParams({
      mail: normalizedEmail,
      pwd: normalizedCode,
      limit: '5',
    });
    return `${TAOBAO_FEED_API_URL}?${params.toString()}`;
  }

  function buildOutlookApiVerificationUrl(email = '', password = '') {
    const normalizedEmail = normalizeEmail(email);
    const normalizedPassword = normalizeString(password);
    if (!normalizedEmail || !normalizedPassword) {
      return '';
    }
    return `${OUTLOOK_API_BASE_URL}${normalizedEmail}----${normalizedPassword}`;
  }

  function makeEntryId(email = '', index = 0) {
    const safeEmail = normalizeEmail(email).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `k12-pool-${safeEmail || 'entry'}-${index + 1}`;
  }

  function normalizePoolCredential(rawValue = '', mode = ICLOUD_API_MODE_NORMAL, email = '') {
    const credential = normalizeString(rawValue);
    const normalizedMode = normalizeApiMode(mode);
    if (!credential) {
      return { apiMode: normalizedMode, verificationUrl: '', queryCode: '', password: '', clientId: '', refreshToken: '' };
    }
    const hotmailParts = credential.split('----').map((part) => normalizeString(part));
    if ((normalizedMode === ICLOUD_API_MODE_HOTMAIL || hotmailParts.length >= 3) && hotmailParts.length >= 3) {
      const password = hotmailParts[0] || '';
      const clientId = hotmailParts[1] || '';
      const refreshToken = hotmailParts.slice(2).join('----').trim();
      if (clientId && refreshToken) {
        return { apiMode: ICLOUD_API_MODE_HOTMAIL, verificationUrl: '', queryCode: '', password, clientId, refreshToken };
      }
    }
    if (normalizedMode === ICLOUD_API_MODE_OUTLOOK_API) {
      return {
        apiMode: ICLOUD_API_MODE_OUTLOOK_API,
        verificationUrl: buildOutlookApiVerificationUrl(email, credential),
        queryCode: '',
        password: credential,
        clientId: '',
        refreshToken: '',
      };
    }
    const verificationUrl = normalizeUrl(credential);
    if (verificationUrl) {
      let queryCode = '';
      try {
        const parsed = new URL(verificationUrl);
        const host = String(parsed.hostname || '').toLowerCase();
        if (host === 'assurivo.com' || host.endsWith('.assurivo.com')) {
          queryCode = normalizeString(parsed.searchParams.get('pwd') || '');
        }
      } catch {
        queryCode = '';
      }
      return {
        apiMode: queryCode ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL,
        verificationUrl,
        queryCode,
        password: '',
        clientId: '',
        refreshToken: '',
      };
    }
    if (normalizedMode === ICLOUD_API_MODE_TAOBAO || isTaobaoQueryCode(credential)) {
      return {
        apiMode: ICLOUD_API_MODE_TAOBAO,
        verificationUrl: buildTaobaoVerificationUrl(email, credential),
        queryCode: credential,
        password: '',
        clientId: '',
        refreshToken: '',
      };
    }
    return { apiMode: normalizedMode, verificationUrl: '', queryCode: '', password: '', clientId: '', refreshToken: '' };
  }

  function normalizeK12EmailPoolEntries(value = [], options = {}) {
    const mode = normalizeApiMode(options?.mode || ICLOUD_API_MODE_NORMAL);
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const entries = [];
    source.forEach((rawEntry, index) => {
      const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : { email: rawEntry };
      const rawEmail = normalizeString(entry.email || '');
      const splitParts = rawEmail.includes('----') ? rawEmail.split('----') : [];
      const email = normalizeEmail(splitParts.length ? splitParts.shift() : rawEmail);
      const parsedCredential = normalizePoolCredential(splitParts.join('----'), mode, email);
      const clientId = normalizeString(entry.clientId || entry.client_id || parsedCredential.clientId || '');
      const refreshToken = normalizeString(entry.refreshToken || entry.refresh_token || entry.token || parsedCredential.refreshToken || '');
      const hasHotmailCredential = Boolean(clientId && refreshToken);
      const outlookPassword = normalizeString(entry.outlookPassword || entry.outlook_password || parsedCredential.password || '');
      const apiMode = hasHotmailCredential
        ? ICLOUD_API_MODE_HOTMAIL
        : normalizeApiMode(entry.apiMode || (mode !== ICLOUD_API_MODE_NORMAL ? mode : '') || parsedCredential.apiMode || mode);
      const queryCode = apiMode === ICLOUD_API_MODE_HOTMAIL
        ? ''
        : normalizeString(entry.queryCode || entry.pwd || parsedCredential.queryCode || '');
      const verificationUrl = apiMode === ICLOUD_API_MODE_HOTMAIL
        ? ''
        : normalizeUrl(
          entry.verificationUrl
          || entry.url
          || entry.mailUrl
          || parsedCredential.verificationUrl
          || (apiMode === ICLOUD_API_MODE_OUTLOOK_API && outlookPassword ? buildOutlookApiVerificationUrl(email, outlookPassword) : '')
          || (apiMode === ICLOUD_API_MODE_TAOBAO && queryCode ? buildTaobaoVerificationUrl(email, queryCode) : '')
        );
      if (!isEmail(email) || seen.has(email)) {
        return;
      }
      seen.add(email);
      entries.push({
        id: normalizeString(entry.id) || makeEntryId(email, entries.length || index),
        email,
        enabled: entry.enabled !== undefined ? Boolean(entry.enabled) : true,
        used: Boolean(entry.used),
        note: normalizeString(entry.note || (apiMode === ICLOUD_API_MODE_HOTMAIL ? 'Hotmail' : (apiMode === ICLOUD_API_MODE_OUTLOOK_API ? 'Outlook API' : (apiMode === ICLOUD_API_MODE_TAOBAO ? '淘宝版' : (verificationUrl ? 'iCloud API' : ''))))),
        apiMode,
        queryCode: apiMode === ICLOUD_API_MODE_HOTMAIL ? '' : queryCode,
        password: apiMode === ICLOUD_API_MODE_HOTMAIL || apiMode === ICLOUD_API_MODE_OUTLOOK_API ? normalizeString(entry.password || parsedCredential.password || outlookPassword || '') : '',
        clientId: apiMode === ICLOUD_API_MODE_HOTMAIL ? clientId : '',
        refreshToken: apiMode === ICLOUD_API_MODE_HOTMAIL ? refreshToken : '',
        verificationUrl,
        lastUsedAt: Number.isFinite(Number(entry.lastUsedAt)) ? Number(entry.lastUsedAt) : 0,
        lastError: normalizeString(entry.lastError || ''),
        accessTokenCheck: entry.accessTokenCheck && typeof entry.accessTokenCheck === 'object'
          ? entry.accessTokenCheck
          : null,
      });
    });
    return entries;
  }

  function parseK12EmailPoolText(text = '', options = {}) {
    const mode = normalizeApiMode(options?.mode || ICLOUD_API_MODE_NORMAL);
    const existingEntries = normalizeK12EmailPoolEntries(options?.existingEntries || []);
    const existingByEmail = new Map(existingEntries.map((entry) => [entry.email, entry]));
    const lines = normalizeString(text).split(/\r?\n/).map((line) => normalizeString(line)).filter(Boolean);
    const parsed = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let source = line;
      if (!line.includes('----') && isEmail(line)) {
        const next = normalizeString(lines[index + 1] || '');
        if (next && (normalizeUrl(next) || isTaobaoQueryCode(next) || mode === ICLOUD_API_MODE_OUTLOOK_API)) {
          source = `${line}----${next}`;
          index += 1;
        }
      }
      const candidate = normalizeK12EmailPoolEntries([{ email: source }], { mode })[0] || null;
      if (!candidate) {
        continue;
      }
      const previous = existingByEmail.get(candidate.email) || {};
      parsed.push({
        ...candidate,
        id: previous.id || candidate.id || makeEntryId(candidate.email, parsed.length),
        enabled: previous.enabled !== undefined ? Boolean(previous.enabled) : candidate.enabled !== false,
        used: Boolean(previous.used),
        note: previous.note || candidate.note || '',
        lastUsedAt: Number(previous.lastUsedAt) || 0,
        lastError: normalizeString(previous.lastError || ''),
        accessTokenCheck: previous.accessTokenCheck || null,
      });
    }
    return normalizeK12EmailPoolEntries(parsed, { mode });
  }

  function serializeK12EmailPoolEntries(entries = []) {
    return normalizeK12EmailPoolEntries(entries).map((entry) => {
      if (entry.apiMode === ICLOUD_API_MODE_HOTMAIL) {
        return `${entry.email}----${entry.password || ''}----${entry.clientId || ''}----${entry.refreshToken || ''}`;
      }
      if (entry.apiMode === ICLOUD_API_MODE_OUTLOOK_API) {
        return `${entry.email}----${entry.password || ''}`;
      }
      if (entry.apiMode === ICLOUD_API_MODE_TAOBAO && entry.queryCode) {
        return `${entry.email}----${entry.queryCode}`;
      }
      return entry.verificationUrl ? `${entry.email}----${entry.verificationUrl}` : entry.email;
    }).filter(Boolean).join('\n');
  }

  function pickUnusedK12EmailPoolEntry(entries = []) {
    const normalizedEntries = normalizeK12EmailPoolEntries(entries);
    return normalizedEntries.find((entry) => entry.enabled !== false && !entry.used) || null;
  }

  function markK12EmailPoolEntryUsed(entries = [], email = '', options = {}) {
    const targetEmail = normalizeEmail(email);
    const now = Number(options?.lastUsedAt) || Date.now();
    return normalizeK12EmailPoolEntries(entries).map((entry) => {
      if (entry.email !== targetEmail) {
        return entry;
      }
      return {
        ...entry,
        used: options?.used === false ? false : true,
        lastUsedAt: now,
        lastError: normalizeString(options?.lastError || ''),
        accessTokenCheck: options?.accessTokenCheck || entry.accessTokenCheck || null,
      };
    });
  }

  function extractAccessToken(rawValue = '') {
    const raw = normalizeString(rawValue);
    if (!raw) {
      return '';
    }
    const fieldMatch = raw.match(/["']?access_token["']?\s*:\s*["']([A-Za-z0-9_\-=.]+)["']/i);
    if (fieldMatch?.[1] && fieldMatch[1].split('.').length === 3) {
      return fieldMatch[1].trim();
    }
    try {
      const parsed = JSON.parse(raw);
      const token = normalizeString(parsed?.access_token || parsed?.accessToken || parsed?.token?.access_token);
      if (token.split('.').length === 3) {
        return token;
      }
    } catch {
      // Try plain JWT below.
    }
    const cleaned = raw.replace(/^["'\s,]+|["'\s,]+$/g, '').replace(/\s+/g, '');
    return cleaned.split('.').length === 3 && cleaned.length > 50 ? cleaned : '';
  }

  function base64UrlDecodeJson(value = '') {
    try {
      const normalized = normalizeString(value)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      return JSON.parse(atob(padded));
    } catch {
      return {};
    }
  }

  function decodeAccessTokenInfo(accessToken = '') {
    const token = normalizeString(accessToken);
    const parts = token.split('.');
    if (parts.length !== 3) {
      return {};
    }
    const payload = base64UrlDecodeJson(parts[1]);
    const auth = payload?.['https://api.openai.com/auth'] || {};
    const profile = payload?.['https://api.openai.com/profile'] || {};
    const exp = Number(payload?.exp) || 0;
    return {
      email: normalizeString(profile?.email || payload?.email || ''),
      userId: normalizeString(auth?.user_id || payload?.sub || ''),
      poid: normalizeString(auth?.poid || ''),
      exp,
      expiresAt: exp > 0 ? exp * 1000 : 0,
    };
  }

  function maskToken(accessToken = '') {
    const token = normalizeString(accessToken);
    if (!token) {
      return '';
    }
    return token.length > 12 ? `...${token.slice(-10)}` : '...';
  }

  async function fetchTextWithTimeout(url, options = {}, timeoutMs = 30000) {
    const fetcher = typeof fetch === 'function' ? fetch.bind(globalThis) : null;
    if (!fetcher) {
      throw new Error('当前运行环境不支持 fetch，无法调用 K12 接口。');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || 30000);
    let timer = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) {
            controller.abort();
          }
          reject(new Error(`K12 接口请求超时（>${Math.round(effectiveTimeoutMs / 1000)} 秒）。`));
        }, effectiveTimeoutMs);
      });
      const response = await Promise.race([
        fetcher(url, { ...options, ...(controller ? { signal: controller.signal } : {}) }),
        timeoutPromise,
      ]);
      const text = await response.text().catch(() => '');
      return { response, text };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async function sendWorkspaceInvite(accessToken = '', workspaceId = DEFAULT_WORKSPACE_ID, route = 'request') {
    const token = normalizeString(accessToken);
    const normalizedWorkspaceId = normalizeString(workspaceId || DEFAULT_WORKSPACE_ID);
    const normalizedRoute = normalizeString(route) === 'accept' ? 'accept' : 'request';
    const endpoint = `https://chatgpt.com/backend-api/accounts/${encodeURIComponent(normalizedWorkspaceId)}/invites/${normalizedRoute}`;
    const { response, text } = await fetchTextWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'oai-device-id': crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        'oai-language': 'zh-CN',
      },
      body: '',
      cache: 'no-store',
      credentials: 'omit',
    }, 30000);
    return {
      route: normalizedRoute,
      ok: Boolean(response?.ok),
      status: Number(response?.status) || 0,
      text: normalizeString(text).slice(0, 600),
    };
  }

  function normalizeHistoryItem(item = {}) {
    return {
      id: normalizeString(item?.id) || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      email: normalizeString(item?.email),
      workspaceId: normalizeString(item?.workspaceId || DEFAULT_WORKSPACE_ID),
      ok: Boolean(item?.ok),
      finalRoute: normalizeString(item?.finalRoute),
      finalStatus: Number(item?.finalStatus) || 0,
      requestStatus: Number(item?.requestStatus) || 0,
      acceptStatus: Number(item?.acceptStatus) || 0,
      message: normalizeString(item?.message),
      tokenPreview: normalizeString(item?.tokenPreview),
      updatedAt: Number(item?.updatedAt) || Date.now(),
    };
  }

  async function runK12WorkspaceRedeem(deps = {}, options = {}) {
    const {
      getState,
      setState,
      broadcastDataUpdate,
      readChatGptAccessTokenInfo,
      readCurrentChatGptSessionForExport,
    } = deps;
    const state = typeof getState === 'function' ? await getState() : {};
    const workspaceId = normalizeString(options?.workspaceId || state?.k12WorkspaceId || DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID;
    let accessToken = extractAccessToken(options?.accessToken || options?.token || '');
    if (!accessToken && options?.useCurrent !== false) {
      if (typeof readCurrentChatGptSessionForExport === 'function') {
        const sessionState = await readCurrentChatGptSessionForExport({}).catch((error) => {
          throw new Error(`读取当前 ChatGPT AC 失败：${error?.message || error}`);
        });
        accessToken = extractAccessToken(sessionState?.accessToken || '');
      } else if (typeof readChatGptAccessTokenInfo === 'function') {
        const tokenInfo = await readChatGptAccessTokenInfo({ silent: true }).catch((error) => {
          throw new Error(`读取当前 ChatGPT AC 失败：${error?.message || error}`);
        });
        accessToken = extractAccessToken(tokenInfo?.accessToken || '');
      }
    }
    if (!accessToken) {
      throw new Error('请先粘贴 access_token，或打开 ChatGPT 后点击“使用当前 AC”。');
    }
    if (accessToken.split('.').length !== 3) {
      throw new Error('access_token 格式错误，应为 JWT 三段式。');
    }
    const tokenInfo = decodeAccessTokenInfo(accessToken);
    if (tokenInfo?.expiresAt && tokenInfo.expiresAt < Date.now()) {
      throw new Error('access_token 已过期，请重新同步当前 ChatGPT AC。');
    }

    const requestResult = await sendWorkspaceInvite(accessToken, workspaceId, 'request');
    let finalResult = requestResult;
    let acceptResult = null;
    if (!requestResult.ok) {
      acceptResult = await sendWorkspaceInvite(accessToken, workspaceId, 'accept');
      finalResult = acceptResult;
    }

    const message = finalResult.ok
      ? `${finalResult.route === 'request' ? 'Request' : 'Accept'} 成功`
      : `Request/Accept 都失败：HTTP ${finalResult.status || requestResult.status || 0}`;
    const historyItem = normalizeHistoryItem({
      email: tokenInfo.email,
      workspaceId,
      ok: finalResult.ok,
      finalRoute: finalResult.route,
      finalStatus: finalResult.status,
      requestStatus: requestResult.status,
      acceptStatus: acceptResult?.status || 0,
      message,
      tokenPreview: maskToken(accessToken),
      updatedAt: Date.now(),
    });
    const history = Array.isArray(state?.k12WorkspaceHistory) ? state.k12WorkspaceHistory : [];
    const updates = {
      k12WorkspaceId: workspaceId,
      k12WorkspaceLastResult: historyItem,
      k12WorkspaceHistory: [historyItem, ...history].slice(0, HISTORY_LIMIT),
    };
    if (typeof setState === 'function') {
      await setState(updates);
    }
    if (typeof broadcastDataUpdate === 'function') {
      broadcastDataUpdate(updates);
    }
    return {
      ok: finalResult.ok,
      workspaceId,
      email: tokenInfo.email,
      request: requestResult,
      accept: acceptResult,
      result: historyItem,
      state: typeof getState === 'function' ? await getState() : updates,
    };
  }

  async function clearK12WorkspaceHistory(deps = {}) {
    const updates = {
      k12WorkspaceLastResult: null,
      k12WorkspaceHistory: [],
    };
    if (typeof deps?.setState === 'function') {
      await deps.setState(updates);
    }
    if (typeof deps?.broadcastDataUpdate === 'function') {
      deps.broadcastDataUpdate(updates);
    }
    return {
      ok: true,
      state: typeof deps?.getState === 'function' ? await deps.getState() : updates,
    };
  }

  return {
    DEFAULT_WORKSPACE_ID,
    clearK12WorkspaceHistory,
    decodeAccessTokenInfo,
    extractAccessToken,
    markK12EmailPoolEntryUsed,
    normalizeApiMode,
    normalizeK12EmailPoolEntries,
    parseK12EmailPoolText,
    pickUnusedK12EmailPoolEntry,
    runK12WorkspaceRedeem,
    serializeK12EmailPoolEntries,
  };
});
