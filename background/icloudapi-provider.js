(function icloudApiProviderModule(root, factory) {
  root.MultiPageBackgroundIcloudApiProvider = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createIcloudApiProviderModule() {
  const DEFAULT_MIN_ATTEMPTS = 90;
  const DEFAULT_INTERVAL_MS = 3000;
  const ICLOUD_API_MODE_NORMAL = 'normal';
  const ICLOUD_API_MODE_TAOBAO = 'taobao';
  const ICLOUD_API_MODE_HOTMAIL = 'hotmail';
  const ICLOUD_API_MODE_OUTLOOK_API = 'outlook-api';
  const TAOBAO_FEED_API_URL = 'https://assurivo.com/console/feed.php';
  const TAOBAO_OPEN_API_URL = 'https://assurivo.com/console/open.php';
  const OUTLOOK_API_BASE_URL = 'http://query.paopaodw.com/boobar?email=';
  const ICLOUD_API_AUTH_FAILED_PREFIX = 'ICLOUD_API_AUTH_FAILED::';
  const DEFAULT_HOTMAIL_LOCAL_BASE_URL = 'http://127.0.0.1:17373';

  function createIcloudApiProvider(deps = {}) {
    const {
      addLog = async () => {},
      extractVerificationCodeFromMessage = null,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      setState = async () => {},
      sleepWithStop = async () => {},
      throwIfStopped = () => {},
    } = deps;

    function normalizeEmail(value = '') {
      return String(value || '').trim().toLowerCase();
    }

    function normalizeUrl(value = '') {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const parsed = new URL(raw);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
      } catch {
        return '';
      }
    }

    function normalizeApiMode(value = '') {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === ICLOUD_API_MODE_OUTLOOK_API || normalized === 'outlook-api' || normalized === 'paopaodw' || normalized === 'outlook_http') {
        return ICLOUD_API_MODE_OUTLOOK_API;
      }
      if (normalized === ICLOUD_API_MODE_HOTMAIL || normalized === 'hotmail' || normalized === 'outlook' || normalized === 'microsoft' || normalized === 'graph') {
        return ICLOUD_API_MODE_HOTMAIL;
      }
      return normalized === ICLOUD_API_MODE_TAOBAO ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL;
    }

    function normalizeQueryCode(value = '') {
      return String(value || '').trim();
    }

    function summarizeIcloudApiError(value = '') {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const statusMatch = raw.match(/HTTP\s+(\d{3})/i);
      const text = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (/Authentication failed/i.test(text)) {
        return statusMatch ? `HTTP ${statusMatch[1]}：Authentication failed` : 'Authentication failed';
      }
      if (/取件失败/i.test(text)) {
        return statusMatch ? `HTTP ${statusMatch[1]}：取件失败` : '取件失败';
      }
      return text.slice(0, 220);
    }

    function isIcloudApiAuthFailureMessage(value = '') {
      return /HTTP\s+401\b|Authentication failed|取件失败/i.test(String(value || ''));
    }

    function buildIcloudApiAuthFailureError(step, target = {}, message = '') {
      const email = normalizeEmail(target.email);
      const detail = summarizeIcloudApiError(message);
      const error = new Error(
        `${ICLOUD_API_AUTH_FAILED_PREFIX}步骤 ${step}：iCloud API 鉴权失败，${email ? `${email} ` : ''}的淘宝版查询码/接口凭证不可用，请检查邮箱----查询码是否匹配。${detail ? `最后错误：${detail}` : ''}`
      );
      error.icloudApiAuthFailed = true;
      error.email = email;
      error.apiMode = target.apiMode;
      return error;
    }

    function buildVerificationRuntimeStatus(step, patch = {}) {
      const normalizedStep = Number(step) || 0;
      return {
        nodeId: normalizedStep === 4 ? 'fetch-signup-code' : 'fetch-login-code',
        step: normalizedStep,
        provider: 'icloud-api',
        phase: 'idle',
        attemptsDone: 0,
        maxAttempts: 0,
        apiMode: ICLOUD_API_MODE_NORMAL,
        updatedAt: Date.now(),
        ...patch,
      };
    }

    async function updateVerificationRuntimeStatus(step, patch = {}) {
      const status = buildVerificationRuntimeStatus(step, patch);
      const key = step === 4 ? 'signupVerificationRuntimeStatus' : 'loginVerificationRuntimeStatus';
      try {
        await setState({
          [key]: status,
          verificationRuntimeStatus: status,
        });
      } catch {
        // Runtime status is diagnostic-only; never block verification polling on it.
      }
      return status;
    }

    function isHttpUrl(value = '') {
      return /^https?:\/\//i.test(String(value || '').trim());
    }

    function isTaobaoQueryCode(value = '') {
      const text = String(value || '').trim();
      return Boolean(text)
        && !isHttpUrl(text)
        && !/^[^@\s]+@[^@\s]+\.[^\s@]+$/.test(text)
        && /^[A-Za-z0-9_-]{6,}$/.test(text);
    }

    function buildTaobaoApiUrl(email = '', queryCode = '', kind = 'feed') {
      const normalizedEmail = normalizeEmail(email);
      const normalizedCode = normalizeQueryCode(queryCode);
      if (!normalizedEmail || !normalizedCode) return '';
      const params = new URLSearchParams({
        mail: normalizedEmail,
        pwd: normalizedCode,
        limit: '5',
      });
      const baseUrl = kind === 'open' ? TAOBAO_OPEN_API_URL : TAOBAO_FEED_API_URL;
      return `${baseUrl}?${params.toString()}`;
    }

    function buildOutlookApiUrl(email = '', password = '') {
      const normalizedEmail = normalizeEmail(email);
      const normalizedPassword = String(password || '').trim();
      if (!normalizedEmail || !normalizedPassword) return '';
      return `${OUTLOOK_API_BASE_URL}${normalizedEmail}----${normalizedPassword}`;
    }

    function extractTaobaoQueryCodeFromUrl(value = '') {
      const url = normalizeUrl(value);
      if (!url) return '';
      try {
        const parsed = new URL(url);
        const host = String(parsed.hostname || '').toLowerCase();
        if (host !== 'assurivo.com' && !host.endsWith('.assurivo.com')) {
          return '';
        }
        return normalizeQueryCode(parsed.searchParams.get('pwd') || '');
      } catch {
        return '';
      }
    }

    function buildIcloudApiFetchUrls(value = '') {
      const original = normalizeUrl(value);
      if (!original) return [];

      const urls = [];
      const addUrl = (candidate) => {
        const normalized = normalizeUrl(candidate);
        if (normalized && !urls.includes(normalized)) {
          urls.push(normalized);
        }
      };

      try {
        const parsed = new URL(original);
        const isIcloudApiHost = parsed.hostname === 'icloudapi.xyz'
          || parsed.hostname.endsWith('.icloudapi.xyz');
        const isTaobaoHost = parsed.hostname === 'assurivo.com'
          || parsed.hostname.endsWith('.assurivo.com');

        if (isIcloudApiHost && parsed.protocol === 'http:') {
          const httpsUrl = new URL(parsed.toString());
          httpsUrl.protocol = 'https:';
          addUrl(httpsUrl.toString());
          addUrl(parsed.toString());
          return urls;
        }

        addUrl(parsed.toString());

        if (isIcloudApiHost && parsed.protocol === 'https:') {
          const httpUrl = new URL(parsed.toString());
          httpUrl.protocol = 'http:';
          addUrl(httpUrl.toString());
        }
        if (isTaobaoHost) {
          const alternate = new URL(parsed.toString());
          if (/\/console\/feed\.php$/i.test(alternate.pathname)) {
            alternate.pathname = alternate.pathname.replace(/feed\.php$/i, 'open.php');
            addUrl(alternate.toString());
          } else if (/\/console\/open\.php$/i.test(alternate.pathname)) {
            alternate.pathname = alternate.pathname.replace(/open\.php$/i, 'feed.php');
            addUrl(alternate.toString());
          }
        }
      } catch {
        addUrl(original);
      }

      return urls;
    }

    function parsePoolLine(value = '') {
      const raw = String(value || '').trim();
      if (!raw) return { email: '', verificationUrl: '', apiMode: ICLOUD_API_MODE_NORMAL, queryCode: '', password: '', clientId: '', refreshToken: '' };
      const parts = raw.split('----');
      const email = normalizeEmail(parts.length > 1 ? parts.shift() : raw);
      const credential = String(parts.length > 0 ? parts.join('----') : '').trim();
      const hotmail = parseHotmailCredential(credential);
      if (hotmail.clientId && hotmail.refreshToken) {
        return {
          email,
          verificationUrl: '',
          apiMode: ICLOUD_API_MODE_HOTMAIL,
          queryCode: '',
          password: hotmail.password,
          clientId: hotmail.clientId,
          refreshToken: hotmail.refreshToken,
        };
      }
      if (isHttpUrl(credential)) {
        const queryCode = extractTaobaoQueryCodeFromUrl(credential);
        return {
          email,
          verificationUrl: normalizeUrl(credential),
          apiMode: queryCode ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL,
          queryCode,
        };
      }
      if (isTaobaoQueryCode(credential)) {
        return {
          email,
          verificationUrl: buildTaobaoApiUrl(email, credential, 'feed'),
          apiMode: ICLOUD_API_MODE_TAOBAO,
          queryCode: credential,
        };
      }
      return { email, verificationUrl: '', apiMode: ICLOUD_API_MODE_NORMAL, queryCode: '', password: credential };
    }

    function parseHotmailCredential(rawValue = '') {
      const parts = String(rawValue || '').split('----').map((part) => String(part || '').trim());
      return {
        password: parts[0] || '',
        clientId: parts[1] || '',
        refreshToken: parts.slice(2).join('----').trim(),
      };
    }

    function normalizeHotmailLocalBaseUrl(value = '') {
      const raw = String(value || '').trim() || DEFAULT_HOTMAIL_LOCAL_BASE_URL;
      try {
        const parsed = new URL(raw);
        parsed.pathname = parsed.pathname.replace(/\/(?:code|messages)\/?$/i, '');
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/g, '');
      } catch {
        return DEFAULT_HOTMAIL_LOCAL_BASE_URL;
      }
    }

    function shouldUseHotmailLocalHelper(state = {}, pollPayload = {}) {
      return pollPayload.hotmailUseLocalHelper === true
        || state.icloudApiHotmailUseLocalHelper === true
        || String(state.hotmailServiceMode || '').trim().toLowerCase() === 'local';
    }

    function collectPoolEntries(state = {}) {
      const entries = [];
      const seen = new Set();
      const addEntry = (entry = {}) => {
        const asObject = entry && typeof entry === 'object' ? entry : { email: entry };
        const objectMode = normalizeApiMode(asObject.apiMode || state.icloudApiMode || '');
        const hasObjectOutlookCredential = objectMode === ICLOUD_API_MODE_OUTLOOK_API && asObject.email && asObject.password;
        const line = typeof entry === 'string'
          ? entry
          : (asObject.raw || asObject.line || (asObject.email && (asObject.verificationUrl || asObject.queryCode || (asObject.clientId && asObject.refreshToken) || hasObjectOutlookCredential)
            ? `${asObject.email}----${asObject.verificationUrl || asObject.queryCode || [asObject.password || '', asObject.clientId || '', asObject.refreshToken || ''].join('----')}`
            : asObject.email));
        const parsed = parsePoolLine(line);
        const email = normalizeEmail(parsed.email || asObject.email);
        if (!email || seen.has(email)) return;
        seen.add(email);
        const clientId = String(asObject.clientId || asObject.client_id || parsed.clientId || '').trim();
        const refreshToken = String(asObject.refreshToken || asObject.refresh_token || asObject.token || parsed.refreshToken || '').trim();
        const password = String(asObject.password || parsed.password || '').trim();
        const hasHotmailCredential = Boolean(clientId && refreshToken);
        const queryCode = hasHotmailCredential ? '' : normalizeQueryCode(asObject.queryCode || asObject.pwd || parsed.queryCode || '');
        const parsedApiMode = normalizeApiMode(parsed.apiMode);
        const apiMode = normalizeApiMode(asObject.apiMode || (hasHotmailCredential ? ICLOUD_API_MODE_HOTMAIL : '') || (parsedApiMode !== ICLOUD_API_MODE_NORMAL ? parsedApiMode : '') || state.icloudApiMode || (queryCode ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL));
        const verificationUrl = normalizeUrl(
          apiMode === ICLOUD_API_MODE_HOTMAIL
            ? ''
            : (apiMode === ICLOUD_API_MODE_OUTLOOK_API
              ? buildOutlookApiUrl(email, password)
              : (asObject.verificationUrl
                || asObject.url
                || asObject.mailUrl
                || parsed.verificationUrl
                || (apiMode === ICLOUD_API_MODE_TAOBAO && queryCode ? buildTaobaoApiUrl(email, queryCode, 'feed') : '')))
        );
        entries.push({
          ...asObject,
          email,
          apiMode,
          queryCode: apiMode === ICLOUD_API_MODE_HOTMAIL || apiMode === ICLOUD_API_MODE_OUTLOOK_API ? '' : queryCode,
          password: apiMode === ICLOUD_API_MODE_HOTMAIL || apiMode === ICLOUD_API_MODE_OUTLOOK_API ? password : '',
          clientId: apiMode === ICLOUD_API_MODE_HOTMAIL ? clientId : '',
          refreshToken: apiMode === ICLOUD_API_MODE_HOTMAIL ? refreshToken : '',
          verificationUrl,
        });
      };

      if (Array.isArray(state.customEmailPoolEntries)) {
        for (const entry of state.customEmailPoolEntries) {
          if (entry && typeof entry === 'object') {
            addEntry(entry);
          } else {
            addEntry({ email: entry });
          }
        }
      }

      const legacyPool = Array.isArray(state.customEmailPool)
        ? state.customEmailPool
        : String(state.customEmailPool || '').split(/[\r\n,，;；]+/);
      for (const item of legacyPool) {
        addEntry({ email: item });
      }

      return entries;
    }

    function resolveIcloudApiPollTarget(state = {}, pollPayload = {}) {
      const targetEmail = normalizeEmail(
        pollPayload.targetEmail
        || pollPayload.email
        || state.step8VerificationTargetEmail
        || state.email
        || state.registrationEmailState?.current
        || ''
      );
      const entries = collectPoolEntries(state);
      const matchedEntry = targetEmail
        ? entries.find((entry) => entry.email === targetEmail)
        : null;
      const fallbackEntry = matchedEntry || entries.find((entry) => entry.verificationUrl || entry.queryCode || (entry.clientId && entry.refreshToken) || (entry.apiMode === ICLOUD_API_MODE_OUTLOOK_API && entry.password)) || entries[0] || null;
      const email = targetEmail || normalizeEmail(fallbackEntry?.email);
      const clientId = String(
        pollPayload.clientId
        || pollPayload.client_id
        || matchedEntry?.clientId
        || fallbackEntry?.clientId
        || ''
      ).trim();
      const refreshToken = String(
        pollPayload.refreshToken
        || pollPayload.refresh_token
        || pollPayload.token
        || matchedEntry?.refreshToken
        || fallbackEntry?.refreshToken
        || ''
      ).trim();
      const password = String(
        pollPayload.password
        || matchedEntry?.password
        || fallbackEntry?.password
        || ''
      ).trim();
      const hasHotmailCredential = Boolean(clientId && refreshToken);
      const queryCode = normalizeQueryCode(
        hasHotmailCredential ? '' : (
        pollPayload.queryCode
        || pollPayload.pwd
        || matchedEntry?.queryCode
        || fallbackEntry?.queryCode
        || ''
        )
      );
      const apiMode = normalizeApiMode(
        pollPayload.apiMode
        || matchedEntry?.apiMode
        || fallbackEntry?.apiMode
        || state.icloudApiMode
        || (hasHotmailCredential ? ICLOUD_API_MODE_HOTMAIL : (queryCode ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL))
      );
      const verificationUrl = normalizeUrl(
        pollPayload.verificationUrl
        || pollPayload.url
        || pollPayload.mailUrl
        || matchedEntry?.verificationUrl
        || fallbackEntry?.verificationUrl
        || (apiMode === ICLOUD_API_MODE_TAOBAO && queryCode ? buildTaobaoApiUrl(email, queryCode, 'feed') : '')
        || (apiMode === ICLOUD_API_MODE_OUTLOOK_API && password ? buildOutlookApiUrl(email, password) : '')
        || state.icloudApiVerificationUrl
        || state.verificationUrl
        || ''
      );

      return {
        email,
        apiMode,
        queryCode,
        password,
        clientId: apiMode === ICLOUD_API_MODE_HOTMAIL ? clientId : '',
        refreshToken: apiMode === ICLOUD_API_MODE_HOTMAIL ? refreshToken : '',
        verificationUrl,
        entry: matchedEntry || fallbackEntry || null,
      };
    }

    function flattenText(value, depth = 0) {
      if (value === null || value === undefined || depth > 6) return '';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      if (Array.isArray(value)) {
        return value.map((item) => flattenText(item, depth + 1)).join('\n');
      }
      if (typeof value === 'object') {
        return Object.entries(value)
          .map(([key, item]) => `${key}: ${flattenText(item, depth + 1)}`)
          .join('\n');
      }
      return '';
    }

    function extractCodeFromPayload(payload) {
      if (payload === null || payload === undefined) return '';
      if (typeof payload === 'object') {
        const direct = [
          payload.code,
          payload.verificationCode,
          payload.verification_code,
          payload.otp,
          payload.pin,
        ].map((item) => String(item || '').trim()).find((item) => /^\d{6}$/.test(item));
        if (direct) return direct;
      }

      const text = flattenText(payload)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ');

      if (typeof extractVerificationCodeFromMessage === 'function') {
        const extracted = extractVerificationCodeFromMessage({
          subject: text,
          bodyPreview: text,
          body: { content: text },
          text,
        });
        const code = String(extracted?.code || extracted || '').trim();
        if (/^\d{6}$/.test(code)) return code;
      }

      const match = text.match(/(?:验证码|verification\s+code|code|otp|pin)[^\d]{0,32}(\d{6})/i)
        || text.match(/(?<!\d)(\d{6})(?!\d)/);
      return match ? match[1] : '';
    }

    async function fetchIcloudApiPayload(url, timeoutMs = 20000) {
      if (!fetchImpl) {
        throw new Error('当前运行环境不支持 fetch，无法轮询 iCloud API。');
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store',
          credentials: 'omit',
          headers: {
            Accept: 'text/html,application/json,text/plain,*/*',
          },
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`);
        }
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          return text;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function fetchHotmailLocalCode(target = {}, latestState = {}, pollPayload = {}, timeoutMs = 20000) {
      if (!fetchImpl) {
        throw new Error('当前运行环境不支持 fetch，无法请求 Hotmail 本地 helper。');
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        const baseUrl = normalizeHotmailLocalBaseUrl(latestState.hotmailLocalBaseUrl || pollPayload.hotmailLocalBaseUrl);
        const response = await fetchImpl(`${baseUrl}/code`, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'omit',
          headers: {
            Accept: 'application/json,text/plain,*/*',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: target.email,
            clientId: target.clientId,
            refreshToken: target.refreshToken,
            mailboxes: Array.isArray(pollPayload.mailboxes) && pollPayload.mailboxes.length
              ? pollPayload.mailboxes
              : ['INBOX', 'Junk'],
            top: Number(pollPayload.top) || 5,
            filterAfterTimestamp: Number(pollPayload.filterAfterTimestamp || 0) || 0,
            excludeCodes: Array.isArray(pollPayload.excludeCodes) ? pollPayload.excludeCodes : [],
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`helper HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`);
        }
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          return text;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function fetchHotmailMicrosoftCode(target = {}, pollPayload = {}, timeoutMs = 30000) {
      const microsoftEmail = typeof globalThis !== 'undefined'
        ? globalThis.MultiPageMicrosoftEmail
        : null;
      if (!microsoftEmail || typeof microsoftEmail.fetchMicrosoftVerificationCode !== 'function') {
        throw new Error('Microsoft 邮箱取码模块未加载。');
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      try {
        return await microsoftEmail.fetchMicrosoftVerificationCode({
          clientId: target.clientId,
          refreshToken: target.refreshToken,
          maxRetries: 1,
          retryDelayMs: 0,
          top: Number(pollPayload.top) || 5,
          filterAfterTimestamp: Number(pollPayload.filterAfterTimestamp || 0) || 0,
          excludeCodes: Array.isArray(pollPayload.excludeCodes) ? pollPayload.excludeCodes : [],
          mailboxes: Array.isArray(pollPayload.mailboxes) && pollPayload.mailboxes.length
            ? pollPayload.mailboxes
            : ['INBOX', 'Junk'],
          fetchImpl,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function persistHotmailRefreshToken(email = '', nextRefreshToken = '') {
      const normalizedEmail = normalizeEmail(email);
      const normalizedToken = String(nextRefreshToken || '').trim();
      if (!normalizedEmail || !normalizedToken) {
        return;
      }
      try {
        const currentState = await getState();
        const entries = Array.isArray(currentState?.customEmailPoolEntries)
          ? currentState.customEmailPoolEntries
          : [];
        let changed = false;
        const nextEntries = entries.map((entry) => {
          if (normalizeEmail(entry?.email) !== normalizedEmail) {
            return entry;
          }
          if (String(entry?.refreshToken || '').trim() === normalizedToken) {
            return entry;
          }
          changed = true;
          return {
            ...entry,
            apiMode: ICLOUD_API_MODE_HOTMAIL,
            refreshToken: normalizedToken,
          };
        });
        if (changed) {
          await setState({ customEmailPoolEntries: nextEntries });
        }
      } catch {
        // Token rotation persistence is best-effort; do not block verification success.
      }
    }

    function buildHotmailVerificationResult(payload = {}, target = {}, source = '') {
      return {
        code: String(payload?.code || '').trim(),
        emailTimestamp: Number(payload?.emailTimestamp) || Date.now(),
        targetEmail: target.email,
        source,
        messageId: payload?.messageId || null,
        sender: payload?.sender || '',
        subject: payload?.subject || '',
        mailbox: payload?.mailbox || '',
      };
    }

    async function pollHotmailVerificationCode(step, latestState = {}, target = {}, pollPayload = {}) {
      if (!target.clientId || !target.refreshToken) {
        throw new Error(`步骤 ${step}：${target.email} 缺少 Hotmail client_id 或 refresh_token。请按“邮箱----密码----client_id----refresh_token”配置。`);
      }
      const maxAttempts = Math.max(DEFAULT_MIN_ATTEMPTS, Math.floor(Number(pollPayload.maxAttempts) || 0));
      const intervalMs = Math.max(1000, Number(pollPayload.intervalMs) || DEFAULT_INTERVAL_MS);
      const rejectedCodes = new Set((pollPayload.excludeCodes || []).map((item) => String(item || '').trim()).filter(Boolean));
      const alreadyAdvancedCheck = typeof pollPayload.alreadyAdvancedCheck === 'function'
        ? pollPayload.alreadyAdvancedCheck
        : null;
      const preferLocalHelper = shouldUseHotmailLocalHelper(latestState, pollPayload);
      let localHelperFailed = false;
      let lastError = null;

      await updateVerificationRuntimeStatus(step, {
        phase: 'polling',
        email: target.email,
        apiMode: ICLOUD_API_MODE_HOTMAIL,
        attemptsDone: 0,
        maxAttempts,
        receivedPayload: false,
        lastError: '',
      });
      await addLog(`步骤 ${step}：正在通过 Hotmail / Microsoft 邮箱轮询 ${target.email} 的验证码...`, 'info');

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfStopped();
        if (alreadyAdvancedCheck) {
          try {
            const alreadyAdvanced = await alreadyAdvancedCheck();
            if (alreadyAdvanced?.alreadyVerified) {
              await updateVerificationRuntimeStatus(step, {
                phase: 'already_advanced',
                email: target.email,
                apiMode: ICLOUD_API_MODE_HOTMAIL,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: false,
                lastError: '',
              });
              return {
                ...alreadyAdvanced,
                targetEmail: alreadyAdvanced.targetEmail || target.email,
                source: alreadyAdvanced.source || 'hotmail_already_advanced',
              };
            }
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
          }
        }

        let receivedPayload = false;
        const attemptErrors = [];
        const sources = [];
        if (preferLocalHelper && !localHelperFailed) {
          sources.push('local');
        }
        sources.push('microsoft');

        for (const source of sources) {
          throwIfStopped();
          try {
            const payload = source === 'local'
              ? await fetchHotmailLocalCode(target, latestState, pollPayload, Math.max(20000, intervalMs + 10000))
              : await fetchHotmailMicrosoftCode(target, pollPayload, Math.max(30000, intervalMs + 15000));
            receivedPayload = true;
            const code = String(payload?.code || '').trim() || extractCodeFromPayload(payload);
            if (code && /^\d{6}$/.test(code) && !rejectedCodes.has(code)) {
              if (payload?.nextRefreshToken) {
                await persistHotmailRefreshToken(target.email, payload.nextRefreshToken);
              }
              await updateVerificationRuntimeStatus(step, {
                phase: 'code_found',
                email: target.email,
                apiMode: ICLOUD_API_MODE_HOTMAIL,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: true,
                lastError: '',
              });
              return buildHotmailVerificationResult({
                ...payload,
                code,
              }, target, source === 'local' ? 'hotmail_local_helper' : 'hotmail_microsoft');
            }
            if (code && rejectedCodes.has(code)) {
              lastError = new Error(`接口返回的验证码 ${code} 已被排除，继续等待新验证码。`);
              await updateVerificationRuntimeStatus(step, {
                phase: 'excluded_code',
                email: target.email,
                apiMode: ICLOUD_API_MODE_HOTMAIL,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: true,
                lastError: lastError.message,
              });
            }
          } catch (error) {
            const message = error?.message || String(error);
            attemptErrors.push(message);
            if (source === 'local') {
              localHelperFailed = true;
              if (attempt === 1) {
                await addLog(`步骤 ${step}：Hotmail 本地 helper 暂不可用，已切换到 Microsoft Graph 后台取码。`, 'info');
              }
            }
          }
        }

        if (!receivedPayload && attemptErrors.length) {
          lastError = new Error(attemptErrors.map((message) => summarizeIcloudApiError(message) || message).join(' | '));
          await updateVerificationRuntimeStatus(step, {
            phase: 'request_failed',
            email: target.email,
            apiMode: ICLOUD_API_MODE_HOTMAIL,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload: false,
            lastError: lastError.message,
          });
          if (attempt === 1 || attempt % 10 === 0) {
            await addLog(`步骤 ${step}：Hotmail 后台请求暂未成功（${attempt}/${maxAttempts}）：${lastError.message}`, 'info');
          }
        } else if (attempt === 1 || attempt % 10 === 0) {
          await updateVerificationRuntimeStatus(step, {
            phase: 'no_code_yet',
            email: target.email,
            apiMode: ICLOUD_API_MODE_HOTMAIL,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload,
            lastError: '',
          });
          await addLog(`步骤 ${step}：Hotmail 邮箱暂未解析到有效验证码（${attempt}/${maxAttempts}），继续等待...`, 'info');
        } else {
          await updateVerificationRuntimeStatus(step, {
            phase: receivedPayload ? 'no_code_yet' : 'waiting',
            email: target.email,
            apiMode: ICLOUD_API_MODE_HOTMAIL,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload,
            lastError: lastError?.message || '',
          });
        }

        if (attempt < maxAttempts) {
          await sleepWithStop(intervalMs);
        }
      }

      await updateVerificationRuntimeStatus(step, {
        phase: 'failed',
        email: target.email,
        apiMode: ICLOUD_API_MODE_HOTMAIL,
        attemptsDone: maxAttempts,
        maxAttempts,
        receivedPayload: false,
        lastError: lastError?.message || '',
      });
      throw new Error(`步骤 ${step}：Hotmail 未获取到 ${target.email} 的验证码。${lastError?.message ? `最后错误：${lastError.message}` : ''}`.trim());
    }

    async function pollIcloudApiVerificationCode(step, state = {}, pollPayload = {}) {
      const latestState = state && Object.keys(state).length ? state : await getState();
      const target = resolveIcloudApiPollTarget(latestState, pollPayload);
      if (!target.email) {
        throw new Error(`步骤 ${step}：iCloud API 邮箱为空，请先配置 iCloud API 邮箱池。`);
      }
      if (target.apiMode === ICLOUD_API_MODE_HOTMAIL) {
        return pollHotmailVerificationCode(step, latestState, target, pollPayload);
      }
      if (!target.verificationUrl) {
        throw new Error(`步骤 ${step}：${target.email} 缺少验证码接口。普通版请填“邮箱----接口URL”，淘宝版请填“邮箱----邮件查询码”，Hotmail 请填“邮箱----密码----client_id----refresh_token”，Outlook API 请填“邮箱----密码”。`);
      }

      const maxAttempts = Math.max(DEFAULT_MIN_ATTEMPTS, Math.floor(Number(pollPayload.maxAttempts) || 0));
      const intervalMs = Math.max(1000, Number(pollPayload.intervalMs) || DEFAULT_INTERVAL_MS);
      const rejectedCodes = new Set((pollPayload.excludeCodes || []).map((item) => String(item || '').trim()).filter(Boolean));
      const alreadyAdvancedCheck = typeof pollPayload.alreadyAdvancedCheck === 'function'
        ? pollPayload.alreadyAdvancedCheck
        : null;
      const fetchUrls = buildIcloudApiFetchUrls(target.verificationUrl);
      if (!fetchUrls.length) {
        throw new Error(`步骤 ${step}：${target.email} 的 iCloud API 验证码接口 URL 无效。`);
      }
      await updateVerificationRuntimeStatus(step, {
        phase: 'polling',
        email: target.email,
        apiMode: target.apiMode,
        attemptsDone: 0,
        maxAttempts,
        receivedPayload: false,
        lastError: '',
      });
      await addLog(`步骤 ${step}：正在通过 iCloud API 轮询 ${target.email} 的验证码...`, 'info');
      if (target.apiMode === ICLOUD_API_MODE_TAOBAO) {
        await addLog(`步骤 ${step}：当前邮箱使用淘宝版验证码接口，后台将通过 assurivo JSON/网页接口取码。`, 'info');
      }
      if (target.apiMode === ICLOUD_API_MODE_OUTLOOK_API) {
        await addLog(`步骤 ${step}：当前邮箱使用 Outlook API 验证码接口，后台将通过 query.paopaodw.com 取码。`, 'info');
      }
      if (fetchUrls.length > 1) {
        await addLog(`步骤 ${step}：iCloud API 将使用后台请求尝试多个接口地址，避免浏览器安全提示影响取码。`, 'info');
      }

      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfStopped();
        if (alreadyAdvancedCheck) {
          try {
            const alreadyAdvanced = await alreadyAdvancedCheck();
            if (alreadyAdvanced?.alreadyVerified) {
              await updateVerificationRuntimeStatus(step, {
                phase: 'already_advanced',
                email: target.email,
                apiMode: target.apiMode,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: false,
                lastError: '',
              });
              return {
                ...alreadyAdvanced,
                targetEmail: alreadyAdvanced.targetEmail || target.email,
                verificationUrl: target.verificationUrl,
              };
            }
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            // Page-state probing is best-effort; keep polling the mailbox if it fails.
          }
        }
        let receivedPayload = false;
        const attemptErrors = [];
        for (const fetchUrl of fetchUrls) {
          throwIfStopped();
          try {
            const payload = await fetchIcloudApiPayload(fetchUrl, Math.max(20000, intervalMs + 10000));
            receivedPayload = true;
            const code = extractCodeFromPayload(payload);
            if (code && !rejectedCodes.has(code)) {
              await updateVerificationRuntimeStatus(step, {
                phase: 'code_found',
                email: target.email,
                apiMode: target.apiMode,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: true,
                lastError: '',
              });
              return {
                code,
                emailTimestamp: Date.now(),
                targetEmail: target.email,
                verificationUrl: target.verificationUrl,
                usedVerificationUrl: fetchUrl,
                source: 'background_fetch',
                raw: payload,
              };
            }
            if (code && rejectedCodes.has(code)) {
              lastError = new Error(`接口返回的验证码 ${code} 已被排除，继续等待新验证码。`);
              await updateVerificationRuntimeStatus(step, {
                phase: 'excluded_code',
                email: target.email,
                apiMode: target.apiMode,
                attemptsDone: attempt,
                maxAttempts,
                receivedPayload: true,
                lastError: lastError.message,
              });
            }
          } catch (error) {
            attemptErrors.push(error?.message || String(error));
          }
        }

        if (!receivedPayload && attemptErrors.length) {
          const summarizedErrors = attemptErrors.map((message) => summarizeIcloudApiError(message)).filter(Boolean);
          lastError = new Error((summarizedErrors.length ? summarizedErrors : attemptErrors).join(' | '));
          await updateVerificationRuntimeStatus(step, {
            phase: 'request_failed',
            email: target.email,
            apiMode: target.apiMode,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload: false,
            lastError: lastError.message,
          });
          if (attempt === 1 || attempt % 10 === 0) {
            await addLog(`步骤 ${step}：iCloud API 后台请求暂未成功（${attempt}/${maxAttempts}）：${lastError.message}`, 'info');
          }
          if (target.apiMode === ICLOUD_API_MODE_TAOBAO && isIcloudApiAuthFailureMessage(attemptErrors.join(' | '))) {
            await updateVerificationRuntimeStatus(step, {
              phase: 'auth_failed',
              email: target.email,
              apiMode: target.apiMode,
              attemptsDone: attempt,
              maxAttempts,
              receivedPayload: false,
              lastError: lastError.message,
            });
            throw buildIcloudApiAuthFailureError(step, target, lastError.message);
          }
        } else if (attempt === 1 || attempt % 10 === 0) {
          await updateVerificationRuntimeStatus(step, {
            phase: 'no_code_yet',
            email: target.email,
            apiMode: target.apiMode,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload,
            lastError: '',
          });
          await addLog(`步骤 ${step}：iCloud API 已返回页面但暂未解析到有效验证码（${attempt}/${maxAttempts}），继续等待...`, 'info');
        } else {
          await updateVerificationRuntimeStatus(step, {
            phase: receivedPayload ? 'no_code_yet' : 'waiting',
            email: target.email,
            apiMode: target.apiMode,
            attemptsDone: attempt,
            maxAttempts,
            receivedPayload,
            lastError: lastError?.message || '',
          });
        }

        if (attempt < maxAttempts) {
          await sleepWithStop(intervalMs);
        }
      }

      await updateVerificationRuntimeStatus(step, {
        phase: 'failed',
        email: target.email,
        apiMode: target.apiMode,
        attemptsDone: maxAttempts,
        maxAttempts,
        receivedPayload: false,
        lastError: lastError?.message || '',
      });
      throw new Error(
        `步骤 ${step}：iCloud API 未获取到 ${target.email} 的验证码。${lastError?.message ? `最后错误：${lastError.message}` : ''}`.trim()
      );
    }

    return {
      buildIcloudApiFetchUrls,
      pollIcloudApiVerificationCode,
      resolveIcloudApiPollTarget,
    };
  }

  return { createIcloudApiProvider };
});
