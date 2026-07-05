(function initSlimIcloudApiSidepanel() {
  const DEFAULT_EMAIL = 'chortle_palmate.3c@icloud.com';
  const DEFAULT_VERIFICATION_URL = 'http://icloudapi.xyz/show/AhobCgIfCgYMBBdfSERSIxsGGAQQHUMaHAhZExcDD0gQARwBSBoTCwNGDAoBEw==/chortle_palmate.3c@icloud.com';
  const DEFAULT_POOL_TEXT = `${DEFAULT_EMAIL}----${DEFAULT_VERIFICATION_URL}`;
  const CHECKOUT_CONVERSION = 'checkout-conversion';
  const ICLOUD_API_PROVIDER = 'icloudapi';
  const ICLOUD_API_MODE_NORMAL = 'normal';
  const ICLOUD_API_MODE_TAOBAO = 'taobao';
  const ICLOUD_API_MODE_HOTMAIL = 'hotmail';
  const TAOBAO_FEED_API_URL = 'https://assurivo.com/console/feed.php';
  const CUSTOM_POOL_GENERATOR = 'custom-pool';
  const EXTERNAL_REDEEM_DEFAULT_BASE_URL = 'https://chong.nerver.cc';
  const EXTERNAL_REDEEM_TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout', 'cancelled', 'rejected', 'not_found', 'submit_failed']);
  const MULTI_THREAD_SYNC_INTERVAL_MS = 3000;
  const DEFAULT_FEISHU_SYNC_CONFIG = {
    enabled: false,
    appId: '',
    appSecret: '',
    bitableAppToken: '',
    bitableTableId: '',
  };

  const els = {
    runCount: document.getElementById('input-run-count'),
    threadCount: document.getElementById('input-thread-count'),
    autoRun: document.getElementById('btn-auto-run'),
    prepareThreads: document.getElementById('btn-prepare-threads'),
    ensureLocalServices: document.getElementById('btn-ensure-local-services'),
    startMultiThread: document.getElementById('btn-start-multi-thread'),
    stopMultiThread: document.getElementById('btn-stop-multi-thread'),
    clearMultiThreadInfo: document.getElementById('btn-clear-multi-thread-info'),
    stop: document.getElementById('btn-stop'),
    reset: document.getElementById('btn-reset'),
    refresh: document.getElementById('btn-refresh'),
    save: document.getElementById('btn-save-settings'),
    clearUsed: document.getElementById('btn-clear-used'),
    clearPoolAll: document.getElementById('btn-clear-pool-all'),
    resetDefaultPool: document.getElementById('btn-reset-default-pool'),
    importEmailPoolCsv: document.getElementById('btn-import-email-pool-csv'),
    emailPoolFile: document.getElementById('input-email-pool-file'),
    icloudApiModeNormal: document.getElementById('input-icloud-api-mode-normal'),
    icloudApiModeTaobao: document.getElementById('input-icloud-api-mode-taobao'),
    icloudApiModeHotmail: document.getElementById('input-icloud-api-mode-hotmail'),
    poolFormatHint: document.getElementById('pool-format-hint'),
    syncChatgptAc: document.getElementById('btn-sync-chatgpt-ac'),
    viewChatgptAc: document.getElementById('btn-view-chatgpt-ac'),
    exportChatgptAc: document.getElementById('btn-export-chatgpt-ac'),
    feishuSyncEnabled: document.getElementById('input-feishu-sync-enabled'),
    feishuAppId: document.getElementById('input-feishu-app-id'),
    feishuAppSecret: document.getElementById('input-feishu-app-secret'),
    feishuBitableAppToken: document.getElementById('input-feishu-bitable-app-token'),
    feishuBitableTableId: document.getElementById('input-feishu-bitable-table-id'),
    testFeishuSync: document.getElementById('btn-test-feishu-sync'),
    syncFeishuNow: document.getElementById('btn-sync-feishu-now'),
    feishuSyncStatus: document.getElementById('feishu-sync-status'),
    testProxy: document.getElementById('btn-test-proxy'),
    uploadProxyPool: document.getElementById('btn-upload-proxy-pool'),
    testProxyPool: document.getElementById('btn-test-proxy-pool'),
    applyProxy: document.getElementById('btn-apply-proxy'),
    clearProxy: document.getElementById('btn-clear-proxy'),
    clearProxyPool: document.getElementById('btn-clear-proxy-pool'),
    emailPool: document.getElementById('input-email-pool'),
    checkoutProxy: document.getElementById('input-checkout-proxy'),
    checkoutProxyPool: document.getElementById('input-checkout-proxy-pool'),
    checkoutProxyPoolFile: document.getElementById('input-checkout-proxy-pool-file'),
    password: document.getElementById('input-password'),
    poolSummary: document.getElementById('pool-summary'),
    poolList: document.getElementById('pool-list'),
    chatgptAcStatus: document.getElementById('chatgpt-ac-status'),
    chatgptAcDetails: document.getElementById('chatgpt-ac-details'),
    externalRedeemEnabled: document.getElementById('input-external-redeem-enabled'),
    chatgptTotpAutoEnable: document.getElementById('input-chatgpt-totp-auto-enable'),
    externalRedeemBaseUrl: document.getElementById('input-external-redeem-base-url'),
    externalRedeemApiKey: document.getElementById('input-external-redeem-api-key'),
    externalRedeemCdkeys: document.getElementById('input-external-redeem-cdkeys'),
    externalRedeemCdkeyFile: document.getElementById('input-external-redeem-cdkey-file'),
    externalRedeemPollSeconds: document.getElementById('input-external-redeem-poll-seconds'),
    uploadExternalRedeemCdkeys: document.getElementById('btn-upload-external-redeem-cdkeys'),
    clearExternalRedeemCdkeys: document.getElementById('btn-clear-external-redeem-cdkeys'),
    clearExternalRedeemCdkeyHistory: document.getElementById('btn-clear-external-redeem-cdkey-history'),
    refreshExternalRedeem: document.getElementById('btn-refresh-external-redeem'),
    refreshExternalRedeemRecords: document.getElementById('btn-refresh-external-redeem-records'),
    clearExternalRedeemRecords: document.getElementById('btn-clear-external-redeem-records'),
    externalRedeemStatus: document.getElementById('external-redeem-status'),
    externalRedeemList: document.getElementById('external-redeem-list'),
    externalRedeemRecordsStatus: document.getElementById('external-redeem-records-status'),
    externalRedeemRecordsList: document.getElementById('external-redeem-records-list'),
    proxyTestResult: document.getElementById('proxy-test-result'),
    proxyPoolList: document.getElementById('proxy-pool-list'),
    multiThreadStatus: document.getElementById('multi-thread-status'),
    multiThreadPlans: document.getElementById('multi-thread-plans'),
    threadLogsGrid: document.getElementById('thread-logs-grid'),
    currentEmail: document.getElementById('current-email'),
    stepsList: document.getElementById('steps-list'),
    logsList: document.getElementById('logs-list'),
    toast: document.getElementById('toast'),
  };

  const stepDefinitions = [
    { id: 1, key: 'open-chatgpt', title: '打开 ChatGPT 官网' },
    { id: 2, key: 'submit-signup-email', title: '注册并输入邮箱' },
    { id: 3, key: 'fill-password', title: '填写密码并继续' },
    { id: 4, key: 'fetch-signup-code', title: '获取注册验证码' },
    { id: 5, key: 'fill-profile', title: '填写姓名和生日' },
    { id: 6, key: 'wait-registration-success', title: '等待注册成功并进入 ChatGPT' },
    { id: 7, key: 'chatgpt-ac-external-redeem', title: '检查 AC 资格并提交外部兑换' },
  ].slice().sort((left, right) => {
    const leftOrder = Number(left.order ?? left.id) || 0;
    const rightOrder = Number(right.order ?? right.id) || 0;
    return leftOrder - rightOrder;
  });

  let state = null;
  let toastTimer = 0;
  let autoRunStarting = false;
  let chatgptAcExpanded = false;
  let loginSecurityConfigDirty = false;
  let externalRedeemConfigDirty = false;
  let feishuConfigDirty = false;
  let multiThreadSyncTimer = 0;
  let multiThreadSyncInFlight = false;
  const fullAccessTokenByEmail = new Map();

  function htmlEscape(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, level = 'info', timeoutMs = 3600) {
    clearTimeout(toastTimer);
    els.toast.textContent = String(message || '');
    els.toast.dataset.level = level;
    els.toast.hidden = false;
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, timeoutMs);
  }

  function sendMessage(message, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${message.type} 请求超时`));
      }, timeoutMs);

      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (response?.error || response?.ok === false) {
          reject(new Error(response.error || response.message || `${message.type} 请求失败`));
          return;
        }
        resolve(response);
      });
    });
  }

  async function getCurrentWindowId() {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      const windowId = Number(currentWindow?.id) || 0;
      return Number.isInteger(windowId) && windowId > 0 ? windowId : null;
    } catch {
      return null;
    }
  }

  async function sendMessageWithWindow(message, timeoutMs = 45000) {
    const windowId = await getCurrentWindowId();
    return sendMessage({
      ...message,
      ...(windowId ? { windowId, automationWindowId: windowId } : {}),
      payload: {
        ...(message.payload || {}),
        ...(windowId ? { windowId, automationWindowId: windowId } : {}),
      },
    }, timeoutMs);
  }

  function isAutoRunActivePhase(phase = '') {
    return [
      'scheduled',
      'running',
      'waiting_step',
      'waiting_email',
      'retrying',
      'waiting_interval',
    ].includes(String(phase || '').trim().toLowerCase());
  }

  function normalizeEmail(value = '') {
    return String(value || '').trim();
  }

  function normalizeUrl(value = '') {
    return String(value || '').trim();
  }

  function normalizeProxyUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }
    const parts = raw.split(':');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && parts.length >= 4) {
      const host = parts.shift().trim();
      const port = parts.shift().trim();
      const username = parts.shift().trim();
      const password = parts.join(':').trim();
      if (host && /^\d{1,5}$/.test(port) && username) {
        return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      }
    }
    try {
      const parsed = new URL(raw);
      const protocol = String(parsed.protocol || '').replace(/:$/g, '').trim().toLowerCase();
      if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol)) {
        return raw;
      }
      const host = String(parsed.hostname || '').trim();
      const port = String(parsed.port || '').trim();
      if (!host || !/^\d{1,5}$/.test(port)) {
        return raw;
      }
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

  function normalizeThreadCount(value = 1) {
    const count = Math.floor(Number(value) || 1);
    return Math.max(1, Math.min(8, count));
  }

  function getThreadCountFromInput() {
    return normalizeThreadCount(els.threadCount?.value || state?.multiThreadCount || 1);
  }

  function normalizeProxyPoolEntry(value = '') {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) {
      return '';
    }
    try {
      const parsed = new URL(normalized);
      const protocol = String(parsed.protocol || '').replace(/:$/g, '').trim().toLowerCase();
      const host = String(parsed.hostname || '').trim();
      const port = String(parsed.port || '').trim();
      if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol) || !host || !/^\d{1,5}$/.test(port)) {
        return '';
      }
      return normalized;
    } catch {
      return '';
    }
  }

  function splitProxyPoolCandidates(value = '') {
    return String(value || '')
      .split(/\r?\n/)
      .flatMap((line) => String(line || '').split(/[\t,，]/g))
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function normalizeProxyPoolText(value = '') {
    const seen = new Set();
    const entries = [];
    splitProxyPoolCandidates(value)
      .forEach((candidate) => {
        const normalized = normalizeProxyPoolEntry(candidate);
        if (!normalized || seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        entries.push(normalized);
      });
    return entries.join('\n');
  }

  function getProxyPoolEntries() {
    return normalizeProxyPoolText(els.checkoutProxyPool?.value || '')
      .split('\n')
      .map((entry) => normalizeProxyPoolEntry(entry))
      .filter(Boolean);
  }

  function getProxyDisplayName(proxyUrl = '') {
    const normalized = normalizeProxyUrl(proxyUrl);
    if (!normalized) {
      return '未配置代理';
    }
    try {
      const parsed = new URL(normalized);
      const protocol = String(parsed.protocol || '').replace(/:$/g, '').toLowerCase() || 'proxy';
      const host = String(parsed.hostname || '').trim();
      const port = String(parsed.port || '').trim();
      if (host && port) {
        return `${protocol}://${host}:${port}`;
      }
      if (host) {
        return `${protocol}://${host}`;
      }
    } catch {
      // Keep credentials out of UI summaries when parsing fails.
    }
    return '已配置代理';
  }

  function sanitizeProxyErrorMessage(message = '') {
    const text = String(message || '代理测试失败').trim();
    if (!text) {
      return '代理测试失败';
    }
    const withoutUrls = text.replace(
      /\b(?:https?|socks5h?|socks4):\/\/[^\s，。；;]+/gi,
      (match) => getProxyDisplayName(match)
    );
    return withoutUrls.slice(0, 220);
  }

  function renderProxyPoolResults(results = []) {
    if (!els.proxyPoolList) {
      return;
    }
    const entries = getProxyPoolEntries();
    if (!entries.length && !results.length) {
      els.proxyPoolList.innerHTML = '';
      return;
    }
    const resultByIndex = new Map(
      (Array.isArray(results) ? results : [])
        .filter((item) => item && Number.isInteger(Number(item.index)))
        .map((item) => [Number(item.index), item])
    );
    els.proxyPoolList.innerHTML = entries.map((proxyUrl, index) => {
      const result = resultByIndex.get(index) || null;
      const status = result
        ? (result.ok ? '可用' : '失败')
        : '待测试';
      const statusClass = result
        ? (result.ok ? 'success' : 'failed')
        : 'skipped';
      const details = result
        ? (result.ok
          ? [
            String(result.exitIp || '').trim(),
            String(result.exitRegion || '').trim(),
          ].filter(Boolean).join(' / ') || '已通过'
          : sanitizeProxyErrorMessage(result.error))
        : '自动运行会按列表顺序取用，取完从第一条继续。';
      return `
        <div class="redeem-item">
          <div class="redeem-head">
            <strong>${index + 1}. ${htmlEscape(getProxyDisplayName(proxyUrl))}</strong>
            <span class="badge ${statusClass}">${htmlEscape(status)}</span>
          </div>
          <div class="pool-meta">${htmlEscape(details)}</div>
        </div>
      `;
    }).join('');
  }

  function normalizeIcloudApiMode(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === ICLOUD_API_MODE_HOTMAIL || normalized === 'outlook' || normalized === 'microsoft') {
      return ICLOUD_API_MODE_HOTMAIL;
    }
    return normalized === ICLOUD_API_MODE_TAOBAO
      ? ICLOUD_API_MODE_TAOBAO
      : ICLOUD_API_MODE_NORMAL;
  }

  function getSelectedIcloudApiMode() {
    if (els.icloudApiModeHotmail?.checked) {
      return ICLOUD_API_MODE_HOTMAIL;
    }
    return els.icloudApiModeTaobao?.checked ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL;
  }

  function getIcloudApiModeLabel(mode = '') {
    const normalized = normalizeIcloudApiMode(mode);
    if (normalized === ICLOUD_API_MODE_HOTMAIL) return 'Hotmail';
    if (normalized === ICLOUD_API_MODE_TAOBAO) return '淘宝版';
    return '普通版';
  }

  function isTaobaoQueryCode(value = '') {
    const text = String(value || '').trim();
    return Boolean(text)
      && !/^https?:\/\//i.test(text)
      && !/^[^@\s]+@[^@\s]+\.[^\s@]+$/.test(text)
      && /^[A-Za-z0-9_-]{6,}$/.test(text);
  }

  function buildTaobaoVerificationUrl(email = '', queryCode = '') {
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = String(queryCode || '').trim();
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

  function applyIcloudApiModeUi(mode = ICLOUD_API_MODE_NORMAL) {
    const normalized = normalizeIcloudApiMode(mode);
    if (els.icloudApiModeNormal) {
      els.icloudApiModeNormal.checked = normalized === ICLOUD_API_MODE_NORMAL;
    }
    if (els.icloudApiModeTaobao) {
      els.icloudApiModeTaobao.checked = normalized === ICLOUD_API_MODE_TAOBAO;
    }
    if (els.icloudApiModeHotmail) {
      els.icloudApiModeHotmail.checked = normalized === ICLOUD_API_MODE_HOTMAIL;
    }
    if (els.poolFormatHint) {
      const hints = {
        [ICLOUD_API_MODE_TAOBAO]: '淘宝版：每行 邮箱----邮件查询码，例如 baptism_gators40@icloud.com----查询码；后台会自动请求 assurivo JSON。',
        [ICLOUD_API_MODE_HOTMAIL]: 'Hotmail：每行 邮箱----密码----client_id----refresh_token；取码靠 client_id 和 refresh_token，密码只用于记录。',
        [ICLOUD_API_MODE_NORMAL]: '普通版：每行 邮箱----完整接口URL，也兼容下一行单独放接口URL。',
      };
      els.poolFormatHint.textContent = hints[normalized] || hints[ICLOUD_API_MODE_NORMAL];
    }
  }

  function normalizeExternalRedeemCdkeyPoolText(value = '') {
    const seen = new Set();
    return String(value || '')
      .split(/[\r\n,;\t ]+/)
      .map((line) => String(line || '').trim())
      .filter((line) => {
        if (!line || seen.has(line)) {
          return false;
        }
        seen.add(line);
        return true;
      })
      .join('\n');
  }

  function mergeExternalRedeemCdkeys(...texts) {
    return normalizeExternalRedeemCdkeyPoolText(texts.filter(Boolean).join('\n'));
  }

  function getExternalRedeemQueue() {
    return Array.isArray(state?.externalRedeemQueue)
      ? state.externalRedeemQueue.filter((item) => item && typeof item === 'object')
      : [];
  }

  function getExternalRedeemRecords() {
    return Array.isArray(state?.externalRedeemRecords)
      ? state.externalRedeemRecords.filter((item) => item && typeof item === 'object')
      : [];
  }

  function getExternalRedeemUsedEmailSet() {
    const usedEmails = new Set();
    getExternalRedeemQueue().forEach((item) => {
      const email = normalizeEmail(item?.email).toLowerCase();
      const cdk = String(item?.cdkey || '').trim();
      if (email && cdk) {
        usedEmails.add(email);
      }
    });
    getExternalRedeemRecords().forEach((record) => {
      const email = normalizeEmail(record?.email).toLowerCase();
      const cdk = String(record?.cdk || record?.cdkey || '').trim();
      const status = String(record?.redeemStatus || record?.status || record?.displayStatus || '').trim();
      if (email && (cdk || status)) {
        usedEmails.add(email);
      }
    });
    return usedEmails;
  }

  function isExternalRedeemTerminal(status = '') {
    return EXTERNAL_REDEEM_TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
  }

  function hasExternalRedeemRechargeFailureSignal(item = {}) {
    const status = String(item?.status || item?.redeemStatus || item?.redeem_status || '').trim().toLowerCase();
    if (status === 'success') {
      return false;
    }
    const text = [
      item?.reason,
      item?.errorMessage,
      item?.error_message,
      item?.displayStatus,
      item?.display_status,
      item?.message,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
    return /充值失败|支付失败|付款失败|recharge\s*failed|br\s*recharge\s*failed|payment\s*failed|failed\s*to\s*recharge/.test(text);
  }

  function isExternalRedeemFailedItem(item = {}) {
    const status = String(item?.status || item?.redeemStatus || '').trim().toLowerCase();
    if (hasExternalRedeemRechargeFailureSignal(item)) {
      return true;
    }
    return Boolean(status)
      && status !== 'success'
      && isExternalRedeemTerminal(status);
  }

  function formatDateTime(value) {
    if (value === null || value === undefined || value === '') {
      return '-';
    }
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric)
      : new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function getChatGptAcInfo() {
    return state?.chatgptAccessTokenInfo || null;
  }

  function getChatGptAcCheck() {
    return state?.chatgptAccessTokenCheck || null;
  }

  function getChatGptAcRecords() {
    return state?.chatgptAccessTokenRecords && typeof state.chatgptAccessTokenRecords === 'object'
      ? state.chatgptAccessTokenRecords
      : {};
  }

  function getChatGptAcHistory() {
    return Array.isArray(state?.chatgptAccessTokenHistory)
      ? state.chatgptAccessTokenHistory.filter((item) => item && typeof item === 'object')
      : [];
  }

  function getAcCheckLabel(check = null) {
    if (!check?.checked) {
      return '未检测';
    }
    if (check.qualified) {
      return '合格';
    }
    if (check.error) {
      return '检测失败';
    }
    if (check.tokenOk === false) {
      return 'AC 无效';
    }
    return '不合格';
  }

  function getAcSummaryLabel(info = null, check = null) {
    if (!info?.hasAccessToken) {
      return '未读取';
    }
    return getAcCheckLabel(check);
  }

  function rememberFullAccessToken(email = '', token = '') {
    const normalizedEmail = normalizeEmail(email).toLowerCase();
    const normalizedToken = String(token || '').trim();
    if (normalizedEmail && normalizedToken) {
      fullAccessTokenByEmail.set(normalizedEmail, normalizedToken);
    }
  }

  function isEmail(value = '') {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim());
  }

  function findFirstEmail(value = '') {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? normalizeEmail(match[0]) : '';
  }

  function findFirstUrl(value = '') {
    const match = String(value || '').match(/https?:\/\/[^\s"',，]+/i);
    return match ? normalizeUrl(match[0]) : '';
  }

  function isHttpUrl(value = '') {
    return /^https?:\/\//i.test(String(value || '').trim());
  }

  function extractTaobaoQueryCodeFromUrl(value = '') {
    const raw = String(value || '').trim();
    if (!isHttpUrl(raw)) {
      return '';
    }
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || '').toLowerCase();
      if (host !== 'assurivo.com' && !host.endsWith('.assurivo.com')) {
        return '';
      }
      return String(parsed.searchParams.get('pwd') || '').trim();
    } catch {
      return '';
    }
  }

  function parseHotmailCredential(rawValue = '') {
    const parts = String(rawValue || '').split('----').map((part) => String(part || '').trim());
    return {
      password: parts[0] || '',
      clientId: parts[1] || '',
      refreshToken: parts.slice(2).join('----').trim(),
    };
  }

  function hasHotmailCredential(rawValue = '') {
    const credential = parseHotmailCredential(rawValue);
    return Boolean(credential.clientId && credential.refreshToken);
  }

  function maskSecret(value = '', visible = 4) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= visible * 2 + 3) return `${text.slice(0, visible)}...`;
    return `${text.slice(0, visible)}...${text.slice(-visible)}`;
  }

  function buildHotmailPoolLine(entry = {}, options = {}) {
    const email = normalizeEmail(entry.email);
    const rawPassword = String(entry.password || '').trim();
    const password = options.mask && rawPassword ? '********' : rawPassword;
    const clientId = String(entry.clientId || '').trim();
    const refreshToken = String(entry.refreshToken || '').trim();
    if (!email) return '';
    if (!password && !clientId && !refreshToken) return email;
    const token = options.mask ? maskSecret(refreshToken, 6) : refreshToken;
    return `${email}----${password}----${clientId}----${token}`;
  }

  function normalizePoolCredential(rawValue = '', mode = ICLOUD_API_MODE_NORMAL, email = '') {
    const credential = String(rawValue || '').trim();
    const normalizedMode = normalizeIcloudApiMode(mode);
    if (normalizedMode === ICLOUD_API_MODE_HOTMAIL || hasHotmailCredential(credential)) {
      const hotmail = parseHotmailCredential(credential);
      return {
        apiMode: ICLOUD_API_MODE_HOTMAIL,
        verificationUrl: '',
        queryCode: '',
        password: hotmail.password,
        clientId: hotmail.clientId,
        refreshToken: hotmail.refreshToken,
      };
    }
    if (isHttpUrl(credential)) {
      const queryCode = extractTaobaoQueryCodeFromUrl(credential);
      return {
        apiMode: queryCode ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL,
        verificationUrl: normalizeUrl(credential),
        queryCode,
        password: '',
        clientId: '',
        refreshToken: '',
      };
    }
    if (isTaobaoQueryCode(credential)) {
      return {
        apiMode: ICLOUD_API_MODE_TAOBAO,
        verificationUrl: buildTaobaoVerificationUrl(email, credential),
        queryCode: credential,
        password: '',
        clientId: '',
        refreshToken: '',
      };
    }
    return {
      apiMode: normalizedMode,
      verificationUrl: '',
      queryCode: '',
      password: '',
      clientId: '',
      refreshToken: '',
    };
  }

  function parseCsvRows(text = '') {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const input = String(text || '').replace(/^\uFEFF/, '');

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const next = input[index + 1];
      if (inQuotes) {
        if (char === '"' && next === '"') {
          cell += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          cell += char;
        }
        continue;
      }

      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(cell);
        cell = '';
      } else if (char === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (char !== '\r') {
        cell += char;
      }
    }

    row.push(cell);
    rows.push(row);
    return rows
      .map((cells) => cells.map((value) => String(value || '').trim()))
      .filter((cells) => cells.some(Boolean));
  }

  function parseEmailPoolCsvText(text = '') {
    const existingByEmail = getExistingEntryMap();
    const mode = getSelectedIcloudApiMode();
    const rows = parseCsvRows(text);
    const entries = [];
    const seen = new Set();

    rows.forEach((cells) => {
      const joined = cells.join(' ').trim();
      if (!joined || !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(joined)) {
        return;
      }

      const directLine = cells.find((cell) => cell.includes('----')) || '';
      let parsedEntry = null;
      if (directLine) {
        parsedEntry = parsePoolText(directLine, { existingByEmail, mode })[0] || null;
      }

      const email = normalizeEmail(parsedEntry?.email || cells.find((cell) => isEmail(cell)) || findFirstEmail(joined));
      if (!isEmail(email)) {
        return;
      }

      const key = email.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      const previous = existingByEmail.get(key) || {};
      const emailCellIndex = cells.findIndex((cell) => isEmail(cell));
      const hotmailCredentialSource = mode === ICLOUD_API_MODE_HOTMAIL && emailCellIndex >= 0
        ? cells.slice(emailCellIndex + 1).filter(Boolean).slice(0, 3).join('----')
        : '';
      const credentialSource = (parsedEntry?.apiMode === ICLOUD_API_MODE_HOTMAIL ? [
          parsedEntry?.password,
          parsedEntry?.clientId,
          parsedEntry?.refreshToken,
        ].filter(Boolean).join('----') : '')
        || parsedEntry?.queryCode
        || parsedEntry?.verificationUrl
        || hotmailCredentialSource
        || cells.find((cell) => isHttpUrl(cell))
        || findFirstUrl(joined)
        || cells.find((cell) => isTaobaoQueryCode(cell) && !isEmail(cell))
        || '';
      const credential = normalizePoolCredential(credentialSource, mode, email);
      const apiMode = normalizeIcloudApiMode(parsedEntry?.apiMode || credential.apiMode || previous.apiMode || mode);
      const queryCode = String(parsedEntry?.queryCode || credential.queryCode || previous.queryCode || '').trim();
      const password = String(parsedEntry?.password || credential.password || previous.password || '').trim();
      const clientId = String(parsedEntry?.clientId || credential.clientId || previous.clientId || '').trim();
      const refreshToken = String(parsedEntry?.refreshToken || credential.refreshToken || previous.refreshToken || '').trim();
      const verificationUrl = normalizeUrl(
        credential.verificationUrl
        || previous.verificationUrl
        || (apiMode === ICLOUD_API_MODE_TAOBAO && queryCode ? buildTaobaoVerificationUrl(email, queryCode) : '')
      );
      entries.push({
        id: String(previous.id || makeEntryId(email, entries.length)).trim(),
        email,
        enabled: previous.enabled !== false,
        used: Boolean(previous.used),
        note: String(previous.note || (apiMode === ICLOUD_API_MODE_HOTMAIL ? 'Hotmail' : (apiMode === ICLOUD_API_MODE_TAOBAO ? '淘宝版' : (verificationUrl ? 'iCloud API' : '')))).trim(),
        apiMode,
        queryCode: apiMode === ICLOUD_API_MODE_HOTMAIL ? '' : queryCode,
        password: apiMode === ICLOUD_API_MODE_HOTMAIL ? password : '',
        clientId: apiMode === ICLOUD_API_MODE_HOTMAIL ? clientId : '',
        refreshToken: apiMode === ICLOUD_API_MODE_HOTMAIL ? refreshToken : '',
        verificationUrl: apiMode === ICLOUD_API_MODE_HOTMAIL ? '' : verificationUrl,
        lastUsedAt: Number(previous.lastUsedAt) || 0,
        lastError: String(previous.lastError || '').trim(),
        accessTokenCheck: previous.accessTokenCheck || null,
      });
    });

    return entries;
  }

  function makeEntryId(email, index) {
    const slug = String(email || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `icloudapi-${slug || 'mail'}-${index + 1}`;
  }

  function getExistingEntryMap() {
    const map = new Map();
    (Array.isArray(state?.customEmailPoolEntries) ? state.customEmailPoolEntries : []).forEach((entry) => {
      const key = normalizeEmail(entry?.email).toLowerCase();
      if (key) map.set(key, entry);
    });
    return map;
  }

  function parsePoolText(text = '', options = {}) {
    const existingByEmail = options.existingByEmail || getExistingEntryMap();
    const mode = normalizeIcloudApiMode(options.mode || getSelectedIcloudApiMode());
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const entries = [];
    const seen = new Set();

    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      let email = '';
      let verificationUrl = '';
      let apiMode = mode;
      let queryCode = '';
      let password = '';
      let clientId = '';
      let refreshToken = '';

      if (line.includes('----')) {
        const parts = line.split('----');
        email = normalizeEmail(parts.shift());
        const credential = normalizePoolCredential(parts.join('----'), mode, email);
        apiMode = credential.apiMode;
        verificationUrl = credential.verificationUrl;
        queryCode = credential.queryCode;
        password = credential.password || '';
        clientId = credential.clientId || '';
        refreshToken = credential.refreshToken || '';
      } else {
        email = normalizeEmail(line);
        const nextLine = normalizeUrl(lines[index + 1] || '');
        if (isEmail(email) && nextLine) {
          const credential = normalizePoolCredential(nextLine, mode, email);
          if (credential.verificationUrl || credential.queryCode) {
            apiMode = credential.apiMode;
            verificationUrl = credential.verificationUrl;
            queryCode = credential.queryCode;
            password = credential.password || '';
            clientId = credential.clientId || '';
            refreshToken = credential.refreshToken || '';
            index += 1;
          }
        }
        if (isEmail(email) && !verificationUrl && apiMode === ICLOUD_API_MODE_TAOBAO) {
          const nextQueryCode = String(lines[index + 1] || '').trim();
          if (isTaobaoQueryCode(nextQueryCode)) {
            const credential = normalizePoolCredential(nextQueryCode, mode, email);
            apiMode = credential.apiMode;
            verificationUrl = credential.verificationUrl;
            queryCode = credential.queryCode;
            password = credential.password || '';
            clientId = credential.clientId || '';
            refreshToken = credential.refreshToken || '';
            index += 1;
          }
        }
      }

      if (!isEmail(email)) {
        continue;
      }

      const key = email.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const previous = existingByEmail.get(key) || {};
      const normalizedApiMode = normalizeIcloudApiMode(apiMode || previous.apiMode || mode);
      const normalizedQueryCode = String(queryCode || previous.queryCode || '').trim();
      const normalizedPassword = String(password || previous.password || '').trim();
      const normalizedClientId = String(clientId || previous.clientId || '').trim();
      const normalizedRefreshToken = String(refreshToken || previous.refreshToken || '').trim();
      const normalizedVerificationUrl = normalizeUrl(
        verificationUrl
        || previous.verificationUrl
        || (normalizedApiMode === ICLOUD_API_MODE_TAOBAO && normalizedQueryCode
          ? buildTaobaoVerificationUrl(email, normalizedQueryCode)
          : '')
      );
      entries.push({
        id: String(previous.id || makeEntryId(email, entries.length)).trim(),
        email,
        enabled: previous.enabled !== false,
        used: Boolean(previous.used),
        note: String(previous.note || (normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? 'Hotmail' : (normalizedApiMode === ICLOUD_API_MODE_TAOBAO ? '淘宝版' : (normalizedVerificationUrl ? 'iCloud API' : '')))).trim(),
        apiMode: normalizedApiMode,
        queryCode: normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? '' : normalizedQueryCode,
        password: normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? normalizedPassword : '',
        clientId: normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? normalizedClientId : '',
        refreshToken: normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? normalizedRefreshToken : '',
        verificationUrl: normalizedApiMode === ICLOUD_API_MODE_HOTMAIL ? '' : normalizedVerificationUrl,
        lastUsedAt: Number(previous.lastUsedAt) || 0,
        lastError: String(previous.lastError || '').trim(),
        accessTokenCheck: previous.accessTokenCheck || null,
      });
    }

    return entries;
  }

  function entriesToText(entries = []) {
    return entries.map((entry) => {
      const email = normalizeEmail(entry.email);
      const mode = normalizeIcloudApiMode(entry.apiMode);
      const queryCode = String(entry.queryCode || '').trim();
      if (mode === ICLOUD_API_MODE_HOTMAIL) {
        return buildHotmailPoolLine(entry);
      }
      if (mode === ICLOUD_API_MODE_TAOBAO && queryCode) {
        return `${email}----${queryCode}`;
      }
      const url = normalizeUrl(entry.verificationUrl);
      return url ? `${email}----${url}` : email;
    }).filter(Boolean).join('\n');
  }

  function csvEscape(value = '') {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function getExportDateSegment() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join('');
  }

  function getPoolEntriesFromInput() {
    const redeemUsedEmails = getExternalRedeemUsedEmailSet();
    const parsed = parsePoolText(els.emailPool.value, { mode: getSelectedIcloudApiMode() });
    if (parsed.length) {
      return parsed.map((entry) => ({
        ...entry,
        used: Boolean(entry.used) || redeemUsedEmails.has(normalizeEmail(entry.email).toLowerCase()),
        lastUsedAt: Boolean(entry.used) || redeemUsedEmails.has(normalizeEmail(entry.email).toLowerCase())
          ? (Number(entry.lastUsedAt) || Date.now())
          : (Number(entry.lastUsedAt) || 0),
      }));
    }
    if (
      String(els.emailPool.value || '').trim() === ''
      && Array.isArray(state?.customEmailPoolEntries)
      && state.customEmailPoolEntries.length === 0
      && Array.isArray(state?.customEmailPool)
      && state.customEmailPool.length === 0
    ) {
      return [];
    }
    const stateEntries = Array.isArray(state?.customEmailPoolEntries)
      ? state.customEmailPoolEntries.filter((entry) => isEmail(entry?.email))
      : [];
    if (stateEntries.length) {
      return stateEntries.map((entry, index) => ({
        ...entry,
        id: String(entry?.id || makeEntryId(entry?.email, index)).trim(),
        email: normalizeEmail(entry?.email),
        enabled: entry?.enabled !== false,
        used: Boolean(entry?.used) || redeemUsedEmails.has(normalizeEmail(entry?.email).toLowerCase()),
        apiMode: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : (entry?.queryCode ? ICLOUD_API_MODE_TAOBAO : ''))),
        queryCode: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : '')) === ICLOUD_API_MODE_HOTMAIL ? '' : String(entry?.queryCode || '').trim(),
        password: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : '')) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.password || '').trim() : '',
        clientId: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : '')) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.clientId || '').trim() : '',
        refreshToken: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : '')) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.refreshToken || '').trim() : '',
        verificationUrl: normalizeIcloudApiMode(entry?.apiMode || (entry?.clientId && entry?.refreshToken ? ICLOUD_API_MODE_HOTMAIL : '')) === ICLOUD_API_MODE_HOTMAIL ? '' : normalizeUrl(entry?.verificationUrl || entry?.url || entry?.mailUrl || ''),
        lastUsedAt: Boolean(entry?.used) || redeemUsedEmails.has(normalizeEmail(entry?.email).toLowerCase())
          ? (Number(entry?.lastUsedAt) || Date.now())
          : 0,
        lastError: String(entry?.lastError || '').trim(),
        accessTokenCheck: entry?.accessTokenCheck || null,
      }));
    }
    const legacyPool = Array.isArray(state?.customEmailPool)
      ? state.customEmailPool.filter((email) => isEmail(email))
      : [];
    if (legacyPool.length) {
      return parsePoolText(legacyPool.join('\n'));
    }
    return parsePoolText(DEFAULT_POOL_TEXT, { existingByEmail: new Map() });
  }

  function buildSettingsPayload() {
    const entries = getPoolEntriesFromInput();
    return {
      activeFlowId: 'openai',
      panelMode: CHECKOUT_CONVERSION,
      plusModeEnabled: false,
      plusPaymentMethod: CHECKOUT_CONVERSION,
      plusAccountAccessStrategy: 'oauth',
      plusCheckoutConversionProxyUrl: normalizeProxyUrl(els.checkoutProxy.value),
      plusCheckoutConversionProxyPoolText: normalizeProxyPoolText(els.checkoutProxyPool?.value || ''),
      plusCheckoutConversionProxyPoolIndex: Math.max(0, Math.floor(Number(state?.plusCheckoutConversionProxyPoolIndex) || 0)),
      externalRedeemEnabled: Boolean(els.externalRedeemEnabled.checked),
      chatgptTotpAutoEnable: Boolean(els.chatgptTotpAutoEnable?.checked),
      externalRedeemBaseUrl: normalizeUrl(els.externalRedeemBaseUrl.value) || EXTERNAL_REDEEM_DEFAULT_BASE_URL,
      externalRedeemApiKey: String(els.externalRedeemApiKey.value || '').trim(),
      externalRedeemCdkeyPoolText: normalizeExternalRedeemCdkeyPoolText(els.externalRedeemCdkeys.value),
      externalRedeemPollSeconds: Math.max(30, Math.min(300, Math.floor(Number(els.externalRedeemPollSeconds.value) || 30))),
      multiThreadEnabled: getThreadCountFromInput() > 1,
      multiThreadCount: getThreadCountFromInput(),
      feishuSyncEnabled: Boolean(els.feishuSyncEnabled.checked),
      feishuAppId: String(els.feishuAppId.value || DEFAULT_FEISHU_SYNC_CONFIG.appId).trim(),
      feishuAppSecret: String(els.feishuAppSecret.value || DEFAULT_FEISHU_SYNC_CONFIG.appSecret).trim(),
      feishuBitableAppToken: String(els.feishuBitableAppToken.value || DEFAULT_FEISHU_SYNC_CONFIG.bitableAppToken).trim(),
      feishuBitableTableId: String(els.feishuBitableTableId.value || DEFAULT_FEISHU_SYNC_CONFIG.bitableTableId).trim(),
      signupMethod: 'email',
      phoneVerificationEnabled: false,
      phoneSignupReloginAfterBindEmailEnabled: false,
      mailProvider: ICLOUD_API_PROVIDER,
      icloudApiMode: getSelectedIcloudApiMode(),
      emailGenerator: CUSTOM_POOL_GENERATOR,
      customEmailPool: entries.filter((entry) => entry.enabled).map((entry) => entry.email),
      customEmailPoolEntries: entries,
      customMailProviderPool: [],
      customPassword: String(els.password.value || ''),
    };
  }

  async function saveSettings(options = {}) {
    const payload = buildSettingsPayload();
    const previousMultiThreadRuntime = {
      multiThreadMode: state?.multiThreadMode,
      multiThreadRunnerUrl: state?.multiThreadRunnerUrl,
      multiThreadRunnerRunId: state?.multiThreadRunnerRunId,
      multiThreadPlans: state?.multiThreadPlans,
      multiThreadLogs: state?.multiThreadLogs,
      multiThreadLastError: state?.multiThreadLastError,
      multiThreadLastUpdatedAt: state?.multiThreadLastUpdatedAt,
    };
    const response = await sendMessage({
      type: 'SAVE_SETTING',
      source: 'sidepanel',
      payload,
    });
    state = response?.state || { ...(state || {}), ...payload };
    if (String(previousMultiThreadRuntime.multiThreadMode || '') === 'isolated-profile-runner') {
      state = {
        ...(state || {}),
        ...Object.fromEntries(
          Object.entries(previousMultiThreadRuntime)
            .filter(([, value]) => value !== undefined && value !== null)
        ),
      };
    }
    loginSecurityConfigDirty = false;
    externalRedeemConfigDirty = false;
    feishuConfigDirty = false;
    renderState();
    ensureMultiThreadLogSync();
    if (!options.silent) {
      showToast('配置已保存', 'success');
    }
    return state;
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('请选择 CSV 文件'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(reader.error?.message || '文件读取失败'));
      reader.readAsText(file);
    });
  }

  async function importEmailPoolCsvFile(file) {
    const text = await readTextFile(file);
    const entries = parseEmailPoolCsvText(text);
    if (!entries.length) {
      throw new Error('CSV 中未解析到有效邮箱。普通版支持“邮箱----接口URL”，淘宝版支持“邮箱----邮件查询码”，Hotmail 支持“邮箱----密码----client_id----refresh_token”。');
    }

    els.emailPool.value = entriesToText(entries);
    state = {
      ...(state || {}),
      customEmailPoolEntries: entries,
      customEmailPool: entries.filter((entry) => entry.enabled).map((entry) => entry.email),
    };
    renderPool(entries);
    await saveSettings({ silent: true });
    showToast(`已导入 ${entries.length} 个邮箱，已按当前版本解析邮箱池`, 'success', 5200);
  }

  async function loadState() {
    state = await sendMessage({ type: 'GET_STATE', source: 'sidepanel' }, 15000);
    renderState();
    ensureMultiThreadLogSync();
    recoverMultiThreadRunnerLogsOnce();
  }

  function isMultiThreadRunnerActive(view = state) {
    return String(view?.multiThreadMode || '').trim() === 'isolated-profile-runner'
      && Boolean(String(view?.multiThreadRunnerRunId || '').trim());
  }

  function hasRunningMultiThreadPlans(view = state) {
    const plans = Array.isArray(view?.multiThreadPlans) ? view.multiThreadPlans : [];
    return isMultiThreadRunnerActive(view)
      || plans.some((plan) => String(plan?.status || '').trim().toLowerCase() === 'running');
  }

  function hasMultiThreadWorkbenchHistory(view = state) {
    const plans = Array.isArray(view?.multiThreadPlans) ? view.multiThreadPlans : [];
    const threadLogs = view?.multiThreadLogs && typeof view.multiThreadLogs === 'object'
      ? view.multiThreadLogs
      : {};
    return Boolean(plans.length || Object.keys(threadLogs).length || String(view?.multiThreadLastError || '').trim());
  }

  function stopMultiThreadLogSync() {
    if (multiThreadSyncTimer) {
      clearInterval(multiThreadSyncTimer);
      multiThreadSyncTimer = 0;
    }
  }

  async function syncMultiThreadRunnerLogs() {
    if (multiThreadSyncInFlight) {
      return;
    }
    const allowRecovery = !isMultiThreadRunnerActive()
      && Number(state?.multiThreadCount || 0) > 1;
    if (!isMultiThreadRunnerActive() && !allowRecovery) {
      stopMultiThreadLogSync();
      return;
    }
    multiThreadSyncInFlight = true;
    try {
      const response = await sendMessage({
        type: 'SYNC_MULTI_THREAD_RUNNER_LOGS',
        source: 'sidepanel',
        payload: {},
      }, 30000);
      if (response?.state) {
        state = response.state;
      } else if (response?.plans) {
        state = {
          ...(state || {}),
          multiThreadPlans: response.plans,
        };
      }
      renderState();
      if (isMultiThreadRunnerActive()) {
        ensureMultiThreadLogSync();
      }
    } catch (error) {
      console.warn('[GuJumpgate sidepanel] sync multi-thread logs failed:', error?.message || error);
    } finally {
      multiThreadSyncInFlight = false;
    }
  }

  function ensureMultiThreadLogSync() {
    if (!isMultiThreadRunnerActive()) {
      stopMultiThreadLogSync();
      return;
    }
    if (multiThreadSyncTimer) {
      return;
    }
    multiThreadSyncTimer = setInterval(() => {
      syncMultiThreadRunnerLogs().catch((error) => {
        console.warn('[GuJumpgate sidepanel] sync multi-thread logs failed:', error?.message || error);
      });
    }, MULTI_THREAD_SYNC_INTERVAL_MS);
    syncMultiThreadRunnerLogs().catch((error) => {
      console.warn('[GuJumpgate sidepanel] initial sync multi-thread logs failed:', error?.message || error);
    });
  }

  function recoverMultiThreadRunnerLogsOnce() {
    if (isMultiThreadRunnerActive() || Number(state?.multiThreadCount || 0) <= 1) {
      return;
    }
    syncMultiThreadRunnerLogs().catch((error) => {
      console.warn('[GuJumpgate sidepanel] recover multi-thread logs failed:', error?.message || error);
    });
  }

  function getStateEntries() {
    const entries = Array.isArray(state?.customEmailPoolEntries)
      ? state.customEmailPoolEntries
      : [];
    if (entries.length) {
      return entries.map((entry, index) => ({
        ...parsePoolText(entriesToText([entry]), {
          existingByEmail: new Map([[normalizeEmail(entry?.email).toLowerCase(), entry]]),
          mode: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode),
        })[0],
        ...entry,
        id: String(entry?.id || makeEntryId(entry?.email, index)).trim(),
        email: normalizeEmail(entry?.email),
        apiMode: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode),
        queryCode: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_HOTMAIL ? '' : String(entry?.queryCode || '').trim(),
        password: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.password || '').trim() : '',
        clientId: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.clientId || '').trim() : '',
        refreshToken: normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_HOTMAIL ? String(entry?.refreshToken || '').trim() : '',
        verificationUrl: normalizeUrl(
          normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_HOTMAIL ? '' : (entry?.verificationUrl
          || entry?.url
          || entry?.mailUrl
          || (normalizeIcloudApiMode(entry?.apiMode || state?.icloudApiMode) === ICLOUD_API_MODE_TAOBAO && entry?.queryCode
            ? buildTaobaoVerificationUrl(entry.email, entry.queryCode)
            : ''))
        ),
      })).filter((entry) => isEmail(entry.email));
    }
    const legacyPool = Array.isArray(state?.customEmailPool) ? state.customEmailPool : [];
    if (legacyPool.length) {
      return parsePoolText(legacyPool.join('\n'));
    }
    if (
      state
      && Array.isArray(state.customEmailPoolEntries)
      && state.customEmailPoolEntries.length === 0
      && Array.isArray(state.customEmailPool)
      && state.customEmailPool.length === 0
    ) {
      return [];
    }
    return parsePoolText(DEFAULT_POOL_TEXT, { existingByEmail: new Map() });
  }

  function updatePoolSummary(entries) {
    const redeemUsedEmails = getExternalRedeemUsedEmailSet();
    const total = entries.length;
    const enabled = entries.filter((entry) => entry.enabled).length;
    const unused = entries.filter((entry) => (
      entry.enabled
      && !entry.used
      && !redeemUsedEmails.has(normalizeEmail(entry.email).toLowerCase())
    )).length;
    els.poolSummary.textContent = `${total} 个邮箱 / ${enabled} 个启用 / ${unused} 个未用`;
    if (Number(els.runCount.value || 1) < 1) {
      els.runCount.value = String(Math.max(1, unused || enabled || 1));
    }
  }

  function renderPool(entries) {
    const redeemUsedEmails = getExternalRedeemUsedEmailSet();
    updatePoolSummary(entries);
    if (!entries.length) {
      els.poolList.innerHTML = '<div class="pool-item">暂无邮箱</div>';
      return;
    }
    const records = getChatGptAcRecords();
    els.poolList.innerHTML = entries.map((entry, index) => {
      const emailKey = normalizeEmail(entry.email).toLowerCase();
      const usedByRedeem = redeemUsedEmails.has(emailKey);
      const isUsed = Boolean(entry.used) || usedByRedeem;
      const status = isUsed ? '已用' : '未用';
      const statusClass = isUsed ? 'skipped' : 'success';
      const url = normalizeUrl(entry.verificationUrl);
      const mode = normalizeIcloudApiMode(entry.apiMode);
      const queryCode = String(entry.queryCode || '').trim();
      const fullLine = mode === ICLOUD_API_MODE_HOTMAIL
        ? buildHotmailPoolLine(entry, { mask: true })
        : (mode === ICLOUD_API_MODE_TAOBAO && queryCode
          ? `${entry.email}----${queryCode}`
          : (url ? `${entry.email}----${url}` : entry.email));
      const modeLabel = getIcloudApiModeLabel(mode);
      const hotmailMeta = mode === ICLOUD_API_MODE_HOTMAIL
        ? ` / client_id：${maskSecret(entry.clientId, 6) || '未配置'} / refresh_token：${entry.refreshToken ? '已配置' : '未配置'}`
        : '';
      const record = records[normalizeEmail(entry.email).toLowerCase()] || null;
      const acCheck = entry.accessTokenCheck && typeof entry.accessTokenCheck === 'object'
        ? entry.accessTokenCheck
        : (record?.check || null);
      const acLabel = acCheck ? getAcCheckLabel({ ...acCheck, checked: true }) : '';
      const acMeta = acCheck ? `
          <div class="pool-meta">AC：${htmlEscape(acLabel)}${acCheck.reason ? ` / ${htmlEscape(acCheck.reason)}` : ''}${acCheck.checkedAt ? ` / ${htmlEscape(formatDateTime(acCheck.checkedAt))}` : ''}</div>
        ` : '';
      return `
        <div class="pool-item">
          <div class="pool-head">
            <strong class="pool-email">${index + 1}. ${htmlEscape(entry.email)}</strong>
            <span class="badge ${statusClass}">${status}</span>
          </div>
          <div class="pool-url">${htmlEscape(fullLine)}</div>
          <div class="pool-meta">${htmlEscape(modeLabel)}${url ? ` / 接口：${htmlEscape(url)}` : ''}${htmlEscape(hotmailMeta)}</div>
          ${acMeta}
          <div class="pool-meta">${usedByRedeem ? '已参与外部兑换，按已用处理。' : '邮箱池会按未用邮箱顺序轮询，成功后自动标记已用。'}</div>
        </div>
      `;
    }).join('');
  }

  function getStatusLabel(status = '') {
    const normalized = String(status || 'pending').trim().toLowerCase();
    const labels = {
      pending: '待执行',
      running: '执行中',
      completed: '已完成',
      manual_completed: '已完成',
      skipped: '已跳过',
      failed: '失败',
      stopped: '已停止',
      waiting_step: '等待中',
      retrying: '重试中',
      ready: '就绪',
      blocked: '阻止',
    };
    return labels[normalized] || normalized || '待执行';
  }

  function renderSteps() {
    const statuses = state?.nodeStatuses || {};
    els.stepsList.innerHTML = stepDefinitions.map((step) => {
      const nodeId = String(step.key || step.nodeId || '').trim();
      const status = statuses[nodeId] || 'pending';
      return `
        <div class="step-item">
          <div class="step-head">
            <div>
              <div class="step-title">${Number(step.id) || ''}. ${htmlEscape(step.title || nodeId)}</div>
              <div class="pool-meta mono">${htmlEscape(nodeId)}</div>
            </div>
            <span class="badge ${htmlEscape(status)}">${getStatusLabel(status)}</span>
          </div>
          <button class="btn small" type="button" data-node-id="${htmlEscape(nodeId)}">执行</button>
        </div>
      `;
    }).join('');
  }

  function renderLogs() {
    const logs = Array.isArray(state?.logs) ? state.logs.slice(-80).reverse() : [];
    if (!logs.length) {
      els.logsList.innerHTML = '<div class="log-item">暂无日志</div>';
      return;
    }
    els.logsList.innerHTML = logs.map((entry) => {
      const date = new Date(Number(entry.timestamp) || Date.now());
      const time = date.toLocaleTimeString('zh-CN', { hour12: false });
      const level = String(entry.level || 'info').toLowerCase();
      return `
        <div class="log-item ${htmlEscape(level)}">
          <div class="log-time">${htmlEscape(time)}${entry.nodeId ? ` / ${htmlEscape(entry.nodeId)}` : ''}</div>
          <div class="log-message">${htmlEscape(entry.message || '')}</div>
        </div>
      `;
    }).join('');
  }

  function renderMultiThreadWorkbench() {
    if (!els.multiThreadStatus || !els.multiThreadPlans || !els.threadLogsGrid) {
      return;
    }
    const threadCount = normalizeThreadCount(state?.multiThreadCount || els.threadCount?.value || 1);
    if (els.threadCount && document.activeElement !== els.threadCount) {
      els.threadCount.value = String(threadCount);
    }
    const plans = Array.isArray(state?.multiThreadPlans) ? state.multiThreadPlans : [];
    const threadLogs = state?.multiThreadLogs && typeof state.multiThreadLogs === 'object'
      ? state.multiThreadLogs
      : {};
    const blockedReason = String(state?.multiThreadLastError || '').trim();
    const readyCount = plans.filter((plan) => String(plan?.status || '').toLowerCase() === 'ready').length;
    const runningCount = plans.filter((plan) => String(plan?.status || '').toLowerCase() === 'running').length;
    const mode = String(state?.multiThreadMode || '').trim();
    const taskActive = hasRunningMultiThreadPlans(state);
    els.multiThreadStatus.textContent = blockedReason
      ? `受保护：${blockedReason}`
      : (mode === 'isolated-profile-runner'
        ? `独立 profile runner：${runningCount}/${threadCount} 运行中`
        : (mode === 'isolated-profile-runner-required'
          ? '需要启动独立 profile runner'
          : (threadCount > 1 ? `${readyCount}/${threadCount} 就绪` : '单线程')));
    if (els.stopMultiThread) {
      els.stopMultiThread.disabled = !taskActive;
      els.stopMultiThread.textContent = taskActive ? '终止任务' : '已停止';
    }
    if (els.clearMultiThreadInfo) {
      els.clearMultiThreadInfo.disabled = taskActive || !hasMultiThreadWorkbenchHistory(state);
    }

    if (!plans.length) {
      els.multiThreadPlans.innerHTML = '<div class="thread-plan">尚未准备线程</div>';
    } else {
      els.multiThreadPlans.innerHTML = plans.map((plan) => {
        const status = String(plan?.status || 'pending').trim().toLowerCase();
        const badgeClass = status === 'ready' ? 'success' : (status === 'running' ? 'running' : 'skipped');
        return `
          <div class="thread-plan">
            <div class="thread-plan-head">
              <strong>${htmlEscape(plan?.label || plan?.id || '线程')}</strong>
              <span class="badge ${htmlEscape(badgeClass)}">${htmlEscape(getStatusLabel(status))}</span>
            </div>
            <div class="pool-meta mono">${htmlEscape(plan?.email || plan?.reason || '等待分配邮箱')}</div>
            <div class="pool-meta">CDK：${htmlEscape(plan?.cdkey ? '已分配' : '未分配')}</div>
            ${plan?.runner ? `<div class="pool-meta mono">debug ${htmlEscape(plan.runner.debugPort || '-')} / bridge ${htmlEscape(plan.runner.proxyBridgePort || '-')}</div>` : ''}
            ${plan?.runnerSnapshot ? `<div class="pool-meta mono">当前：${htmlEscape(plan.runnerSnapshot.currentNodeId || plan.runnerSnapshot.autoRunPhase || '-')}${plan.runnerSnapshot.url ? ` / ${htmlEscape(plan.runnerSnapshot.url)}` : ''}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    const columnIds = plans.length
      ? plans.map((plan) => String(plan?.id || '').trim()).filter(Boolean)
      : Array.from({ length: threadCount }, (_, index) => `thread-${index + 1}`);
    els.threadLogsGrid.innerHTML = columnIds.map((threadId, index) => {
      const plan = plans.find((item) => String(item?.id || '') === threadId) || {};
      const logs = Array.isArray(threadLogs[threadId]) ? threadLogs[threadId].slice(-40).reverse() : [];
      const logHtml = logs.length
        ? logs.map((entry) => {
          const date = new Date(Number(entry.timestamp) || Date.now());
          const time = date.toLocaleTimeString('zh-CN', { hour12: false });
          const level = String(entry.level || 'info').toLowerCase();
          return `
            <div class="log-item ${htmlEscape(level)}">
              <div class="log-time">${htmlEscape(time)}</div>
              <div class="log-message">${htmlEscape(entry.message || '')}</div>
            </div>
          `;
        }).join('')
        : '<div class="log-item">暂无线程日志</div>';
      return `
        <div class="thread-log-column">
          <div class="thread-column-title">
            <strong>${htmlEscape(plan?.label || `线程 ${index + 1}`)}</strong>
            <span>${htmlEscape(plan?.email || '未分配')}</span>
          </div>
          ${plan?.runnerSnapshot ? `
            <div class="pool-meta mono">节点：${htmlEscape(plan.runnerSnapshot.currentNodeId || plan.runnerSnapshot.autoRunPhase || '-')}</div>
            <div class="pool-meta mono">页面：${htmlEscape(plan.runnerSnapshot.title || '-')}${plan.runnerSnapshot.url ? ` / ${htmlEscape(plan.runnerSnapshot.url)}` : ''}</div>
            ${plan.runnerSnapshot.textPreview ? `<div class="pool-meta">文本：${htmlEscape(plan.runnerSnapshot.textPreview)}</div>` : ''}
            ${plan.runnerSnapshot.error ? `<div class="pool-meta warn">诊断失败：${htmlEscape(plan.runnerSnapshot.error)}</div>` : ''}
          ` : ''}
          <div class="logs-list">${logHtml}</div>
        </div>
      `;
    }).join('');
  }

  function renderChatGptAc() {
    const info = getChatGptAcInfo();
    const check = getChatGptAcCheck();
    const records = getChatGptAcRecords();
    const history = getChatGptAcHistory();
    const recordCount = Object.keys(records).filter(Boolean).length;
    const historyCount = history.length;
    const summary = recordCount > 0 || historyCount > 0
      ? `${getAcSummaryLabel(info, check)} / ${recordCount} 邮箱 / ${historyCount} 次`
      : getAcSummaryLabel(info, check);
    els.chatgptAcStatus.textContent = summary;
    els.chatgptAcDetails.hidden = !chatgptAcExpanded;
    els.viewChatgptAc.textContent = chatgptAcExpanded ? '收起' : '查看';
    els.viewChatgptAc.setAttribute('aria-expanded', chatgptAcExpanded ? 'true' : 'false');

    const currentEmail = normalizeEmail(check?.email || info?.email || '').toLowerCase();
    const rowsByEmail = new Map();
    Object.entries(records).forEach(([rawEmail, record]) => {
      const email = normalizeEmail(record?.email || rawEmail).toLowerCase();
      if (!email) {
        return;
      }
      rowsByEmail.set(email, {
        email,
        info: record?.info || {},
        check: record?.check ? { ...record.check, checked: true } : null,
        record,
      });
    });
    if (currentEmail || info?.hasAccessToken || check?.checked) {
      rowsByEmail.set(currentEmail || 'current', {
        email: currentEmail,
        info: info || {},
        check,
        record: null,
        current: true,
      });
    }

    const rows = [...rowsByEmail.values()].sort((left, right) => {
      if (left.current) return -1;
      if (right.current) return 1;
      const leftTime = Number(left.check?.checkedAt || left.info?.syncedAt || left.record?.updatedAt || 0) || 0;
      const rightTime = Number(right.check?.checkedAt || right.info?.syncedAt || right.record?.updatedAt || 0) || 0;
      return rightTime - leftTime;
    });

    if (!rows.length) {
      els.chatgptAcDetails.innerHTML = '<div class="ac-card">暂无 AC 记录</div>';
      return;
    }

    els.chatgptAcDetails.innerHTML = rows.map((row, index) => {
      const rowInfo = row.info || {};
      const rowCheck = row.check || null;
      const email = normalizeEmail(rowCheck?.email || rowInfo?.email || row.email || '');
      const tokenPreview = rowInfo?.accessTokenPreview
        || row.record?.accessTokenPreview
        || (email ? fullAccessTokenByEmail.get(email.toLowerCase()) : '')
        || '';
      const tokenLength = rowInfo?.accessTokenLength || (tokenPreview ? String(tokenPreview).length : 0);
      const tokenText = tokenPreview
        ? `${tokenPreview}${tokenLength ? ` (${tokenLength} chars)` : ''}`
        : '未读取';
      const expiresAt = rowCheck?.jwtExpMs || rowInfo?.tokenExpiresAt || rowInfo?.sessionExpiresAt || '';
      const reason = rowCheck?.error || rowCheck?.reason || '-';
      const coupon = [
        rowCheck?.couponState || '',
        rowCheck?.promoId || '',
      ].filter(Boolean).join(' / ') || '-';
      const httpStatus = [
        rowCheck?.tokenOk === true ? 'token_ok=true' : (rowCheck?.tokenOk === false ? 'token_ok=false' : ''),
        rowCheck?.status ? `status=${rowCheck.status}` : '',
      ].filter(Boolean).join(' / ') || '-';
      const accountText = [
        rowCheck?.accountId || rowInfo?.accountId || '',
        rowCheck?.planType || rowInfo?.planType || '',
      ].filter(Boolean).join(' / ') || '-';
      const source = normalizeUrl(rowInfo?.sourceUrl || row.record?.sourceUrl || '') || '-';
      return `
        <div class="ac-card">
          <div class="ac-card-title">
            <strong>${htmlEscape(index + 1)}. ${htmlEscape(email || '-')}</strong>
            <span class="badge ${rowCheck?.qualified ? 'success' : 'skipped'}">${htmlEscape(getAcCheckLabel(rowCheck))}</span>
          </div>
          <div class="ac-row"><span>原因</span><span>${htmlEscape(reason)}</span></div>
          <div class="ac-row"><span>优惠券</span><span>${htmlEscape(coupon)}</span></div>
          <div class="ac-row"><span>状态</span><span>${htmlEscape(httpStatus)}</span></div>
          <div class="ac-row"><span>账号</span><span>${htmlEscape(accountText)}</span></div>
          <div class="ac-row"><span>Token</span><code>${htmlEscape(tokenText)}</code></div>
          <div class="ac-row"><span>过期</span><span>${htmlEscape(formatDateTime(expiresAt))}</span></div>
          <div class="ac-row"><span>来源</span><span>${htmlEscape(source)}</span></div>
        </div>
      `;
    }).join('');
  }

  function getExternalRedeemStatusLabel(item = {}) {
    if (hasExternalRedeemRechargeFailureSignal(item)) {
      return '充值失败';
    }
    const display = String(item?.displayStatus || '').trim();
    if (display) {
      return display;
    }
    const status = String(item?.status || '').trim().toLowerCase();
    const labels = {
      pending_dispatch: '等待兑换',
      awaiting_token: '等待 AC',
      awaiting_payment_expiry: '等待支付过期',
      dispatched: '兑换中',
      running: '兑换中',
      success: '兑换成功',
      failed: '兑换失败',
      timeout: '兑换超时',
      cancelled: '已取消',
      rejected: '提交失败',
      submit_failed: '提交失败',
      not_found: '未找到',
    };
    return labels[status] || status || '未知';
  }

  function getExternalRedeemBadgeClass(item = {}) {
    const status = String(item?.status || item?.redeemStatus || '').trim().toLowerCase();
    if (status === 'success') return 'success';
    if (isExternalRedeemFailedItem(item)) return 'failed';
    if (item?.accepted) return 'running';
    return 'skipped';
  }

  function canRetryExternalRedeemItem(item = {}) {
    const status = String(item?.status || '').trim().toLowerCase();
    return Boolean(item?.id && item?.email && item?.cdkey)
      && (['failed', 'timeout', 'cancelled', 'rejected', 'submit_failed', 'not_found'].includes(status)
        || hasExternalRedeemRechargeFailureSignal(item));
  }

  function renderExternalRedeemQueue() {
    const queue = getExternalRedeemQueue();
    const pending = queue.filter((item) => item?.accepted
      && !isExternalRedeemTerminal(item?.status)
      && !hasExternalRedeemRechargeFailureSignal(item)).length;
    const success = queue.filter((item) => String(item?.status || '').toLowerCase() === 'success').length;
    const failed = queue.filter((item) => isExternalRedeemFailedItem(item)).length;
    const enabled = Boolean(state?.externalRedeemEnabled);
    const lastError = String(state?.externalRedeemLastError || '').trim();
    els.externalRedeemStatus.textContent = lastError
      ? `异常：${lastError}`
      : (enabled ? `${pending} 个进行中 / ${success} 成功 / ${failed} 失败` : '未启用');

    if (!queue.length) {
      els.externalRedeemList.innerHTML = '<div class="redeem-item">暂无兑换任务</div>';
      return;
    }

    els.externalRedeemList.innerHTML = queue.slice().reverse().map((item) => {
      const statusLabel = getExternalRedeemStatusLabel(item);
      const reason = String(item.reason || item.errorMessage || '').trim();
      const updated = item.lastCheckedAt || item.updatedAt || item.submittedAt || item.createdAt;
      const retryButton = canRetryExternalRedeemItem(item)
        ? `<button class="btn small" type="button" data-retry-redeem-id="${htmlEscape(item.id)}">重试</button>`
        : '';
      const deleteButton = item?.id
        ? `<button class="btn small danger" type="button" data-delete-redeem-id="${htmlEscape(item.id)}">删除</button>`
        : '';
      return `
        <div class="redeem-item">
          <div class="redeem-head">
            <div>
              <strong class="pool-email">${htmlEscape(item.email || '-')}</strong>
              <div class="pool-meta mono">${htmlEscape(item.cdkey || '-')}</div>
            </div>
            <span class="badge ${getExternalRedeemBadgeClass(item)}">${htmlEscape(statusLabel)}</span>
          </div>
          <div class="redeem-grid">
            <span>Task</span><code>${htmlEscape(item.taskId || '-')}</code>
            <span>AC</span><code>${htmlEscape(item.accessTokenPreview || '-')}</code>
            <span>交易</span><code>${htmlEscape([item.transactionId, item.transactionStatus].filter(Boolean).join(' / ') || '-')}</code>
            <span>更新</span><span>${htmlEscape(formatDateTime(updated))}</span>
          </div>
          ${reason ? `<div class="pool-meta">原因：${htmlEscape(reason)}</div>` : ''}
          ${(retryButton || deleteButton) ? `<div class="actions">${retryButton}${deleteButton}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function getRedeemRecordStatusLabel(record = {}) {
    return getExternalRedeemStatusLabel({
      status: record.redeemStatus,
      displayStatus: record.displayStatus,
      reason: record.reason,
      errorMessage: record.errorMessage,
    });
  }

  function renderExternalRedeemRecords() {
    const records = getExternalRedeemRecords();
    const dbPath = String(state?.externalRedeemRecordsDbPath || '').trim();
    const lastError = String(state?.externalRedeemRecordsLastError || '').trim();
    els.externalRedeemRecordsStatus.textContent = lastError
      ? `异常：${lastError}`
      : (records.length ? `${records.length} 条${dbPath ? ` / ${dbPath}` : ''}` : '未读取');

    if (!records.length) {
      els.externalRedeemRecordsList.innerHTML = '<div class="redeem-item">暂无 SQLite 记录</div>';
      return;
    }

    els.externalRedeemRecordsList.innerHTML = records.slice(0, 80).map((record) => {
      const statusLabel = getRedeemRecordStatusLabel(record);
      const reason = String(record.reason || record.errorMessage || record.checkReason || '').trim();
      const cdk = String(record.cdk || '').trim();
      return `
        <div class="redeem-item">
          <div class="redeem-head">
            <div>
              <strong class="pool-email">${htmlEscape(record.email || '-')}</strong>
              <div class="pool-meta mono">${htmlEscape(cdk || '-')}</div>
            </div>
            <span class="badge ${getExternalRedeemBadgeClass(record)}">${htmlEscape(statusLabel || (record.qualified ? '合格' : '未兑换'))}</span>
          </div>
          <div class="redeem-grid">
            <span>资格</span><code>${htmlEscape(record.qualified ? '合格' : '不合格')}</code>
            <span>AC</span><code>${htmlEscape(record.accessTokenPreview || '-')}</code>
            <span>Task</span><code>${htmlEscape(record.taskId || '-')}</code>
            <span>交易</span><code>${htmlEscape([record.transactionId, record.transactionStatus].filter(Boolean).join(' / ') || '-')}</code>
            <span>更新</span><span>${htmlEscape(formatDateTime(record.updatedAt))}</span>
          </div>
          ${reason ? `<div class="pool-meta">原因：${htmlEscape(reason)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderFeishuSyncStatus() {
    if (!els.feishuSyncStatus) {
      return;
    }
    const enabled = Boolean(state?.feishuSyncEnabled);
    const lastError = String(state?.feishuLastError || '').trim();
    const lastEmail = normalizeEmail(state?.feishuLastSyncEmail || '');
    const lastSyncAt = Number(state?.feishuLastSyncAt) || 0;
    if (!enabled) {
      els.feishuSyncStatus.textContent = '未启用';
    } else if (lastError) {
      els.feishuSyncStatus.textContent = `异常：${lastError}`;
    } else if (lastSyncAt) {
      els.feishuSyncStatus.textContent = lastEmail
        ? `已同步 ${lastEmail} / ${formatDateTime(lastSyncAt)}`
        : `已连接 / ${formatDateTime(lastSyncAt)}`;
    } else {
      els.feishuSyncStatus.textContent = '待测试';
    }
  }

  function isAutoRunning() {
    return Boolean(state?.autoRunning) || isAutoRunActivePhase(state?.autoRunPhase);
  }

  function setRunningUi() {
    const autoRunning = isAutoRunning();
    els.stop.disabled = !autoRunning;
    els.autoRun.disabled = autoRunStarting || autoRunning;
    if (els.startMultiThread) els.startMultiThread.disabled = autoRunStarting || autoRunning;
    if (els.stopMultiThread) els.stopMultiThread.disabled = !hasRunningMultiThreadPlans();
    els.autoRun.textContent = autoRunStarting ? '启动中...' : (autoRunning ? '执行中' : '自动执行');
    els.autoRun.dataset.state = autoRunStarting ? 'starting' : (autoRunning ? 'running' : 'idle');
  }

  function renderState() {
    const entries = getStateEntries();
    applyIcloudApiModeUi(state?.icloudApiMode || entries.find((entry) => entry.apiMode)?.apiMode || ICLOUD_API_MODE_NORMAL);
    els.emailPool.value = entriesToText(entries);
    els.checkoutProxy.value = normalizeProxyUrl(state?.plusCheckoutConversionProxyUrl || '');
    if (els.checkoutProxyPool) {
      els.checkoutProxyPool.value = normalizeProxyPoolText(state?.plusCheckoutConversionProxyPoolText || els.checkoutProxyPool.value || '');
    }
    if (!loginSecurityConfigDirty) {
      els.password.value = String(state?.customPassword || els.password.value || '');
      if (els.chatgptTotpAutoEnable) {
        els.chatgptTotpAutoEnable.checked = Boolean(state?.chatgptTotpAutoEnable);
      }
    }
    if (!externalRedeemConfigDirty) {
      els.externalRedeemEnabled.checked = Boolean(state?.externalRedeemEnabled);
      els.externalRedeemBaseUrl.value = normalizeUrl(state?.externalRedeemBaseUrl || els.externalRedeemBaseUrl.value || EXTERNAL_REDEEM_DEFAULT_BASE_URL);
      els.externalRedeemApiKey.value = String(state?.externalRedeemApiKey || els.externalRedeemApiKey.value || '');
      els.externalRedeemCdkeys.value = normalizeExternalRedeemCdkeyPoolText(state?.externalRedeemCdkeyPoolText || els.externalRedeemCdkeys.value || '');
      els.externalRedeemPollSeconds.value = String(Math.max(30, Math.min(300, Math.floor(Number(state?.externalRedeemPollSeconds) || 30))));
    }
    if (!feishuConfigDirty) {
      els.feishuSyncEnabled.checked = state?.feishuSyncEnabled !== false;
      els.feishuAppId.value = String(state?.feishuAppId || els.feishuAppId.value || DEFAULT_FEISHU_SYNC_CONFIG.appId);
      els.feishuAppSecret.value = String(state?.feishuAppSecret || els.feishuAppSecret.value || DEFAULT_FEISHU_SYNC_CONFIG.appSecret);
      els.feishuBitableAppToken.value = String(state?.feishuBitableAppToken || els.feishuBitableAppToken.value || DEFAULT_FEISHU_SYNC_CONFIG.bitableAppToken);
      els.feishuBitableTableId.value = String(state?.feishuBitableTableId || els.feishuBitableTableId.value || DEFAULT_FEISHU_SYNC_CONFIG.bitableTableId);
    }
    els.currentEmail.textContent = normalizeEmail(state?.email || state?.registrationEmailState?.current || '') || '等待邮箱';
    renderPool(entries);
    renderChatGptAc();
    renderFeishuSyncStatus();
    renderExternalRedeemQueue();
    renderExternalRedeemRecords();
    renderProxyPoolResults(state?.plusCheckoutConversionProxyPoolResults || []);
    renderSteps();
    renderLogs();
    renderMultiThreadWorkbench();
    setRunningUi();
  }

  async function syncChatGptAc() {
    els.syncChatgptAc.disabled = true;
    const previousText = els.syncChatgptAc.textContent;
    els.syncChatgptAc.textContent = '同步中...';
    els.chatgptAcStatus.textContent = '同步中...';
    try {
      const response = await sendMessage({
        type: 'READ_CHATGPT_ACCESS_TOKEN',
        source: 'sidepanel',
        payload: { promoId: 'plus-1-month-free' },
      }, 70000);
      const tokenEmail = normalizeEmail(response?.accessTokenCheck?.email || response?.accessTokenInfo?.email || '');
      rememberFullAccessToken(tokenEmail, response?.accessToken);
      state = response?.state || {
        ...(state || {}),
        chatgptAccessTokenInfo: response?.accessTokenInfo || null,
        chatgptAccessTokenCheck: response?.accessTokenCheck || null,
      };
      chatgptAcExpanded = true;
      renderState();
      showToast(`AC 已同步：${getAcSummaryLabel(getChatGptAcInfo(), getChatGptAcCheck())}`, 'success');
    } catch (error) {
      chatgptAcExpanded = true;
      renderChatGptAc();
      showToast(error.message || 'AC 同步失败', 'error', 7000);
    } finally {
      els.syncChatgptAc.disabled = false;
      els.syncChatgptAc.textContent = previousText || '同步 AC';
    }
  }

  async function testFeishuSync() {
    els.testFeishuSync.disabled = true;
    const previousText = els.testFeishuSync.textContent;
    els.testFeishuSync.textContent = '测试中...';
    els.feishuSyncStatus.textContent = '测试中...';
    try {
      await saveSettings({ silent: true });
      const response = await sendMessage({
        type: 'TEST_FEISHU_SYNC',
        source: 'sidepanel',
      }, 45000);
      state = response?.state || state;
      renderState();
      showToast('飞书同步连接正常', 'success');
    } catch (error) {
      els.feishuSyncStatus.textContent = '测试失败';
      showToast(error.message || '飞书同步测试失败', 'error', 7000);
    } finally {
      els.testFeishuSync.disabled = false;
      els.testFeishuSync.textContent = previousText || '测试连接';
    }
  }

  async function syncFeishuNow() {
    els.syncFeishuNow.disabled = true;
    const previousText = els.syncFeishuNow.textContent;
    els.syncFeishuNow.textContent = '同步中...';
    els.feishuSyncStatus.textContent = '同步中...';
    try {
      await saveSettings({ silent: true });
      const response = await sendMessage({
        type: 'SYNC_FEISHU_NOW',
        source: 'sidepanel',
      }, 45000);
      state = response?.state || state;
      renderState();
      if (response?.ok === false) {
        showToast(response.error || `飞书同步完成：成功 ${Number(response.success) || 0} 条，失败 ${Number(response.failed) || 0} 条`, 'error', 9000);
      } else {
        showToast(`飞书兑换记录已同步：${Number(response?.success) || 0} 条`, 'success');
      }
    } catch (error) {
      els.feishuSyncStatus.textContent = '同步失败';
      showToast(error.message || '飞书同步失败', 'error', 9000);
    } finally {
      els.syncFeishuNow.disabled = false;
      els.syncFeishuNow.textContent = previousText || '同步兑换记录';
    }
  }

  async function refreshExternalRedeemQueue() {
    els.refreshExternalRedeem.disabled = true;
    const previousText = els.refreshExternalRedeem.textContent;
    els.refreshExternalRedeem.textContent = '刷新中...';
    try {
      const response = await sendMessage({ type: 'POLL_EXTERNAL_REDEEM_QUEUE', source: 'sidepanel' }, 45000);
      state = response?.state || state;
      renderState();
      showToast(`兑换队列已刷新${Number(response?.checked) ? `：${response.checked} 条` : ''}`, 'success');
    } catch (error) {
      showToast(error.message || '兑换队列刷新失败', 'error', 6200);
    } finally {
      els.refreshExternalRedeem.disabled = false;
      els.refreshExternalRedeem.textContent = previousText || '刷新队列';
    }
  }

  async function refreshExternalRedeemRecords() {
    els.refreshExternalRedeemRecords.disabled = true;
    const previousText = els.refreshExternalRedeemRecords.textContent;
    els.refreshExternalRedeemRecords.textContent = '读取中...';
    try {
      const response = await sendMessage({
        type: 'GET_EXTERNAL_REDEEM_RECORDS',
        source: 'sidepanel',
        payload: { limit: 500 },
      }, 20000);
      state = response?.state || state;
      renderState();
      showToast(`兑换记录已读取：${getExternalRedeemRecords().length} 条`, 'success');
    } catch (error) {
      showToast(error.message || '兑换记录读取失败，请确认本地 Node 代理已启动', 'error', 7000);
    } finally {
      els.refreshExternalRedeemRecords.disabled = false;
      els.refreshExternalRedeemRecords.textContent = previousText || '刷新记录';
    }
  }

  let clearExternalRedeemRecordsArmed = false;
  let clearExternalRedeemRecordsTimer = null;
  let clearExternalRedeemCdkeyHistoryArmed = false;
  let clearExternalRedeemCdkeyHistoryTimer = null;

  function disarmClearExternalRedeemRecords() {
    clearExternalRedeemRecordsArmed = false;
    if (clearExternalRedeemRecordsTimer) {
      clearTimeout(clearExternalRedeemRecordsTimer);
      clearExternalRedeemRecordsTimer = null;
    }
    if (els.clearExternalRedeemRecords) {
      els.clearExternalRedeemRecords.textContent = '删除历史记录';
    }
  }

  function disarmClearExternalRedeemCdkeyHistory() {
    clearExternalRedeemCdkeyHistoryArmed = false;
    if (clearExternalRedeemCdkeyHistoryTimer) {
      clearTimeout(clearExternalRedeemCdkeyHistoryTimer);
      clearExternalRedeemCdkeyHistoryTimer = null;
    }
    if (els.clearExternalRedeemCdkeyHistory) {
      els.clearExternalRedeemCdkeyHistory.textContent = '清空 CDK 历史';
    }
  }

  async function clearExternalRedeemRecords() {
    if (!clearExternalRedeemRecordsArmed) {
      clearExternalRedeemRecordsArmed = true;
      els.clearExternalRedeemRecords.textContent = '再次点击确认清空';
      clearExternalRedeemRecordsTimer = setTimeout(disarmClearExternalRedeemRecords, 4000);
      return;
    }
    disarmClearExternalRedeemRecords();
    els.clearExternalRedeemRecords.disabled = true;
    els.clearExternalRedeemRecords.textContent = '清空中...';
    try {
      const response = await sendMessage({
        type: 'CLEAR_EXTERNAL_REDEEM_RECORDS',
        source: 'sidepanel',
        payload: {},
      }, 20000);
      state = response?.state || state;
      renderState();
      if (response?.ok === false) {
        showToast(response.error || '兑换历史清空失败', 'error', 7000);
      } else {
        showToast('已清空兑换历史记录', 'success');
      }
    } catch (error) {
      showToast(error.message || '兑换历史清空失败，请确认本地 Node 代理已启动', 'error', 7000);
    } finally {
      els.clearExternalRedeemRecords.disabled = false;
      els.clearExternalRedeemRecords.textContent = '删除历史记录';
    }
  }

  async function clearExternalRedeemCdkeyHistory() {
    if (!clearExternalRedeemCdkeyHistoryArmed) {
      clearExternalRedeemCdkeyHistoryArmed = true;
      els.clearExternalRedeemCdkeyHistory.textContent = '再次点击确认';
      clearExternalRedeemCdkeyHistoryTimer = setTimeout(disarmClearExternalRedeemCdkeyHistory, 4000);
      return;
    }
    disarmClearExternalRedeemCdkeyHistory();
    els.clearExternalRedeemCdkeyHistory.disabled = true;
    els.clearExternalRedeemCdkeyHistory.textContent = '清空中...';
    try {
      const response = await sendMessage({
        type: 'CLEAR_EXTERNAL_REDEEM_CDKEY_HISTORY',
        source: 'sidepanel',
        payload: {},
      }, 25000);
      state = response?.state || state;
      renderState();
      const removedQueue = Number(response?.removedQueue) || 0;
      const recordsCleared = response?.recordsCleared === true;
      const recordHint = recordsCleared ? '，SQLite 记录已清空' : '';
      showToast(`已清空 CDK 使用历史：队列 ${removedQueue} 条${recordHint}`, 'success', 6200);
    } catch (error) {
      showToast(error.message || 'CDK 历史清空失败', 'error', 7000);
    } finally {
      els.clearExternalRedeemCdkeyHistory.disabled = false;
      els.clearExternalRedeemCdkeyHistory.textContent = '清空 CDK 历史';
    }
  }

  async function retryExternalRedeemItem(itemId, button = null) {
    const normalizedItemId = String(itemId || '').trim();
    if (!normalizedItemId) {
      return;
    }
    const previousText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = '重试中...';
    }
    try {
      const response = await sendMessage({
        type: 'RETRY_EXTERNAL_REDEEM_ITEM',
        source: 'sidepanel',
        payload: { itemId: normalizedItemId },
      }, 70000);
      state = response?.state || state;
      renderState();
      if (response?.ok === false) {
        showToast(response.error || '外部兑换重试失败', 'error', 7000);
      } else {
        showToast('外部兑换已重新提交', 'success');
      }
    } catch (error) {
      showToast(error.message || '外部兑换重试失败', 'error', 7000);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = previousText || '重试';
      }
    }
  }

  async function deleteExternalRedeemItem(itemId, button = null) {
    const normalizedItemId = String(itemId || '').trim();
    if (!normalizedItemId) {
      return;
    }
    const previousText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = '删除中...';
    }
    try {
      const response = await sendMessage({
        type: 'DELETE_EXTERNAL_REDEEM_ITEM',
        source: 'sidepanel',
        payload: { itemId: normalizedItemId },
      }, 20000);
      state = response?.state || state;
      externalRedeemConfigDirty = false;
      renderState();
      showToast('已删除本地兑换记录和对应 CDK', 'success');
    } catch (error) {
      showToast(error.message || '兑换记录删除失败', 'error', 7000);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = previousText || '删除';
      }
    }
  }

  async function saveExternalRedeemCdkeys(text, toastMessage) {
    const normalized = normalizeExternalRedeemCdkeyPoolText(text);
    els.externalRedeemCdkeys.value = normalized;
    externalRedeemConfigDirty = true;
    await saveSettings({ silent: true });
    showToast(toastMessage || `CDK 池已保存：${normalized ? normalized.split(/\n/).length : 0} 个`, 'success');
  }

  async function clearExternalRedeemCdkeys() {
    els.externalRedeemCdkeys.value = '';
    externalRedeemConfigDirty = true;
    const response = await sendMessage({
      type: 'CLEAR_EXTERNAL_REDEEM_CDKEY_POOL',
      source: 'sidepanel',
    }, 20000);
    state = response?.state || {
      ...(state || {}),
      externalRedeemCdkeyPoolText: '',
    };
    externalRedeemConfigDirty = false;
    renderState();
    showToast('已清理 CDK 池，并移除本地提交失败记录。', 'success');
  }

  async function importExternalRedeemCdkeyFile(file) {
    if (!file) {
      return;
    }
    const text = await file.text();
    const merged = mergeExternalRedeemCdkeys(els.externalRedeemCdkeys.value, text);
    await saveExternalRedeemCdkeys(merged, `CDK 已上传并合并：${merged ? merged.split(/\n/).length : 0} 个`);
  }

  function exportChatGptAcCsv() {
    const entries = getStateEntries();
    const currentInfo = getChatGptAcInfo();
    const currentCheck = getChatGptAcCheck();
    const currentEmail = normalizeEmail(currentCheck?.email || currentInfo?.email || '').toLowerCase();
    const records = getChatGptAcRecords();
    const history = getChatGptAcHistory();
    const redeemQueue = getExternalRedeemQueue();
    const redeemRecords = getExternalRedeemRecords();
    const redeemByEmail = new Map();
    redeemQueue.forEach((item) => {
      const email = normalizeEmail(item?.email).toLowerCase();
      if (!email || !item?.cdkey) {
        return;
      }
      const previous = redeemByEmail.get(email);
      const previousTime = Number(previous?.lastCheckedAt || previous?.submittedAt || previous?.createdAt) || 0;
      const currentTime = Number(item?.lastCheckedAt || item?.submittedAt || item?.createdAt) || 0;
      if (!previous || currentTime >= previousTime) {
        redeemByEmail.set(email, item);
      }
    });
    redeemRecords.forEach((item) => {
      const email = normalizeEmail(item?.email).toLowerCase();
      if (!email || !item?.cdk) {
        return;
      }
      if (!redeemByEmail.has(email)) {
        redeemByEmail.set(email, {
          cdkey: item.cdk,
          displayStatus: item.displayStatus,
          status: item.redeemStatus,
        });
      }
    });
    const getRedeemForEmail = (email = '') => redeemByEmail.get(normalizeEmail(email).toLowerCase()) || null;
    const entryByEmail = new Map();
    entries.forEach((entry) => {
      const email = normalizeEmail(entry.email).toLowerCase();
      if (email) {
        entryByEmail.set(email, entry);
      }
    });
    const rows = [['邮箱信息', 'AC', '是否有资格', 'AC检测原因', 'Coupon', 'HTTP状态', '检测时间', 'CDK', '兑换状态']];
    const appendAcRow = (emailValue = '', tokenValue = '', checkValue = null, redeemValue = null, fallbackTime = '') => {
      const check = checkValue && typeof checkValue === 'object'
        ? { ...checkValue, checked: checkValue.checked !== false }
        : null;
      const redeem = redeemValue || getRedeemForEmail(emailValue);
      rows.push([
        normalizeEmail(emailValue),
        tokenValue,
        getAcCheckLabel(check),
        check?.error || check?.reason || '',
        [check?.couponState || '', check?.promoId || ''].filter(Boolean).join(' / '),
        [check?.tokenOk === true ? 'token_ok=true' : (check?.tokenOk === false ? 'token_ok=false' : ''), check?.status ? `status=${check.status}` : ''].filter(Boolean).join(' / '),
        formatDateTime(check?.checkedAt || fallbackTime),
        redeem?.cdkey || redeem?.cdk || '',
        redeem?.displayStatus || redeem?.status || redeem?.redeemStatus || '',
      ]);
    };
    if (history.length) {
      history.slice().reverse().forEach((record) => {
        const email = normalizeEmail(record?.email || record?.check?.email || record?.info?.email || '');
        if (!email) {
          return;
        }
        const key = email.toLowerCase();
        const token = fullAccessTokenByEmail.get(key)
          || String(record?.accessToken || '')
          || String(record?.accessTokenPreview || '')
          || String(record?.info?.accessTokenPreview || '');
        appendAcRow(email, token, record?.check || null, getRedeemForEmail(email), record?.checkedAt || record?.updatedAt);
      });
    }
    const exportEmails = new Set([
      ...entries.map((entry) => normalizeEmail(entry.email).toLowerCase()).filter(Boolean),
      ...Object.keys(records).map((email) => normalizeEmail(email).toLowerCase()).filter(Boolean),
      ...redeemRecords.map((record) => normalizeEmail(record.email).toLowerCase()).filter(Boolean),
      currentEmail,
    ].filter(Boolean));

    if (!history.length) exportEmails.forEach((key) => {
      const entry = entryByEmail.get(key) || {};
      const record = records[key] || null;
      const email = normalizeEmail(entry.email || record?.email || key);
      const entryCheck = entry.accessTokenCheck && typeof entry.accessTokenCheck === 'object'
        ? { ...entry.accessTokenCheck, checked: true }
        : null;
      const recordCheck = record?.check && typeof record.check === 'object'
        ? { ...record.check, checked: true }
        : null;
      const check = recordCheck || entryCheck || (key && key === currentEmail ? currentCheck : null);
      const token = fullAccessTokenByEmail.get(key)
        || String(record?.accessToken || '')
        || String(record?.accessTokenPreview || '')
        || (key && key === currentEmail ? String(currentInfo?.accessTokenPreview || '') : '')
        || String(entry.accessTokenCheck?.accessTokenPreview || '');
      const redeem = redeemByEmail.get(key) || null;
      appendAcRow(email, token, check, redeem, record?.updatedAt);
    });

    if (rows.length === 1) {
      showToast('没有可导出的邮箱信息', 'error');
      return;
    }

    const csv = `\ufeff${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chatgpt-ac-${getExportDateSegment()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已导出 Excel CSV', 'success');
  }

  async function runAuto() {
    if (autoRunStarting || isAutoRunning()) {
      return;
    }

    autoRunStarting = true;
    setRunningUi();
    showToast('正在启动自动流程...', 'info');

    try {
      await saveSettings({ silent: true });
      const totalRuns = Math.max(1, Math.floor(Number(els.runCount.value) || 1));
      await sendMessageWithWindow({
        type: 'AUTO_RUN',
        source: 'sidepanel',
        payload: {
          totalRuns,
          mode: 'restart',
          autoRunSkipFailures: false,
          contributionMode: false,
        },
      });
      state = {
        ...(state || {}),
        autoRunning: true,
        autoRunPhase: 'running',
        autoRunTotalRuns: totalRuns,
      };
      renderState();
      showToast('自动流程已启动', 'success');
      setTimeout(() => {
        loadState().catch(() => {});
      }, 800);
    } catch (error) {
      loadState().catch(() => {});
      showToast(error.message || '自动流程启动失败', 'error', 6200);
    } finally {
      autoRunStarting = false;
      setRunningUi();
    }
  }

  async function prepareThreads() {
    await saveSettings({ silent: true });
    const threadCount = getThreadCountFromInput();
    const response = await sendMessageWithWindow({
      type: 'PREPARE_MULTI_THREAD_WORKBENCH',
      source: 'sidepanel',
      payload: { threadCount },
    }, 30000);
    state = response?.state || state;
    renderState();
    showToast(`已准备 ${threadCount} 个线程`, 'success');
  }

  async function ensureLocalServices() {
    const button = els.ensureLocalServices;
    const originalText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = '启动中...';
    }
    try {
      const response = await sendMessageWithWindow({
        type: 'ENSURE_LOCAL_SERVICES',
        source: 'sidepanel',
        payload: {},
      }, 120000);
      if (response?.state) {
        state = response.state;
        renderState();
      } else {
        await loadState();
      }
      if (response?.ok === false) {
        throw new Error(response.error || response.message || '启动本地服务失败');
      }
      showToast(
        '本地服务已就绪，可以点击多线程启动。',
        'success',
        9000
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText || '启动本地服务';
      }
    }
  }

  async function startMultiThread() {
    await saveSettings({ silent: true });
    const threadCount = getThreadCountFromInput();
    const response = await sendMessageWithWindow({
      type: 'START_MULTI_THREAD_AUTO_RUN',
      source: 'sidepanel',
      payload: { threadCount },
    }, 120000).catch((error) => ({ ok: false, error: error.message }));
    if (response?.state) {
      state = response.state;
      renderState();
    } else {
      await loadState();
    }
    if (response?.blocked) {
      showToast(response.reason || '多线程启动已被保护拦截', 'error', 9000);
      return;
    }
    if (response?.ok === false) {
      showToast(response.error || response.reason || '多线程启动失败', 'error', 9000);
      return;
    }
    ensureMultiThreadLogSync();
    showToast('多线程任务已启动', 'success');
  }

  async function stopMultiThreadTask(options = {}) {
    const button = els.stopMultiThread;
    const originalText = button?.textContent || '终止任务';
    if (button) {
      button.disabled = true;
      button.textContent = '终止中...';
    }
    try {
      const response = await sendMessageWithWindow({
        type: 'STOP_MULTI_THREAD_AUTO_RUN',
        source: 'sidepanel',
        payload: {},
      }, 45000);
      stopMultiThreadLogSync();
      if (response?.state) {
        state = response.state;
        renderState();
      } else {
        await loadState();
      }
      if (response?.stopped === false) {
        if (!options.silent) {
          showToast(response.message || '终止请求已记录，但 runner 返回异常', 'error', 9000);
        }
        return response;
      }
      if (!options.silent) {
        showToast('多线程任务已终止', 'success');
      }
      return response;
    } finally {
      if (button) {
        button.textContent = originalText;
        button.disabled = !hasRunningMultiThreadPlans();
      }
    }
  }

  async function clearMultiThreadInfo() {
    if (hasRunningMultiThreadPlans()) {
      showToast('请先终止多线程任务，再清空线程信息', 'error', 7000);
      return;
    }
    const button = els.clearMultiThreadInfo;
    const originalText = button?.textContent || '清空线程信息';
    if (button) {
      button.disabled = true;
      button.textContent = '清空中...';
    }
    try {
      const response = await sendMessageWithWindow({
        type: 'CLEAR_MULTI_THREAD_WORKBENCH',
        source: 'sidepanel',
        payload: {},
      }, 20000);
      stopMultiThreadLogSync();
      if (response?.state) {
        state = response.state;
        renderState();
      } else {
        await loadState();
      }
      if (response?.ok === false) {
        showToast(response.error || response.message || '清空线程信息失败', 'error', 7000);
        return;
      }
      showToast('已清空线程信息', 'success');
    } finally {
      if (button) {
        button.textContent = originalText;
        button.disabled = hasRunningMultiThreadPlans() || !hasMultiThreadWorkbenchHistory();
      }
    }
  }

  async function stopFlow() {
    const shouldStopMultiThread = hasRunningMultiThreadPlans();
    await sendMessage({ type: 'STOP_FLOW', source: 'sidepanel' }, 15000);
    if (shouldStopMultiThread) {
      await stopMultiThreadTask({ silent: true }).catch((error) => {
        console.warn('[GuJumpgate sidepanel] stop multi-thread task failed:', error?.message || error);
      });
    }
    stopMultiThreadLogSync();
    showToast('已发送停止请求', 'info');
    await loadState();
  }

  async function resetFlow() {
    await sendMessage({ type: 'RESET', source: 'sidepanel' }, 20000);
    stopMultiThreadLogSync();
    showToast('流程已重置', 'success');
    await loadState();
  }

  async function executeNode(nodeId) {
    await saveSettings({ silent: true });
    await sendMessageWithWindow({
      type: 'EXECUTE_NODE',
      source: 'sidepanel',
      nodeId,
      payload: { nodeId },
    });
    showToast(`已执行 ${nodeId}`, 'success');
    await loadState();
  }

  async function testProxy() {
    const proxyUrl = normalizeProxyUrl(els.checkoutProxy.value);
    if (!proxyUrl) {
      els.proxyTestResult.textContent = '请先填写代理';
      showToast('请先填写全流程代理', 'error');
      return;
    }
    els.testProxy.disabled = true;
    els.proxyTestResult.textContent = '测试中（最多 90 秒）...';
    try {
      const response = await sendMessage({
        type: 'TEST_PLUS_CHECKOUT_CONVERSION_PROXY',
        source: 'sidepanel',
        payload: { proxyUrl },
      }, 90000);
      const exitIp = String(response?.exitIp || '').trim();
      const exitRegion = String(response?.exitRegion || '').trim();
      const summary = exitIp ? `${exitIp}${exitRegion ? ` [${exitRegion}]` : ''}` : '可用';
      els.proxyTestResult.textContent = `可用: ${summary}`;
      showToast(`代理测试通过：${summary}`, 'success');
    } catch (error) {
      const message = sanitizeProxyErrorMessage(error?.message || '代理测试失败');
      els.proxyTestResult.textContent = `测试失败: ${message}`;
      showToast(message, 'error', 9000);
    } finally {
      els.testProxy.disabled = false;
    }
  }

  async function testProxyPool() {
    const entries = getProxyPoolEntries();
    if (!entries.length) {
      els.proxyTestResult.textContent = '代理池为空';
      showToast('请先填写或上传代理池', 'error');
      return;
    }
    els.testProxyPool.disabled = true;
    els.proxyTestResult.textContent = `批量测试中 0/${entries.length}`;
    const results = [];
    try {
      els.checkoutProxyPool.value = entries.join('\n');
      await saveSettings({ silent: true });
      renderProxyPoolResults(results);
      for (let index = 0; index < entries.length; index += 1) {
        const proxyUrl = entries[index];
        els.proxyTestResult.textContent = `批量测试中 ${index + 1}/${entries.length}`;
        try {
          const response = await sendMessage({
            type: 'TEST_PLUS_CHECKOUT_CONVERSION_PROXY',
            source: 'sidepanel',
            payload: { proxyUrl },
          }, 90000);
          results.push({
            index,
            ok: true,
            exitIp: String(response?.exitIp || '').trim(),
            exitRegion: String(response?.exitRegion || '').trim(),
          });
        } catch (error) {
          results.push({
            index,
            ok: false,
            error: sanitizeProxyErrorMessage(error?.message || '代理测试失败'),
          });
        }
        renderProxyPoolResults(results);
      }
      const okCount = results.filter((item) => item.ok).length;
      const failCount = results.length - okCount;
      els.proxyTestResult.textContent = `代理池：可用 ${okCount} / 失败 ${failCount}`;
      state = {
        ...(state || {}),
        plusCheckoutConversionProxyPoolText: entries.join('\n'),
        plusCheckoutConversionProxyPoolResults: results,
      };
      await sendMessage({
        type: 'SAVE_PLUS_CHECKOUT_CONVERSION_PROXY_POOL_RESULTS',
        source: 'sidepanel',
        payload: { results },
      }).catch(() => null);
      showToast(`代理池测试完成：可用 ${okCount} 条，失败 ${failCount} 条`, okCount ? 'success' : 'error', 6200);
    } finally {
      els.testProxyPool.disabled = false;
    }
  }

  async function importProxyPoolFile(file) {
    const text = await readTextFile(file);
    const existing = getProxyPoolEntries();
    const imported = normalizeProxyPoolText(text).split('\n').filter(Boolean);
    const merged = normalizeProxyPoolText([...existing, ...imported].join('\n'));
    const count = merged ? merged.split('\n').filter(Boolean).length : 0;
    if (!count) {
      throw new Error('文件中未解析到有效代理。支持 host:port:user:pass 或 http://user:pass@host:port。');
    }
    els.checkoutProxyPool.value = merged;
    state = {
      ...(state || {}),
      plusCheckoutConversionProxyPoolText: merged,
      plusCheckoutConversionProxyPoolIndex: 0,
      plusCheckoutConversionProxyPoolResults: [],
    };
    renderProxyPoolResults([]);
    await saveSettings({ silent: true });
    els.proxyTestResult.textContent = `代理池 ${count} 条`;
    showToast(`已导入代理池 ${count} 条`, 'success');
  }

  async function clearProxyPool() {
    els.checkoutProxyPool.value = '';
    state = {
      ...(state || {}),
      plusCheckoutConversionProxyPoolText: '',
      plusCheckoutConversionProxyPoolIndex: 0,
      plusCheckoutConversionProxyPoolResults: [],
    };
    renderProxyPoolResults([]);
    await saveSettings({ silent: true });
    await sendMessage({
      type: 'SAVE_PLUS_CHECKOUT_CONVERSION_PROXY_POOL_RESULTS',
      source: 'sidepanel',
      payload: { results: [] },
    }, 15000).catch(() => null);
    els.proxyTestResult.textContent = '代理池已清空';
    showToast('代理池已清空', 'success');
  }

  async function applyProxy() {
    const proxyUrl = normalizeProxyUrl(els.checkoutProxy.value);
    if (!proxyUrl) {
      els.proxyTestResult.textContent = '请先填写代理';
      showToast('请先填写全流程代理', 'error');
      return;
    }
    els.applyProxy.disabled = true;
    els.proxyTestResult.textContent = '启用中...';
    try {
      await saveSettings({ silent: true });
      const response = await sendMessage({
        type: 'APPLY_PLUGIN_PROXY',
        source: 'sidepanel',
        payload: { proxyUrl },
      }, 30000);
      const display = normalizeUrl(response?.displayName) || '已启用';
      els.proxyTestResult.textContent = `已启用: ${display}`;
      showToast('全流程代理已启用', 'success');
    } catch (error) {
      els.proxyTestResult.textContent = '启用失败';
      showToast(error.message || '代理启用失败', 'error', 6200);
    } finally {
      els.applyProxy.disabled = false;
    }
  }

  async function clearProxy() {
    els.clearProxy.disabled = true;
    els.proxyTestResult.textContent = '清除中...';
    try {
      await sendMessage({
        type: 'CLEAR_PLUGIN_PROXY',
        source: 'sidepanel',
      }, 30000);
      els.proxyTestResult.textContent = '已清除';
      showToast('浏览器代理已清除', 'success');
    } catch (error) {
      els.proxyTestResult.textContent = '清除失败';
      showToast(error.message || '代理清除失败', 'error', 6200);
    } finally {
      els.clearProxy.disabled = false;
    }
  }

  async function clearUsedFlags() {
    const entries = getPoolEntriesFromInput().map((entry) => ({
      ...entry,
      used: false,
      lastUsedAt: 0,
      lastError: '',
    }));
    els.emailPool.value = entriesToText(entries);
    state = {
      ...(state || {}),
      customEmailPoolEntries: entries,
      customEmailPool: entries.map((entry) => entry.email),
    };
    renderPool(entries);
    const response = await sendMessage({
      type: 'CLEAR_CUSTOM_EMAIL_POOL_USED_FLAGS',
      source: 'sidepanel',
      payload: { entries },
    }, 20000);
    state = response?.state || state;
    renderState();
    showToast('已清空邮箱已用状态', 'success');
  }

  async function clearPoolAll() {
    els.emailPool.value = '';
    state = {
      ...(state || {}),
      customEmailPoolEntries: [],
      customEmailPool: [],
    };
    renderPool([]);
    const response = await sendMessage({
      type: 'CLEAR_CUSTOM_EMAIL_POOL_ALL',
      source: 'sidepanel',
    }, 20000);
    state = response?.state || state;
    renderState();
    showToast('已清空全部邮箱池', 'success');
  }

  function resetDefaultPool() {
    applyIcloudApiModeUi(ICLOUD_API_MODE_NORMAL);
    els.emailPool.value = DEFAULT_POOL_TEXT;
    const entries = parsePoolText(DEFAULT_POOL_TEXT, { existingByEmail: new Map() });
    state = {
      ...(state || {}),
      icloudApiMode: ICLOUD_API_MODE_NORMAL,
      customEmailPoolEntries: entries,
      customEmailPool: entries.map((entry) => entry.email),
    };
    renderPool(entries);
  }

  els.save.addEventListener('click', () => {
    saveSettings().catch((error) => showToast(error.message, 'error'));
  });
  els.autoRun.addEventListener('click', () => {
    runAuto().catch((error) => showToast(error.message, 'error', 6200));
  });
  if (els.prepareThreads) {
    els.prepareThreads.addEventListener('click', () => {
      prepareThreads().catch((error) => showToast(error.message || '准备线程失败', 'error', 7000));
    });
  }
  if (els.ensureLocalServices) {
    els.ensureLocalServices.addEventListener('click', () => {
      ensureLocalServices().catch((error) => showToast(error.message || '本地服务启动失败', 'error', 9000));
    });
  }
  if (els.startMultiThread) {
    els.startMultiThread.addEventListener('click', () => {
      startMultiThread().catch((error) => showToast(error.message || '多线程启动失败', 'error', 9000));
    });
  }
  if (els.stopMultiThread) {
    els.stopMultiThread.addEventListener('click', () => {
      stopMultiThreadTask().catch((error) => showToast(error.message || '多线程终止失败', 'error', 9000));
    });
  }
  if (els.clearMultiThreadInfo) {
    els.clearMultiThreadInfo.addEventListener('click', () => {
      clearMultiThreadInfo().catch((error) => showToast(error.message || '清空线程信息失败', 'error', 7000));
    });
  }
  els.stop.addEventListener('click', () => {
    stopFlow().catch((error) => showToast(error.message, 'error'));
  });
  els.reset.addEventListener('click', () => {
    resetFlow().catch((error) => showToast(error.message, 'error'));
  });
  els.refresh.addEventListener('click', () => {
    loadState().catch((error) => showToast(error.message, 'error'));
  });
  els.testProxy.addEventListener('click', () => {
    testProxy().catch((error) => showToast(error.message, 'error'));
  });
  if (els.uploadProxyPool && els.checkoutProxyPoolFile) {
    els.uploadProxyPool.addEventListener('click', () => {
      els.checkoutProxyPoolFile.click();
    });
    els.checkoutProxyPoolFile.addEventListener('change', () => {
      const file = els.checkoutProxyPoolFile.files?.[0] || null;
      importProxyPoolFile(file)
        .catch((error) => showToast(error.message || '代理池导入失败', 'error', 6200))
        .finally(() => {
          els.checkoutProxyPoolFile.value = '';
        });
    });
  }
  if (els.testProxyPool) {
    els.testProxyPool.addEventListener('click', () => {
      testProxyPool().catch((error) => showToast(error.message, 'error', 7000));
    });
  }
  els.applyProxy.addEventListener('click', () => {
    applyProxy().catch((error) => showToast(error.message, 'error'));
  });
  els.clearProxy.addEventListener('click', () => {
    clearProxy().catch((error) => showToast(error.message, 'error'));
  });
  if (els.clearProxyPool) {
    els.clearProxyPool.addEventListener('click', () => {
      clearProxyPool().catch((error) => showToast(error.message, 'error'));
    });
  }
  els.clearUsed.addEventListener('click', () => {
    clearUsedFlags().catch((error) => showToast(error.message, 'error'));
  });
  els.clearPoolAll.addEventListener('click', () => {
    clearPoolAll().catch((error) => showToast(error.message, 'error'));
  });
  els.importEmailPoolCsv.addEventListener('click', () => {
    els.emailPoolFile.click();
  });
  els.emailPoolFile.addEventListener('change', () => {
    const file = els.emailPoolFile.files?.[0] || null;
    importEmailPoolCsvFile(file)
      .catch((error) => showToast(error.message || 'CSV 导入失败', 'error', 6200))
      .finally(() => {
        els.emailPoolFile.value = '';
      });
  });
  els.resetDefaultPool.addEventListener('click', resetDefaultPool);
  els.syncChatgptAc.addEventListener('click', () => {
    syncChatGptAc().catch((error) => showToast(error.message, 'error', 7000));
  });
  els.viewChatgptAc.addEventListener('click', () => {
    chatgptAcExpanded = !chatgptAcExpanded;
    renderChatGptAc();
  });
  els.exportChatgptAc.addEventListener('click', exportChatGptAcCsv);
  els.testFeishuSync.addEventListener('click', () => {
    testFeishuSync().catch((error) => showToast(error.message || '飞书同步测试失败', 'error', 7000));
  });
  els.syncFeishuNow.addEventListener('click', () => {
    syncFeishuNow().catch((error) => showToast(error.message || '飞书同步失败', 'error', 9000));
  });
  els.uploadExternalRedeemCdkeys.addEventListener('click', () => {
    els.externalRedeemCdkeyFile.click();
  });
  els.externalRedeemCdkeyFile.addEventListener('change', () => {
    const file = els.externalRedeemCdkeyFile.files?.[0] || null;
    importExternalRedeemCdkeyFile(file)
      .catch((error) => showToast(error.message || 'CDK 上传失败', 'error', 6200))
      .finally(() => {
        els.externalRedeemCdkeyFile.value = '';
      });
  });
  els.clearExternalRedeemCdkeys.addEventListener('click', () => {
    clearExternalRedeemCdkeys().catch((error) => showToast(error.message || 'CDK 清理失败', 'error', 6200));
  });
  if (els.clearExternalRedeemCdkeyHistory) {
    els.clearExternalRedeemCdkeyHistory.addEventListener('click', () => {
      clearExternalRedeemCdkeyHistory().catch((error) => showToast(error.message || 'CDK 历史清空失败', 'error', 7000));
    });
  }
  els.refreshExternalRedeem.addEventListener('click', () => {
    refreshExternalRedeemQueue().catch((error) => showToast(error.message, 'error', 6200));
  });
  els.refreshExternalRedeemRecords.addEventListener('click', () => {
    refreshExternalRedeemRecords().catch((error) => showToast(error.message, 'error', 6200));
  });
  els.clearExternalRedeemRecords.addEventListener('click', () => {
    clearExternalRedeemRecords().catch((error) => showToast(error.message, 'error', 6200));
  });
  els.externalRedeemList.addEventListener('click', (event) => {
    const retryButton = event.target.closest('button[data-retry-redeem-id]');
    if (retryButton) {
      retryExternalRedeemItem(retryButton.dataset.retryRedeemId, retryButton);
      return;
    }
    const deleteButton = event.target.closest('button[data-delete-redeem-id]');
    if (deleteButton) {
      deleteExternalRedeemItem(deleteButton.dataset.deleteRedeemId, deleteButton);
    }
  });
  [
    els.feishuSyncEnabled,
    els.feishuAppId,
    els.feishuAppSecret,
    els.feishuBitableAppToken,
    els.feishuBitableTableId,
  ].forEach((element) => {
    element.addEventListener('input', () => {
      feishuConfigDirty = true;
    });
    element.addEventListener('change', () => {
      feishuConfigDirty = true;
    });
  });
  [
    els.password,
    els.chatgptTotpAutoEnable,
  ].forEach((element) => {
    if (!element) return;
    element.addEventListener('input', () => {
      loginSecurityConfigDirty = true;
    });
    element.addEventListener('change', () => {
      loginSecurityConfigDirty = true;
    });
  });
  [
    els.externalRedeemEnabled,
    els.externalRedeemBaseUrl,
    els.externalRedeemApiKey,
    els.externalRedeemCdkeys,
    els.externalRedeemPollSeconds,
  ].forEach((element) => {
    if (!element) return;
    element.addEventListener('input', () => {
      externalRedeemConfigDirty = true;
    });
    element.addEventListener('change', () => {
      externalRedeemConfigDirty = true;
    });
  });
  els.emailPool.addEventListener('input', () => {
    renderPool(getPoolEntriesFromInput());
  });
  [els.icloudApiModeNormal, els.icloudApiModeTaobao, els.icloudApiModeHotmail].forEach((element) => {
    if (!element) return;
    element.addEventListener('change', () => {
      const mode = getSelectedIcloudApiMode();
      applyIcloudApiModeUi(mode);
      const entries = parsePoolText(els.emailPool.value, { mode });
      state = {
        ...(state || {}),
        icloudApiMode: mode,
        customEmailPoolEntries: entries,
        customEmailPool: entries.filter((entry) => entry.enabled).map((entry) => entry.email),
      };
      renderPool(entries);
    });
  });
  els.stepsList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-node-id]');
    if (!button) return;
    executeNode(button.dataset.nodeId).catch((error) => showToast(error.message, 'error'));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'DATA_UPDATED') {
      state = { ...(state || {}), ...(message.payload || {}) };
      renderState();
    } else if (message.type === 'NODE_STATUS_CHANGED') {
      state = {
        ...(state || {}),
        currentNodeId: message.payload?.nodeId || state?.currentNodeId || '',
        nodeStatuses: {
          ...(state?.nodeStatuses || {}),
          [message.payload?.nodeId]: message.payload?.status,
        },
      };
      renderSteps();
      setRunningUi();
    } else if (message.type === 'LOG_ENTRY') {
      state = {
        ...(state || {}),
        logs: [...(state?.logs || []), message.payload].filter(Boolean).slice(-500),
      };
      renderLogs();
      renderMultiThreadWorkbench();
    } else if (message.type === 'AUTO_RUN_STATUS') {
      const phase = String(message.payload?.phase || '').trim().toLowerCase();
      state = {
        ...(state || {}),
        autoRunning: isAutoRunActivePhase(phase),
        autoRunPhase: phase || state?.autoRunPhase || 'idle',
      };
      setRunningUi();
      loadState().catch(() => {});
    } else if (message.type === 'AUTO_RUN_RESET') {
      loadState().catch(() => {});
    }
  });

  loadState().catch((error) => {
    els.emailPool.value = DEFAULT_POOL_TEXT;
    renderPool(parsePoolText(DEFAULT_POOL_TEXT, { existingByEmail: new Map() }));
    showToast(error.message || '状态加载失败', 'error');
  });
})();
