(function attachBackgroundStep5(root, factory) {
  root.MultiPageBackgroundStep5 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep5Module() {
  function createStep5Executor(deps = {}) {
    const {
      addLog,
      generateRandomBirthday,
      generateRandomName,
      sendToContentScript,
      sendToContentScriptResilient,
      SIGNUP_PAGE_INJECT_FILES,
    } = deps;

    async function executeStep5() {
      const { firstName, lastName } = generateRandomName();
      const { year, month, day } = generateRandomBirthday();

      await addLog(`步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

      const message = {
        type: 'EXECUTE_NODE',
        nodeId: 'fill-profile',
        step: 5,
        source: 'background',
        payload: {
          firstName,
          lastName,
          year,
          month,
          day,
        },
      };

      if (typeof sendToContentScriptResilient === 'function') {
        await sendToContentScriptResilient('signup-page', message, {
          inject: SIGNUP_PAGE_INJECT_FILES,
          injectSource: 'signup-page',
          timeoutMs: 150000,
          responseTimeoutMs: 70000,
          retryDelayMs: 900,
          logMessage: '步骤 5：资料页或 ChatGPT 引导页内容脚本通信中断，正在重新注入并继续处理...',
          logStep: 5,
          logStepKey: 'fill-profile',
        });
        return;
      }

      await sendToContentScript('signup-page', message);
    }

    return { executeStep5 };
  }

  return { createStep5Executor };
});
