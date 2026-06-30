// background/default-payment-proxy.js — avoid global proxy takeover.
(function installDefaultPaymentProxy(root) {
  const STORAGE_KEY = 'plusCheckoutConversionProxyUrl';
  const MIGRATION_KEY = 'gujumpgateDefaultPaymentProxyClearedAt';
  const STATUS_KEY = 'gujumpgateStaticProxyStatus';

  function proxyApiCall(method, payload) {
    return new Promise((resolve, reject) => {
      chrome.proxy.settings[method](payload, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        resolve();
      });
    });
  }

  async function clearGlobalProxyLeftover(reason = 'startup') {
    try {
      await proxyApiCall('clear', { scope: 'regular' });
      await chrome.storage.local.set({
        [STATUS_KEY]: {
          enabled: false,
          reason,
          error: '',
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.warn('[GuJumpgate default payment proxy] failed to clear global proxy:', error);
    }
  }

  async function clearLegacyDefaultPaymentProxy() {
    const [localStored, sessionStored] = await Promise.all([
      chrome.storage.local.get([STORAGE_KEY, MIGRATION_KEY]),
      chrome.storage.session?.get ? chrome.storage.session.get([STORAGE_KEY]) : Promise.resolve({}),
    ]);
    const localValue = String(localStored?.[STORAGE_KEY] || '').trim();
    const sessionValue = String(sessionStored?.[STORAGE_KEY] || '').trim();
    if (localStored?.[MIGRATION_KEY] && !localValue && !sessionValue) {
      return;
    }
    const current = localValue || sessionValue;
    if (!current) {
      await chrome.storage.local.set({ [MIGRATION_KEY]: new Date().toISOString() });
      return;
    }
    await Promise.all([
      chrome.storage.local.set({
        [STORAGE_KEY]: '',
        [MIGRATION_KEY]: new Date().toISOString(),
      }),
      chrome.storage.session?.set ? chrome.storage.session.set({ [STORAGE_KEY]: '' }) : Promise.resolve(),
    ]);
  }

  async function initialize(reason = 'startup') {
    await clearGlobalProxyLeftover(reason);
    await clearLegacyDefaultPaymentProxy();
  }

  root.guJumpgateDefaultPaymentProxy = {
    ensure: clearLegacyDefaultPaymentProxy,
    clearLegacyDefaultPaymentProxy,
    clearGlobalProxyLeftover,
  };

  chrome.runtime.onInstalled.addListener(() => {
    initialize('installed').catch((error) => {
      console.warn('[GuJumpgate default payment proxy] install init failed:', error);
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    initialize('chrome_startup').catch((error) => {
      console.warn('[GuJumpgate default payment proxy] startup init failed:', error);
    });
  });

  initialize('service_worker_start').catch((error) => {
    console.warn('[GuJumpgate default payment proxy] service worker init failed:', error);
  });
})(globalThis);
