// background/k12-workspace.js — K12 workspace invite helper.
(function attachK12Workspace(root, factory) {
  root.GuJumpgateK12Workspace = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createK12WorkspaceModule() {
  const DEFAULT_WORKSPACE_ID = '631e1603-06cf-4f0b-b79b-d09fbfcfe98d';
  const HISTORY_LIMIT = 80;

  function normalizeString(value = '') {
    return String(value || '').trim();
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
    runK12WorkspaceRedeem,
  };
});
