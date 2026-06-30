(function attachSignupFlowHelpers(root, factory) {
  root.MultiPageSignupFlowHelpers = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSignupFlowHelpersModule() {
  function createSignupFlowHelpers(deps = {}) {
    const {
      addLog,
      buildGeneratedAliasEmail,
      chrome,
      ensureContentScriptReadyOnTab,
      ensureHotmailAccountForFlow,
      ensureMail2925AccountForFlow,
      ensureLuckmailPurchaseForFlow,
      fetchGeneratedEmail,
      isGeneratedAliasProvider,
      isReusableGeneratedAliasEmail,
      isHotmailProvider,
      isRetryableContentScriptTransportError = () => false,
      isLuckmailProvider,
      isSignupEmailVerificationPageUrl,
      isSignupPasswordPageUrl,
      isSignupPhoneVerificationPageUrl = null,
      isSignupProfilePageUrl = null,
      persistRegistrationEmailState = null,
      reuseOrCreateTab,
      sendToContentScriptResilient,
      setEmailState,
      setState,
      SIGNUP_ENTRY_URL,
      SIGNUP_PAGE_INJECT_FILES,
      waitForTabStableComplete = null,
      waitForTabUrlMatch,
    } = deps;

    async function waitForSignupEntryTabToSettle(tabId, step = 1) {
      if (!Number.isInteger(tabId) || typeof waitForTabStableComplete !== 'function') {
        return null;
      }

      // Do not request window focus here. The automation tab is already
      // locked to the selected Chrome window; raising that window would
      // interrupt the user's active workspace.

      if (typeof addLog === 'function') {
        await addLog(
          step === 2
            ? `步骤 ${step}：注册页已打开，正在等待页面加载完成并额外稳定 3 秒...`
            : `步骤 ${step}：ChatGPT 登录页已打开，正在等待页面加载完成...`,
          'info',
          { step, stepKey: step === 1 ? 'open-chatgpt' : 'signup-entry' }
        );
      }

      return waitForTabStableComplete(tabId, {
        timeoutMs: 45000,
        retryDelayMs: 300,
        stableMs: step === 2 ? 3000 : 1000,
        initialDelayMs: 300,
      });
    }

    function isBrowserErrorPageTab(tab = {}) {
      const url = String(tab?.url || '').trim();
      const pendingUrl = String(tab?.pendingUrl || '').trim();
      return /^chrome-error:\/\/chromewebdata\/?/i.test(url)
        || /^chrome-error:\/\/chromewebdata\/?/i.test(pendingUrl);
    }

    async function isTabShowingBrowserErrorPage(tabId) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.get) {
        return false;
      }

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (isBrowserErrorPageTab(tab)) {
        return true;
      }

      if (!chrome?.scripting?.executeScript) {
        return false;
      }

      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => Boolean(
            document?.body?.classList?.contains('neterror')
            || document?.querySelector?.('#main-frame-error')
            || document?.querySelector?.('#main-message .error-code')
            || /^chrome-error:\/\/chromewebdata\/?/i.test(String(location?.href || ''))
          ),
        });
        return Boolean(execution?.result);
      } catch (error) {
        return /Frame with ID \d+ is showing error page|Cannot access contents of url "chrome-error:\/\/chromewebdata|Cannot access a chrome:\/\//i
          .test(String(error?.message || error || ''));
      }
    }

    async function reopenSignupEntryTabAfterBrowserError(tabId, step = 1) {
      if (!Number.isInteger(tabId) || !chrome?.tabs?.update) {
        return { tabId, recovered: false, stillError: false };
      }

      if (!await isTabShowingBrowserErrorPage(tabId)) {
        return { tabId, recovered: false, stillError: false };
      }

      if (typeof addLog === 'function') {
        await addLog(
          `步骤 ${step}：检测到 ChatGPT 登录页停在浏览器错误页，正在重新打开登录入口...`,
          'warn',
          { step, stepKey: step === 1 ? 'open-chatgpt' : 'signup-entry' }
        );
      }

      await chrome.tabs.update(tabId, { url: 'about:blank', active: true });
      if (typeof waitForTabStableComplete === 'function') {
        await waitForTabStableComplete(tabId, {
          timeoutMs: 10000,
          retryDelayMs: 200,
          stableMs: 300,
          initialDelayMs: 100,
        });
      }
      await chrome.tabs.update(tabId, { url: SIGNUP_ENTRY_URL, active: true });
      if (typeof waitForTabStableComplete === 'function') {
        await waitForTabStableComplete(tabId, {
          timeoutMs: 45000,
          retryDelayMs: 300,
          stableMs: 1000,
          initialDelayMs: 800,
        });
      }
      const stillError = await isTabShowingBrowserErrorPage(tabId);
      return { tabId, recovered: !stillError, stillError };
    }

    async function openSignupEntryTab(step = 1) {
      const tabId = await reuseOrCreateTab('signup-page', SIGNUP_ENTRY_URL);

      await waitForSignupEntryTabToSettle(tabId, step);
      const recovery = await reopenSignupEntryTabAfterBrowserError(tabId, step);
      if (recovery?.stillError) {
        throw new Error(
          `步骤 ${step}：ChatGPT 登录页仍停在浏览器错误页，通常是当前代理/网络无法打开 chatgpt.com，请更换可访问 ChatGPT 的代理后重试。`
        );
      }

      await ensureContentScriptReadyOnTab('signup-page', tabId, {
        inject: SIGNUP_PAGE_INJECT_FILES,
        injectSource: 'signup-page',
        timeoutMs: 45000,
        retryDelayMs: 900,
        logMessage: `步骤 ${step}：ChatGPT 官网仍在加载，正在重试连接内容脚本...`,
      });

      return tabId;
    }

    async function ensureSignupEntryPageReady(step = 1) {
      const tabId = await openSignupEntryTab(step);
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'ENSURE_SIGNUP_ENTRY_READY',
        step,
        source: 'background',
        payload: {},
      }, {
        timeoutMs: 20000,
        retryDelayMs: 700,
        logMessage: `步骤 ${step}：官网注册入口正在切换，等待页面恢复...`,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      return { tabId, result: result || {} };
    }

    function parseUrlSafely(rawUrl) {
      if (!rawUrl) return null;
      try {
        return new URL(rawUrl);
      } catch {
        return null;
      }
    }

    function fallbackSignupPhoneVerificationPageUrl(rawUrl) {
      const parsed = parseUrlSafely(rawUrl);
      if (!parsed) return false;
      return /\/phone-verification(?:[/?#]|$)/i.test(parsed.pathname || '');
    }

    function fallbackSignupProfilePageUrl(rawUrl) {
      const parsed = parseUrlSafely(rawUrl);
      if (!parsed) return false;
      return /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i.test(parsed.pathname || '');
    }

    function resolveSignupPostIdentityState(rawUrl) {
      if (isSignupPasswordPageUrl(rawUrl)) {
        return 'password_page';
      }
      if (isSignupEmailVerificationPageUrl(rawUrl)) {
        return 'verification_page';
      }
      const isPhoneVerificationUrl = typeof isSignupPhoneVerificationPageUrl === 'function'
        ? isSignupPhoneVerificationPageUrl(rawUrl)
        : fallbackSignupPhoneVerificationPageUrl(rawUrl);
      if (isPhoneVerificationUrl) {
        return 'phone_verification_page';
      }
      const isProfileUrl = typeof isSignupProfilePageUrl === 'function'
        ? isSignupProfilePageUrl(rawUrl)
        : fallbackSignupProfilePageUrl(rawUrl);
      if (isProfileUrl) {
        return 'profile_page';
      }
      if (isLikelyLoggedInChatgptHomeUrl(rawUrl)) {
        return 'logged_in_home';
      }
      return '';
    }

    function isLikelyLoggedInChatgptHomeUrl(rawUrl = '') {
      const url = String(rawUrl || '').trim();
      if (!url) {
        return false;
      }

      try {
        const parsed = new URL(url);
        const host = String(parsed.hostname || '').toLowerCase();
        if (!['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(host)) {
          return false;
        }

        const path = String(parsed.pathname || '');
        return !/^\/(?:auth(?:\/.*)?|create-account(?:\/.*)?|email-verification(?:\/.*)?|log-in(?:\/.*)?|add-phone(?:\/.*)?)(?:[?#]|$)/i.test(path);
      } catch {
        return false;
      }
    }

    async function ensureSignupPostIdentityPageReadyInTab(tabId, step = 2, options = {}) {
      const { skipUrlWait = false } = options;
      let landingUrl = '';
      let landingState = '';
      let timedOutWaitingForUrl = false;

      if (!skipUrlWait) {
        const matchedTab = await waitForTabUrlMatch(tabId, (url) => Boolean(resolveSignupPostIdentityState(url)), {
          timeoutMs: 45000,
          retryDelayMs: 300,
        });
        if (!matchedTab) {
          timedOutWaitingForUrl = true;
        } else {
          landingUrl = matchedTab.url || '';
          landingState = resolveSignupPostIdentityState(landingUrl);
        }
      }

      if (!landingState) {
        try {
          const currentTab = await chrome.tabs.get(tabId);
          landingUrl = landingUrl || currentTab?.url || '';
          landingState = resolveSignupPostIdentityState(landingUrl);
        } catch {
          landingUrl = landingUrl || '';
        }
      }

      if (!landingState && timedOutWaitingForUrl && typeof sendToContentScriptResilient === 'function') {
        try {
          const pageState = await sendToContentScriptResilient('signup-page', {
            type: 'ENSURE_SIGNUP_ENTRY_READY',
            step,
            source: 'background',
            payload: { timeoutMs: 1500 },
          }, {
            timeoutMs: 6000,
            retryDelayMs: 500,
            logMessage: `步骤 ${step}：页面跳转未完成，正在回读当前注册页状态...`,
          });
          const state = String(pageState?.state || '').trim();
          if (state) {
            return {
              ...(pageState || {}),
              ready: Boolean(pageState?.ready),
              state,
              url: pageState?.url || landingUrl || '',
              postIdentityTimeout: true,
            };
          }
        } catch {
          // Fall through to the detailed timeout error below.
        }
      }

      if (!landingState) {
        const timeoutHint = timedOutWaitingForUrl ? '等待注册身份提交后的页面跳转超时，' : '';
        throw new Error(`${timeoutHint}注册身份提交后未能识别当前页面，既不是密码页、验证码页，也不是资料页。URL: ${landingUrl || 'unknown'}`);
      }

      if (landingState !== 'password_page' && typeof waitForTabStableComplete === 'function') {
        const stableTab = await waitForTabStableComplete(tabId, {
          timeoutMs: 45000,
          retryDelayMs: 300,
          stableMs: 800,
          initialDelayMs: 300,
        });
        if (stableTab?.url) {
          const stableState = resolveSignupPostIdentityState(stableTab.url);
          if (stableState) {
            landingUrl = stableTab.url;
            landingState = stableState;
          }
        }
      }

      await ensureContentScriptReadyOnTab('signup-page', tabId, {
        inject: SIGNUP_PAGE_INJECT_FILES,
        injectSource: 'signup-page',
        timeoutMs: 45000,
        retryDelayMs: 900,
        logMessage: landingState === 'password_page'
          ? `步骤 ${step}：密码页仍在加载，正在重试连接内容脚本...`
          : `步骤 ${step}：注册后续页面仍在加载，正在等待页面恢复...`,
      });

      if (landingState === 'logged_in_home') {
        return {
          ready: true,
          state: landingState,
          url: landingUrl,
          alreadyLoggedInHome: true,
          skipProfileStep: true,
        };
      }

      if (landingState !== 'password_page') {
        return {
          ready: true,
          state: landingState,
          url: landingUrl,
        };
      }

      const result = await sendToContentScriptResilient('signup-page', {
        type: 'ENSURE_SIGNUP_PASSWORD_PAGE_READY',
        step,
        source: 'background',
        payload: {},
      }, {
        timeoutMs: 20000,
        retryDelayMs: 700,
        logMessage: `步骤 ${step}：认证页正在切换，等待密码页重新就绪...`,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      return {
        ...(result || {}),
        ready: true,
        state: landingState,
        url: landingUrl,
      };
    }

    async function ensureSignupPostEmailPageReadyInTab(tabId, step = 2, options = {}) {
      return ensureSignupPostIdentityPageReadyInTab(tabId, step, options);
    }

    async function ensureSignupPasswordPageReadyInTab(tabId, step = 2, options = {}) {
      const result = await ensureSignupPostEmailPageReadyInTab(tabId, step, options);
      if (result.state !== 'password_page') {
        throw new Error(`当前页面不是密码页，实际落地为 ${result.state || 'unknown'}。URL: ${result.url || 'unknown'}`);
      }
      return result;
    }

    async function finalizeSignupPasswordSubmitInTab(tabId, password = '', step = 3) {
      if (!Number.isInteger(tabId)) {
        throw new Error(`认证页面标签页已关闭，无法完成步骤 ${step} 的提交后确认。`);
      }

      await ensureContentScriptReadyOnTab('signup-page', tabId, {
        inject: SIGNUP_PAGE_INJECT_FILES,
        injectSource: 'signup-page',
        timeoutMs: 45000,
        retryDelayMs: 900,
        logMessage: `步骤 ${step}：认证页仍在切换，正在等待页面恢复后继续确认提交流程...`,
      });

      let result;
      try {
        result = await sendToContentScriptResilient('signup-page', {
          type: 'PREPARE_SIGNUP_VERIFICATION',
          step,
          source: 'background',
          payload: {
            password: password || '',
            prepareSource: 'step3_finalize',
            prepareLogLabel: '步骤 3 收尾',
          },
        }, {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: `步骤 ${step}：密码已提交，正在确认是否进入下一页面，必要时自动恢复重试页...`,
        });
      } catch (error) {
        if (isRetryableContentScriptTransportError(error)) {
          const message = `步骤 ${step}：认证页在提交后切换过程中页面通信超时，未能重新就绪，暂时无法确认是否进入下一页面。请重试当前轮。`;
          if (typeof addLog === 'function') {
            await addLog(message, 'warn');
          }
          throw new Error(message);
        }
        throw error;
      }

      if (result?.error) {
        throw new Error(result.error);
      }

      return result || {};
    }

    function getPreservedPhoneIdentityForEmailResolution(state = {}, options = {}) {
      if (!Boolean(options?.preserveAccountIdentity)) {
        return null;
      }
      const accountIdentifierType = String(state?.accountIdentifierType || '').trim().toLowerCase();
      const signupPhoneNumber = String(
        state?.signupPhoneNumber
        || (accountIdentifierType === 'phone' ? state?.accountIdentifier : '')
        || state?.signupPhoneCompletedActivation?.phoneNumber
        || state?.signupPhoneActivation?.phoneNumber
        || ''
      ).trim();
      if (accountIdentifierType !== 'phone' && !signupPhoneNumber) {
        return null;
      }
      return {
        accountIdentifierType: 'phone',
        accountIdentifier: signupPhoneNumber || String(state?.accountIdentifier || '').trim(),
        signupPhoneNumber,
        signupPhoneActivation: state?.signupPhoneActivation || null,
        signupPhoneCompletedActivation: state?.signupPhoneCompletedActivation || null,
        signupPhoneVerificationRequestedAt: state?.signupPhoneVerificationRequestedAt ?? null,
        signupPhoneVerificationPurpose: state?.signupPhoneVerificationPurpose || '',
      };
    }

    async function persistResolvedSignupEmail(resolvedEmail, state = {}, options = {}) {
      if (resolvedEmail === state.email && !options?.preserveAccountIdentity) {
        return;
      }
      const generatedEmailAlreadyPersisted = Boolean(options?.generatedEmailAlreadyPersisted);
      if (typeof persistRegistrationEmailState === 'function') {
        if (!generatedEmailAlreadyPersisted) {
          await persistRegistrationEmailState(state, resolvedEmail, {
            source: 'flow',
            preserveAccountIdentity: Boolean(options?.preserveAccountIdentity),
          });
        }
        return;
      }
      const preservedPhoneIdentity = getPreservedPhoneIdentityForEmailResolution(state, options);
      if (preservedPhoneIdentity && typeof setState === 'function') {
        if (!generatedEmailAlreadyPersisted && resolvedEmail !== state.email) {
          await setEmailState(resolvedEmail, { source: 'flow' });
        }
        await setState(preservedPhoneIdentity);
        return;
      }
      if (resolvedEmail !== state.email) {
        await setEmailState(resolvedEmail);
      }
    }

    async function resolveSignupEmailForFlow(state, options = {}) {
      let resolvedEmail = state.email;
      let generatedEmailAlreadyPersisted = false;
      if (isHotmailProvider(state)) {
        const account = await ensureHotmailAccountForFlow({
          allowAllocate: true,
          markUsed: true,
          preferredAccountId: state.currentHotmailAccountId || null,
        });
        resolvedEmail = account.registrationAliasEmail || account.email;
      } else if (isLuckmailProvider(state)) {
        const purchase = await ensureLuckmailPurchaseForFlow({ allowReuse: true });
        resolvedEmail = purchase.email_address;
      } else if (isGeneratedAliasProvider(state)) {
        if (Boolean(state?.mail2925UseAccountPool)
          && String(state?.mailProvider || '').trim().toLowerCase() === '2925'
          && typeof ensureMail2925AccountForFlow === 'function') {
          await ensureMail2925AccountForFlow({
            allowAllocate: true,
            preferredAccountId: state.currentMail2925AccountId || null,
            markUsed: true,
          });
        }
        if (!isReusableGeneratedAliasEmail?.(state, resolvedEmail)) {
          resolvedEmail = buildGeneratedAliasEmail(state);
        }
      } else if (!resolvedEmail && typeof fetchGeneratedEmail === 'function') {
        resolvedEmail = await fetchGeneratedEmail(state, options);
        generatedEmailAlreadyPersisted = true;
      }

      if (!resolvedEmail) {
        throw new Error('缺少邮箱地址，请先在侧边栏粘贴邮箱。');
      }

      if (!generatedEmailAlreadyPersisted || options?.preserveAccountIdentity) {
        await persistResolvedSignupEmail(resolvedEmail, state, {
          ...options,
          generatedEmailAlreadyPersisted,
        });
      }

      return resolvedEmail;
    }

    return {
      ensureSignupEntryPageReady,
      ensureSignupPostIdentityPageReadyInTab,
      ensureSignupPostEmailPageReadyInTab,
      finalizeSignupPasswordSubmitInTab,
      ensureSignupPasswordPageReadyInTab,
      openSignupEntryTab,
      resolveSignupEmailForFlow,
    };
  }

  return {
    createSignupFlowHelpers,
  };
});
