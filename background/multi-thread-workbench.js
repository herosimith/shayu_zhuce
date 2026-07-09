(function attachBackgroundMultiThreadWorkbench(root, factory) {
  root.MultiPageBackgroundMultiThreadWorkbench = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundMultiThreadWorkbenchModule() {
  const DEFAULT_THREAD_COUNT = 1;
  const MAX_THREAD_COUNT = 8;
  const MAX_THREAD_LOGS_PER_THREAD = 160;
  const DEFAULT_PROFILE_RUNNER_URL = 'http://127.0.0.1:18792';
  const PROFILE_RUNNER_START_PATH = '/start';
  const PROFILE_RUNNER_RUNS_PATH = '/runs';
  const PROFILE_RUNNER_STOP_PATH = '/stop';
  const NATIVE_LAUNCHER_HOST = 'com.gujumpgate.icloud_api_launcher';

  function createMultiThreadWorkbench(deps = {}) {
    const {
      addLog = async () => {},
      broadcastDataUpdate = () => {},
      getState = async () => ({}),
      normalizeExternalRedeemCdkey = (value = '') => String(value || '').trim(),
      normalizeExternalRedeemCdkeyPoolText = (value = '') => String(value || '').trim(),
      ensureLocalServices = null,
      readExternalRedeemRecordsFromSqlite = null,
      setPersistentSettings = async () => {},
      setState = async () => {},
    } = deps;

    function normalizeThreadCount(value) {
      const count = Math.floor(Number(value) || DEFAULT_THREAD_COUNT);
      return Math.max(1, Math.min(MAX_THREAD_COUNT, count));
    }

    function normalizeEmail(value = '') {
      return String(value || '').trim().toLowerCase();
    }

    function normalizeThreadId(value = '') {
      return String(value || '').trim() || 'thread-1';
    }

    function getThreadLabel(index) {
      return `线程 ${index + 1}`;
    }

    function getUnusedEmailEntries(state = {}) {
      const entries = Array.isArray(state?.customEmailPoolEntries)
        ? state.customEmailPoolEntries
        : [];
      const reuseAllowedEmails = new Set(
        entries
          .filter((entry) => entry?.reuseAllowed === true)
          .map((entry) => normalizeEmail(entry?.email))
          .filter(Boolean)
      );
      const redeemUsedEmails = new Set(
        (Array.isArray(state?.externalRedeemQueue) ? state.externalRedeemQueue : [])
          .map((item) => normalizeEmail(item?.email))
          .filter(Boolean)
      );
      reuseAllowedEmails.forEach((email) => redeemUsedEmails.delete(email));
      return entries
        .filter((entry) => entry && typeof entry === 'object')
        .filter((entry) => entry.enabled !== false)
        .filter((entry) => normalizeEmail(entry.email))
        .filter((entry) => !entry.used && !redeemUsedEmails.has(normalizeEmail(entry.email)));
    }

    function getCdkeyPool(state = {}) {
      return normalizeExternalRedeemCdkeyPoolText(state?.externalRedeemCdkeyPoolText || '')
        .split(/\r?\n/)
        .map((line) => normalizeExternalRedeemCdkey(line))
        .filter(Boolean);
    }

    function getReservedCdkeys(state = {}) {
      return new Set(
        (Array.isArray(state?.externalRedeemQueue) ? state.externalRedeemQueue : [])
          .filter((item) => isCdkeyReservedForThreadPlanning(item))
          .map((item) => normalizeExternalRedeemCdkey(item?.cdkey))
          .filter(Boolean)
      );
    }

    function isCdkeyReservedForThreadPlanning(item = {}) {
      if (!normalizeExternalRedeemCdkey(item?.cdkey)) {
        return false;
      }
      const status = String(item?.status || item?.redeemStatus || item?.redeem_status || '').trim().toLowerCase();
      const transactionStatus = String(item?.transactionStatus || item?.transaction_status || '').trim().toLowerCase();
      const text = [
        item?.reason,
        item?.errorMessage,
        item?.error_message,
        item?.displayStatus,
        item?.display_status,
        item?.message,
      ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
      if (/充值失败|支付失败|付款失败|提交失败|被拒绝|无效或未购买|不能重复|已被使用|recharge\s*failed|payment\s*failed|submit\s*failed|failed|失败|rejected|not_found|cancel/.test(`${status} ${text}`)) {
        return false;
      }
      if (status === 'success' || transactionStatus === 'paid') {
        return true;
      }
      if (['failed', 'submit_failed', 'rejected', 'not_found', 'cancelled', 'canceled', 'error'].includes(status)) {
        return false;
      }
      return item?.accepted === true || Boolean(String(item?.taskId || item?.task_id || '').trim());
    }

    function getAvailableCdkeys(state = {}) {
      const reserved = getReservedCdkeys(state);
      return getCdkeyPool(state).filter((cdkey) => !reserved.has(cdkey));
    }

    function getRedeemQueueItemKey(item = {}) {
      const id = String(item?.id || '').trim();
      if (id) {
        return `id:${id}`;
      }
      const taskId = String(item?.taskId || '').trim();
      if (taskId) {
        return `task:${taskId}`;
      }
      const email = normalizeEmail(item?.email || '');
      const cdkey = normalizeExternalRedeemCdkey(item?.cdkey || item?.cdk || '');
      if (email && cdkey) {
        return `email-cdk:${email}:${cdkey}`;
      }
      return '';
    }

    function getRedeemRecordKey(record = {}) {
      const email = normalizeEmail(record?.email || '');
      const cdkey = normalizeExternalRedeemCdkey(record?.cdk || record?.cdkey || '');
      const taskId = String(record?.taskId || '').trim();
      if (!email) {
        return '';
      }
      return [email, cdkey || taskId || String(record?.updatedAt || '')].filter(Boolean).join('::');
    }

    function getRedeemItemSortTime(item = {}) {
      const values = [
        item?.lastCheckedAt,
        item?.updatedAt,
        item?.finishedAt,
        item?.submittedAt,
        item?.createdAt,
      ];
      for (const value of values) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
          return numeric;
        }
        const parsed = Date.parse(String(value || ''));
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
      return 0;
    }

    function mergeRedeemCollection(existingItems = [], incomingItems = [], getKey = () => '') {
      const byKey = new Map();
      const append = (item, source = 'existing') => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const key = getKey(item);
        if (!key) {
          return;
        }
        const previous = byKey.get(key);
        if (!previous) {
          byKey.set(key, { ...item });
          return;
        }
        const previousTime = getRedeemItemSortTime(previous);
        const nextTime = getRedeemItemSortTime(item);
        if (!previousTime || nextTime >= previousTime) {
          byKey.set(key, { ...previous, ...item });
        }
      };
      (Array.isArray(existingItems) ? existingItems : []).forEach((item) => append(item, 'existing'));
      (Array.isArray(incomingItems) ? incomingItems : []).forEach((item) => append(item, 'incoming'));
      return Array.from(byKey.values())
        .sort((left, right) => getRedeemItemSortTime(right) - getRedeemItemSortTime(left))
        .slice(0, 1000);
    }

    function collectRunnerRedeemState(runnerThreads = []) {
      const queues = [];
      const records = [];
      let lastSyncAt = 0;
      let lastError = '';
      let recordsLastSyncAt = 0;
      let recordsLastError = '';
      let recordsDbPath = '';
      for (const thread of Array.isArray(runnerThreads) ? runnerThreads : []) {
        const snapshot = thread?.snapshot && typeof thread.snapshot === 'object' ? thread.snapshot : null;
        if (!snapshot) {
          continue;
        }
        if (Array.isArray(snapshot.externalRedeemQueue) && snapshot.externalRedeemQueue.length) {
          queues.push(...snapshot.externalRedeemQueue);
        }
        if (Array.isArray(snapshot.externalRedeemRecords) && snapshot.externalRedeemRecords.length) {
          records.push(...snapshot.externalRedeemRecords);
        }
        lastSyncAt = Math.max(lastSyncAt, Number(snapshot.externalRedeemLastSyncAt) || 0);
        recordsLastSyncAt = Math.max(recordsLastSyncAt, Number(snapshot.externalRedeemRecordsLastSyncAt) || 0);
        if (!lastError && String(snapshot.externalRedeemLastError || '').trim()) {
          lastError = String(snapshot.externalRedeemLastError || '').trim();
        }
        if (!recordsLastError && String(snapshot.externalRedeemRecordsLastError || '').trim()) {
          recordsLastError = String(snapshot.externalRedeemRecordsLastError || '').trim();
        }
        if (!recordsDbPath && String(snapshot.externalRedeemRecordsDbPath || '').trim()) {
          recordsDbPath = String(snapshot.externalRedeemRecordsDbPath || '').trim();
        }
      }
      return {
        queues,
        records,
        lastSyncAt,
        lastError,
        recordsLastSyncAt,
        recordsLastError,
        recordsDbPath,
      };
    }

    function hasRunnerExternalRedeemActivity(runnerThreads = []) {
      return (Array.isArray(runnerThreads) ? runnerThreads : []).some((thread) => {
        const snapshot = thread?.snapshot && typeof thread.snapshot === 'object' ? thread.snapshot : null;
        if (!snapshot) {
          return false;
        }
        if (String(snapshot.currentNodeId || '').trim() === 'chatgpt-ac-external-redeem') {
          return true;
        }
        if (snapshot.nodeStatuses && typeof snapshot.nodeStatuses === 'object') {
          const status = String(snapshot.nodeStatuses['chatgpt-ac-external-redeem'] || '').trim().toLowerCase();
          if (status && status !== 'pending' && status !== 'skipped') {
            return true;
          }
        }
        return (Array.isArray(snapshot.logs) ? snapshot.logs : []).some((entry) => {
          const message = String(entry?.message || '');
          const nodeId = String(entry?.nodeId || '');
          return nodeId === 'chatgpt-ac-external-redeem'
            || message.includes('外部兑换')
            || message.includes('步骤 7');
        });
      });
    }

    function buildThreadPlans(state = {}, threadCount = DEFAULT_THREAD_COUNT) {
      const count = normalizeThreadCount(threadCount);
      const emails = getUnusedEmailEntries(state);
      const cdkeys = getAvailableCdkeys(state);
      return Array.from({ length: count }, (_, index) => {
        const emailEntry = emails[index] || null;
        const emailPoolEntries = emails
          .filter((_, emailIndex) => emailIndex % count === index)
          .map((entry) => ({
            id: String(entry?.id || ''),
            email: normalizeEmail(entry?.email || ''),
            raw: String(entry?.raw || entry?.email || ''),
            enabled: entry?.enabled !== false,
            used: false,
            note: String(entry?.note || ''),
            apiMode: String(entry?.apiMode || '').trim(),
            queryCode: String(entry?.queryCode || entry?.pwd || '').trim(),
            password: String(entry?.password || '').trim(),
            clientId: String(entry?.clientId || entry?.client_id || '').trim(),
            refreshToken: String(entry?.refreshToken || entry?.refresh_token || entry?.token || '').trim(),
            verificationUrl: String(entry?.verificationUrl || entry?.url || entry?.mailUrl || '').trim(),
            lastUsedAt: Number(entry?.lastUsedAt) || 0,
          }))
          .filter((entry) => entry.email);
        const cdkey = cdkeys[index] || '';
        return {
          id: `thread-${index + 1}`,
          index,
          label: getThreadLabel(index),
          status: emailEntry ? 'ready' : 'blocked',
          email: normalizeEmail(emailEntry?.email || ''),
          emailEntryId: String(emailEntry?.id || ''),
          raw: String(emailEntry?.raw || emailEntry?.email || ''),
          emailPoolEntries,
          cdkey,
          proxyUrl: '',
          proxyDisplay: '',
          windowId: null,
          startedAt: 0,
          updatedAt: Date.now(),
          reason: !emailEntry ? '没有可用未用邮箱' : '',
        };
      });
    }

    function getProfileRunnerBaseUrl(state = {}, options = {}) {
      return String(
        options.runnerUrl
        || state?.multiThreadRunnerUrl
        || state?.multiThreadProfileRunnerUrl
        || DEFAULT_PROFILE_RUNNER_URL
      ).trim().replace(/\/+$/g, '') || DEFAULT_PROFILE_RUNNER_URL;
    }

    function normalizeLogTimestamp(value, fallback = Date.now()) {
      const timestamp = Number(value);
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
    }

    function sanitizeThreadLogMessage(value = '') {
      return String(value || '')
        .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[token]')
        .replace(/([?&](?:key|token|code|state|api_key|access_token)=)[^&\s]+/gi, '$1[hidden]')
        .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (match) => match)
        .slice(0, 600);
    }

    function bucketDiagnosticTimestamp(value, bucketMs = 15000) {
      const timestamp = normalizeLogTimestamp(value, Date.now());
      const bucket = Math.max(1000, Number(bucketMs) || 15000);
      return Math.floor(timestamp / bucket) * bucket;
    }

    function formatVerificationPhase(value = '') {
      const phase = String(value || '').trim();
      const labels = {
        polling: '开始轮询',
        waiting: '等待接口返回',
        request_failed: '接口请求失败',
        auth_failed: '接口鉴权失败，准备换邮箱',
        no_code_yet: '接口有返回但未解析到验证码',
        excluded_code: '返回旧验证码，继续等待新验证码',
        code_found: '已拿到验证码，准备提交',
        already_advanced: '页面已进入后续阶段',
        failed: '取码失败',
      };
      return labels[phase] || phase || '运行中';
    }

    function formatVerificationRuntimeStatus(status = {}) {
      if (!status || typeof status !== 'object') return '';
      const attemptsDone = Math.max(0, Number(status.attemptsDone) || 0);
      const maxAttempts = Math.max(0, Number(status.maxAttempts) || 0);
      const attemptText = maxAttempts ? `第 ${attemptsDone}/${maxAttempts} 次` : '轮询中';
      const apiMode = String(status.apiMode || '').trim().toLowerCase();
      const mode = apiMode === 'hotmail' ? 'Hotmail' : (apiMode === 'taobao' ? '淘宝版' : '普通版');
      const phaseText = formatVerificationPhase(status.phase);
      const lastError = String(status.lastError || '').trim();
      return `取码状态：${mode} iCloud API ${attemptText}，${phaseText}${lastError ? `；最后错误：${lastError}` : ''}`;
    }

    function buildThreadLogIdentity(entry = {}) {
      return [
        normalizeLogTimestamp(entry.timestamp, 0),
        String(entry.level || ''),
        String(entry.message || ''),
        String(entry.nodeId || entry.stepKey || ''),
      ].join('|');
    }

    function mergeThreadLogs(existingLogs = [], incomingLogs = []) {
      const merged = Array.isArray(existingLogs) ? [...existingLogs] : [];
      const seen = new Set(merged.map((entry) => buildThreadLogIdentity(entry)));
      for (const rawEntry of Array.isArray(incomingLogs) ? incomingLogs : []) {
        const message = sanitizeThreadLogMessage(rawEntry?.message || '');
        if (!message) continue;
        const entry = {
          message,
          level: String(rawEntry?.level || 'info').trim().toLowerCase() || 'info',
          timestamp: normalizeLogTimestamp(rawEntry?.timestamp),
          step: rawEntry?.step ?? null,
          stepKey: String(rawEntry?.stepKey || '').trim(),
          nodeId: String(rawEntry?.nodeId || '').trim(),
          source: 'runner-snapshot',
        };
        const identity = buildThreadLogIdentity(entry);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(entry);
      }
      return merged
        .sort((left, right) => normalizeLogTimestamp(left?.timestamp, 0) - normalizeLogTimestamp(right?.timestamp, 0))
        .slice(-MAX_THREAD_LOGS_PER_THREAD);
    }

    function buildRunnerBaseSettings(state = {}) {
      return {
        activeFlowId: state?.activeFlowId || 'openai',
        panelMode: 'checkout-conversion',
        plusModeEnabled: false,
        plusPaymentMethod: 'checkout-conversion',
        plusAccountAccessStrategy: state?.plusAccountAccessStrategy || 'oauth',
        externalRedeemEnabled: Boolean(state?.externalRedeemEnabled),
        externalRedeemBaseUrl: String(state?.externalRedeemBaseUrl || '').trim(),
        externalRedeemApiKey: String(state?.externalRedeemApiKey || '').trim(),
        externalRedeemPollSeconds: Number(state?.externalRedeemPollSeconds) || 30,
        chatgptTotpAutoEnable: state?.chatgptTotpAutoEnable === true,
        customPassword: String(state?.customPassword || ''),
        signupMethod: 'email',
        phoneVerificationEnabled: false,
        phoneSignupReloginAfterBindEmailEnabled: false,
        mailProvider: state?.mailProvider || 'icloud-api',
        icloudApiMode: state?.icloudApiMode || 'normal',
        emailGenerator: 'custom-pool',
        feishuSyncEnabled: Boolean(state?.feishuSyncEnabled),
        feishuAppId: String(state?.feishuAppId || '').trim(),
        feishuAppSecret: String(state?.feishuAppSecret || '').trim(),
        feishuBitableAppToken: String(state?.feishuBitableAppToken || '').trim(),
        feishuBitableTableId: String(state?.feishuBitableTableId || '').trim(),
      };
    }

    async function startProfileRunner(plans = [], state = {}, options = {}) {
      const runnablePlans = plans.filter((plan) => String(plan?.status || '').toLowerCase() === 'ready');
      if (!runnablePlans.length) {
        throw new Error('没有可启动的线程计划：需要未用邮箱。');
      }
      const runnerUrl = getProfileRunnerBaseUrl(state, options);
      const payload = {
        runId: `mt-${Date.now()}`,
        extensionDir: options.extensionDir || '',
        baseSettings: buildRunnerBaseSettings(state),
        threads: runnablePlans.map((plan) => ({
          id: plan.id,
          email: plan.email,
          emailEntryId: plan.emailEntryId,
          raw: plan.raw,
          emailPoolEntries: Array.isArray(plan.emailPoolEntries) ? plan.emailPoolEntries : [],
          cdkey: plan.cdkey,
        })),
      };
      const response = await fetch(`${runnerUrl}${PROFILE_RUNNER_START_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || `独立浏览器 profile runner 请求失败：HTTP ${response.status}`);
      }
      return {
        runnerUrl,
        ...data,
      };
    }

    async function fetchProfileRunnerRuns(state = {}, options = {}) {
      const runnerUrl = getProfileRunnerBaseUrl(state, options);
      const response = await fetch(`${runnerUrl}${PROFILE_RUNNER_RUNS_PATH}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || `独立浏览器 profile runner 状态请求失败：HTTP ${response.status}`);
      }
      return {
        runnerUrl,
        runs: Array.isArray(data?.runs) ? data.runs : [],
      };
    }

    async function stopProfileRunnerRun(state = {}, options = {}) {
      const runnerUrl = getProfileRunnerBaseUrl(state, options);
      const runId = String(options.runId || state?.multiThreadRunnerRunId || '').trim();
      const response = await fetch(`${runnerUrl}${PROFILE_RUNNER_STOP_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ runId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || `独立浏览器 profile runner 终止请求失败：HTTP ${response.status}`);
      }
      return {
        runnerUrl,
        ...data,
      };
    }

    async function ensureServicesBeforeRunnerStart() {
      if (typeof ensureLocalServices === 'function') {
        return ensureLocalServices();
      }
      const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
      if (!runtime?.sendNativeMessage) {
        return { ok: false, skipped: true, message: '当前扩展没有 nativeMessaging 能力。' };
      }
      return new Promise((resolve) => {
        runtime.sendNativeMessage(
          NATIVE_LAUNCHER_HOST,
          {
            type: 'ensureServices',
            services: ['externalRedeemProxy', 'multiProfileRunner'],
          },
          (response) => {
            const lastError = runtime.lastError;
            if (lastError) {
              resolve({ ok: false, message: lastError.message || String(lastError) });
              return;
            }
            resolve(response || { ok: false, message: 'Native launcher 没有返回响应。' });
          }
        );
      });
    }

    async function ensureLocalServicesForWorkbench() {
      const result = await ensureServicesBeforeRunnerStart();
      if (result?.ok === false) {
        const message = String(result.message || result.error || '本地服务启动失败').trim();
        await addLog(`多线程工作台：本地服务启动失败：${message}`, 'warn');
        return {
          ok: false,
          message,
          state: await getState(),
        };
      }
      await addLog('多线程工作台：本地服务已就绪。', 'ok');
      return {
        ok: true,
        ...(result && typeof result === 'object' ? result : {}),
        state: await getState(),
      };
    }

    function normalizeThreadLogs(value = {}) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const next = {};
      for (const [rawThreadId, logs] of Object.entries(source)) {
        const threadId = normalizeThreadId(rawThreadId);
        next[threadId] = Array.isArray(logs) ? logs.slice(-MAX_THREAD_LOGS_PER_THREAD) : [];
      }
      return next;
    }

    function selectRecoverableRunnerRun(runs = [], runnerRunId = '') {
      const normalizedRunId = String(runnerRunId || '').trim();
      const candidates = Array.isArray(runs) ? runs : [];
      if (normalizedRunId) {
        return candidates.find((item) => String(item?.id || '') === normalizedRunId) || null;
      }
      const scored = candidates
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const threads = Array.isArray(item?.threads) ? item.threads : [];
          const hasSnapshot = threads.some((thread) => thread?.snapshot && typeof thread.snapshot === 'object');
          const hasLogs = threads.some((thread) => Array.isArray(thread?.snapshot?.logs) && thread.snapshot.logs.length > 0);
          const status = String(item?.status || '').trim().toLowerCase();
          const score = (status === 'running' ? 100 : 0)
            + (hasSnapshot ? 20 : 0)
            + (hasLogs ? 10 : 0)
            + Math.min(9, threads.length);
          return { item, score, updatedAt: Number(item?.updatedAt || item?.startedAt) || 0 };
        })
        .filter((entry) => entry.score > 0)
        .sort((left, right) => (right.score - left.score) || (right.updatedAt - left.updatedAt));
      return scored[0]?.item || null;
    }

    function buildRecoveredPlansFromRunner(run = {}, existingPlans = []) {
      const existingById = new Map((Array.isArray(existingPlans) ? existingPlans : [])
        .map((plan) => [String(plan?.id || ''), plan]));
      const threads = Array.isArray(run?.threads) ? run.threads : [];
      return threads.map((thread, index) => {
        const id = normalizeThreadId(thread?.id || `thread-${index + 1}`);
        const existing = existingById.get(id) || {};
        const snapshot = thread?.snapshot && typeof thread.snapshot === 'object' ? thread.snapshot : null;
        const email = normalizeEmail(snapshot?.email || thread?.email || existing.email || '');
        return {
          ...existing,
          id,
          index: Number.isFinite(Number(existing.index)) ? Number(existing.index) : index,
          label: existing.label || getThreadLabel(index),
          status: String(thread?.status || existing.status || '').trim().toLowerCase() || 'running',
          email,
          cdkey: String(thread?.cdkey || existing.cdkey || ''),
          proxyUrl: '',
          proxyDisplay: '',
          runner: {
            ...(existing.runner && typeof existing.runner === 'object' ? existing.runner : {}),
            debugPort: Number(thread?.debugPort) || Number(existing.runner?.debugPort) || 0,
            proxyBridgePort: Number(thread?.proxyBridgePort) || Number(existing.runner?.proxyBridgePort) || 0,
            profileDir: String(thread?.profileDir || existing.runner?.profileDir || ''),
            chromePid: Number(thread?.chromePid) || Number(existing.runner?.chromePid) || 0,
            proxyBridgePid: Number(thread?.proxyBridgePid) || Number(existing.runner?.proxyBridgePid) || 0,
          },
          startedAt: Number(thread?.startedAt || existing.startedAt) || 0,
          updatedAt: Date.now(),
        };
      });
    }

    async function addThreadLog(threadId, message, level = 'info', extra = {}) {
      const normalizedThreadId = normalizeThreadId(threadId);
      const state = await getState();
      const threadLogs = normalizeThreadLogs(state?.multiThreadLogs);
      const entry = {
        message: String(message || ''),
        level: String(level || 'info').trim().toLowerCase() || 'info',
        timestamp: Date.now(),
        threadId: normalizedThreadId,
        ...(extra && typeof extra === 'object' ? extra : {}),
      };
      threadLogs[normalizedThreadId] = [...(threadLogs[normalizedThreadId] || []), entry]
        .slice(-MAX_THREAD_LOGS_PER_THREAD);
      const updates = {
        multiThreadLogs: threadLogs,
      };
      await setState(updates);
      broadcastDataUpdate(updates);
      return entry;
    }

    async function syncMultiThreadRunnerLogs(options = {}) {
      const state = await getState();
      const mode = String(state?.multiThreadMode || '').trim();
      const runnerRunId = String(state?.multiThreadRunnerRunId || '').trim();

      let runnerData = null;
      try {
        runnerData = await fetchProfileRunnerRuns(state, options);
      } catch (error) {
        const message = `同步子线程日志失败：${error?.message || error}`;
        await addLog(`多线程工作台：${message}`, 'warn');
        const updates = {
          multiThreadLastError: message,
          multiThreadLastUpdatedAt: Date.now(),
        };
        await setState(updates);
        broadcastDataUpdate(updates);
        return {
          ok: false,
          message,
          state: { ...state, ...updates },
        };
      }

      const shouldRecover = mode !== 'isolated-profile-runner' || !runnerRunId;
      const run = selectRecoverableRunnerRun(runnerData.runs, runnerRunId);
      if (!run) {
        const latestState = await getState();
        const plans = Array.isArray(latestState?.multiThreadPlans) ? latestState.multiThreadPlans : [];
        const threadLogs = normalizeThreadLogs(latestState?.multiThreadLogs);
        const stoppedPlans = plans.map((plan) => {
          const status = String(plan?.status || '').trim().toLowerCase();
          return status === 'running'
            ? {
              ...plan,
              status: 'stopped',
              reason: plan.reason || 'runner 中没有找到对应任务',
              updatedAt: Date.now(),
            }
            : plan;
        });
        for (const plan of stoppedPlans) {
          if (plans.find((oldPlan) => oldPlan?.id === plan?.id && String(oldPlan?.status || '').toLowerCase() === 'running')) {
            threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
              message: '独立 profile runner 已无运行任务，已自动标记为停止。',
              level: 'warn',
              timestamp: Date.now(),
              nodeId: '',
            }]);
          }
        }
        const updates = {
          multiThreadMode: 'stopped',
          multiThreadRunnerRunId: '',
          multiThreadPlans: stoppedPlans,
          multiThreadLogs: threadLogs,
          multiThreadLastError: '',
          multiThreadLastUpdatedAt: Date.now(),
        };
        await setState(updates);
        if (typeof readExternalRedeemRecordsFromSqlite === 'function') {
          await readExternalRedeemRecordsFromSqlite({
            limit: 500,
            silent: true,
            timeoutMs: 6000,
          }).catch(() => null);
        }
        const finalState = await getState();
        broadcastDataUpdate(finalState);
        return { ok: true, skipped: true, reason: 'run_not_found', state: finalState };
      }

      const latestState = await getState();
      const existingPlans = Array.isArray(latestState?.multiThreadPlans) ? latestState.multiThreadPlans : [];
      const plans = existingPlans.length
        ? existingPlans
        : buildRecoveredPlansFromRunner(run, existingPlans);
      const threadLogs = normalizeThreadLogs(latestState?.multiThreadLogs);
      const runnerThreads = Array.isArray(run?.threads) ? run.threads : [];
      const runnerById = new Map(runnerThreads.map((thread) => [String(thread?.id || ''), thread]));
      const runnerRedeemState = collectRunnerRedeemState(runnerThreads);
      const shouldRefreshRedeemRecords = runnerRedeemState.queues.length
        || runnerRedeemState.records.length
        || hasRunnerExternalRedeemActivity(runnerThreads);
      const nextPlans = plans.map((plan) => {
        const thread = runnerById.get(String(plan?.id || '')) || null;
        if (!thread) return plan;
        const snapshot = thread.snapshot && typeof thread.snapshot === 'object' ? thread.snapshot : null;
        const snapshotLogs = Array.isArray(snapshot?.logs) ? snapshot.logs : [];
        threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], snapshotLogs);
        const diagnostics = snapshot ? {
          ok: snapshot.ok !== false,
          url: String(snapshot.url || '').slice(0, 300),
          title: String(snapshot.title || '').slice(0, 160),
          readyState: String(snapshot.readyState || ''),
          textPreview: String(snapshot.textPreview || '').slice(0, 260),
          pageError: String(snapshot.pageError || '').slice(0, 200),
          currentNodeId: String(snapshot.currentNodeId || ''),
          autoRunPhase: String(snapshot.autoRunPhase || ''),
          autoRunning: Boolean(snapshot.autoRunning),
          externalRedeemEnabled: snapshot.externalRedeemEnabled === true,
          hasExternalRedeemApiKey: snapshot.hasExternalRedeemApiKey === true,
          externalRedeemCdkeyCount: Math.max(0, Number(snapshot.externalRedeemCdkeyCount) || 0),
          verificationRuntimeStatus: snapshot.verificationRuntimeStatus && typeof snapshot.verificationRuntimeStatus === 'object'
            ? snapshot.verificationRuntimeStatus
            : null,
          error: String(snapshot.error || ''),
          updatedAt: Number(snapshot.updatedAt) || Date.now(),
        } : null;
        if (diagnostics) {
          const diagnosticMessage = diagnostics.ok
            ? `当前停留：${diagnostics.currentNodeId || diagnostics.autoRunPhase || '运行中'} / ${diagnostics.url || '-'}`
            : `诊断失败：${diagnostics.error || '无法读取子线程页面'}`;
          threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
            message: diagnosticMessage,
            level: diagnostics.ok ? 'info' : 'warn',
            timestamp: bucketDiagnosticTimestamp(diagnostics.updatedAt, 15000),
            nodeId: diagnostics.currentNodeId,
          }]);
          const verificationStatusMessage = formatVerificationRuntimeStatus(diagnostics.verificationRuntimeStatus);
          if (verificationStatusMessage) {
            threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
              message: verificationStatusMessage,
              level: String(diagnostics.verificationRuntimeStatus?.phase || '') === 'request_failed' ? 'warn' : 'info',
              timestamp: bucketDiagnosticTimestamp(diagnostics.verificationRuntimeStatus?.updatedAt || diagnostics.updatedAt, 3000) + 1,
              nodeId: String(diagnostics.verificationRuntimeStatus?.nodeId || diagnostics.currentNodeId || ''),
            }]);
          }
          if (diagnostics.textPreview) {
            threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
              message: `页面文本：${diagnostics.textPreview}`,
              level: 'info',
              timestamp: bucketDiagnosticTimestamp(diagnostics.updatedAt, 30000) + 2,
              nodeId: diagnostics.currentNodeId,
            }]);
          }
          if (diagnostics.pageError) {
            threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
              message: `页面诊断失败：${diagnostics.pageError}`,
              level: 'warn',
              timestamp: bucketDiagnosticTimestamp(diagnostics.updatedAt, 15000) + 3,
              nodeId: diagnostics.currentNodeId,
            }]);
          }
          if (diagnostics.currentNodeId === 'chatgpt-ac-external-redeem') {
            const configParts = [
              diagnostics.externalRedeemEnabled ? '外部兑换已启用' : '外部兑换未启用',
              diagnostics.hasExternalRedeemApiKey ? 'API Key 已配置' : 'API Key 未配置',
              `线程 CDK 数：${diagnostics.externalRedeemCdkeyCount}`,
            ];
            const level = diagnostics.externalRedeemEnabled && diagnostics.hasExternalRedeemApiKey && diagnostics.externalRedeemCdkeyCount > 0
              ? 'info'
              : 'warn';
            threadLogs[plan.id] = mergeThreadLogs(threadLogs[plan.id], [{
              message: `步骤 7 配置诊断：${configParts.join('；')}${diagnostics.externalRedeemCdkeyCount <= 0 ? '；不会提交外部兑换，只会同步 AC。' : '。'}`,
              level,
              timestamp: bucketDiagnosticTimestamp(diagnostics.updatedAt, 15000) + 4,
              nodeId: diagnostics.currentNodeId,
            }]);
          }
        }
        return {
          ...plan,
          status: String(thread.status || plan.status || '').toLowerCase() || plan.status,
          email: String(snapshot?.email || thread.email || plan.email || '').trim().toLowerCase(),
          runnerSnapshot: diagnostics,
          updatedAt: Date.now(),
        };
      });

      const updates = {
        multiThreadMode: 'isolated-profile-runner',
        multiThreadRunnerUrl: runnerData.runnerUrl,
        multiThreadRunnerRunId: String(run?.id || ''),
        multiThreadCount: nextPlans.length || Number(latestState?.multiThreadCount) || DEFAULT_THREAD_COUNT,
        multiThreadEnabled: (nextPlans.length || Number(latestState?.multiThreadCount) || DEFAULT_THREAD_COUNT) > 1,
        multiThreadPlans: nextPlans,
        multiThreadLogs: threadLogs,
        multiThreadLastError: '',
        multiThreadLastUpdatedAt: Date.now(),
      };
      if (runnerRedeemState.queues.length) {
        updates.externalRedeemQueue = mergeRedeemCollection(
          latestState?.externalRedeemQueue,
          runnerRedeemState.queues,
          getRedeemQueueItemKey
        );
        updates.externalRedeemLastSyncAt = runnerRedeemState.lastSyncAt || Date.now();
        updates.externalRedeemLastError = runnerRedeemState.lastError || '';
      }
      if (runnerRedeemState.records.length) {
        updates.externalRedeemRecords = mergeRedeemCollection(
          latestState?.externalRedeemRecords,
          runnerRedeemState.records,
          getRedeemRecordKey
        );
        updates.externalRedeemRecordsLastSyncAt = runnerRedeemState.recordsLastSyncAt || Date.now();
        updates.externalRedeemRecordsLastError = runnerRedeemState.recordsLastError || '';
        if (runnerRedeemState.recordsDbPath) {
          updates.externalRedeemRecordsDbPath = runnerRedeemState.recordsDbPath;
        }
      }
      await setState(updates);
      let finalState = { ...latestState, ...updates };
      if (shouldRefreshRedeemRecords && typeof readExternalRedeemRecordsFromSqlite === 'function') {
        try {
          await readExternalRedeemRecordsFromSqlite({
            limit: 500,
            silent: true,
            timeoutMs: 6000,
          });
          finalState = await getState();
        } catch {
          finalState = { ...latestState, ...updates };
        }
      }
      broadcastDataUpdate(finalState);
      return {
        ok: true,
        recovered: shouldRecover,
        run,
        plans: nextPlans,
        state: finalState,
      };
    }

    async function prepareMultiThreadWorkbench(options = {}) {
      const state = await getState();
      const requestedThreadCount = normalizeThreadCount(
        options.threadCount ?? state?.multiThreadCount ?? DEFAULT_THREAD_COUNT
      );
      const plans = buildThreadPlans(state, requestedThreadCount);
      const updates = {
        multiThreadEnabled: requestedThreadCount > 1,
        multiThreadCount: requestedThreadCount,
        multiThreadMode: 'workbench',
        multiThreadPlans: plans,
        multiThreadLogs: normalizeThreadLogs(state?.multiThreadLogs),
        multiThreadLastUpdatedAt: Date.now(),
        multiThreadLastError: '',
      };
      await setPersistentSettings({
        multiThreadCount: requestedThreadCount,
        multiThreadEnabled: requestedThreadCount > 1,
      });
      await setState(updates);
      broadcastDataUpdate(updates);

      for (const plan of plans) {
        await addThreadLog(
          plan.id,
          plan.email
            ? `已分配 ${plan.email}${plan.cdkey ? ' 和一个 CDK' : '，暂无可用 CDK'}。`
            : plan.reason,
          plan.status === 'ready' ? 'ok' : 'warn',
          {
            email: plan.email,
            hasCdkey: Boolean(plan.cdkey),
          }
        );
      }
      return {
        ok: true,
        plans,
        state: await getState(),
      };
    }

    async function startMultiThreadAutoRun(options = {}) {
      const state = await getState();
      const threadCount = normalizeThreadCount(options.threadCount ?? state?.multiThreadCount);
      const prepared = await prepareMultiThreadWorkbench({ threadCount });
      if (threadCount <= 1) {
        return prepared;
      }

      let localServiceError = '';
      const localServices = await ensureServicesBeforeRunnerStart();
      if (localServices?.ok === false) {
        localServiceError = String(localServices.message || '').trim();
        await addLog(`多线程工作台：本地服务自动启动失败：${localServices.message || 'unknown error'}`, 'warn');
      } else if (localServices?.ok === true) {
        await addLog('多线程工作台：本地服务已就绪，准备启动独立 profile runner。', 'info');
      }

      let runnerResult = null;
      try {
        runnerResult = await startProfileRunner(prepared.plans, state, options);
      } catch (error) {
        const message = String(error?.message || error || '').trim();
        const noRunnablePlans = message.includes('没有可启动的线程计划');
        const nativeHint = noRunnablePlans
          ? '请先在 iCloud API 邮箱池里新增未用邮箱，或清空/恢复已用邮箱后再启动；CDK 可以留空。'
          : (localServiceError
            ? `本地启动器返回：${localServiceError}。请先点“启动本地服务”；如仍失败，再运行 npm run install-native-launcher 并重载插件。临时方案是手动运行 npm run multi-profile-runner。`
            : '请先点“启动本地服务”；如仍失败，再运行 npm run install-native-launcher 并重载插件。临时方案是手动运行 npm run multi-profile-runner。');
        const reason = noRunnablePlans
          ? `${message}。${nativeHint}`
          : `独立浏览器 profile runner 未启动或启动失败：${message || 'unknown error'}。${nativeHint}`;
        await addLog(`多线程工作台：已生成 ${threadCount} 个线程计划，但未启动真实并发。${reason}`, 'warn');
        const latestState = await getState();
        const updates = {
          multiThreadMode: 'isolated-profile-runner-required',
          multiThreadLastError: reason,
          multiThreadLastUpdatedAt: Date.now(),
        };
        await setState(updates);
        broadcastDataUpdate(updates);
        return {
          ok: true,
          blocked: true,
          reason,
          plans: prepared.plans,
          state: { ...latestState, ...updates },
        };
      }

      const run = runnerResult?.run || {};
      const runningById = new Map((Array.isArray(run.threads) ? run.threads : []).map((thread) => [String(thread.id || ''), thread]));
      const runningPlans = prepared.plans.map((plan) => {
        const runnerThread = runningById.get(String(plan.id || '')) || null;
        return runnerThread ? {
          ...plan,
          status: 'running',
          runner: {
            debugPort: Number(runnerThread.debugPort) || 0,
            proxyBridgePort: Number(runnerThread.proxyBridgePort) || 0,
            profileDir: String(runnerThread.profileDir || ''),
            chromePid: Number(runnerThread.chromePid) || 0,
            proxyBridgePid: Number(runnerThread.proxyBridgePid) || 0,
          },
          startedAt: Number(runnerThread.startedAt) || Date.now(),
          updatedAt: Date.now(),
        } : plan;
      });
      const updates = {
        multiThreadMode: 'isolated-profile-runner',
        multiThreadRunnerUrl: runnerResult.runnerUrl,
        multiThreadRunnerRunId: String(run.id || ''),
        multiThreadPlans: runningPlans,
        multiThreadLastError: '',
        multiThreadLastUpdatedAt: Date.now(),
      };
      await setState(updates);
      broadcastDataUpdate(updates);
      for (const plan of runningPlans) {
        if (String(plan.status || '').toLowerCase() === 'running') {
          await addThreadLog(
            plan.id,
            `已启动独立 Chrome profile；debug=${plan.runner?.debugPort || '-'}，proxyBridge=${plan.runner?.proxyBridgePort || '-'}`,
            'ok',
            plan.runner || {}
          );
        }
      }
      await addLog(`多线程工作台：已通过独立浏览器 profile runner 启动 ${runningPlans.filter((plan) => String(plan.status || '').toLowerCase() === 'running').length} 个线程。`, 'ok');
      await syncMultiThreadRunnerLogs({ runnerUrl: runnerResult.runnerUrl }).catch((error) => {
        addLog(`多线程工作台：首次同步子线程日志失败：${error?.message || error}`, 'warn').catch(() => {});
      });
      return {
        ok: true,
        blocked: false,
        runner: runnerResult,
        plans: runningPlans,
        state: { ...await getState(), ...updates },
      };
    }

    async function stopMultiThreadAutoRun(options = {}) {
      const state = await getState();
      const runnerRunId = String(options.runId || state?.multiThreadRunnerRunId || '').trim();
      const plans = Array.isArray(state?.multiThreadPlans) ? state.multiThreadPlans : [];
      let stopResult = null;
      let stopError = '';

      if (String(state?.multiThreadMode || '') === 'isolated-profile-runner' && runnerRunId) {
        try {
          stopResult = await stopProfileRunnerRun(state, { ...options, runId: runnerRunId });
        } catch (error) {
          stopError = error?.message || String(error || '终止 runner 失败');
        }
      }

      const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'blocked']);
      const stoppedPlans = plans.map((plan) => {
        const status = String(plan?.status || '').toLowerCase();
        return {
          ...plan,
          status: terminalStatuses.has(status) ? (plan?.status || status) : 'stopped',
          updatedAt: Date.now(),
        };
      });
      const threadLogs = normalizeThreadLogs(state?.multiThreadLogs);
      for (const plan of stoppedPlans) {
        const threadId = normalizeThreadId(plan?.id);
        const message = stopError
          ? `终止请求已记录，但 runner 返回异常：${stopError}`
          : '已终止任务：独立 Chrome profile 和本地代理桥已停止。';
        threadLogs[threadId] = mergeThreadLogs(threadLogs[threadId], [{
          message,
          level: stopError ? 'warn' : 'warn',
          timestamp: Date.now(),
          nodeId: '',
        }]);
      }

      const updates = {
        multiThreadMode: 'workbench',
        multiThreadRunnerRunId: '',
        multiThreadPlans: stoppedPlans,
        multiThreadLogs: threadLogs,
        multiThreadLastError: stopError,
        multiThreadLastUpdatedAt: Date.now(),
      };
      await setState(updates);
      broadcastDataUpdate(updates);
      await addLog(stopError
        ? `多线程工作台：终止任务时 runner 返回异常：${stopError}`
        : '多线程工作台：已终止当前多线程任务。', stopError ? 'warn' : 'ok');
      return {
        ok: true,
        stopped: !stopError,
        message: stopError,
        runner: stopResult,
        plans: stoppedPlans,
        state: { ...state, ...updates },
      };
    }

    async function clearMultiThreadWorkbench() {
      const state = await getState();
      const plans = Array.isArray(state?.multiThreadPlans) ? state.multiThreadPlans : [];
      const hasActiveRunner = String(state?.multiThreadMode || '') === 'isolated-profile-runner'
        && Boolean(String(state?.multiThreadRunnerRunId || '').trim());
      const hasRunningPlan = plans.some((plan) => String(plan?.status || '').toLowerCase() === 'running');
      if (hasActiveRunner || hasRunningPlan) {
        return {
          ok: false,
          message: '当前多线程任务仍在运行，请先终止任务后再清空线程信息。',
          state,
        };
      }
      const updates = {
        multiThreadMode: 'workbench',
        multiThreadRunnerRunId: '',
        multiThreadPlans: [],
        multiThreadLogs: {},
        multiThreadLastError: '',
        multiThreadLastUpdatedAt: Date.now(),
      };
      await setState(updates);
      broadcastDataUpdate(updates);
      await addLog('多线程工作台：已清空线程信息展示。', 'ok');
      return {
        ok: true,
        state: { ...state, ...updates },
      };
    }

    return {
      addThreadLog,
      getAvailableCdkeys,
      getUnusedEmailEntries,
      clearMultiThreadWorkbench,
      ensureLocalServicesForWorkbench,
      normalizeThreadCount,
      prepareMultiThreadWorkbench,
      syncMultiThreadRunnerLogs,
      startMultiThreadAutoRun,
      stopMultiThreadAutoRun,
    };
  }

  return {
    createMultiThreadWorkbench,
  };
});
