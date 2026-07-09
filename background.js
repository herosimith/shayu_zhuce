// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts(
  'shared/source-registry.js',
  'shared/flow-capabilities.js',
  'managed-alias-utils.js',
  'mail2925-utils.js',
  'phone-sms/providers/hero-sms.js',
  'phone-sms/providers/five-sim.js',
  'phone-sms/providers/registry.js',
  'background/phone-verification-flow.js',
  'background/account-run-history.js',
  'background/mail-2925-session.js',
  'background/ip-proxy-provider-711proxy.js',
  'background/ip-proxy-core.js',
  'background/k12-workspace.js',
  'background/registration-email-state.js',
  'background/workflow-engine.js',
  'background/runtime-state.js',
  'background/generated-email-helpers.js',
  'background/signup-flow-helpers.js',
  'background/mail-rule-registry.js',
  'flows/openai/mail-rules.js',
  'background/message-router.js',
  'background/verification-flow.js',
  'background/auto-run-controller.js',
  'background/multi-thread-workbench.js',
  'background/tab-runtime.js',
  'background/navigation-utils.js',
  'background/logging-status.js',
  'background/default-payment-proxy.js',
  'background/steps/registry.js',
  'data/step-definitions.js',
  'data/address-sources.js',
  'background/steps/open-chatgpt.js',
  'background/steps/submit-signup-email.js',
  'background/steps/fill-password.js',
  'background/steps/fetch-signup-code.js',
  'background/steps/fill-profile.js',
  'background/steps/wait-registration-success.js',
  'background/steps/create-plus-checkout.js',
  'data/names.js',
  'hotmail-utils.js',
  'microsoft-email.js',
  'luckmail-utils.js',
  'cloudflare-temp-email-utils.js',
  'cloudmail-utils.js',
  'background/cloudmail-provider.js',
  'background/icloudapi-provider.js',
  'icloud-utils.js',
  'mail-provider-utils.js',
  'content/activation-utils.js'
);

const DEFAULT_ACTIVE_FLOW_ID = 'openai';
const PLUS_ACCOUNT_ACCESS_STRATEGY_OAUTH = 'oauth';
const PLUS_PAYMENT_METHOD_CHECKOUT_CONVERSION = 'checkout-conversion';
const SLIM_STEP_DEFINITIONS = Object.freeze([
  { id: 1, order: 10, key: 'open-chatgpt', title: '打开 ChatGPT 官网', sourceId: 'chatgpt', driverId: null, command: 'open-chatgpt' },
  { id: 2, order: 20, key: 'submit-signup-email', title: '注册并输入邮箱', sourceId: 'openai-auth', driverId: 'content/signup-page', command: 'submit-signup-email' },
  { id: 3, order: 30, key: 'fill-password', title: '填写密码并继续', sourceId: 'openai-auth', driverId: 'content/signup-page', command: 'fill-password' },
  { id: 4, order: 40, key: 'fetch-signup-code', title: '获取注册验证码', sourceId: 'openai-auth', driverId: 'content/signup-page', command: 'submit-verification-code', mailRuleId: 'openai-signup-code' },
  { id: 5, order: 50, key: 'fill-profile', title: '填写姓名和生日', sourceId: 'openai-auth', driverId: 'content/signup-page', command: 'fill-profile' },
  { id: 6, order: 60, key: 'wait-registration-success', title: '等待注册成功并进入 ChatGPT', sourceId: 'chatgpt', driverId: null, command: 'wait-registration-success' },
  { id: 7, order: 70, key: 'chatgpt-ac-external-redeem', title: '检查 AC 资格并提交外部兑换', sourceId: 'chatgpt', driverId: null, command: 'chatgpt-ac-external-redeem' },
]);
const K12_WORKSPACE_STEP_DEFINITIONS = Object.freeze(
  SLIM_STEP_DEFINITIONS.filter((definition) => Number(definition?.id) <= 6)
);
const NORMAL_STEP_DEFINITIONS = SLIM_STEP_DEFINITIONS;
const PLUS_STEP_DEFINITIONS = SLIM_STEP_DEFINITIONS;
const ALL_STEP_DEFINITIONS = SLIM_STEP_DEFINITIONS;
const STEP_IDS = Array.from(new Set(ALL_STEP_DEFINITIONS
  .map((definition) => Number(definition?.id))
  .filter(Number.isFinite)))
  .sort((left, right) => left - right);
const DEFAULT_STEP_STATUSES = Object.fromEntries(STEP_IDS.map((stepId) => [stepId, 'pending']));
const DEFAULT_NODE_IDS = Array.from(new Set(ALL_STEP_DEFINITIONS
  .map((definition) => String(definition?.key || '').trim())
  .filter(Boolean)));
const DEFAULT_NODE_STATUSES = Object.fromEntries(DEFAULT_NODE_IDS.map((nodeId) => [nodeId, 'pending']));
const NORMAL_STEP_IDS = NORMAL_STEP_DEFINITIONS
  .map((definition) => Number(definition?.id))
  .filter(Number.isFinite)
  .sort((left, right) => left - right);
const PLUS_STEP_IDS = NORMAL_STEP_IDS;
const LAST_STEP_ID = Math.max(
  NORMAL_STEP_IDS[NORMAL_STEP_IDS.length - 1] || 10,
  PLUS_STEP_IDS[PLUS_STEP_IDS.length - 1] || 10
);
const FINAL_OAUTH_CHAIN_START_STEP = 7;

const {
  extractVerificationCodeFromMessage,
  filterHotmailAccountsByUsage,
  getLatestHotmailMessage,
  getHotmailMailApiRequestConfig,
  getHotmailVerificationPollConfig,
  getHotmailVerificationRequestTimestamp,
  normalizeHotmailServiceMode,
  normalizeHotmailMailApiMessages,
  pickHotmailAccountForRun,
  pickVerificationMessage,
  pickVerificationMessageWithFallback,
  pickVerificationMessageWithTimeFallback,
  shouldClearHotmailCurrentSelection,
} = self.HotmailUtils;
const {
  MAIL2925_LIMIT_COOLDOWN_MS,
  findMail2925Account,
  getMail2925AccountStatus,
  normalizeMail2925Account,
  normalizeMail2925Accounts,
  parseMail2925ImportText,
  pickMail2925AccountForRun,
  upsertMail2925AccountInList,
} = self.Mail2925Utils;
const {
  fetchMicrosoftMailboxMessages,
} = self.MultiPageMicrosoftEmail;
const {
  DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  DEFAULT_LUCKMAIL_BASE_URL,
  DEFAULT_LUCKMAIL_EMAIL_TYPE,
  buildLuckmailBaselineCursor,
  buildLuckmailMailCursor,
  filterReusableLuckmailPurchases,
  isLuckmailMailNewerThanCursor,
  isLuckmailPurchaseReusable,
  isLuckmailPurchaseForProject,
  isLuckmailPurchasePreserved,
  normalizeLuckmailBaseUrl,
  normalizeLuckmailEmailType,
  normalizeLuckmailMailCursor,
  normalizeLuckmailProjectName,
  normalizeLuckmailPurchase,
  normalizeLuckmailPurchaseId,
  normalizeLuckmailPurchaseListPage,
  normalizeLuckmailPurchases,
  normalizeLuckmailTags,
  normalizeLuckmailTokenCode,
  normalizeLuckmailTokenMail,
  normalizeLuckmailTokenMails,
  normalizeLuckmailUsedPurchases,
  normalizeTimestamp: normalizeLuckmailTimestamp,
  pickLuckmailVerificationMail,
} = self.LuckMailUtils;
const {
  DEFAULT_MAIL_PAGE_SIZE: CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE,
  buildCloudflareTempEmailHeaders,
  getCloudflareTempEmailAddressFromResponse,
  joinCloudflareTempEmailUrl,
  normalizeCloudflareTempEmailAddress,
  normalizeCloudflareTempEmailBaseUrl,
  normalizeCloudflareTempEmailDomain,
  normalizeCloudflareTempEmailDomains,
  normalizeCloudflareTempEmailMailApiMessages,
} = self.CloudflareTempEmailUtils;
const {
  DEFAULT_MAIL_PAGE_SIZE: CLOUD_MAIL_DEFAULT_PAGE_SIZE,
  buildCloudMailHeaders,
  getCloudMailTokenFromResponse,
  joinCloudMailUrl,
  normalizeCloudMailAddress,
  normalizeCloudMailBaseUrl,
  normalizeCloudMailDomain,
  normalizeCloudMailDomains,
  normalizeCloudMailMailApiMessages,
} = self.CloudMailUtils;
const {
  findIcloudAliasByEmail,
  getConfiguredIcloudHostPreference,
  getIcloudHostHintFromMessage,
  getIcloudLoginUrlForHost,
  getIcloudMailUrlForHost,
  getIcloudSetupUrlForHost,
  normalizeBooleanMap,
  normalizeIcloudAliasList,
  normalizeIcloudAliasRecord,
  normalizeIcloudHost,
  pickReusableIcloudAlias,
  toNormalizedEmailSet,
} = self.IcloudUtils;
const {
  getIcloudForwardMailConfig: getSharedIcloudForwardMailConfig,
  normalizeIcloudForwardMailProvider,
  normalizeIcloudTargetMailboxType,
} = self.MailProviderUtils;
const {
  isRecoverableStep9AuthFailure,
} = self.MultiPageActivationUtils;
const registrationEmailStateHelpers = self.MultiPageRegistrationEmailState?.createRegistrationEmailStateHelpers?.() || null;
const runtimeStateHelpers = self.MultiPageBackgroundRuntimeState?.createRuntimeStateHelpers?.({
  DEFAULT_ACTIVE_FLOW_ID,
  defaultNodeStatuses: DEFAULT_NODE_STATUSES,
}) || null;
const DEFAULT_REGISTRATION_EMAIL_STATE = registrationEmailStateHelpers?.DEFAULT_REGISTRATION_EMAIL_STATE || {
  current: '',
  previous: '',
  source: '',
  updatedAt: 0,
};

function getRegistrationEmailState(state = {}) {
  if (registrationEmailStateHelpers?.getRegistrationEmailState) {
    return registrationEmailStateHelpers.getRegistrationEmailState(state);
  }
  const fallbackEmail = String(state?.email || '').trim();
  return {
    current: fallbackEmail,
    previous: fallbackEmail,
    source: '',
    updatedAt: 0,
  };
}

function buildRegistrationEmailStateUpdates(state = {}, options = {}) {
  if (registrationEmailStateHelpers?.buildRegistrationEmailStateUpdates) {
    return registrationEmailStateHelpers.buildRegistrationEmailStateUpdates(state, options);
  }
  const currentEmail = String(options?.currentEmail || '').trim();
  const preservePrevious = Boolean(options?.preservePrevious);
  const currentState = getRegistrationEmailState(state);
  return {
    email: currentEmail || null,
    registrationEmailState: {
      current: currentEmail,
      previous: currentEmail || (preservePrevious ? currentState.previous : ''),
      source: currentEmail
        ? String(options?.source || '').trim()
        : (preservePrevious ? currentState.source : ''),
      updatedAt: currentEmail || (preservePrevious && currentState.previous) ? Date.now() : 0,
    },
  };
}

function getRegistrationEmailBaseline(state = {}, options = {}) {
  if (registrationEmailStateHelpers?.getRegistrationEmailBaseline) {
    return registrationEmailStateHelpers.getRegistrationEmailBaseline(state, options);
  }
  const preferredEmail = String(options?.preferredEmail || '').trim();
  const fallbackEmail = String(options?.fallbackEmail || '').trim();
  const currentState = getRegistrationEmailState(state);
  return preferredEmail || currentState.current || currentState.previous || fallbackEmail || '';
}

function buildFlowRegistrationEmailStateUpdates(state = {}, options = {}) {
  if (registrationEmailStateHelpers?.buildFlowRegistrationEmailStateUpdates) {
    return registrationEmailStateHelpers.buildFlowRegistrationEmailStateUpdates(state, options);
  }
  return buildRegistrationEmailStateUpdates(state, options);
}

function getPreservedPhoneIdentity(state = {}) {
  if (registrationEmailStateHelpers?.getPreservedPhoneIdentity) {
    return registrationEmailStateHelpers.getPreservedPhoneIdentity(state);
  }
  return null;
}

function buildStateViewWithRuntimeState(state = {}) {
  if (runtimeStateHelpers?.buildStateView) {
    return runtimeStateHelpers.buildStateView(state);
  }
  return state;
}

function buildStatePatchWithRuntimeState(currentState = {}, updates = {}) {
  if (runtimeStateHelpers?.buildSessionStatePatch) {
    return runtimeStateHelpers.buildSessionStatePatch(currentState, updates);
  }
  return updates;
}

function statePatchHasChanges(state = {}, patch = {}) {
  return Object.keys(patch).some((key) => JSON.stringify(state?.[key] ?? null) !== JSON.stringify(patch[key] ?? null));
}

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const ICLOUD_SETUP_URLS = [
  'https://setup.icloud.com/setup/ws/1',
  'https://setup.icloud.com.cn/setup/ws/1',
];
const ICLOUD_LOGIN_URLS = [
  'https://www.icloud.com/',
  'https://www.icloud.com.cn/',
];
const ICLOUD_REQUEST_TIMEOUT_MS = 15000;
const ICLOUD_LIST_MAX_ATTEMPTS = 3;
const ICLOUD_WRITE_MAX_ATTEMPTS = 2;
const ICLOUD_RETRY_DELAYS_MS = [1000, 2500, 5000];
const ICLOUD_TAB_URL_PATTERNS = [
  'https://www.icloud.com/*',
  'https://www.icloud.com.cn/*',
  'https://setup.icloud.com/*',
  'https://setup.icloud.com.cn/*',
  'https://*.icloud.com/*',
  'https://*.icloud.com.cn/*',
];
const ICLOUD_MAILDOMAINWS_CLIENT_BUILD_NUMBER = '2206Hotfix11';
const ICLOUD_ALIAS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ICLOUD_TRANSIENT_RETRY_MAX_ATTEMPTS = 2;
const ICLOUD_TRANSIENT_RETRY_DELAY_MS = 1200;
const ICLOUD_PROVIDER = 'icloud';
const GMAIL_PROVIDER = 'gmail';
const GMAIL_ALIAS_GENERATOR = 'gmail-alias';
const HOTMAIL_PROVIDER = 'hotmail-api';
const LUCKMAIL_PROVIDER = 'luckmail-api';
const CLOUDFLARE_TEMP_EMAIL_PROVIDER = 'cloudflare-temp-email';
const CLOUDFLARE_TEMP_EMAIL_GENERATOR = 'cloudflare-temp-email';
const CLOUD_MAIL_PROVIDER = 'cloudmail';
const CLOUD_MAIL_GENERATOR = 'cloudmail';
const ICLOUD_API_PROVIDER = 'icloudapi';
const CUSTOM_EMAIL_POOL_GENERATOR = 'custom-pool';
const HOTMAIL_MAILBOXES = ['INBOX', 'Junk'];
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX = 'CF_SECURITY_BLOCKED::';
const CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE = '您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器';
const BROWSER_SWITCH_REQUIRED_ERROR_PREFIX = 'BROWSER_SWITCH_REQUIRED::';
const AUTH_HTTP_500_RELOGIN_CURRENT_ACCOUNT_ERROR_PREFIX = 'AUTH_HTTP_500_RELOGIN_CURRENT_ACCOUNT::';
const EXTERNAL_REDEEM_QUALIFIED_FAILURE_ERROR_PREFIX = 'EXTERNAL_REDEEM_QUALIFIED_FAILED::';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const STEP6_MAX_ATTEMPTS = 3;
const STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS = 8;
const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const SUB2API_STEP1_RESPONSE_TIMEOUT_MS = 90000;
const SUB2API_STEP9_RESPONSE_TIMEOUT_MS = 120000;
const DEFAULT_SUB2API_URL = '';
const DEFAULT_CODEX2API_URL = 'http://localhost:8080/admin/accounts';
const DEFAULT_SUB2API_GROUP_NAME = 'codex';
const DEFAULT_SUB2API_PROXY_NAME = '';
const DEFAULT_SUB2API_ACCOUNT_PRIORITY = 1;
const DEFAULT_PANEL_MODE = 'checkout-conversion';
const CONTRIBUTION_SOURCE_CPA = 'cpa';
const CONTRIBUTION_SOURCE_SUB2API = 'sub2api';
const CONTRIBUTION_SUB2API_DEFAULT_GROUP_NAME = 'codex号池';
const CONTRIBUTION_SUB2API_PLUS_GROUP_NAME = 'openai-plus';
const DEFAULT_SUB2API_GROUP_NAMES = [
  DEFAULT_SUB2API_GROUP_NAME,
  CONTRIBUTION_SUB2API_PLUS_GROUP_NAME,
];
const DEFAULT_SUB2API_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const DEFAULT_IP_PROXY_SERVICE = '711proxy';
const IP_PROXY_SERVICE_VALUES = ['711proxy', 'lumiproxy', 'iproyal', 'omegaproxy'];
const IP_PROXY_ENABLED_SERVICE_VALUES = ['711proxy'];
const DEFAULT_IP_PROXY_MODE = 'account';
const IP_PROXY_MODE_VALUES = ['api', 'account'];
const DEFAULT_IP_PROXY_PROTOCOL = 'http';
const IP_PROXY_PROTOCOL_VALUES = ['http', 'https', 'socks4', 'socks5'];
const IP_PROXY_FETCH_TIMEOUT_MS = 20000;
const IP_PROXY_SETTINGS_SCOPE = 'regular';
const IP_PROXY_BYPASS_LIST = [
  '<local>',
  'localhost',
  '127.0.0.1',
  'assurivo.com',
  '*.assurivo.com',
  'icloudapi.xyz',
  '*.icloudapi.xyz',
];
const IP_PROXY_ROUTE_ALL_TRAFFIC = true;
const IP_PROXY_FORCE_DIRECT_HOST_PATTERNS = [
  'pm-redirects.stripe.com',
  '*.pm-redirects.stripe.com',
  'hwork.pro',
  '*.hwork.pro',
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.openai.com',
  'luckyous.com',
  '*.luckyous.com',
];
const IP_PROXY_FORCE_DIRECT_FALLBACK = 'PROXY 127.0.0.1:7897';
const IP_PROXY_ACCOUNT_LIST_ENABLED = false;
const IP_PROXY_INIT_ENABLE_EXIT_PROBE = false;
const IP_PROXY_INIT_SUPPRESS_AUTH_REBIND = true;
const IP_PROXY_INIT_AUTO_APPLY = false;
const LEGACY_IP_PROXY_FEATURE_ENABLED = false;
const IP_PROXY_TARGET_HOST_PATTERNS = [
  'openai.com',
  '*.openai.com',
  'chatgpt.com',
  '*.chatgpt.com',
  'ipwho.is',
  '*.ipwho.is',
  'ipapi.co',
  '*.ipapi.co',
  'ipinfo.io',
  '*.ipinfo.io',
  'api.ipify.org',
  'api64.ipify.org',
  'api.ip.cc',
  'ifconfig.me',
  'checkip.amazonaws.com',
  'ipv4.icanhazip.com',
  'ident.me',
  'httpbin.org',
  'ip-api.com',
  'myip.ipip.net',
];
const AUTO_RUN_TIMER_ALARM_NAME = 'auto-run-timer';
const IP_PROXY_AUTO_SYNC_ALARM_NAME = 'ip-proxy-auto-sync';
const EXTERNAL_REDEEM_MONITOR_ALARM_NAME = 'external-redeem-monitor';
const AUTO_RUN_TIMER_KIND_SCHEDULED_START = 'scheduled_start';
const AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS = 'between_rounds';
const AUTO_RUN_TIMER_KIND_BEFORE_RETRY = 'before_retry';
const EXTERNAL_REDEEM_DEFAULT_BASE_URL = 'https://chong.nerver.cc';
const EXTERNAL_REDEEM_LOCAL_PROXY_URL = 'http://127.0.0.1:18789/external-redeem';
const EXTERNAL_REDEEM_LOCAL_RECORDS_URL = 'http://127.0.0.1:18789/redeem-records';
const SHAYU_LEDGER_RECORDS_URL = 'https://api.herobb.org/shayu/api/records';
const SHAYU_LEDGER_SOURCE = 'GuJumpgate iCloud API';
const TAOBAO_FEED_API_URL = 'https://assurivo.com/console/feed.php';
const CHATGPT_TOTP_ENABLE_URL = 'https://cha.nerver.cc/api/v1/totp/enable';
const CHATGPT_TOTP_LOOKUP_URL = 'https://cha.nerver.cc/api/v1/totp/lookup';
const EXTERNAL_REDEEM_DEFAULT_POLL_SECONDS = 30;
const EXTERNAL_REDEEM_MIN_POLL_SECONDS = 30;
const EXTERNAL_REDEEM_MAX_POLL_SECONDS = 300;
const EXTERNAL_REDEEM_MAX_BATCH_SIZE = 100;
const EXTERNAL_REDEEM_FETCH_TIMEOUT_MS = 30000;
const EXTERNAL_REDEEM_TERMINAL_STATUSES = new Set([
  'success',
  'failed',
  'timeout',
  'cancelled',
  'rejected',
  'not_found',
  'submit_failed',
]);
const IP_PROXY_AUTO_SYNC_INTERVAL_MIN_MINUTES = 1;
const IP_PROXY_AUTO_SYNC_INTERVAL_MAX_MINUTES = 1440;
const IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES = 15;
const AUTO_RUN_DELAY_MIN_MINUTES = 1;
const AUTO_RUN_DELAY_MAX_MINUTES = 1440;
const AUTO_RUN_RETRY_DELAY_MS = 3000;
const AUTO_RUN_MAX_RETRIES_PER_ROUND = 3;
const AUTO_STEP_DELAY_MIN_ALLOWED_SECONDS = 0;
const AUTO_STEP_DELAY_MAX_ALLOWED_SECONDS = 600;
const OUTLOOK_ALIAS_DEFAULT_MAX_PER_ACCOUNT = 5;
const OUTLOOK_ALIAS_MAX_PER_ACCOUNT_LIMIT = 50;
const OUTLOOK_SUBSCRIPTION_USED_KEYWORD = 'ChatGPT Plus Subscription';
const VERIFICATION_RESEND_COUNT_MIN = 0;
const VERIFICATION_RESEND_COUNT_MAX = 20;
const DEFAULT_VERIFICATION_RESEND_COUNT = 4;
const PHONE_REPLACEMENT_LIMIT_MIN = 1;
const PHONE_REPLACEMENT_LIMIT_MAX = 20;
const DEFAULT_PHONE_VERIFICATION_REPLACEMENT_LIMIT = 3;
const PHONE_CODE_WAIT_SECONDS_MIN = 15;
const PHONE_CODE_WAIT_SECONDS_MAX = 300;
const DEFAULT_PHONE_CODE_WAIT_SECONDS = 60;
const PHONE_CODE_TIMEOUT_WINDOWS_MIN = 1;
const PHONE_CODE_TIMEOUT_WINDOWS_MAX = 10;
const DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS = 2;
const PHONE_CODE_POLL_INTERVAL_SECONDS_MIN = 1;
const PHONE_CODE_POLL_INTERVAL_SECONDS_MAX = 30;
const DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS = 5;
const PHONE_CODE_POLL_ROUNDS_MIN = 1;
const PHONE_CODE_POLL_ROUNDS_MAX = 120;
const DEFAULT_PHONE_CODE_POLL_ROUNDS = 4;
const LEGACY_AUTO_STEP_DELAY_KEYS = ['autoStepRandomDelayMinSeconds', 'autoStepRandomDelayMaxSeconds'];
const LEGACY_VERIFICATION_RESEND_COUNT_KEYS = ['signupVerificationResendCount', 'loginVerificationResendCount'];
const DEFAULT_LOCAL_CPA_STEP9_MODE = 'submit';
const MAIL_2925_MODE_PROVIDE = 'provide';
const MAIL_2925_MODE_RECEIVE = 'receive';
const DEFAULT_MAIL_2925_MODE = MAIL_2925_MODE_PROVIDE;
const CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_RECEIVE_MAILBOX = 'receive-mailbox';
const CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL = 'registration-email';
const DEFAULT_CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE = CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_RECEIVE_MAILBOX;
const HOTMAIL_SERVICE_MODE_REMOTE = 'remote';
const HOTMAIL_SERVICE_MODE_LOCAL = 'local';
const DEFAULT_HOTMAIL_REMOTE_BASE_URL = '';
const DEFAULT_HOTMAIL_LOCAL_BASE_URL = 'http://127.0.0.1:17373';
const DEFAULT_ACCOUNT_RUN_HISTORY_HELPER_BASE_URL = DEFAULT_HOTMAIL_LOCAL_BASE_URL;
const DEFAULT_LOCAL_CPA_JSON_RELATIVE_AUTH_DIR = '.cli-proxy-api';
const HOTMAIL_LOCAL_HELPER_TIMEOUT_MS = 45000;
const DEFAULT_LUCKMAIL_PROJECT_CODE = 'openai';
const DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
const HERO_SMS_SERVICE_CODE = 'dr';
const HERO_SMS_SERVICE_LABEL = 'OpenAI';
const HERO_SMS_COUNTRY_ID = 52;
const HERO_SMS_COUNTRY_LABEL = 'Thailand';
const PHONE_SMS_PROVIDER_HERO = 'hero-sms';
const PHONE_SMS_PROVIDER_5SIM = '5sim';
const PHONE_SMS_PROVIDER_HERO_SMS = PHONE_SMS_PROVIDER_HERO;
const PHONE_SMS_PROVIDER_FIVE_SIM = PHONE_SMS_PROVIDER_5SIM;
const PHONE_SMS_PROVIDER_NEXSMS = 'nexsms';
const DEFAULT_PHONE_SMS_PROVIDER = PHONE_SMS_PROVIDER_HERO;
const DEFAULT_PHONE_SMS_PROVIDER_ORDER = Object.freeze([
  PHONE_SMS_PROVIDER_HERO,
  PHONE_SMS_PROVIDER_5SIM,
  PHONE_SMS_PROVIDER_NEXSMS,
]);
const DEFAULT_FIVE_SIM_BASE_URL = 'https://5sim.net/v1';
const DEFAULT_FIVE_SIM_PRODUCT = 'openai';
const DEFAULT_FIVE_SIM_OPERATOR = 'any';
const DEFAULT_FIVE_SIM_COUNTRY_ORDER = Object.freeze(['thailand']);
const DEFAULT_NEX_SMS_BASE_URL = 'https://api.nexsms.net';
const DEFAULT_NEX_SMS_SERVICE_CODE = 'ot';
const DEFAULT_NEX_SMS_COUNTRY_ORDER = Object.freeze([1]);
const DEFAULT_HERO_SMS_REUSE_ENABLED = true;
const HERO_SMS_ACQUIRE_PRIORITY_COUNTRY = 'country';
const HERO_SMS_ACQUIRE_PRIORITY_PRICE = 'price';
const HERO_SMS_ACQUIRE_PRIORITY_PRICE_HIGH = 'price_high';
const DEFAULT_HERO_SMS_ACQUIRE_PRIORITY = HERO_SMS_ACQUIRE_PRIORITY_COUNTRY;
const FIVE_SIM_COUNTRY_ID = 'vietnam';
const FIVE_SIM_COUNTRY_LABEL = '越南 (Vietnam)';
const FIVE_SIM_SUPPORTED_COUNTRY_IDS = ['indonesia', 'thailand', 'vietnam'];
const FIVE_SIM_SUPPORTED_COUNTRY_ID_SET = new Set(FIVE_SIM_SUPPORTED_COUNTRY_IDS);
const HERO_SMS_SUPPORTED_COUNTRY_IDS = [6, 52, 187, 16, 151, 43, 73, 10];
const HERO_SMS_SUPPORTED_COUNTRY_ID_SET = new Set(HERO_SMS_SUPPORTED_COUNTRY_IDS.map(String));
const HERO_SMS_COUNTRY_BY_PHONE_PREFIX = Object.freeze([
  { prefix: '84', id: 10, label: 'Vietnam' },
  { prefix: '66', id: 52, label: 'Thailand' },
  { prefix: '62', id: 6, label: 'Indonesia' },
  { prefix: '44', id: 16, label: 'United Kingdom' },
  { prefix: '81', id: 151, label: 'Japan' },
  { prefix: '49', id: 43, label: 'Germany' },
  { prefix: '33', id: 73, label: 'France' },
  { prefix: '1', id: 187, label: 'USA' },
]);
const FIVE_SIM_OPERATOR = DEFAULT_FIVE_SIM_OPERATOR;
const DEFAULT_PLUS_PAYMENT_METHOD = PLUS_PAYMENT_METHOD_CHECKOUT_CONVERSION;
const DEFAULT_ICLOUD_API_EMAIL = 'chortle_palmate.3c@icloud.com';
const DEFAULT_ICLOUD_API_VERIFICATION_URL = 'http://icloudapi.xyz/show/AhobCgIfCgYMBBdfSERSIxsGGAQQHUMaHAhZExcDD0gQARwBSBoTCwNGDAoBEw==/chortle_palmate.3c@icloud.com';
const ICLOUD_API_MODE_NORMAL = 'normal';
const ICLOUD_API_MODE_TAOBAO = 'taobao';
const ICLOUD_API_MODE_HOTMAIL = 'hotmail';
const ICLOUD_API_MODE_OUTLOOK_API = 'outlook-api';
const OUTLOOK_API_BASE_URL = 'http://query.paopaodw.com/boobar?email=';
const DEFAULT_ICLOUD_API_EMAIL_POOL_ENTRY = Object.freeze({
  id: 'icloudapi-default-chortle-palmate-3c',
  email: DEFAULT_ICLOUD_API_EMAIL,
  enabled: true,
  used: false,
  note: 'iCloud API',
  apiMode: ICLOUD_API_MODE_NORMAL,
  queryCode: '',
  verificationUrl: DEFAULT_ICLOUD_API_VERIFICATION_URL,
  lastUsedAt: 0,
});
const DISPLAY_TIMEZONE = 'Asia/Shanghai';
const MICROSOFT_TOKEN_DNR_RULE_ID = 1001;
const EXTERNAL_REDEEM_CORS_DNR_RULE_ID = 1002;
const PERSISTENT_ALIAS_STATE_KEYS = [
  'manualAliasUsage',
  'preservedAliases',
  'icloudAliasCache',
  'icloudAliasCacheAt',
];
const ACCOUNT_RUN_HISTORY_STORAGE_KEY = 'accountRunHistory';
const SIGNUP_METHOD_EMAIL = 'email';
const SIGNUP_METHOD_PHONE = 'phone';
const DEFAULT_SIGNUP_METHOD = SIGNUP_METHOD_EMAIL;
const CONTRIBUTION_RUNTIME_DEFAULTS = self.MultiPageBackgroundContributionOAuth?.RUNTIME_DEFAULTS || {
  contributionMode: false,
  contributionModeExpected: false,
  contributionSource: CONTRIBUTION_SOURCE_SUB2API,
  contributionTargetGroupName: CONTRIBUTION_SUB2API_DEFAULT_GROUP_NAME,
  contributionNickname: '',
  contributionQq: '',
  contributionSessionId: '',
  contributionAuthUrl: '',
  contributionAuthState: '',
  contributionCallbackUrl: '',
  contributionStatus: '',
  contributionStatusMessage: '',
  contributionLastPollAt: 0,
  contributionCallbackStatus: 'idle',
  contributionCallbackMessage: '',
  contributionAuthOpenedAt: 0,
  contributionAuthTabId: 0,
};
const CONTRIBUTION_RUNTIME_KEYS = self.MultiPageBackgroundContributionOAuth?.RUNTIME_KEYS
  || Object.keys(CONTRIBUTION_RUNTIME_DEFAULTS);

function isPlusModeState(state = {}) {
  return Boolean(state?.plusModeEnabled);
}

function normalizePlusPaymentMethod(value = '') {
  return PLUS_PAYMENT_METHOD_CHECKOUT_CONVERSION;
}

function normalizeGpcHelperPhoneMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'auto' || normalized === 'builtin' ? 'auto' : 'manual';
}

function normalizeContributionModeSource(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === CONTRIBUTION_SOURCE_SUB2API
    ? CONTRIBUTION_SOURCE_SUB2API
    : CONTRIBUTION_SOURCE_CPA;
}

function resolveContributionModeRoutingState(state = {}) {
  const currentStatus = String(state?.contributionStatus || '').trim().toLowerCase();
  const currentSource = normalizeContributionModeSource(state?.contributionSource);
  const hasActiveSession = Boolean(
    String(state?.contributionSessionId || '').trim()
    && currentStatus
    && !['auto_approved', 'auto_rejected', 'expired', 'error'].includes(currentStatus)
  );

  if (hasActiveSession) {
    return {
      source: currentSource,
      targetGroupName: currentSource === CONTRIBUTION_SOURCE_SUB2API
        ? (String(state?.contributionTargetGroupName || '').trim() || CONTRIBUTION_SUB2API_DEFAULT_GROUP_NAME)
        : '',
    };
  }

  const source = CONTRIBUTION_SOURCE_SUB2API;
  return {
    source,
    targetGroupName: isPlusModeState(state)
      ? CONTRIBUTION_SUB2API_PLUS_GROUP_NAME
      : (String(state?.contributionTargetGroupName || '').trim() || CONTRIBUTION_SUB2API_DEFAULT_GROUP_NAME),
  };
}

function getSignupMethodForStepDefinitions(state = {}) {
  return normalizeSignupMethod(state?.resolvedSignupMethod || state?.signupMethod);
}

function getStepDefinitionsForState(state = {}) {
  const activeFlowId = String(state?.activeFlowId || '').trim().toLowerCase();
  if (activeFlowId && activeFlowId !== DEFAULT_ACTIVE_FLOW_ID) {
    return [];
  }
  if (state?.k12WorkspaceRunActive) {
    return K12_WORKSPACE_STEP_DEFINITIONS;
  }
  return SLIM_STEP_DEFINITIONS;
}

function getStepIdsForState(state = {}) {
  const definitions = getStepDefinitionsForState(state);
  if (Array.isArray(definitions) && definitions.length) {
    return definitions
      .map((definition) => Number(definition?.id))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
  }
  return NORMAL_STEP_IDS;
}

function getLastStepIdForState(state = {}) {
  const ids = getStepIdsForState(state);
  if (ids.length) {
    return ids[ids.length - 1];
  }
  return String(state?.activeFlowId || '').trim().toLowerCase() === DEFAULT_ACTIVE_FLOW_ID ? 10 : 0;
}

function getAuthChainStartStepId(state = {}) {
  const authStepId = typeof getStepIdByKeyForState === 'function'
    ? getStepIdByKeyForState('oauth-login', state)
    : null;
  if (Number.isInteger(authStepId) && authStepId > 0) {
    return authStepId;
  }
  return isPlusModeState(state) ? 10 : FINAL_OAUTH_CHAIN_START_STEP;
}

function getStepDefinitionForState(step, state = {}) {
  const numericStep = Number(step);
  return getStepDefinitionsForState(state).find((definition) => Number(definition.id) === numericStep) || null;
}

function getStepIdByKeyForState(stepKey, state = {}) {
  const normalizedKey = String(stepKey || '').trim();
  if (!normalizedKey) return null;
  const ids = getStepIdsForState(state);
  for (const id of ids) {
    if (String(getStepDefinitionForState(id, state)?.key || '').trim() === normalizedKey) {
      return Number(id);
    }
  }
  return null;
}

function getNodeDefinitionsForState(state = {}) {
  return getStepDefinitionsForState(state)
    .map((definition) => ({
      legacyStepId: Number(definition?.id),
      nodeId: String(definition?.key || '').trim(),
      displayOrder: Number.isFinite(Number(definition?.order)) ? Number(definition.order) : Number(definition?.id),
      title: String(definition?.title || '').trim(),
      executeKey: String(definition?.key || '').trim(),
    }))
    .filter((definition) => definition.nodeId);
}

function getNodeIdsForState(state = {}) {
  return getNodeDefinitionsForState(state).map((definition) => definition.nodeId).filter(Boolean);
}

function getNodeDefinitionForState(nodeId, state = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return null;
  return getNodeDefinitionsForState(state).find((definition) => definition.nodeId === normalizedNodeId) || null;
}

function getLastNodeIdForState(state = {}) {
  const nodeIds = getNodeIdsForState(state);
  return nodeIds[nodeIds.length - 1] || '';
}

function getNodeIdByStepForState(step, state = {}) {
  const definition = getStepDefinitionForState(step, state);
  return String(definition?.key || '').trim();
}

function getStepIdByNodeIdForState(nodeId, state = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return null;
  const node = getNodeDefinitionForState(normalizedNodeId, state);
  const legacyStepId = Number(node?.legacyStepId);
  if (Number.isInteger(legacyStepId) && legacyStepId > 0) {
    return legacyStepId;
  }
  return getStepIdByKeyForState(normalizedNodeId, state);
}

function getNodeTitleForState(nodeId, state = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return '';
  return getNodeDefinitionForState(normalizedNodeId, state)?.title || normalizedNodeId;
}

initializeSessionStorageAccess();
setupDeclarativeNetRequestRules();

function setupDeclarativeNetRequestRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return;
  }

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [
      MICROSOFT_TOKEN_DNR_RULE_ID,
      EXTERNAL_REDEEM_CORS_DNR_RULE_ID,
    ],
    addRules: [
      {
        id: MICROSOFT_TOKEN_DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: 'login.microsoftonline.com/*/oauth2/v2.0/token',
          resourceTypes: ['xmlhttprequest'],
        },
      },
      {
        id: EXTERNAL_REDEEM_CORS_DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '|https://chong.nerver.cc/api/external/',
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ],
  }).catch((error) => {
    console.warn(LOG_PREFIX, 'Failed to setup declarativeNetRequest rules:', error?.message || error);
  });
}

// ============================================================
// 状态管理（chrome.storage.session + chrome.storage.local）
// ============================================================

const PERSISTED_SETTING_DEFAULTS = {
  panelMode: DEFAULT_PANEL_MODE,
  localCpaJsonPluginDir: '',
  localCpaJsonRelativeAuthDir: DEFAULT_LOCAL_CPA_JSON_RELATIVE_AUTH_DIR,
  vpsUrl: '',
  vpsPassword: '',
  localCpaStep9Mode: DEFAULT_LOCAL_CPA_STEP9_MODE,
  sub2apiUrl: DEFAULT_SUB2API_URL,
  sub2apiEmail: '',
  sub2apiPassword: '',
  sub2apiGroupName: DEFAULT_SUB2API_GROUP_NAME,
  sub2apiGroupNames: DEFAULT_SUB2API_GROUP_NAMES,
  sub2apiAccountPriority: DEFAULT_SUB2API_ACCOUNT_PRIORITY,
  sub2apiDefaultProxyName: DEFAULT_SUB2API_PROXY_NAME,
  ipProxyEnabled: false,
  ipProxyService: DEFAULT_IP_PROXY_SERVICE,
  ipProxyMode: DEFAULT_IP_PROXY_MODE,
  ipProxyApiUrl: '',
  ipProxyServiceProfiles: {},
  ipProxyAccountList: '',
  ipProxyAccountSessionPrefix: '',
  ipProxyAccountLifeMinutes: '',
  ipProxyPoolTargetCount: '20',
  ipProxyAutoSyncEnabled: false,
  ipProxyAutoSyncIntervalMinutes: IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES,
  ipProxyHost: '',
  ipProxyPort: '',
  ipProxyProtocol: DEFAULT_IP_PROXY_PROTOCOL,
  ipProxyUsername: '',
  ipProxyPassword: '',
  ipProxyRegion: '',
  customPassword: '',
  plusModeEnabled: true,
  plusPaymentMethod: DEFAULT_PLUS_PAYMENT_METHOD,
  plusAccountAccessStrategy: PLUS_ACCOUNT_ACCESS_STRATEGY_OAUTH,
  plusCheckoutConversionProxyUrl: '',
  plusCheckoutConversionProxyPoolText: '',
  plusCheckoutConversionProxyPoolIndex: 0,
  externalRedeemEnabled: false,
  externalRedeemBaseUrl: EXTERNAL_REDEEM_DEFAULT_BASE_URL,
  externalRedeemApiKey: '',
  externalRedeemCdkeyPoolText: '',
  externalRedeemPollSeconds: EXTERNAL_REDEEM_DEFAULT_POLL_SECONDS,
  chatgptTotpAutoEnable: false,
  chatgptTotpOptionalMigrationVersion: 1,
  k12WorkspaceId: self.GuJumpgateK12Workspace?.DEFAULT_WORKSPACE_ID || '631e1603-06cf-4f0b-b79b-d09fbfcfe98d',
  k12IcloudApiMode: ICLOUD_API_MODE_NORMAL,
  k12EmailPoolText: '',
  k12EmailPoolEntries: [],
  multiThreadEnabled: false,
  multiThreadCount: 1,
  multiThreadProfileRunnerUrl: 'http://127.0.0.1:18792',
  feishuSyncEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBitableAppToken: '',
  feishuBitableTableId: '',
  autoRunSkipFailures: false,
  autoRunFallbackThreadIntervalMinutes: 0,
  oauthFlowTimeoutEnabled: true,
  autoRunDelayEnabled: false,
  operationDelayEnabled: true,
  autoRunDelayMinutes: 30,
  autoStepDelaySeconds: null,
  step6CookieCleanupEnabled: false,
  phoneVerificationEnabled: false,
  phoneSignupReloginAfterBindEmailEnabled: false,
  phoneSmsReuseEnabled: DEFAULT_HERO_SMS_REUSE_ENABLED,
  freePhoneReuseEnabled: true,
  freePhoneReuseAutoEnabled: true,
  signupMethod: DEFAULT_SIGNUP_METHOD,
  phoneSmsProvider: DEFAULT_PHONE_SMS_PROVIDER,
  phoneSmsProviderOrder: [],
  verificationResendCount: DEFAULT_VERIFICATION_RESEND_COUNT,
  phoneVerificationReplacementLimit: DEFAULT_PHONE_VERIFICATION_REPLACEMENT_LIMIT,
  phoneCodeWaitSeconds: DEFAULT_PHONE_CODE_WAIT_SECONDS,
  phoneCodeTimeoutWindows: DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS,
  phoneCodePollIntervalSeconds: DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS,
  phoneCodePollMaxRounds: DEFAULT_PHONE_CODE_POLL_ROUNDS,
  mailProvider: ICLOUD_API_PROVIDER,
  mail2925Mode: DEFAULT_MAIL_2925_MODE,
  mail2925UseAccountPool: false,
  emailGenerator: CUSTOM_EMAIL_POOL_GENERATOR,
  customMailProviderPool: [],
  customEmailPool: [DEFAULT_ICLOUD_API_EMAIL],
  customEmailPoolEntries: [{ ...DEFAULT_ICLOUD_API_EMAIL_POOL_ENTRY }],
  autoDeleteUsedIcloudAlias: false,
  icloudHostPreference: 'auto',
  icloudTargetMailboxType: 'icloud-inbox',
  icloudForwardMailProvider: 'qq',
  icloudFetchMode: 'reuse_existing',
  accountRunHistoryTextEnabled: true,
  accountRunHistoryHelperBaseUrl: DEFAULT_ACCOUNT_RUN_HISTORY_HELPER_BASE_URL,
  gmailBaseEmail: '',
  mail2925BaseEmail: '',
  currentMail2925AccountId: '',
  emailPrefix: '',
  inbucketHost: '',
  inbucketMailbox: '',
  hotmailServiceMode: HOTMAIL_SERVICE_MODE_LOCAL,
  hotmailRemoteBaseUrl: DEFAULT_HOTMAIL_REMOTE_BASE_URL,
  hotmailLocalBaseUrl: DEFAULT_HOTMAIL_LOCAL_BASE_URL,
  luckmailApiKey: '',
  luckmailBaseUrl: DEFAULT_LUCKMAIL_BASE_URL,
  luckmailEmailType: DEFAULT_LUCKMAIL_EMAIL_TYPE,
  luckmailDomain: '',
  luckmailUsedPurchases: {},
  luckmailPreserveTagId: 0,
  luckmailPreserveTagName: DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  cloudflareDomain: '',
  cloudflareDomains: [],
  cloudflareTempEmailBaseUrl: '',
  cloudflareTempEmailAdminAuth: '',
  cloudflareTempEmailCustomAuth: '',
  cloudflareTempEmailLookupMode: DEFAULT_CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE,
  cloudflareTempEmailReceiveMailbox: '',
  cloudflareTempEmailUseRandomSubdomain: false,
  cloudflareTempEmailDomain: '',
  cloudflareTempEmailDomains: [],
  cloudMailBaseUrl: '',
  cloudMailAdminEmail: '',
  cloudMailAdminPassword: '',
  cloudMailToken: '',
  cloudMailReceiveMailbox: '',
  cloudMailDomain: '',
  cloudMailDomains: [],
  icloudApiMode: ICLOUD_API_MODE_NORMAL,
  icloudApiVerificationUrl: '',
  hotmailAccounts: [],
  hotmailAliasEnabled: false,
  outlookAliasMaxPerAccount: OUTLOOK_ALIAS_DEFAULT_MAX_PER_ACCOUNT,
  hotmailAliasUsage: {},
  mail2925Accounts: [],
  phoneSmsProvider: DEFAULT_PHONE_SMS_PROVIDER,
  heroSmsApiKey: '',
  heroSmsReuseEnabled: DEFAULT_HERO_SMS_REUSE_ENABLED,
  heroSmsAcquirePriority: DEFAULT_HERO_SMS_ACQUIRE_PRIORITY,
  heroSmsMinPrice: '',
  heroSmsMaxPrice: '',
  heroSmsPreferredPrice: '',
  heroSmsCountryId: HERO_SMS_COUNTRY_ID,
  heroSmsCountryLabel: HERO_SMS_COUNTRY_LABEL,
  heroSmsCountryFallback: [],
  fiveSimApiKey: '',
  fiveSimProduct: DEFAULT_FIVE_SIM_PRODUCT,
  fiveSimCountryId: FIVE_SIM_COUNTRY_ID,
  fiveSimCountryLabel: FIVE_SIM_COUNTRY_LABEL,
  fiveSimCountryFallback: [],
  fiveSimCountryOrder: [...DEFAULT_FIVE_SIM_COUNTRY_ORDER],
  fiveSimMinPrice: '',
  fiveSimMaxPrice: '',
  fiveSimOperator: FIVE_SIM_OPERATOR,
  nexSmsApiKey: '',
  nexSmsCountryOrder: [...DEFAULT_NEX_SMS_COUNTRY_ORDER],
  nexSmsServiceCode: DEFAULT_NEX_SMS_SERVICE_CODE,
  phonePreferredActivation: null,
};

const PERSISTED_SETTING_KEYS = Object.keys(PERSISTED_SETTING_DEFAULTS);
const CHATGPT_TOTP_OPTIONAL_MIGRATION_VERSION = 1;
const SETTINGS_EXPORT_SCHEMA_VERSION = 1;
const SETTINGS_EXPORT_FILENAME_PREFIX = 'multipage-settings';
const STEP6_REGISTRATION_SUCCESS_WAIT_MS = 4000;

const DEFAULT_STATE = {
  flowId: DEFAULT_ACTIVE_FLOW_ID,
  runId: '',
  activeFlowId: DEFAULT_ACTIVE_FLOW_ID,
  activeRunId: '',
  currentNodeId: '',
  nodeStatuses: { ...DEFAULT_NODE_STATUSES },
  runtimeState: runtimeStateHelpers?.buildDefaultRuntimeState?.() || null,
  ...CONTRIBUTION_RUNTIME_DEFAULTS,
  oauthUrl: null, // 运行时抓取到的 OAuth 地址，不要手动预填。
  resolvedSignupMethod: null, // 当前自动轮次冻结后的实际注册方式。
  accountIdentifierType: null,
  accountIdentifier: '',
  registrationEmailState: { ...DEFAULT_REGISTRATION_EMAIL_STATE },
  email: null, // 运行时邮箱，由程序自动获取并写入，不能手动预填。
  password: null, // 运行时实际密码，由 customPassword 或程序自动生成后写入。
  accounts: [], // 已生成账号记录：{ email, password, createdAt }。
  accountRunHistory: [], // 账号运行历史快照，实际持久化在 chrome.storage.local。
  manualAliasUsage: {},
  preservedAliases: {},
  icloudAliasCache: [],
  icloudAliasCacheAt: 0,
  lastEmailTimestamp: null, // 最近一次获取到邮箱数据的运行时时间戳。
  lastSignupCode: null, // 注册验证码，运行时由程序自动读取并写入。
  lastLoginCode: null, // 登录验证码，运行时由程序自动读取并写入。
  localhostUrl: null, // 运行时捕获到的 localhost 回调地址，不要手动预填。
  plusCheckoutTabId: null, // Plus checkout 标签页 ID。
  automationWindowId: null, // 当前任务锁定的浏览器窗口 ID，避免新标签页跑到其它窗口。
  plusCheckoutUrl: null, // Plus checkout 运行时短链，不写入持久配置。
  plusCheckoutCountry: 'DE',
  plusCheckoutCurrency: 'EUR',
  plusCheckoutSource: '',
  plusBillingCountryText: '',
  plusBillingAddress: null,
  plusReturnUrl: '',
  plusManualConfirmationPending: false,
  plusManualConfirmationRequestId: '',
  plusManualConfirmationStep: 0,
  plusManualConfirmationMethod: '',
  plusManualConfirmationTitle: '',
  plusManualConfirmationMessage: '',
  skipOpenChatgptCookieCleanupOnce: false,
  preserveOpenChatgptCookiesOnce: false,
  flowStartTime: null, // 当前流程开始时间。
  tabRegistry: {}, // 程序维护的标签页注册表。
  sourceLastUrls: {}, // 各来源页面最近一次打开的地址记录。
  logs: [], // 侧边栏展示的运行日志。
  ...PERSISTED_SETTING_DEFAULTS, // 合并 chrome.storage.local 中持久化保存的用户配置。
  ipProxyApiPool: [],
  ipProxyApiCurrentIndex: 0,
  ipProxyApiCurrent: null,
  ipProxyAccountPool: [],
  ipProxyAccountCurrentIndex: 0,
  ipProxyAccountCurrent: null,
  ipProxyPool: [],
  ipProxyCurrentIndex: 0,
  ipProxyCurrent: null,
  luckmailApiKey: '',
  luckmailBaseUrl: DEFAULT_LUCKMAIL_BASE_URL,
  luckmailEmailType: DEFAULT_LUCKMAIL_EMAIL_TYPE,
  luckmailDomain: '',
  luckmailUsedPurchases: {},
  luckmailPreserveTagId: 0,
  luckmailPreserveTagName: DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  currentLuckmailPurchase: null,
  currentLuckmailMailCursor: null,
  currentPhoneActivation: null,
  phoneNumber: '',
  currentPhoneVerificationCode: '',
  currentPhoneVerificationCountdownEndsAt: 0,
  currentPhoneVerificationCountdownWindowIndex: 0,
  currentPhoneVerificationCountdownWindowTotal: 0,
  reusablePhoneActivation: null,
  freeReusablePhoneActivation: null,
  phoneReusableActivationPool: [],
  signupPhoneNumber: '',
  signupPhoneActivation: null,
  signupPhoneCompletedActivation: null,
  signupPhoneVerificationRequestedAt: null,
  signupPhoneVerificationPurpose: '',
  heroSmsLastPriceTiers: [],
  heroSmsLastPriceCountryId: 0,
  heroSmsLastPriceCountryLabel: '',
  heroSmsLastPriceUserLimit: '',
  heroSmsLastPriceAt: 0,
  pendingPhoneActivationConfirmation: null,
  autoRunning: false, // 当前是否处于自动运行中。
  autoRunPhase: 'idle', // 当前自动运行阶段。
  autoRunCurrentRun: 0, // 自动运行当前执行到第几轮。
  autoRunTotalRuns: 1, // 自动运行计划总轮数。
  autoRunAttemptRun: 0, // 当前轮次的重试序号。
  autoRunSessionId: 0,
  autoRunRoundSummaries: [], // 自动运行轮次摘要。
  scheduledAutoRunAt: null, // 自动运行计划启动时间戳。
  autoRunTimerPlan: null, // 自动运行可恢复计时计划快照。
  autoRunCountdownAt: null,
  autoRunCountdownTitle: '',
  autoRunCountdownNote: '',
  signupVerificationRequestedAt: null,
  loginVerificationRequestedAt: null,
  chatgptAccessTokenInfo: null,
  chatgptAccessTokenCheck: null,
  chatgptAccessTokenRecords: {},
  chatgptAccessTokenHistory: [],
  chatgptTotpRecords: {},
  plusCheckoutConversionProxyPoolResults: [],
  externalRedeemQueue: [],
  externalRedeemLastSyncAt: 0,
  externalRedeemLastError: '',
  externalRedeemRecords: [],
  externalRedeemRecordsDbPath: '',
  externalRedeemRecordsLastSyncAt: 0,
  externalRedeemRecordsLastError: '',
  k12WorkspaceLastResult: null,
  k12WorkspaceHistory: [],
  k12WorkspaceLogs: [],
  k12WorkspaceAutoRunning: false,
  k12WorkspaceAutoStatus: 'idle',
  k12WorkspaceRunActive: false,
  k12WorkspaceAccessTokenDraft: '',
  k12WorkspaceAccessTokenUpdatedAt: 0,
  k12WorkspaceAutoLastEmail: '',
  k12WorkspaceAutoLastError: '',
  multiThreadMode: 'workbench',
  multiThreadRunnerUrl: '',
  multiThreadRunnerRunId: '',
  multiThreadPlans: [],
  multiThreadLogs: {},
  multiThreadLastUpdatedAt: 0,
  multiThreadLastError: '',
  feishuLastSyncAt: 0,
  feishuLastSyncEmail: '',
  feishuLastError: '',
  oauthFlowDeadlineAt: null,
  oauthFlowDeadlineSourceUrl: null,
  currentHotmailAccountId: null,
  currentMail2925AccountId: null,
  preferredIcloudHost: '',
  ipProxyApplied: false,
  ipProxyAppliedReason: 'disabled',
  ipProxyAppliedAt: 0,
  ipProxyAppliedHost: '',
  ipProxyAppliedPort: 0,
  ipProxyAppliedRegion: '',
  ipProxyAppliedHasAuth: false,
  ipProxyAppliedProvider: DEFAULT_IP_PROXY_SERVICE,
  ipProxyAppliedError: '',
  ipProxyAppliedWarning: '',
  ipProxyAppliedExitIp: '',
  ipProxyAppliedExitRegion: '',
  ipProxyAppliedExitDetecting: false,
  ipProxyAppliedExitError: '',
  ipProxyAppliedExitSource: '',
};

function normalizeAutoRunDelayMinutes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return PERSISTED_SETTING_DEFAULTS.autoRunDelayMinutes;
  }
  return Math.min(
    AUTO_RUN_DELAY_MAX_MINUTES,
    Math.max(AUTO_RUN_DELAY_MIN_MINUTES, Math.floor(numeric))
  );
}

function normalizeAutoRunFallbackThreadIntervalMinutes(value) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return 0;
  }

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.min(
    AUTO_RUN_DELAY_MAX_MINUTES,
    Math.max(0, Math.floor(numeric))
  );
}

function normalizeExternalRedeemBaseUrl(value = '') {
  const rawValue = String(value || '').trim() || EXTERNAL_REDEEM_DEFAULT_BASE_URL;
  try {
    const url = new URL(rawValue);
    if (!/^https?:$/i.test(url.protocol)) {
      return EXTERNAL_REDEEM_DEFAULT_BASE_URL;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return EXTERNAL_REDEEM_DEFAULT_BASE_URL;
  }
}

function normalizeExternalRedeemCdkey(value = '') {
  return String(value || '').trim();
}

function normalizeExternalRedeemCdkeyPoolText(value = '') {
  const seen = new Set();
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => normalizeExternalRedeemCdkey(line))
    .filter((line) => {
      if (!line || seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    })
    .join('\n');
}

function normalizeMultiThreadCount(value = 1) {
  const count = Math.floor(Number(value) || 1);
  return Math.max(1, Math.min(8, count));
}

function normalizeExternalRedeemPollSeconds(value) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) {
    return EXTERNAL_REDEEM_DEFAULT_POLL_SECONDS;
  }
  return Math.min(
    EXTERNAL_REDEEM_MAX_POLL_SECONDS,
    Math.max(EXTERNAL_REDEEM_MIN_POLL_SECONDS, numeric)
  );
}

function normalizeIpProxyAutoSyncIntervalMinutes(value, fallback = IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return Math.min(
      IP_PROXY_AUTO_SYNC_INTERVAL_MAX_MINUTES,
      Math.max(IP_PROXY_AUTO_SYNC_INTERVAL_MIN_MINUTES, Math.floor(Number(fallback) || IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES))
    );
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return Math.min(
      IP_PROXY_AUTO_SYNC_INTERVAL_MAX_MINUTES,
      Math.max(IP_PROXY_AUTO_SYNC_INTERVAL_MIN_MINUTES, Math.floor(Number(fallback) || IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES))
    );
  }
  return Math.min(
    IP_PROXY_AUTO_SYNC_INTERVAL_MAX_MINUTES,
    Math.max(IP_PROXY_AUTO_SYNC_INTERVAL_MIN_MINUTES, Math.floor(numeric))
  );
}

function normalizeAutoStepDelaySeconds(value, fallback = null) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return fallback;
  }

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(
    AUTO_STEP_DELAY_MAX_ALLOWED_SECONDS,
    Math.max(AUTO_STEP_DELAY_MIN_ALLOWED_SECONDS, Math.floor(numeric))
  );
}

function normalizeOutlookAliasMaxPerAccount(value, fallback = OUTLOOK_ALIAS_DEFAULT_MAX_PER_ACCOUNT) {
  const rawValue = String(value ?? '').trim();
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber)
    ? Math.min(OUTLOOK_ALIAS_MAX_PER_ACCOUNT_LIMIT, Math.max(1, Math.floor(fallbackNumber)))
    : OUTLOOK_ALIAS_DEFAULT_MAX_PER_ACCOUNT;
  if (!rawValue) {
    return normalizedFallback;
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return normalizedFallback;
  }
  return Math.min(OUTLOOK_ALIAS_MAX_PER_ACCOUNT_LIMIT, Math.max(1, Math.floor(numeric)));
}

function normalizeVerificationResendCount(value, fallback) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return fallback;
  }

  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(
    VERIFICATION_RESEND_COUNT_MAX,
    Math.max(VERIFICATION_RESEND_COUNT_MIN, Math.floor(numeric))
  );
}

function normalizePhoneVerificationReplacementLimit(value, fallback = DEFAULT_PHONE_VERIFICATION_REPLACEMENT_LIMIT) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isFinite(numeric)) {
    return Math.min(
      PHONE_REPLACEMENT_LIMIT_MAX,
      Math.max(PHONE_REPLACEMENT_LIMIT_MIN, Math.floor(Number(fallback) || DEFAULT_PHONE_VERIFICATION_REPLACEMENT_LIMIT))
    );
  }
  return Math.min(
    PHONE_REPLACEMENT_LIMIT_MAX,
    Math.max(PHONE_REPLACEMENT_LIMIT_MIN, Math.floor(numeric))
  );
}

function normalizePhoneCodeWaitSeconds(value, fallback = DEFAULT_PHONE_CODE_WAIT_SECONDS) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isFinite(numeric)) {
    return Math.min(
      PHONE_CODE_WAIT_SECONDS_MAX,
      Math.max(PHONE_CODE_WAIT_SECONDS_MIN, Math.floor(Number(fallback) || DEFAULT_PHONE_CODE_WAIT_SECONDS))
    );
  }
  return Math.min(
    PHONE_CODE_WAIT_SECONDS_MAX,
    Math.max(PHONE_CODE_WAIT_SECONDS_MIN, Math.floor(numeric))
  );
}

function normalizePhoneCodeTimeoutWindows(value, fallback = DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isFinite(numeric)) {
    return Math.min(
      PHONE_CODE_TIMEOUT_WINDOWS_MAX,
      Math.max(PHONE_CODE_TIMEOUT_WINDOWS_MIN, Math.floor(Number(fallback) || DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS))
    );
  }
  return Math.min(
    PHONE_CODE_TIMEOUT_WINDOWS_MAX,
    Math.max(PHONE_CODE_TIMEOUT_WINDOWS_MIN, Math.floor(numeric))
  );
}

function normalizePhoneCodePollIntervalSeconds(value, fallback = DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isFinite(numeric)) {
    return Math.min(
      PHONE_CODE_POLL_INTERVAL_SECONDS_MAX,
      Math.max(PHONE_CODE_POLL_INTERVAL_SECONDS_MIN, Math.floor(Number(fallback) || DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS))
    );
  }
  return Math.min(
    PHONE_CODE_POLL_INTERVAL_SECONDS_MAX,
    Math.max(PHONE_CODE_POLL_INTERVAL_SECONDS_MIN, Math.floor(numeric))
  );
}

function normalizePhoneCodePollMaxRounds(value, fallback = DEFAULT_PHONE_CODE_POLL_ROUNDS) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isFinite(numeric)) {
    return Math.min(
      PHONE_CODE_POLL_ROUNDS_MAX,
      Math.max(PHONE_CODE_POLL_ROUNDS_MIN, Math.floor(Number(fallback) || DEFAULT_PHONE_CODE_POLL_ROUNDS))
    );
  }
  return Math.min(
    PHONE_CODE_POLL_ROUNDS_MAX,
    Math.max(PHONE_CODE_POLL_ROUNDS_MIN, Math.floor(numeric))
  );
}

function normalizeBoundedIntegerSetting(value, fallback, min, max) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  const fallbackNumeric = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumeric)
    ? Math.min(max, Math.max(min, Math.floor(fallbackNumeric)))
    : min;
  if (!rawValue || !Number.isFinite(numeric)) {
    return normalizedFallback;
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeLocalHttpBaseUrl(value = '', fallback = 'http://127.0.0.1:18767') {
  const rawValue = String(value || fallback).trim();
  try {
    const parsed = new URL(rawValue);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return fallback;
    }
    const endpointPath = parsed.pathname.replace(/\/+$/g, '') || '/';
    if (['/otp', '/latest-otp', '/health'].includes(endpointPath)) {
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function normalizeHeroSmsMaxPrice(value = '') {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return '';
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  return String(Math.round(numeric * 10000) / 10000);
}

function normalizeHeroSmsAcquirePriority(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === HERO_SMS_ACQUIRE_PRIORITY_PRICE) {
    return HERO_SMS_ACQUIRE_PRIORITY_PRICE;
  }
  if (normalized === HERO_SMS_ACQUIRE_PRIORITY_PRICE_HIGH) {
    return HERO_SMS_ACQUIRE_PRIORITY_PRICE_HIGH;
  }
  return HERO_SMS_ACQUIRE_PRIORITY_COUNTRY;
}

function normalizeHeroSmsCountryFallback(value = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\r\n,，;；]+/)
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const seenIds = new Set();
  const normalized = [];

  for (const entry of source) {
    let countryId = 0;
    let countryLabel = '';

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      countryId = Math.floor(Number(entry.countryId ?? entry.id) || 0);
      countryLabel = String((entry.countryLabel ?? entry.label) || '').trim();
    } else {
      const text = String(entry || '').trim();
      const structuredMatch = text.match(/^(\d+)\s*(?:[:|/-]\s*(.+))?$/);
      if (structuredMatch) {
        countryId = Math.floor(Number(structuredMatch[1]) || 0);
        countryLabel = String(structuredMatch[2] || '').trim();
      } else {
        countryId = Math.floor(Number(text) || 0);
      }
    }

    if (!Number.isFinite(countryId) || countryId <= 0 || seenIds.has(countryId)) {
      continue;
    }
    seenIds.add(countryId);
    normalized.push({
      id: countryId,
      label: countryLabel || `Country #${countryId}`,
    });
    if (normalized.length >= 20) {
      break;
    }
  }

  return normalized;
}


function normalizePhoneSmsProvider(value = '') {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsProviderRegistry?.normalizeProviderId) {
    return rootScope.PhoneSmsProviderRegistry.normalizeProviderId(value);
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === PHONE_SMS_PROVIDER_FIVE_SIM) {
    return PHONE_SMS_PROVIDER_FIVE_SIM;
  }
  if (normalized === PHONE_SMS_PROVIDER_NEXSMS) {
    return PHONE_SMS_PROVIDER_NEXSMS;
  }
  return PHONE_SMS_PROVIDER_HERO_SMS;
}
function normalizePhoneSmsProviderOrder(value = [], fallbackOrder = []) {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsProviderRegistry?.normalizeProviderOrder) {
    return rootScope.PhoneSmsProviderRegistry.normalizeProviderOrder(value, fallbackOrder);
  }
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\r\n,]+/)
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const normalized = [];
  const seen = new Set();

  source.forEach((entry) => {
    const provider = normalizePhoneSmsProvider(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.provider || entry.id || entry.value || '')
        : entry
    );
    if (!provider || seen.has(provider)) {
      return;
    }
    seen.add(provider);
    normalized.push(provider);
  });

  if (normalized.length) {
    return normalized.slice(0, DEFAULT_PHONE_SMS_PROVIDER_ORDER.length);
  }

  const fallback = Array.isArray(fallbackOrder) ? fallbackOrder : [];
  fallback.forEach((entry) => {
    const provider = normalizePhoneSmsProvider(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.provider || entry.id || entry.value || '')
        : entry
    );
    if (!provider || seen.has(provider)) {
      return;
    }
    seen.add(provider);
    normalized.push(provider);
  });

  return normalized.slice(0, DEFAULT_PHONE_SMS_PROVIDER_ORDER.length);
}
function normalizeSignupMethod(value = '') {
  return String(value || '').trim().toLowerCase() === 'phone'
    ? 'phone'
    : 'email';
}

function getFlowCapabilityRegistry() {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (typeof flowCapabilityRegistry !== 'undefined' && flowCapabilityRegistry) {
    return flowCapabilityRegistry;
  }
  return rootScope.MultiPageFlowCapabilities?.createFlowCapabilityRegistry?.({
    defaultFlowId: typeof DEFAULT_ACTIVE_FLOW_ID === 'string' ? DEFAULT_ACTIVE_FLOW_ID : 'openai',
  }) || null;
}

function resolveCurrentFlowCapabilities(state = {}, options = {}) {
  const registry = getFlowCapabilityRegistry();
  if (!registry?.resolveSidepanelCapabilities) {
    return null;
  }
  return registry.resolveSidepanelCapabilities({
    activeFlowId: options?.activeFlowId ?? state?.activeFlowId,
    panelMode: options?.panelMode ?? state?.panelMode,
    signupMethod: options?.signupMethod ?? state?.signupMethod,
    state,
  });
}

function validateAutoRunStartState(state = {}, options = {}) {
  const registry = getFlowCapabilityRegistry();
  if (!registry?.validateAutoRunStart) {
    return { ok: true, errors: [] };
  }
  return registry.validateAutoRunStart({
    activeFlowId: options?.activeFlowId ?? state?.activeFlowId,
    panelMode: options?.panelMode ?? state?.panelMode,
    signupMethod: options?.signupMethod ?? state?.signupMethod,
    state,
  });
}

function validateModeSwitchState(state = {}, options = {}) {
  const registry = getFlowCapabilityRegistry();
  if (!registry?.validateModeSwitch) {
    return {
      ok: true,
      changedKeys: Array.isArray(options?.changedKeys) ? options.changedKeys : [],
      errors: [],
      normalizedUpdates: {},
    };
  }
  return registry.validateModeSwitch({
    activeFlowId: options?.activeFlowId ?? state?.activeFlowId,
    changedKeys: options?.changedKeys,
    panelMode: options?.panelMode ?? state?.panelMode,
    signupMethod: options?.signupMethod ?? state?.signupMethod,
    state,
  });
}

function canUsePhoneSignup(state = {}) {
  const capabilityState = typeof resolveCurrentFlowCapabilities === 'function'
    ? resolveCurrentFlowCapabilities(state)
    : (() => {
      const rootScope = typeof self !== 'undefined' ? self : globalThis;
      const registry = rootScope.MultiPageFlowCapabilities?.createFlowCapabilityRegistry?.({
        defaultFlowId: typeof DEFAULT_ACTIVE_FLOW_ID === 'string' ? DEFAULT_ACTIVE_FLOW_ID : 'openai',
      }) || null;
      return registry?.resolveSidepanelCapabilities
        ? registry.resolveSidepanelCapabilities({
          activeFlowId: state?.activeFlowId,
          panelMode: state?.panelMode,
          signupMethod: state?.signupMethod,
          state,
        })
        : null;
    })();
  if (capabilityState && typeof capabilityState.canUsePhoneSignup === 'boolean') {
    return capabilityState.canUsePhoneSignup;
  }
  return Boolean(state?.phoneVerificationEnabled)
    && !Boolean(state?.plusModeEnabled)
    && !Boolean(state?.contributionMode);
}

function resolveSignupMethod(state = {}) {
  const frozenMethod = String(state?.resolvedSignupMethod || '').trim().toLowerCase();
  if (frozenMethod === SIGNUP_METHOD_EMAIL || frozenMethod === SIGNUP_METHOD_PHONE) {
    return normalizeSignupMethod(frozenMethod);
  }
  const method = normalizeSignupMethod(state?.signupMethod);
  const capabilityState = typeof resolveCurrentFlowCapabilities === 'function'
    ? resolveCurrentFlowCapabilities(state, { signupMethod: method })
    : (() => {
      const rootScope = typeof self !== 'undefined' ? self : globalThis;
      const registry = rootScope.MultiPageFlowCapabilities?.createFlowCapabilityRegistry?.({
        defaultFlowId: typeof DEFAULT_ACTIVE_FLOW_ID === 'string' ? DEFAULT_ACTIVE_FLOW_ID : 'openai',
      }) || null;
      return registry?.resolveSidepanelCapabilities
        ? registry.resolveSidepanelCapabilities({
          activeFlowId: state?.activeFlowId,
          panelMode: state?.panelMode,
          signupMethod: method,
          state,
        })
        : null;
    })();
  if (capabilityState?.effectiveSignupMethod) {
    return normalizeSignupMethod(capabilityState.effectiveSignupMethod);
  }
  return method === SIGNUP_METHOD_PHONE && canUsePhoneSignup(state) ? SIGNUP_METHOD_PHONE : SIGNUP_METHOD_EMAIL;
}

function hasSignupPhoneActivationState(state = {}) {
  return Boolean(
    state?.signupPhoneActivation
    || state?.signupPhoneCompletedActivation
    || String(state?.signupPhoneNumber || '').trim()
  );
}

function isPhoneSignupIdentityStateForReuse(state = {}) {
  if (resolveSignupMethod(state) === SIGNUP_METHOD_PHONE) {
    return true;
  }

  const runtimeActive = (
    (typeof isAutoRunLockedState === 'function' && isAutoRunLockedState(state))
    || (typeof isAutoRunPausedState === 'function' && isAutoRunPausedState(state))
    || (typeof isAutoRunScheduledState === 'function' && isAutoRunScheduledState(state))
    || Boolean(state?.autoRunning)
  );
  if (!runtimeActive) {
    return false;
  }

  const identifierType = String(state?.accountIdentifierType || '').trim().toLowerCase();
  return identifierType === 'phone' || hasSignupPhoneActivationState(state);
}

async function ensureResolvedSignupMethodForRun(options = {}) {
  const state = await getState();
  const force = Boolean(options.force);
  const existing = String(state?.resolvedSignupMethod || '').trim().toLowerCase();
  if (!force && (existing === SIGNUP_METHOD_EMAIL || existing === SIGNUP_METHOD_PHONE)) {
    return normalizeSignupMethod(existing);
  }

  const configuredMethod = normalizeSignupMethod(state?.signupMethod);
  const resolvedMethod = resolveSignupMethod({
    ...state,
    resolvedSignupMethod: null,
  });
  await setState({ resolvedSignupMethod: resolvedMethod });
  if (configuredMethod === SIGNUP_METHOD_PHONE && resolvedMethod !== SIGNUP_METHOD_PHONE) {
    await addLog('当前模式暂不支持手机号注册，本轮已固定为邮箱注册。', 'warn');
  }
  return resolvedMethod;
}

function normalizePlusPaymentMethod(value = '') {
  return PLUS_PAYMENT_METHOD_CHECKOUT_CONVERSION;
}

function normalizeFiveSimCountryId(value, fallback = FIVE_SIM_COUNTRY_ID) {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  const rawNormalized = rootScope.PhoneSmsFiveSimProvider?.normalizeFiveSimCountryId
    ? rootScope.PhoneSmsFiveSimProvider.normalizeFiveSimCountryId(value, '')
    : String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  const normalized = String(rawNormalized || '').trim().toLowerCase();
  if (normalized) {
    return normalized;
  }
  const fallbackSource = fallback === undefined || fallback === null ? FIVE_SIM_COUNTRY_ID : fallback;
  const normalizedFallback = String(fallbackSource).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
  if (!normalizedFallback) {
    return '';
  }
  return normalizedFallback || FIVE_SIM_COUNTRY_ID;
}

function normalizeFiveSimCountryCode(value = '', fallback = 'thailand') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '');
  return normalized || fallback;
}

function normalizeFiveSimCountryOrder(value = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\r\n,，;；]+/)
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const normalized = [];
  const seen = new Set();

  source.forEach((entry) => {
    const code = normalizeFiveSimCountryCode(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.code || entry.country || entry.id || '')
        : entry,
      ''
    );
    if (!code || seen.has(code)) {
      return;
    }
    seen.add(code);
    normalized.push(code);
  });

  return normalized.slice(0, 10);
}

function normalizeNexSmsCountryId(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  const fallbackParsed = Math.floor(Number(fallback));
  if (Number.isFinite(fallbackParsed) && fallbackParsed >= 0) {
    return fallbackParsed;
  }
  return 0;
}

function normalizeNexSmsCountryOrder(value = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\r\n,，;；]+/)
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const normalized = [];
  const seen = new Set();
  source.forEach((entry) => {
    const id = normalizeNexSmsCountryId(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry.id || entry.countryId || entry.country || '')
        : entry,
      -1
    );
    if (id < 0 || seen.has(id)) {
      return;
    }
    seen.add(id);
    normalized.push(id);
  });
  return normalized.slice(0, 10);
}

function normalizeNexSmsServiceCode(value = '', fallback = DEFAULT_NEX_SMS_SERVICE_CODE) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (normalized) {
    return normalized;
  }
  const fallbackNormalized = String(fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return fallbackNormalized || DEFAULT_NEX_SMS_SERVICE_CODE;
}

function normalizePhonePreferredActivation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const activationId = String(value.activationId ?? value.id ?? value.activation ?? '').trim();
  const phoneNumber = String(value.phoneNumber ?? value.number ?? value.phone ?? '').trim();
  if (!activationId || !phoneNumber) {
    return null;
  }
  const provider = normalizePhoneSmsProvider(value.provider || value.smsProvider || DEFAULT_PHONE_SMS_PROVIDER);
  return {
    ...value,
    provider,
    activationId,
    phoneNumber,
    countryId: value.countryId ?? value.country ?? value.countryCode ?? null,
    countryLabel: String(value.countryLabel || value.label || '').trim(),
    successfulUses: Math.max(0, Math.floor(Number(value.successfulUses) || 0)),
    maxUses: Math.max(1, Math.floor(Number(value.maxUses) || 1)),
  };
}

function normalizeFiveSimCountryLabel(value = '', fallback = FIVE_SIM_COUNTRY_LABEL) {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsFiveSimProvider?.normalizeFiveSimCountryLabel) {
    return rootScope.PhoneSmsFiveSimProvider.normalizeFiveSimCountryLabel(value, fallback);
  }
  if (rootScope.PhoneSmsFiveSimProvider?.formatFiveSimCountryLabel) {
    return rootScope.PhoneSmsFiveSimProvider.formatFiveSimCountryLabel('', value, fallback);
  }
  return String(value || '').trim() || fallback;
}

function normalizeFiveSimOperator(value = '', fallback = FIVE_SIM_OPERATOR) {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsFiveSimProvider?.normalizeFiveSimOperator) {
    return rootScope.PhoneSmsFiveSimProvider.normalizeFiveSimOperator(value || fallback);
  }
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '') || fallback;
}

function normalizeFiveSimMaxPrice(value = '') {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsFiveSimProvider?.normalizeFiveSimMaxPrice) {
    return rootScope.PhoneSmsFiveSimProvider.normalizeFiveSimMaxPrice(value);
  }
  const rawValue = String(value ?? '').trim();
  if (!rawValue) {
    return '';
  }
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  return String(Math.round(numeric * 10000) / 10000);
}

function normalizeFiveSimCountryFallback(value = []) {
  const rootScope = typeof self !== 'undefined' ? self : globalThis;
  if (rootScope.PhoneSmsFiveSimProvider?.normalizeFiveSimCountryFallback) {
    return rootScope.PhoneSmsFiveSimProvider.normalizeFiveSimCountryFallback(value);
  }
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\r\n,，;；]+/)
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const seenIds = new Set();
  const normalized = [];

  for (const entry of source) {
    let countryId = '';
    let countryLabel = '';

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      countryId = normalizeFiveSimCountryId(entry.countryId ?? entry.id ?? entry.slug, '');
      countryLabel = String((entry.countryLabel ?? entry.label ?? entry.name ?? entry.text_en) || '').trim();
    } else {
      const text = String(entry || '').trim();
      const structuredMatch = text.match(/^([a-z0-9_-]+)\s*(?:[:|/-]\s*(.+))?$/i);
      countryId = normalizeFiveSimCountryId(structuredMatch?.[1] || text, '');
      countryLabel = String(structuredMatch?.[2] || '').trim();
    }

    if (!countryId || seenIds.has(countryId)) {
      continue;
    }
    seenIds.add(countryId);
    normalized.push({
      id: countryId,
      label: countryLabel || normalizeFiveSimCountryLabel('', countryId),
    });
    if (normalized.length >= 20) {
      break;
    }
  }

  return normalized;
}

function resolveLegacyAutoStepDelaySeconds(input = {}) {
  const hasLegacyMin = input.autoStepRandomDelayMinSeconds !== undefined;
  const hasLegacyMax = input.autoStepRandomDelayMaxSeconds !== undefined;
  if (!hasLegacyMin && !hasLegacyMax) {
    return undefined;
  }

  const minSeconds = normalizeAutoStepDelaySeconds(input.autoStepRandomDelayMinSeconds, null);
  const maxSeconds = normalizeAutoStepDelaySeconds(input.autoStepRandomDelayMaxSeconds, null);
  if (minSeconds === null && maxSeconds === null) {
    return null;
  }
  if (minSeconds === null) {
    return maxSeconds;
  }
  if (maxSeconds === null) {
    return minSeconds;
  }
  return Math.round((minSeconds + maxSeconds) / 2);
}

function normalizeRunCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.floor(numeric));
}

function normalizeAutoRunTimerKind(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === AUTO_RUN_TIMER_KIND_SCHEDULED_START) {
    return AUTO_RUN_TIMER_KIND_SCHEDULED_START;
  }
  if (normalized === AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS) {
    return AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS;
  }
  if (normalized === AUTO_RUN_TIMER_KIND_BEFORE_RETRY) {
    return AUTO_RUN_TIMER_KIND_BEFORE_RETRY;
  }
  return '';
}

function normalizeAutoRunSessionId(value) {
  const numeric = Math.floor(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function createAutoRunSessionId() {
  autoRunSessionSeed = Math.max(autoRunSessionSeed + 1, Date.now());
  autoRunSessionId = autoRunSessionSeed;
  return autoRunSessionId;
}

function setCurrentAutoRunSessionId(value) {
  autoRunSessionId = normalizeAutoRunSessionId(value);
  return autoRunSessionId;
}

function clearCurrentAutoRunSessionId(expectedSessionId = null) {
  if (expectedSessionId === null) {
    autoRunSessionId = 0;
    return autoRunSessionId;
  }

  const normalizedExpected = normalizeAutoRunSessionId(expectedSessionId);
  if (!normalizedExpected || normalizedExpected === autoRunSessionId) {
    autoRunSessionId = 0;
  }
  return autoRunSessionId;
}

function isCurrentAutoRunSessionId(value) {
  const normalized = normalizeAutoRunSessionId(value);
  return normalized > 0 && normalized === autoRunSessionId;
}

function isRunScopedCheckoutConversionProxyActive() {
  return Boolean(runScopedCheckoutConversionProxySnapshot?.applied);
}

function getRunScopedCheckoutConversionProxyDisplay(snapshot = null) {
  if (snapshot?.entry?.protocol || snapshot?.entry?.host) {
    const protocol = String(snapshot.entry.protocol || 'proxy').replace(/:$/g, '').trim().toLowerCase();
    const host = String(snapshot.entry.host || '').trim();
    const port = String(snapshot.entry.port || '').trim();
    if (host && port) {
      return `${protocol}://${host}:${port}`;
    }
    if (host) {
      return `${protocol}://${host}`;
    }
  }
  return getCheckoutConversionProxyLogDisplay(snapshot?.displayName || '');
}

function normalizeCheckoutConversionProxyInput(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return '';
  }
  const colonParts = rawValue.split(':');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue) && colonParts.length >= 4) {
    const host = colonParts.shift().trim();
    const port = colonParts.shift().trim();
    const username = colonParts.shift().trim();
    const password = colonParts.join(':').trim();
    if (host && /^\d{1,5}$/.test(port) && username) {
      return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
  }
  try {
    const parsed = new URL(rawValue);
    const protocol = String(parsed.protocol || '').replace(/:$/g, '').trim().toLowerCase();
    if (!['http', 'https', 'socks4', 'socks5', 'socks5h'].includes(protocol)) {
      return rawValue;
    }
    const host = String(parsed.hostname || '').trim();
    const port = String(parsed.port || '').trim();
    if (!host || !/^\d{1,5}$/.test(port)) {
      return rawValue;
    }
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';
    const auth = username || password
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
      : '';
    return `${protocol}://${auth}${host}:${port}`;
  } catch {
    return rawValue;
  }
}

function normalizeCheckoutConversionProxyPoolEntry(value = '') {
  const normalized = normalizeCheckoutConversionProxyInput(value);
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

function splitCheckoutConversionProxyPoolCandidates(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .flatMap((line) => String(line || '').split(/[\t,，]/g))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeCheckoutConversionProxyPoolText(value = '') {
  const seen = new Set();
  const entries = [];
  splitCheckoutConversionProxyPoolCandidates(value)
    .forEach((candidate) => {
      const normalized = normalizeCheckoutConversionProxyPoolEntry(candidate);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      entries.push(normalized);
    });
  return entries.join('\n');
}

function getCheckoutConversionProxyPoolEntries(state = {}) {
  const poolText = normalizeCheckoutConversionProxyPoolText(state?.plusCheckoutConversionProxyPoolText);
  return poolText
    .split('\n')
    .map((entry) => normalizeCheckoutConversionProxyPoolEntry(entry))
    .filter(Boolean);
}

function normalizeCheckoutConversionProxyPoolIndex(value = 0) {
  const index = Math.floor(Number(value) || 0);
  return index >= 0 ? index : 0;
}

function getCheckoutConversionProxyLogDisplay(proxyUrl = '') {
  const normalized = normalizeCheckoutConversionProxyInput(proxyUrl);
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
    // Fall through to a non-sensitive generic label.
  }
  return '已配置代理';
}

async function selectNextCheckoutConversionProxyForAutoRun(context = {}) {
  const state = await getState();
  const entries = getCheckoutConversionProxyPoolEntries(state);
  if (!entries.length) {
    const singleProxyUrl = normalizeCheckoutConversionProxyInput(state?.plusCheckoutConversionProxyUrl);
    if (singleProxyUrl && singleProxyUrl !== state?.plusCheckoutConversionProxyUrl) {
      await setPersistentSettings({ plusCheckoutConversionProxyUrl: singleProxyUrl }).catch(() => {});
      await setState({ plusCheckoutConversionProxyUrl: singleProxyUrl }).catch(() => {});
    }
    return singleProxyUrl;
  }

  const index = normalizeCheckoutConversionProxyPoolIndex(state?.plusCheckoutConversionProxyPoolIndex);
  const selectedIndex = index % entries.length;
  const selectedProxyUrl = entries[selectedIndex];
  const nextIndex = (selectedIndex + 1) % entries.length;
  await setPersistentSettings({
    plusCheckoutConversionProxyUrl: selectedProxyUrl,
    plusCheckoutConversionProxyPoolText: entries.join('\n'),
    plusCheckoutConversionProxyPoolIndex: nextIndex,
  }).catch(() => {});
  await setState({
    plusCheckoutConversionProxyUrl: selectedProxyUrl,
    plusCheckoutConversionProxyPoolText: entries.join('\n'),
    plusCheckoutConversionProxyPoolIndex: nextIndex,
  }).catch(() => {});

  const targetRun = Number(context?.targetRun) || 0;
  const totalRuns = Number(context?.totalRuns) || 0;
  const attemptRuns = Number(context?.attemptRuns) || 0;
  const runLabel = targetRun && totalRuns
    ? `第 ${targetRun}/${totalRuns} 轮${attemptRuns > 1 ? ` 第 ${attemptRuns} 次尝试` : ''}`
    : '本次执行';
  await addLog(
    `全流程代理池：${runLabel} 已切换到第 ${selectedIndex + 1}/${entries.length} 条代理（${getCheckoutConversionProxyLogDisplay(selectedProxyUrl)}）。`,
    'info'
  );
  return selectedProxyUrl;
}

async function applyRunScopedCheckoutConversionProxy(options = {}) {
  if (isRunScopedCheckoutConversionProxyActive()) {
    return runScopedCheckoutConversionProxySnapshot;
  }
  const state = options.state || await getState();
  const proxyUrl = normalizeCheckoutConversionProxyInput(state?.plusCheckoutConversionProxyUrl);
  if (!proxyUrl) {
    return null;
  }
  if (!plusCheckoutCreateExecutor?.applyCheckoutConversionProxyForScope) {
    await addLog('全流程代理未启用：代理模块尚未加载。', 'warn');
    return null;
  }

  const snapshot = await plusCheckoutCreateExecutor.applyCheckoutConversionProxyForScope(state);
  if (!snapshot?.applied) {
    return null;
  }
  runScopedCheckoutConversionProxySnapshot = snapshot;
  const display = getRunScopedCheckoutConversionProxyDisplay(snapshot);
  if (options.startLog !== false) {
    await addLog(`${options.startLog || '全流程代理已启用：本次插件执行期间，浏览器网络都会走该代理。'}（${display}）`, 'info');
  }
  return snapshot;
}

async function restoreRunScopedCheckoutConversionProxy(reason = '插件执行结束') {
  const snapshot = runScopedCheckoutConversionProxySnapshot;
  if (!snapshot?.applied) {
    runScopedCheckoutConversionProxySnapshot = null;
    return false;
  }

  runScopedCheckoutConversionProxySnapshot = null;
  try {
    if (plusCheckoutCreateExecutor?.restoreCheckoutConversionProxyForScope) {
      await plusCheckoutCreateExecutor.restoreCheckoutConversionProxyForScope(snapshot);
    }
    await addLog(`全流程代理已释放：${reason}，浏览器网络已恢复到执行前状态。`, 'info');
    return true;
  } catch (error) {
    runScopedCheckoutConversionProxySnapshot = snapshot;
    await addLog(`全流程代理释放失败：${error?.message || String(error || '未知错误')}`, 'warn');
    return false;
  }
}

async function runWithCheckoutConversionProxyDuringPluginUse(callback, options = {}) {
  const wasActive = isRunScopedCheckoutConversionProxyActive();
  if (!wasActive) {
    await applyRunScopedCheckoutConversionProxy(options);
  }
  try {
    return await callback();
  } finally {
    if (!wasActive) {
      await restoreRunScopedCheckoutConversionProxy(options.finishReason || '插件执行结束');
    }
  }
}

async function applyPluginProxyForManualUse(options = {}) {
  const proxyUrl = normalizeCheckoutConversionProxyInput(options?.proxyUrl);
  if (proxyUrl) {
    await setPersistentSettings({ plusCheckoutConversionProxyUrl: proxyUrl }).catch(() => {});
    await setState({ plusCheckoutConversionProxyUrl: proxyUrl }).catch(() => {});
  }
  const snapshot = await applyRunScopedCheckoutConversionProxy({
    state: {
      ...(await getState()),
      ...(proxyUrl ? { plusCheckoutConversionProxyUrl: proxyUrl } : {}),
    },
    startLog: '全流程代理已手动启用：当前 Chrome 浏览器网络会走该代理。',
  });
  return {
    applied: Boolean(snapshot?.applied),
    displayName: getRunScopedCheckoutConversionProxyDisplay(snapshot),
  };
}

async function clearPluginProxyForManualUse(reason = '用户手动清除') {
  const cleared = await restoreRunScopedCheckoutConversionProxy(reason);
  return { cleared };
}

function throwIfAutoRunSessionStopped(sessionId) {
  const normalizedSessionId = normalizeAutoRunSessionId(sessionId);
  if (normalizedSessionId && !isCurrentAutoRunSessionId(normalizedSessionId)) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
  throwIfStopped();
}

function normalizeAutoRunTimerPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return null;
  }

  const kind = normalizeAutoRunTimerKind(plan.kind);
  if (!kind) {
    return null;
  }

  const fireAt = Number(plan.fireAt);
  if (!Number.isFinite(fireAt)) {
    return null;
  }

  const totalRuns = normalizeRunCount(plan.totalRuns);
  const autoRunSkipFailures = Boolean(plan.autoRunSkipFailures);
  const mode = plan.mode === 'continue' ? 'continue' : 'restart';
  const currentRun = Math.max(0, Math.min(totalRuns, Math.floor(Number(plan.currentRun) || 0)));
  const attemptRun = Math.max(
    0,
    Math.min(AUTO_RUN_MAX_RETRIES_PER_ROUND + 1, Math.floor(Number(plan.attemptRun) || 0))
  );
  const autoRunSessionId = normalizeAutoRunSessionId(plan.autoRunSessionId ?? plan.sessionId);
  const roundSummaries = serializeAutoRunRoundSummaries(totalRuns, plan.roundSummaries);
  const countdownTitle = String(plan.countdownTitle || '').trim();
  const countdownNote = String(plan.countdownNote || '').trim();

  if (kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START) {
    return {
      kind,
      fireAt,
      totalRuns,
      autoRunSkipFailures,
      mode,
      currentRun: 0,
      attemptRun: 0,
      autoRunSessionId,
      roundSummaries: [],
      countdownTitle: countdownTitle || '已计划自动运行',
      countdownNote: countdownNote || `计划于 ${formatAutoRunScheduleTime(fireAt)} 开始`,
    };
  }

  if (kind === AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS) {
    const normalizedCurrentRun = Math.max(1, Math.min(totalRuns, currentRun));
    const normalizedAttemptRun = Math.max(1, attemptRun);
    return {
      kind,
      fireAt,
      totalRuns,
      autoRunSkipFailures,
      mode: 'restart',
      currentRun: normalizedCurrentRun,
      attemptRun: normalizedAttemptRun,
      autoRunSessionId,
      roundSummaries,
      countdownTitle: countdownTitle || '线程间隔中',
      countdownNote: countdownNote || `第 ${Math.min(normalizedCurrentRun + 1, totalRuns)}/${totalRuns} 轮即将开始`,
    };
  }

  const normalizedCurrentRun = Math.max(1, Math.min(totalRuns, currentRun));
  const normalizedAttemptRun = Math.max(1, attemptRun);
  return {
    kind,
    fireAt,
    totalRuns,
    autoRunSkipFailures,
    mode: 'restart',
    currentRun: normalizedCurrentRun,
    attemptRun: normalizedAttemptRun,
    autoRunSessionId,
    roundSummaries,
    countdownTitle: countdownTitle || '线程间隔中',
    countdownNote: countdownNote || `第 ${normalizedCurrentRun}/${totalRuns} 轮第 ${normalizedAttemptRun} 次尝试即将开始`,
  };
}

function normalizeAutoRunTimerPlanFromState(state = {}) {
  const directPlan = normalizeAutoRunTimerPlan(state.autoRunTimerPlan);
  if (directPlan) {
    return directPlan;
  }

  if (state.autoRunPhase !== 'scheduled') {
    return null;
  }

  const legacyScheduledAt = Number(state.scheduledAutoRunAt);
  if (!Number.isFinite(legacyScheduledAt)) {
    return null;
  }

  return normalizeAutoRunTimerPlan({
    kind: AUTO_RUN_TIMER_KIND_SCHEDULED_START,
    fireAt: legacyScheduledAt,
    totalRuns: state.scheduledAutoRunPlan?.totalRuns ?? state.autoRunTotalRuns,
    autoRunSkipFailures: state.scheduledAutoRunPlan?.autoRunSkipFailures ?? state.autoRunSkipFailures,
    autoRunSessionId: state.autoRunSessionId,
    mode: state.scheduledAutoRunPlan?.mode,
  });
}

function getAutoRunTimerPlanPhase(kind = '') {
  return kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START ? 'scheduled' : 'waiting_interval';
}

function getAutoRunTimerStatusPayload(plan) {
  const normalizedPlan = normalizeAutoRunTimerPlan(plan);
  if (!normalizedPlan) {
    return null;
  }

  const phase = getAutoRunTimerPlanPhase(normalizedPlan.kind);
  return {
    phase,
    currentRun: normalizedPlan.currentRun,
    totalRuns: normalizedPlan.totalRuns,
    attemptRun: normalizedPlan.attemptRun,
    sessionId: normalizedPlan.autoRunSessionId,
    scheduledAt: phase === 'scheduled' ? normalizedPlan.fireAt : null,
    countdownAt: normalizedPlan.fireAt,
    countdownTitle: normalizedPlan.countdownTitle,
    countdownNote: normalizedPlan.countdownNote,
  };
}

function normalizeEmailGenerator(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  const customEmailPoolGenerator = typeof CUSTOM_EMAIL_POOL_GENERATOR === 'string'
    ? CUSTOM_EMAIL_POOL_GENERATOR
    : 'custom-pool';
  const gmailAliasGenerator = typeof GMAIL_ALIAS_GENERATOR === 'string'
    ? GMAIL_ALIAS_GENERATOR
    : 'gmail-alias';
  if (normalized === 'custom' || normalized === 'manual') {
    return 'custom';
  }
  if (normalized === gmailAliasGenerator) {
    return gmailAliasGenerator;
  }
  if (normalized === customEmailPoolGenerator) {
    return customEmailPoolGenerator;
  }
  if (normalized === 'icloud') {
    return 'icloud';
  }
  if (normalized === 'cloudflare') return 'cloudflare';
  if (normalized === CLOUDFLARE_TEMP_EMAIL_GENERATOR) return CLOUDFLARE_TEMP_EMAIL_GENERATOR;
  if (normalized === 'cloudmail') return 'cloudmail';
  return 'duck';
}

function normalizeIcloudFetchMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'always_new' ? 'always_new' : 'reuse_existing';
}

function normalizeCustomEmailPool(value = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[\r\n,，;；]+/);

  return source
    .map((item) => parseEmailWithOptionalVerificationUrl(item).email)
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}

function parseEmailWithOptionalVerificationUrl(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return { email: '', verificationUrl: '', queryCode: '', apiMode: ICLOUD_API_MODE_NORMAL, password: '', clientId: '', refreshToken: '' };
  }

  const parts = rawValue.split('----');
  const rawEmail = parts.length > 1 ? parts.shift() : rawValue;
  const credential = String(parts.length > 0 ? parts.join('----') : '').trim();
  let verificationUrl = '';
  let queryCode = '';
  let apiMode = ICLOUD_API_MODE_NORMAL;
  let password = '';
  let clientId = '';
  let refreshToken = '';
  if (credential) {
    const hotmailParts = credential.split('----').map((part) => String(part || '').trim());
    if (hotmailParts.length >= 3 && hotmailParts[1] && hotmailParts.slice(2).join('----').trim()) {
      password = hotmailParts[0] || '';
      clientId = hotmailParts[1] || '';
      refreshToken = hotmailParts.slice(2).join('----').trim();
      apiMode = ICLOUD_API_MODE_HOTMAIL;
    } else {
    try {
      const parsed = new URL(credential);
      verificationUrl = ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
      const host = String(parsed.hostname || '').toLowerCase();
      if (host === 'assurivo.com' || host.endsWith('.assurivo.com')) {
        queryCode = String(parsed.searchParams.get('pwd') || '').trim();
        if (queryCode) {
          apiMode = ICLOUD_API_MODE_TAOBAO;
        }
      }
    } catch {
      if (/^[A-Za-z0-9_-]{6,}$/.test(credential)) {
        queryCode = credential;
        apiMode = ICLOUD_API_MODE_TAOBAO;
      }
    }
    }
  }

  return {
    email: String(rawEmail || '').trim().toLowerCase(),
    verificationUrl,
    queryCode,
    apiMode,
    password,
    clientId,
    refreshToken,
  };
}

function normalizeVerificationUrlValue(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return '';
  }
  try {
    const parsed = new URL(rawValue);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function buildOutlookApiVerificationUrl(email = '', password = '') {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '').trim();
  if (!normalizedEmail || !normalizedPassword) {
    return '';
  }
  return `${OUTLOOK_API_BASE_URL}${normalizedEmail}----${normalizedPassword}`;
}

function normalizeIcloudApiModeValue(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === ICLOUD_API_MODE_OUTLOOK_API || normalized === 'paopaodw' || normalized === 'outlook_http') {
    return ICLOUD_API_MODE_OUTLOOK_API;
  }
  if (normalized === ICLOUD_API_MODE_HOTMAIL || normalized === 'hotmail' || normalized === 'outlook' || normalized === 'microsoft' || normalized === 'graph') {
    return ICLOUD_API_MODE_HOTMAIL;
  }
  return normalized === ICLOUD_API_MODE_TAOBAO ? ICLOUD_API_MODE_TAOBAO : ICLOUD_API_MODE_NORMAL;
}

function normalizeCustomEmailPoolEntryObjects(value = []) {
  const source = Array.isArray(value) ? value : [];
  const seenEmails = new Set();
  const entries = [];

  for (const rawEntry of source) {
    const asObject = rawEntry && typeof rawEntry === 'object'
      ? rawEntry
      : { email: rawEntry };
    const parsedEntry = parseEmailWithOptionalVerificationUrl(asObject.email || '');
    const email = parsedEntry.email;
    const password = String(asObject.password || parsedEntry.password || '').trim();
    const clientId = String(asObject.clientId || asObject.client_id || parsedEntry.clientId || '').trim();
    const refreshToken = String(asObject.refreshToken || asObject.refresh_token || asObject.token || parsedEntry.refreshToken || '').trim();
    const hasHotmailCredential = Boolean(clientId && refreshToken);
    const queryCode = hasHotmailCredential
      ? ''
      : String(asObject.queryCode || asObject.pwd || parsedEntry.queryCode || '').trim();
    const apiMode = normalizeIcloudApiModeValue(hasHotmailCredential
      ? ICLOUD_API_MODE_HOTMAIL
      : (queryCode
      ? ICLOUD_API_MODE_TAOBAO
      : (asObject.apiMode || parsedEntry.apiMode || ICLOUD_API_MODE_NORMAL)));
    const verificationUrl = normalizeVerificationUrlValue(
      asObject.verificationUrl
      || asObject.url
      || asObject.mailUrl
      || parsedEntry.verificationUrl
      || (apiMode === ICLOUD_API_MODE_OUTLOOK_API && password ? buildOutlookApiVerificationUrl(email, password) : '')
      || ''
    );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      continue;
    }
    if (seenEmails.has(email)) {
      continue;
    }
    seenEmails.add(email);
    entries.push({
      id: String(asObject.id || `custom-pool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
      email,
      enabled: asObject.enabled !== undefined ? Boolean(asObject.enabled) : true,
      used: Boolean(asObject.used),
      note: String(asObject.note || '').trim(),
      apiMode,
      queryCode: apiMode === ICLOUD_API_MODE_HOTMAIL ? '' : queryCode,
      password: apiMode === ICLOUD_API_MODE_HOTMAIL || apiMode === ICLOUD_API_MODE_OUTLOOK_API ? password : '',
      clientId: apiMode === ICLOUD_API_MODE_HOTMAIL ? clientId : '',
      refreshToken: apiMode === ICLOUD_API_MODE_HOTMAIL ? refreshToken : '',
      verificationUrl: apiMode === ICLOUD_API_MODE_HOTMAIL ? '' : verificationUrl,
      reuseAllowed: Boolean(asObject.reuseAllowed),
      lastUsedAt: Number.isFinite(Number(asObject.lastUsedAt)) ? Number(asObject.lastUsedAt) : 0,
      lastError: String(asObject.lastError || '').trim(),
      accessTokenCheck: asObject.accessTokenCheck && typeof asObject.accessTokenCheck === 'object'
        ? asObject.accessTokenCheck
        : null,
    });
  }

  return entries;
}

function isCustomEmailPoolGenerator(stateOrValue = {}) {
  const generator = typeof stateOrValue === 'string'
    ? stateOrValue
    : stateOrValue?.emailGenerator;
  const customEmailPoolGenerator = typeof CUSTOM_EMAIL_POOL_GENERATOR === 'string'
    ? CUSTOM_EMAIL_POOL_GENERATOR
    : 'custom-pool';
  return normalizeEmailGenerator(generator) === customEmailPoolGenerator;
}

function getCustomEmailPool(state = {}) {
  if (typeof normalizeCustomEmailPoolEntryObjects === 'function') {
    const entries = normalizeCustomEmailPoolEntryObjects(state?.customEmailPoolEntries);
    if (entries.length > 0) {
      return entries
        .filter((entry) => entry.enabled && !entry.used)
        .map((entry) => entry.email);
    }
  }
  return normalizeCustomEmailPool(state?.customEmailPool);
}

function getCustomEmailPoolEntries(state = {}) {
  const entries = normalizeCustomEmailPoolEntryObjects(state?.customEmailPoolEntries);
  if (entries.length > 0) {
    return entries;
  }
  return normalizeCustomEmailPool(state?.customEmailPool).map((email) => ({
    id: `custom-pool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    email,
    enabled: true,
    used: false,
    note: '',
    lastUsedAt: 0,
  }));
}

async function markCurrentCustomEmailPoolEntryUsed(state = {}, options = {}) {
  if (!isCustomEmailPoolGenerator(state)) {
    return { updated: false };
  }

  const currentEmail = String(state?.email || '').trim().toLowerCase();
  if (!currentEmail) {
    return { updated: false };
  }

  const entries = getCustomEmailPoolEntries(state);
  if (!entries.length) {
    return { updated: false };
  }

  let changed = false;
  const now = Date.now();
  const nextEntries = entries.map((entry) => {
    if (entry.email !== currentEmail) {
      return entry;
    }
    if (entry.used && entry.lastUsedAt) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      used: true,
      reuseAllowed: false,
      lastUsedAt: now,
    };
  });

  if (!changed) {
    return { updated: false };
  }

  const nextCustomEmailPool = nextEntries
    .filter((entry) => entry.enabled && !entry.used)
    .map((entry) => entry.email);
  await setPersistentSettings({
    customEmailPoolEntries: nextEntries,
    customEmailPool: nextCustomEmailPool,
  });
  await setState({
    customEmailPoolEntries: nextEntries,
    customEmailPool: nextCustomEmailPool,
  });
  broadcastDataUpdate({
    customEmailPoolEntries: nextEntries,
    customEmailPool: nextCustomEmailPool,
  });
  const logPrefix = String(options.logPrefix || '').trim() || '自定义邮箱池：流程成功后';
  await addLog(`${logPrefix}已将 ${currentEmail} 标记为已用。`, options.level || 'ok');
  return {
    updated: true,
    customEmailPoolEntries: nextEntries,
    customEmailPool: nextCustomEmailPool,
  };
}

async function markCustomEmailPoolEntryUsedByEmail(emailValue = '', options = {}) {
  const targetEmail = String(emailValue || '').trim().toLowerCase();
  if (!targetEmail) {
    return { updated: false };
  }

  const state = options.state || await getState().catch(() => ({}));
  const entries = getCustomEmailPoolEntries(state);
  if (!entries.length) {
    return { updated: false };
  }

  let changed = false;
  const now = Date.now();
  const nextEntries = entries.map((entry) => {
    const email = String(entry?.email || '').trim().toLowerCase();
    if (email !== targetEmail) {
      return entry;
    }
    if (entry.used && Number(entry.lastUsedAt) > 0) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      used: true,
      reuseAllowed: false,
      lastUsedAt: Number(entry.lastUsedAt) || now,
    };
  });

  if (!changed) {
    return { updated: false };
  }

  const nextCustomEmailPool = nextEntries
    .filter((entry) => entry.enabled && !entry.used)
    .map((entry) => entry.email);
  const updates = {
    customEmailPoolEntries: nextEntries,
    customEmailPool: nextCustomEmailPool,
  };
  await setPersistentSettings(updates);
  await setState(updates);
  broadcastDataUpdate(updates);

  if (options.log !== false) {
    const logPrefix = String(options.logPrefix || '').trim() || 'iCloud API 邮箱池：外部兑换';
    await addLog(`${logPrefix}已将 ${targetEmail} 标记为已用。`, options.level || 'ok');
  }

  return {
    updated: true,
    ...updates,
  };
}

async function markCurrentRegistrationAccountUsed(state = {}, options = {}) {
  const providedState = state && typeof state === 'object' ? state : {};
  const currentState = await getState();
  const latestState = {
    ...providedState,
    ...(currentState && typeof currentState === 'object' ? currentState : {}),
  };
  const reasonPrefix = String(options.logPrefix || '').trim() || '当前账号';
  let updated = false;

  if (latestState.currentHotmailAccountId && isHotmailProvider(latestState)) {
    const existingHotmailAccount = Array.isArray(latestState.hotmailAccounts)
      ? latestState.hotmailAccounts.find((account) => String(account?.id || '').trim() === String(latestState.currentHotmailAccountId || '').trim())
      : null;
    const currentEmail = String(latestState.email || '').trim();
    if (Boolean(latestState?.hotmailAliasEnabled) && existingHotmailAccount && currentEmail && isOutlookPlusAliasForAccount(currentEmail, existingHotmailAccount)) {
      await setHotmailAliasUsageEntry(existingHotmailAccount, currentEmail, {
        used: true,
        lastCheckedAt: Date.now(),
        reason: 'flow_completed',
      });
      await addLog(`${reasonPrefix}：Outlook 别名 ${currentEmail} 已标记为已用。`, options.level || 'warn');
      const refreshedState = await getState();
      if (
        !existingHotmailAccount.used
        && countHotmailUsedAliases(refreshedState.hotmailAliasUsage, existingHotmailAccount) >= normalizeOutlookAliasMaxPerAccount(refreshedState.outlookAliasMaxPerAccount)
      ) {
        await patchHotmailAccount(
          latestState.currentHotmailAccountId,
          {
            used: true,
            lastUsedAt: Date.now(),
          },
          {
            preserveCurrentSelection: true,
          }
        );
        await addLog(`${reasonPrefix}：Hotmail 账号的别名额度已用完，基邮箱已标记为已用。`, options.level || 'warn');
      }
    } else if (!existingHotmailAccount?.used) {
      await patchHotmailAccount(
        latestState.currentHotmailAccountId,
        {
          used: true,
          lastUsedAt: Date.now(),
        },
        {
          preserveCurrentSelection: true,
        }
      );
      await addLog(`${reasonPrefix}：Hotmail 账号已标记为已用。`, options.level || 'warn');
    }
    updated = true;
  }

  if (isLuckmailProvider(latestState)) {
    const currentPurchase = getCurrentLuckmailPurchase(latestState);
    if (currentPurchase?.id) {
      await setLuckmailPurchaseUsedState(currentPurchase.id, true);
      await clearLuckmailRuntimeState({ clearEmail: true });
      await addLog(`${reasonPrefix}：LuckMail 邮箱 ${currentPurchase.email_address} 已标记为已用。`, options.level || 'warn');
      updated = true;
    }
  }

  if (String(latestState.mailProvider || '').trim().toLowerCase() === '2925' && latestState.currentMail2925AccountId) {
    await patchMail2925Account(latestState.currentMail2925AccountId, {
      lastUsedAt: Date.now(),
      lastError: '',
    });
    await addLog(`${reasonPrefix}：2925 账号已记录最近使用时间。`, options.level || 'warn');
    updated = true;
  }

  const icloudResult = await finalizeIcloudAliasAfterSuccessfulFlow(latestState);
  updated = Boolean(icloudResult?.handled) || updated;

  if (typeof markCurrentCustomEmailPoolEntryUsed === 'function') {
    const result = await markCurrentCustomEmailPoolEntryUsed(latestState, {
      logPrefix: `${reasonPrefix}：自定义邮箱池`,
      level: options.level || 'warn',
    });
    updated = Boolean(result?.updated) || updated;
  }

  return { updated };
}

function getCustomEmailPoolSelectionForRun(state = {}, targetRun = 1) {
  const numericRun = Math.max(1, Math.floor(Number(targetRun) || 1));
  const configuredEntries = normalizeCustomEmailPoolEntryObjects(state?.customEmailPoolEntries)
    .filter((entry) => entry.enabled);

  if (configuredEntries.length > 0) {
    const usedCount = configuredEntries.filter((entry) => entry.used).length;
    const unusedEntries = configuredEntries.filter((entry) => !entry.used);
    if (!unusedEntries.length) {
      return {
        entry: null,
        total: configuredEntries.length,
        used: usedCount,
        unused: 0,
      };
    }
    const preferredIndex = usedCount > 0
      ? Math.max(0, numericRun - 1 - usedCount)
      : numericRun - 1;
    return {
      entry: unusedEntries[preferredIndex] || (usedCount > 0 ? unusedEntries[0] : null),
      total: configuredEntries.length,
      used: usedCount,
      unused: unusedEntries.length,
    };
  }

  const legacyPool = normalizeCustomEmailPool(state?.customEmailPool);
  return {
    entry: legacyPool[numericRun - 1] ? {
      id: `legacy-custom-pool-${numericRun}`,
      email: legacyPool[numericRun - 1],
      enabled: true,
      used: false,
    } : null,
    total: legacyPool.length,
    used: 0,
    unused: legacyPool.length,
  };
}

function getCustomEmailPoolEmailForRun(state = {}, targetRun = 1) {
  return String(getCustomEmailPoolSelectionForRun(state, targetRun).entry?.email || '').trim();
}

function getCustomEmailPoolEntryForRun(state = {}, targetRun = 1) {
  return getCustomEmailPoolSelectionForRun(state, targetRun).entry || null;
}

function getUnusedCustomEmailPoolCount(state = {}) {
  const entries = normalizeCustomEmailPoolEntryObjects(state?.customEmailPoolEntries)
    .filter((entry) => entry.enabled);
  if (entries.length > 0) {
    return entries.filter((entry) => !entry.used).length;
  }
  return normalizeCustomEmailPool(state?.customEmailPool).length;
}

function hasUnusedCustomEmailPoolEntry(state = {}) {
  return getUnusedCustomEmailPoolCount(state) > 0;
}

function getCustomMailProviderPool(state = {}) {
  return normalizeCustomEmailPool(state?.customMailProviderPool);
}

function getCustomMailProviderPoolEmailForRun(state = {}, targetRun = 1) {
  const entries = getCustomMailProviderPool(state);
  const numericRun = Math.max(1, Math.floor(Number(targetRun) || 1));
  return entries[numericRun - 1] || '';
}

function normalizePanelMode(value = '') {
  return DEFAULT_PANEL_MODE;
}

function normalizePlusAccountAccessStrategy(value = '') {
  return PLUS_ACCOUNT_ACCESS_STRATEGY_OAUTH;
}

function normalizePlusAccountAccessStrategyForState(state = {}) {
  return PLUS_ACCOUNT_ACCESS_STRATEGY_OAUTH;
}

function normalizeMailProvider(value = '') {
  return ICLOUD_API_PROVIDER;
}

function buildLuckmailSessionSettingsPayload(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const payload = {};

  if (input.luckmailApiKey !== undefined) {
    payload.luckmailApiKey = String(input.luckmailApiKey || '');
  }
  if (input.luckmailBaseUrl !== undefined) {
    payload.luckmailBaseUrl = normalizeLuckmailBaseUrl(input.luckmailBaseUrl);
  }
  if (input.luckmailEmailType !== undefined) {
    payload.luckmailEmailType = normalizeLuckmailEmailType(input.luckmailEmailType);
  }
  if (input.luckmailDomain !== undefined) {
    payload.luckmailDomain = String(input.luckmailDomain || '').trim();
  }
  if (input.luckmailUsedPurchases !== undefined) {
    payload.luckmailUsedPurchases = normalizeLuckmailUsedPurchases(input.luckmailUsedPurchases);
  }
  if (input.luckmailPreserveTagId !== undefined) {
    payload.luckmailPreserveTagId = Number(input.luckmailPreserveTagId) || 0;
  }
  if (input.luckmailPreserveTagName !== undefined) {
    payload.luckmailPreserveTagName = String(input.luckmailPreserveTagName || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME;
  }
  if (input.currentLuckmailPurchase !== undefined) {
    payload.currentLuckmailPurchase = input.currentLuckmailPurchase
      ? normalizeLuckmailPurchase(input.currentLuckmailPurchase)
      : null;
  }
  if (input.currentLuckmailMailCursor !== undefined) {
    payload.currentLuckmailMailCursor = input.currentLuckmailMailCursor
      ? normalizeLuckmailMailCursor(input.currentLuckmailMailCursor)
      : null;
  }

  return payload;
}

function normalizeMail2925Mode(value = '') {
  return String(value || '').trim().toLowerCase() === MAIL_2925_MODE_RECEIVE
    ? MAIL_2925_MODE_RECEIVE
    : DEFAULT_MAIL_2925_MODE;
}

function normalizeCloudflareTempEmailLookupMode(value = '') {
  return String(value || '').trim().toLowerCase() === CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL
    ? CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL
    : DEFAULT_CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE;
}

function normalizeLocalCpaStep9Mode(value = '') {
  return String(value || '').trim().toLowerCase() === 'bypass'
    ? 'bypass'
    : DEFAULT_LOCAL_CPA_STEP9_MODE;
}

function normalizeCloudflareDomain(rawValue = '') {
  let value = String(rawValue || '').trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^@+/, '');
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return '';
  return value;
}

function normalizeCloudflareDomains(values) {
  const normalizedDomains = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeCloudflareDomain(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedDomains.push(normalized);
  }

  return normalizedDomains;
}

function normalizeHotmailRemoteBaseUrl(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return DEFAULT_HOTMAIL_REMOTE_BASE_URL;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return DEFAULT_HOTMAIL_REMOTE_BASE_URL;
    }

    if (parsed.pathname.endsWith('/api/mail-new') || parsed.pathname.endsWith('/api/mail-all') || parsed.pathname === '/api.html') {
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
    }

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_HOTMAIL_REMOTE_BASE_URL;
  }
}

function normalizeHotmailLocalBaseUrl(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return DEFAULT_HOTMAIL_LOCAL_BASE_URL;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return DEFAULT_HOTMAIL_LOCAL_BASE_URL;
    }

    if (['/messages', '/code', '/clear', '/token'].includes(parsed.pathname)) {
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
    }

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_HOTMAIL_LOCAL_BASE_URL;
  }
}

function normalizeAccountRunHistoryHelperBaseUrl(rawValue = '') {
  const value = String(rawValue || '').trim();
  if (!value) return DEFAULT_ACCOUNT_RUN_HISTORY_HELPER_BASE_URL;

  try {
    const parsed = new URL(value);
    if (parsed.pathname === '/append-account-log' || parsed.pathname === '/sync-account-run-records') {
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
    }
    return normalizeHotmailLocalBaseUrl(parsed.toString());
  } catch {
    return normalizeHotmailLocalBaseUrl(value);
  }
}

function getHotmailServiceSettings(state = {}) {
  return {
    mode: normalizeHotmailServiceMode(state.hotmailServiceMode),
    remoteBaseUrl: normalizeHotmailRemoteBaseUrl(state.hotmailRemoteBaseUrl),
    localBaseUrl: normalizeHotmailLocalBaseUrl(state.hotmailLocalBaseUrl),
  };
}

function getCloudflareTempEmailConfig(state = {}) {
  return {
    baseUrl: normalizeCloudflareTempEmailBaseUrl(state.cloudflareTempEmailBaseUrl),
    adminAuth: String(state.cloudflareTempEmailAdminAuth || ''),
    customAuth: String(state.cloudflareTempEmailCustomAuth || ''),
    lookupMode: normalizeCloudflareTempEmailLookupMode(state.cloudflareTempEmailLookupMode),
    receiveMailbox: normalizeCloudflareTempEmailReceiveMailbox(state.cloudflareTempEmailReceiveMailbox),
    useRandomSubdomain: Boolean(state.cloudflareTempEmailUseRandomSubdomain),
    domain: normalizeCloudflareTempEmailDomain(state.cloudflareTempEmailDomain),
    domains: normalizeCloudflareTempEmailDomains(state.cloudflareTempEmailDomains),
  };
}

function normalizeCloudflareTempEmailReceiveMailbox(value = '') {
  const normalized = normalizeCloudflareTempEmailAddress(value);
  if (!normalized) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

function resolveCloudflareTempEmailPollTargetEmail(state = {}, pollPayload = {}, config = getCloudflareTempEmailConfig(state)) {
  const configuredReceiveMailbox = normalizeCloudflareTempEmailReceiveMailbox(config.receiveMailbox);
  const mailProvider = String(state?.mailProvider || '').trim().toLowerCase();
  const emailGenerator = String(state?.emailGenerator || '').trim().toLowerCase();
  const shouldPreferConfiguredReceiveMailbox = mailProvider === 'cloudflare-temp-email'
    && emailGenerator !== 'cloudflare-temp-email';
  const requestedTarget = normalizeCloudflareTempEmailReceiveMailbox(pollPayload.targetEmail);
  if (
    shouldPreferConfiguredReceiveMailbox
    && normalizeCloudflareTempEmailLookupMode(config.lookupMode) === CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL
  ) {
    return requestedTarget || normalizeCloudflareTempEmailReceiveMailbox(state.email);
  }

  if (shouldPreferConfiguredReceiveMailbox && configuredReceiveMailbox) {
    return configuredReceiveMailbox;
  }

  if (requestedTarget) {
    return requestedTarget;
  }

  return normalizeCloudflareTempEmailReceiveMailbox(state.email);
}

const cloudMailProvider = self.MultiPageBackgroundCloudMailProvider.createCloudMailProvider({
  addLog,
  buildCloudMailHeaders,
  CLOUD_MAIL_DEFAULT_PAGE_SIZE,
  CLOUD_MAIL_GENERATOR,
  CLOUD_MAIL_PROVIDER,
  getCloudMailTokenFromResponse,
  getState,
  joinCloudMailUrl,
  normalizeCloudMailAddress,
  normalizeCloudMailBaseUrl,
  normalizeCloudMailDomain,
  normalizeCloudMailDomains,
  normalizeCloudMailMailApiMessages,
  persistRegistrationEmailState,
  pickVerificationMessageWithTimeFallback,
  setEmailState,
  setPersistentSettings,
  sleepWithStop,
  throwIfStopped,
});
const {
  getCloudMailConfig,
  normalizeCloudMailReceiveMailbox,
  fetchCloudMailAddress,
  pollCloudMailVerificationCode,
  resolveCloudMailPollTargetEmail,
} = cloudMailProvider;
const icloudApiProvider = self.MultiPageBackgroundIcloudApiProvider?.createIcloudApiProvider({
  addLog,
  extractVerificationCodeFromMessage,
  getState,
  setState,
  sleepWithStop,
  throwIfStopped,
});
const {
  pollIcloudApiVerificationCode,
  resolveIcloudApiPollTarget,
} = icloudApiProvider || {};
const multiThreadWorkbench = self.MultiPageBackgroundMultiThreadWorkbench?.createMultiThreadWorkbench({
  addLog,
  broadcastDataUpdate,
  getCheckoutConversionProxyPoolEntries,
  getState,
  normalizeCheckoutConversionProxyInput,
  normalizeExternalRedeemCdkey,
  normalizeExternalRedeemCdkeyPoolText,
  readExternalRedeemRecordsFromSqlite,
  setPersistentSettings,
  setState,
});

function normalizeSub2ApiGroupNames(value = '') {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[\r\n,，、]+/);
  const names = [];
  const seen = new Set();
  for (const item of source) {
    const name = String(item || '').trim();
    const key = name.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names;
}

function normalizeSub2ApiAccountPriority(value, fallback = DEFAULT_SUB2API_ACCOUNT_PRIORITY) {
  const rawValue = String(value ?? '').trim();
  const numeric = Number(rawValue);
  if (!rawValue || !Number.isSafeInteger(numeric) || numeric < 1) {
    const fallbackNumber = Number(fallback);
    return Number.isSafeInteger(fallbackNumber) && fallbackNumber >= 1
      ? fallbackNumber
      : DEFAULT_SUB2API_ACCOUNT_PRIORITY;
  }
  return numeric;
}

function normalizePersistentSettingValue(key, value) {
  switch (key) {
    case 'panelMode':
      return normalizePanelMode(value);
    case 'vpsUrl':
      return String(value || '').trim();
    case 'vpsPassword':
      return String(value || '');
    case 'localCpaStep9Mode':
      return normalizeLocalCpaStep9Mode(value);
    case 'sub2apiUrl':
      return String(value || '').trim();
    case 'sub2apiEmail':
      return String(value || '').trim();
    case 'sub2apiPassword':
      return String(value || '');
    case 'sub2apiGroupName':
      return String(value || '').trim();
    case 'sub2apiGroupNames':
      return normalizeSub2ApiGroupNames(value);
    case 'sub2apiAccountPriority':
      return normalizeSub2ApiAccountPriority(value);
    case 'sub2apiDefaultProxyName':
      return String(value || '').trim();
    case 'ipProxyEnabled':
      return Boolean(value);
    case 'ipProxyService':
      return normalizeIpProxyProviderValue(value);
    case 'ipProxyMode':
      return normalizeIpProxyMode(value);
    case 'ipProxyApiUrl':
      return String(value || '').trim();
    case 'ipProxyServiceProfiles':
      return normalizeIpProxyServiceProfiles(value || {}, PERSISTED_SETTING_DEFAULTS);
    case 'ipProxyAccountList':
      return normalizeIpProxyAccountList(value || '');
    case 'ipProxyAccountSessionPrefix':
      return normalizeIpProxyAccountSessionPrefix(value || '');
    case 'ipProxyAccountLifeMinutes':
      return normalizeIpProxyAccountLifeMinutes(value || '');
    case 'ipProxyPoolTargetCount':
      return normalizeIpProxyPoolTargetCount(value || '', 20);
    case 'ipProxyAutoSyncEnabled':
      return Boolean(value);
    case 'ipProxyAutoSyncIntervalMinutes':
      return normalizeIpProxyAutoSyncIntervalMinutes(
        value,
        PERSISTED_SETTING_DEFAULTS.ipProxyAutoSyncIntervalMinutes
      );
    case 'ipProxyHost':
      return String(value || '').trim();
    case 'ipProxyPort':
      return String(normalizeIpProxyPort(value || '') || '');
    case 'ipProxyProtocol':
      return normalizeIpProxyProtocol(value);
    case 'ipProxyUsername':
      return String(value || '').trim();
    case 'ipProxyPassword':
      return String(value || '');
    case 'ipProxyRegion':
      return String(value || '').trim();
    case 'ipProxyApiPool':
      return normalizeProxyPoolEntries(
        value,
        normalizeIpProxyProviderValue(value?.provider || DEFAULT_IP_PROXY_SERVICE)
      );
    case 'ipProxyApiCurrentIndex':
      return normalizeIpProxyCurrentIndex(value, 0);
    case 'ipProxyApiCurrent':
      return normalizeProxyPoolEntries(value ? [value] : [], DEFAULT_IP_PROXY_SERVICE)[0] || null;
    case 'ipProxyAccountPool':
      return normalizeProxyPoolEntries(
        value,
        normalizeIpProxyProviderValue(value?.provider || DEFAULT_IP_PROXY_SERVICE)
      );
    case 'ipProxyAccountCurrentIndex':
      return normalizeIpProxyCurrentIndex(value, 0);
    case 'ipProxyAccountCurrent':
      return normalizeProxyPoolEntries(value ? [value] : [], DEFAULT_IP_PROXY_SERVICE)[0] || null;
    case 'ipProxyPool':
      return normalizeProxyPoolEntries(
        value,
        normalizeIpProxyProviderValue(value?.provider || DEFAULT_IP_PROXY_SERVICE)
      );
    case 'ipProxyCurrentIndex':
      return normalizeIpProxyCurrentIndex(value, 0);
    case 'ipProxyCurrent':
      return normalizeProxyPoolEntries(value ? [value] : [], DEFAULT_IP_PROXY_SERVICE)[0] || null;
    case 'codex2apiUrl':
      return normalizeCodex2ApiUrl(value);
    case 'codex2apiAdminKey':
      return String(value || '').trim();
    case 'customPassword':
      return String(value || '');
    case 'signupMethod':
      return normalizeSignupMethod(value);
    case 'plusPaymentMethod':
      return normalizePlusPaymentMethod(value);
    case 'plusAccountAccessStrategy':
      return normalizePlusAccountAccessStrategy(value);
    case 'plusCheckoutConversionProxyUrl':
      return normalizeCheckoutConversionProxyInput(value);
    case 'plusCheckoutConversionProxyPoolText':
      return normalizeCheckoutConversionProxyPoolText(value);
    case 'plusCheckoutConversionProxyPoolIndex':
      return normalizeCheckoutConversionProxyPoolIndex(value);
    case 'autoRunSkipFailures':
    case 'oauthFlowTimeoutEnabled':
    case 'autoRunDelayEnabled':
      return Boolean(value);
    case 'operationDelayEnabled':
      return typeof value === 'boolean' ? value : true;
    case 'step6CookieCleanupEnabled':
    case 'phoneVerificationEnabled':
    case 'phoneSignupReloginAfterBindEmailEnabled':
    case 'phoneSmsReuseEnabled':
    case 'freePhoneReuseEnabled':
    case 'freePhoneReuseAutoEnabled':
    case 'plusModeEnabled':
    case 'externalRedeemEnabled':
    case 'chatgptTotpAutoEnable':
    case 'multiThreadEnabled':
    case 'feishuSyncEnabled':
      return Boolean(value);
    case 'externalRedeemBaseUrl':
      return normalizeExternalRedeemBaseUrl(value);
    case 'externalRedeemApiKey':
      return String(value || '').trim();
    case 'externalRedeemCdkeyPoolText':
      return normalizeExternalRedeemCdkeyPoolText(value);
    case 'externalRedeemPollSeconds':
      return normalizeExternalRedeemPollSeconds(value);
    case 'k12WorkspaceId':
      return String(value || self.GuJumpgateK12Workspace?.DEFAULT_WORKSPACE_ID || '631e1603-06cf-4f0b-b79b-d09fbfcfe98d').trim()
        || (self.GuJumpgateK12Workspace?.DEFAULT_WORKSPACE_ID || '631e1603-06cf-4f0b-b79b-d09fbfcfe98d');
    case 'k12IcloudApiMode':
      return normalizeIcloudApiModeValue(value);
    case 'k12EmailPoolText':
      return String(value || '').trim();
    case 'k12EmailPoolEntries':
      return normalizeCustomEmailPoolEntryObjects(value);
    case 'multiThreadCount':
      return normalizeMultiThreadCount(value);
    case 'feishuAppId':
    case 'feishuAppSecret':
    case 'feishuBitableAppToken':
    case 'feishuBitableTableId':
      return String(value || '').trim();
    case 'phoneSmsProvider':
      return normalizePhoneSmsProvider(value);
    case 'phoneSmsProviderOrder':
      return normalizePhoneSmsProviderOrder(value);
    case 'autoRunFallbackThreadIntervalMinutes':
      return normalizeAutoRunFallbackThreadIntervalMinutes(value);
    case 'autoRunDelayMinutes':
      return normalizeAutoRunDelayMinutes(value);
    case 'autoStepDelaySeconds':
      return normalizeAutoStepDelaySeconds(value, PERSISTED_SETTING_DEFAULTS.autoStepDelaySeconds);
    case 'verificationResendCount':
      return normalizeVerificationResendCount(value, DEFAULT_VERIFICATION_RESEND_COUNT);
    case 'phoneVerificationReplacementLimit':
      return normalizePhoneVerificationReplacementLimit(value, DEFAULT_PHONE_VERIFICATION_REPLACEMENT_LIMIT);
    case 'phoneCodeWaitSeconds':
      return normalizePhoneCodeWaitSeconds(value, DEFAULT_PHONE_CODE_WAIT_SECONDS);
    case 'phoneCodeTimeoutWindows':
      return normalizePhoneCodeTimeoutWindows(value, DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS);
    case 'phoneCodePollIntervalSeconds':
      return normalizePhoneCodePollIntervalSeconds(value, DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS);
    case 'phoneCodePollMaxRounds':
      return normalizePhoneCodePollMaxRounds(value, DEFAULT_PHONE_CODE_POLL_ROUNDS);
    case 'mailProvider':
      {
        const normalizedMailProvider = normalizeMailProvider(value);
        if (normalizedMailProvider === CLOUDFLARE_TEMP_EMAIL_PROVIDER) {
          return CLOUDFLARE_TEMP_EMAIL_PROVIDER;
        }
        if (normalizedMailProvider === CLOUD_MAIL_PROVIDER) {
          return CLOUD_MAIL_PROVIDER;
        }
        if (normalizedMailProvider === ICLOUD_API_PROVIDER) {
          return ICLOUD_API_PROVIDER;
        }
        return HOTMAIL_PROVIDER;
      }
    case 'mail2925Mode':
      return normalizeMail2925Mode(value);
    case 'mail2925UseAccountPool':
      return Boolean(value);
    case 'emailGenerator':
      return normalizeEmailGenerator(value);
    case 'customMailProviderPool':
    case 'customEmailPool':
      return normalizeCustomEmailPool(value);
    case 'customEmailPoolEntries':
      return normalizeCustomEmailPoolEntryObjects(value);
    case 'autoDeleteUsedIcloudAlias':
    case 'accountRunHistoryTextEnabled':
    case 'cloudflareTempEmailUseRandomSubdomain':
      return Boolean(value);
    case 'icloudHostPreference':
      return normalizeIcloudHost(value) || 'auto';
    case 'icloudTargetMailboxType':
      return normalizeIcloudTargetMailboxType(value);
    case 'icloudForwardMailProvider':
      return normalizeIcloudForwardMailProvider(value);
    case 'icloudFetchMode':
      return normalizeIcloudFetchMode(value);
    case 'accountRunHistoryHelperBaseUrl':
      return normalizeAccountRunHistoryHelperBaseUrl(value);
    case 'localCpaJsonPluginDir':
      return normalizeLocalCpaJsonPluginDir(value);
    case 'localCpaJsonRelativeAuthDir':
      return normalizeLocalCpaJsonRelativeAuthDir(value);
    case 'gmailBaseEmail':
    case 'mail2925BaseEmail':
    case 'currentMail2925AccountId':
    case 'emailPrefix':
      return String(value || '').trim();
    case 'inbucketHost':
      return String(value || '').trim();
    case 'inbucketMailbox':
      return String(value || '').trim();
    case 'hotmailServiceMode':
      return normalizeHotmailServiceMode(value);
    case 'hotmailRemoteBaseUrl':
      return normalizeHotmailRemoteBaseUrl(value);
    case 'hotmailLocalBaseUrl':
      return normalizeHotmailLocalBaseUrl(value);
    case 'luckmailApiKey':
      return String(value || '');
    case 'luckmailBaseUrl':
      return normalizeLuckmailBaseUrl(value);
    case 'luckmailEmailType':
      return normalizeLuckmailEmailType(value);
    case 'luckmailDomain':
      return String(value || '').trim();
    case 'luckmailUsedPurchases':
      return normalizeLuckmailUsedPurchases(value);
    case 'luckmailPreserveTagId':
      return Number(value) || 0;
    case 'luckmailPreserveTagName':
      return String(value || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME;
    case 'cloudflareDomain':
      return normalizeCloudflareDomain(value);
    case 'cloudflareDomains':
      return normalizeCloudflareDomains(value);
    case 'cloudflareTempEmailBaseUrl':
      return normalizeCloudflareTempEmailBaseUrl(value);
    case 'cloudflareTempEmailAdminAuth':
    case 'cloudflareTempEmailCustomAuth':
      return String(value || '');
    case 'cloudflareTempEmailLookupMode':
      return normalizeCloudflareTempEmailLookupMode(value);
    case 'cloudflareTempEmailReceiveMailbox':
      return normalizeCloudflareTempEmailReceiveMailbox(value);
    case 'cloudflareTempEmailDomain':
      return normalizeCloudflareTempEmailDomain(value);
    case 'cloudflareTempEmailDomains':
      return normalizeCloudflareTempEmailDomains(value);
    case 'cloudMailBaseUrl':
      return normalizeCloudMailBaseUrl(value);
    case 'cloudMailAdminEmail':
      return String(value || '').trim();
    case 'cloudMailAdminPassword':
    case 'cloudMailToken':
      return String(value || '');
    case 'cloudMailReceiveMailbox':
      return normalizeCloudMailReceiveMailbox(value);
    case 'cloudMailDomain':
      return normalizeCloudMailDomain(value);
    case 'cloudMailDomains':
      return normalizeCloudMailDomains(value);
    case 'icloudApiVerificationUrl':
      return normalizeVerificationUrlValue(value);
    case 'icloudApiMode':
      return normalizeIcloudApiModeValue(value);
    case 'hotmailAccounts':
      return normalizeHotmailAccounts(value);
    case 'hotmailAliasEnabled':
      return Boolean(value);
    case 'outlookAliasMaxPerAccount':
      return normalizeOutlookAliasMaxPerAccount(
        value,
        PERSISTED_SETTING_DEFAULTS.outlookAliasMaxPerAccount
      );
    case 'hotmailAliasUsage':
      return normalizeHotmailAliasUsage(value);
    case 'mail2925Accounts':
      return normalizeMail2925Accounts(value);
    case 'phoneSmsProvider':
      return normalizePhoneSmsProvider(value);
    case 'heroSmsApiKey':
      return String(value || '');
    case 'heroSmsReuseEnabled':
      return Boolean(value);
    case 'heroSmsAcquirePriority':
      return normalizeHeroSmsAcquirePriority(value);
    case 'heroSmsMinPrice':
    case 'heroSmsMaxPrice':
      return normalizeHeroSmsMaxPrice(value);
    case 'heroSmsPreferredPrice':
      return normalizeHeroSmsMaxPrice(value);
    case 'heroSmsCountryId': {
      const parsed = Math.floor(Number(value));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      return HERO_SMS_COUNTRY_ID;
    }
    case 'heroSmsCountryLabel':
      return String(value || HERO_SMS_COUNTRY_LABEL).trim() || HERO_SMS_COUNTRY_LABEL;
    case 'heroSmsCountryFallback':
      return normalizeHeroSmsCountryFallback(value);
    case 'fiveSimApiKey':
      return String(value || '');
    case 'fiveSimProduct':
      return normalizeFiveSimCountryCode(value, DEFAULT_FIVE_SIM_PRODUCT);
    case 'fiveSimCountryId':
      return normalizeFiveSimCountryId(value);
    case 'fiveSimCountryLabel':
      return normalizeFiveSimCountryLabel(value);
    case 'fiveSimCountryFallback':
      return normalizeFiveSimCountryFallback(value);
    case 'fiveSimCountryOrder':
      return normalizeFiveSimCountryOrder(value);
    case 'fiveSimMinPrice':
    case 'fiveSimMaxPrice':
      return normalizeFiveSimMaxPrice(value);
    case 'fiveSimOperator':
      return normalizeFiveSimOperator(value);
    case 'nexSmsApiKey':
      return String(value || '');
    case 'nexSmsCountryOrder':
      return normalizeNexSmsCountryOrder(value);
    case 'nexSmsServiceCode':
      return normalizeNexSmsServiceCode(value);
    case 'phonePreferredActivation':
      return normalizePhonePreferredActivation(value);
    default:
      return value;
  }
}

function buildPersistentSettingsPayload(input = {}, options = {}) {
  const { fillDefaults = false, requireKnownKeys = false } = options;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('\u914d\u7f6e\u5185\u5bb9\u683c\u5f0f\u65e0\u6548\u3002');
  }

  const persistedSettingDefaults = typeof PERSISTED_SETTING_DEFAULTS !== 'undefined' && PERSISTED_SETTING_DEFAULTS
    ? PERSISTED_SETTING_DEFAULTS
    : {};
  const persistedSettingKeys = Array.isArray(typeof PERSISTED_SETTING_KEYS !== 'undefined' ? PERSISTED_SETTING_KEYS : null)
    ? PERSISTED_SETTING_KEYS
    : Object.keys(persistedSettingDefaults);

  const normalizedInput = { ...input };
  if (normalizedInput.autoStepDelaySeconds === undefined) {
    const legacyAutoStepDelaySeconds = resolveLegacyAutoStepDelaySeconds(normalizedInput);
    if (legacyAutoStepDelaySeconds !== undefined) {
      normalizedInput.autoStepDelaySeconds = legacyAutoStepDelaySeconds;
    }
  }
  if (normalizedInput.verificationResendCount === undefined) {
    const legacyVerificationResendCount = normalizedInput.signupVerificationResendCount !== undefined
      ? normalizedInput.signupVerificationResendCount
      : normalizedInput.loginVerificationResendCount;
    if (legacyVerificationResendCount !== undefined) {
      normalizedInput.verificationResendCount = legacyVerificationResendCount;
    }
  }

  const payload = {};
  let matchedKeyCount = 0;
  for (const key of persistedSettingKeys) {
    if (normalizedInput[key] !== undefined) {
      payload[key] = normalizePersistentSettingValue(key, normalizedInput[key]);
      matchedKeyCount += 1;
    } else if (fillDefaults) {
      payload[key] = normalizePersistentSettingValue(key, persistedSettingDefaults[key]);
    }
  }

  const hasPhoneSmsReuseEnabled = Object.prototype.hasOwnProperty.call(normalizedInput, 'phoneSmsReuseEnabled');
  const hasHeroSmsReuseEnabled = Object.prototype.hasOwnProperty.call(normalizedInput, 'heroSmsReuseEnabled');
  const hasFiveSimReuseEnabled = Object.prototype.hasOwnProperty.call(normalizedInput, 'fiveSimReuseEnabled');
  if (hasPhoneSmsReuseEnabled || hasHeroSmsReuseEnabled || hasFiveSimReuseEnabled) {
    const reuseSource = hasPhoneSmsReuseEnabled
      ? normalizedInput.phoneSmsReuseEnabled
      : (hasHeroSmsReuseEnabled
        ? normalizedInput.heroSmsReuseEnabled
        : normalizedInput.fiveSimReuseEnabled);
    const normalizedReuseEnabled = normalizePersistentSettingValue('phoneSmsReuseEnabled', reuseSource);
    payload.phoneSmsReuseEnabled = normalizedReuseEnabled;
    payload.heroSmsReuseEnabled = normalizedReuseEnabled;
  }

  if (requireKnownKeys && matchedKeyCount === 0) {
    throw new Error('\u914d\u7f6e\u6587\u4ef6\u4e2d\u6ca1\u6709\u53ef\u8bc6\u522b\u7684\u914d\u7f6e\u5185\u5bb9\u3002');
  }

  if (payload.cloudflareDomains) {
    const domains = normalizeCloudflareDomains(payload.cloudflareDomains);
    if (payload.cloudflareDomain && !domains.includes(payload.cloudflareDomain)) {
      domains.unshift(payload.cloudflareDomain);
    }
    payload.cloudflareDomains = domains;
  }
  if (payload.cloudflareTempEmailDomains) {
    const domains = normalizeCloudflareTempEmailDomains(payload.cloudflareTempEmailDomains);
    if (payload.cloudflareTempEmailDomain && !domains.includes(payload.cloudflareTempEmailDomain)) {
      domains.unshift(payload.cloudflareTempEmailDomain);
    }
    payload.cloudflareTempEmailDomains = domains;
  }
  if (payload.cloudMailDomains) {
    const domains = normalizeCloudMailDomains(payload.cloudMailDomains);
    if (payload.cloudMailDomain && !domains.includes(payload.cloudMailDomain)) {
      domains.unshift(payload.cloudMailDomain);
    }
    payload.cloudMailDomains = domains;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, 'sub2apiGroupName')
    || Object.prototype.hasOwnProperty.call(payload, 'sub2apiGroupNames')
  ) {
    const groupNames = normalizeSub2ApiGroupNames([
      ...(Array.isArray(payload.sub2apiGroupNames) ? payload.sub2apiGroupNames : []),
      payload.sub2apiGroupName,
    ]);
    payload.sub2apiGroupNames = groupNames.length
      ? groupNames
      : [...DEFAULT_SUB2API_GROUP_NAMES];
  }
  const nextSignupConstraintState = {
    ...PERSISTED_SETTING_DEFAULTS,
    ...payload,
    resolvedSignupMethod: null,
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'phoneVerificationEnabled')
    || Object.prototype.hasOwnProperty.call(payload, 'plusModeEnabled')
    || Object.prototype.hasOwnProperty.call(payload, 'signupMethod')
    || Object.prototype.hasOwnProperty.call(payload, 'panelMode')
    || Object.prototype.hasOwnProperty.call(payload, 'activeFlowId')) {
    payload.signupMethod = resolveSignupMethod(nextSignupConstraintState);
  }
  if (payload.ipProxyServiceProfiles) {
    const selectedService = normalizeIpProxyProviderValue(
      payload.ipProxyService || PERSISTED_SETTING_DEFAULTS.ipProxyService
    );
    const normalizedProfiles = normalizeIpProxyServiceProfiles(payload.ipProxyServiceProfiles, {
      ...PERSISTED_SETTING_DEFAULTS,
      ...payload,
    });
    payload.ipProxyServiceProfiles = normalizedProfiles;
    const activeProfile = normalizedProfiles[selectedService]
      || buildIpProxyServiceProfileFromState({
        ...PERSISTED_SETTING_DEFAULTS,
        ...payload,
      });
    payload.ipProxyService = selectedService;
    payload.ipProxyMode = normalizeIpProxyMode(activeProfile?.mode || payload.ipProxyMode);
    payload.ipProxyApiUrl = String(activeProfile?.apiUrl || payload.ipProxyApiUrl || '').trim();
    payload.ipProxyAccountList = normalizeIpProxyAccountList(activeProfile?.accountList || payload.ipProxyAccountList || '');
    payload.ipProxyAccountSessionPrefix = normalizeIpProxyAccountSessionPrefix(activeProfile?.accountSessionPrefix || payload.ipProxyAccountSessionPrefix || '');
    payload.ipProxyAccountLifeMinutes = normalizeIpProxyAccountLifeMinutes(activeProfile?.accountLifeMinutes || payload.ipProxyAccountLifeMinutes || '');
    payload.ipProxyPoolTargetCount = normalizeIpProxyPoolTargetCount(activeProfile?.poolTargetCount || payload.ipProxyPoolTargetCount || '', 20);
    payload.ipProxyHost = String(activeProfile?.host || payload.ipProxyHost || '').trim();
    payload.ipProxyPort = String(normalizeIpProxyPort(activeProfile?.port || payload.ipProxyPort || '') || '');
    payload.ipProxyProtocol = normalizeIpProxyProtocol(activeProfile?.protocol || payload.ipProxyProtocol);
    payload.ipProxyUsername = String(activeProfile?.username || payload.ipProxyUsername || '').trim();
    payload.ipProxyPassword = String(activeProfile?.password || payload.ipProxyPassword || '');
    payload.ipProxyRegion = String(activeProfile?.region || payload.ipProxyRegion || '').trim();
  }

  return payload;
}

async function getPersistedSettings() {
  const stored = await chrome.storage.local.get([
    ...PERSISTED_SETTING_KEYS,
    ...LEGACY_AUTO_STEP_DELAY_KEYS,
    ...LEGACY_VERIFICATION_RESEND_COUNT_KEYS,
  ]);
  const settings = buildPersistentSettingsPayload(stored, { fillDefaults: true });
  const migrationVersion = Number(stored.chatgptTotpOptionalMigrationVersion) || 0;
  if (migrationVersion < CHATGPT_TOTP_OPTIONAL_MIGRATION_VERSION) {
    settings.chatgptTotpAutoEnable = false;
    settings.chatgptTotpOptionalMigrationVersion = CHATGPT_TOTP_OPTIONAL_MIGRATION_VERSION;
    chrome.storage.local.set({
      chatgptTotpAutoEnable: false,
      chatgptTotpOptionalMigrationVersion: CHATGPT_TOTP_OPTIONAL_MIGRATION_VERSION,
    }).catch((err) => {
      console.warn(LOG_PREFIX, 'Failed to migrate optional 2FA setting:', err?.message || err);
    });
  }
  return settings;
}

async function getPersistedAliasState() {
  try {
    const stored = await chrome.storage.local.get(PERSISTENT_ALIAS_STATE_KEYS);
    const manualAliasUsage = normalizeBooleanMap(stored.manualAliasUsage);
    const preservedAliases = normalizeBooleanMap(stored.preservedAliases);
    return {
      manualAliasUsage,
    preservedAliases,
    icloudAliasCache: normalizeIcloudAliasCacheList(stored.icloudAliasCache, {
      usedEmails: toNormalizedEmailSet(manualAliasUsage),
      preservedEmails: toNormalizedEmailSet(preservedAliases),
    }),
      icloudAliasCacheAt: Math.max(0, Number(stored.icloudAliasCacheAt) || 0),
    };
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to read persisted iCloud alias state:', err?.message || err);
    return {
      manualAliasUsage: {},
      preservedAliases: {},
      icloudAliasCache: [],
      icloudAliasCacheAt: 0,
    };
  }
}

async function getState() {
  const [state, persistedSettings, persistedAliasState, accountRunHistory] = await Promise.all([
    chrome.storage.session.get(null),
    getPersistedSettings(),
    getPersistedAliasState(),
    accountRunHistoryHelpers?.getPersistedAccountRunHistory?.() || [],
  ]);
  const view = buildStateViewWithRuntimeState({
    ...DEFAULT_STATE,
    ...persistedSettings,
    ...persistedAliasState,
    ...state,
    accountRunHistory,
  });
  if (Number(view?.automationWindowId) <= 0) {
    view.automationWindowId = null;
  }
  if (view?.runtimeState?.sharedState && Number(view.runtimeState.sharedState.automationWindowId) <= 0) {
    view.runtimeState.sharedState.automationWindowId = null;
  }
  return view;
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

function redactStateLogPreview(value, depth = 0) {
  if (depth > 4) {
    return '[nested]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => redactStateLogPreview(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const normalizedKey = String(key || '').toLowerCase();
      if (/(token|secret|password|authorization|apikey|api_key|refresh)/.test(normalizedKey)) {
        return [key, item ? '[redacted]' : item];
      }
      return [key, redactStateLogPreview(item, depth + 1)];
    }));
  }
  return value;
}

async function setState(updates) {
  let preview = '{}';
  try {
    preview = JSON.stringify(redactStateLogPreview(updates)).slice(0, 200);
  } catch (_) {
    preview = '[unserializable]';
  }
  console.log(LOG_PREFIX, 'storage.set:', preview);
  if (Object.keys(updates || {}).length > 0) {
    const currentSessionState = await chrome.storage.session.get(null);
    const sessionUpdates = buildStatePatchWithRuntimeState({
      ...DEFAULT_STATE,
      ...currentSessionState,
    }, updates);
    await chrome.storage.session.set(sessionUpdates);
    const persistentAliasUpdates = {};
    if (Object.prototype.hasOwnProperty.call(sessionUpdates, 'manualAliasUsage')) {
      persistentAliasUpdates.manualAliasUsage = normalizeBooleanMap(sessionUpdates.manualAliasUsage);
    }
    if (Object.prototype.hasOwnProperty.call(sessionUpdates, 'preservedAliases')) {
      persistentAliasUpdates.preservedAliases = normalizeBooleanMap(sessionUpdates.preservedAliases);
    }
    if (Object.prototype.hasOwnProperty.call(sessionUpdates, 'icloudAliasCache')) {
      persistentAliasUpdates.icloudAliasCache = normalizeIcloudAliasCacheList(sessionUpdates.icloudAliasCache);
    }
    if (Object.prototype.hasOwnProperty.call(sessionUpdates, 'icloudAliasCacheAt')) {
      persistentAliasUpdates.icloudAliasCacheAt = Math.max(0, Number(sessionUpdates.icloudAliasCacheAt) || 0);
    }
    if (Object.keys(persistentAliasUpdates).length > 0) {
      await chrome.storage.local.set(persistentAliasUpdates);
    }
  }
}

function normalizeLocalCpaJsonPluginDir(rawValue = '') {
  return String(rawValue || '').trim();
}

function normalizeLocalCpaJsonRelativeAuthDir(rawValue = '') {
  return String(rawValue || '').trim() || DEFAULT_LOCAL_CPA_JSON_RELATIVE_AUTH_DIR;
}

async function setPersistentSettings(updates) {
  const persistedUpdates = buildPersistentSettingsPayload(updates);

  if (Object.keys(persistedUpdates).length > 0) {
    await chrome.storage.local.set(persistedUpdates);
  }
}

function buildSettingsExportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${SETTINGS_EXPORT_FILENAME_PREFIX}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

async function exportSettingsBundle() {
  const settings = await getPersistedSettings();
  const bundle = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    settings,
  };

  return {
    fileName: buildSettingsExportFilename(),
    fileContent: JSON.stringify(bundle, null, 2),
  };
}

async function importSettingsBundle(configBundle) {
  const state = await ensureManualInteractionAllowed('\u5bfc\u5165\u914d\u7f6e');
  if (Object.values(state.nodeStatuses || {}).some((status) => status === 'running')) {
    throw new Error('\u5f53\u524d\u6709\u6b65\u9aa4\u6b63\u5728\u6267\u884c\uff0c\u65e0\u6cd5\u5bfc\u5165\u914d\u7f6e\u3002');
  }
  if (!configBundle || typeof configBundle !== 'object' || Array.isArray(configBundle)) {
    throw new Error('\u914d\u7f6e\u6587\u4ef6\u5185\u5bb9\u65e0\u6548\u3002');
  }

  const schemaVersion = Number(configBundle.schemaVersion);
  if (schemaVersion !== SETTINGS_EXPORT_SCHEMA_VERSION) {
    throw new Error(`\u4ec5\u652f\u6301\u5bfc\u5165 schemaVersion=${SETTINGS_EXPORT_SCHEMA_VERSION} \u7684\u914d\u7f6e\u6587\u4ef6\u3002`);
  }
  if (!configBundle.settings || typeof configBundle.settings !== 'object' || Array.isArray(configBundle.settings)) {
    throw new Error('\u914d\u7f6e\u6587\u4ef6\u7f3a\u5c11 settings \u914d\u7f6e\u6bb5\u3002');
  }

  const importedSettings = buildPersistentSettingsPayload(configBundle.settings, {
    fillDefaults: true,
    requireKnownKeys: true,
  });
  const importModeValidation = validateModeSwitchState({
    ...state,
    ...importedSettings,
    resolvedSignupMethod: null,
  }, {
    changedKeys: Object.keys(importedSettings),
  });
  if (importModeValidation?.normalizedUpdates && Object.keys(importModeValidation.normalizedUpdates).length > 0) {
    Object.assign(importedSettings, importModeValidation.normalizedUpdates);
  }
  if (
    Object.prototype.hasOwnProperty.call(importedSettings, 'phoneVerificationEnabled')
    || Object.prototype.hasOwnProperty.call(importedSettings, 'plusModeEnabled')
    || Object.prototype.hasOwnProperty.call(importedSettings, 'signupMethod')
    || Object.prototype.hasOwnProperty.call(importedSettings, 'panelMode')
    || Object.prototype.hasOwnProperty.call(importedSettings, 'activeFlowId')
    || Object.prototype.hasOwnProperty.call(importedSettings, 'contributionMode')
  ) {
    importedSettings.signupMethod = resolveSignupMethod({
      ...state,
      ...importedSettings,
      resolvedSignupMethod: null,
    });
  }

  await setPersistentSettings(importedSettings);

  const sessionUpdates = {
    ...importedSettings,
    currentHotmailAccountId: null,
    email: null,
    registrationEmailState: { ...DEFAULT_REGISTRATION_EMAIL_STATE },
  };

  await setState(sessionUpdates);
  broadcastDataUpdate({
    ...importedSettings,
    currentHotmailAccountId: null,
    ...(sessionUpdates.email !== undefined ? { email: sessionUpdates.email } : {}),
    registrationEmailState: sessionUpdates.registrationEmailState,
  });

  return getState();
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => { });
}

function broadcastIcloudAliasesChanged(payload = {}) {
  chrome.runtime.sendMessage({
    type: 'ICLOUD_ALIASES_CHANGED',
    payload,
  }).catch(() => { });
}

function normalizePhoneIdentityDigits(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function getPhoneActivationPhoneNumber(activation = null) {
  if (!activation || typeof activation !== 'object' || Array.isArray(activation)) {
    return '';
  }
  return String(
    activation.phoneNumber
    ?? activation.number
    ?? activation.phone
    ?? ''
  ).trim();
}

function isPhoneActivationForNumber(activation, phoneNumber) {
  const activationPhone = getPhoneActivationPhoneNumber(activation);
  const targetPhone = String(phoneNumber || '').trim();
  if (!activationPhone || !targetPhone) {
    return false;
  }
  if (activationPhone === targetPhone) {
    return true;
  }
  const activationDigits = normalizePhoneIdentityDigits(activationPhone);
  const targetDigits = normalizePhoneIdentityDigits(targetPhone);
  return Boolean(activationDigits && targetDigits && activationDigits === targetDigits);
}

async function setEmailStateSilently(email, options = {}) {
  const currentState = await getState();
  const preserveAccountIdentity = Boolean(options?.preserveAccountIdentity);
  const updates = preserveAccountIdentity
    ? buildFlowRegistrationEmailStateUpdates(currentState, {
        currentEmail: email,
        preservePrevious: Boolean(options?.preservePrevious),
        preserveAccountIdentity: true,
        source: options?.source || '',
      })
    : buildRegistrationEmailStateUpdates(currentState, {
        currentEmail: email,
        preservePrevious: Boolean(options?.preservePrevious),
        source: options?.source || '',
      });
  const normalizedEmail = updates.email;

  if (!preserveAccountIdentity && normalizedEmail) {
    updates.accountIdentifierType = 'email';
    updates.accountIdentifier = normalizedEmail;
    updates.phoneNumber = '';
    updates.signupPhoneNumber = '';
    updates.signupPhoneActivation = null;
    updates.signupPhoneCompletedActivation = null;
    updates.signupPhoneVerificationRequestedAt = null;
    updates.signupPhoneVerificationPurpose = '';
  } else if (!preserveAccountIdentity && String(currentState?.accountIdentifierType || '').trim().toLowerCase() === 'email') {
    updates.accountIdentifierType = null;
    updates.accountIdentifier = '';
  }

  await setState(updates);
  broadcastDataUpdate(updates);
}

async function setEmailState(email, options = {}) {
  await setEmailStateSilently(email, options);
  if (email) {
    const latestState = await getState();
    const recordStatus = shouldMarkAccountRunRecordRunning(latestState) ? 'running' : 'node:submit-signup-email:stopped';
    const recordReason = recordStatus === 'running' ? '正在运行' : '节点 submit-signup-email 已使用邮箱，流程尚未完成。';
    await appendManualAccountRunRecordIfNeeded(recordStatus, latestState, recordReason);
    await resumeAutoRunIfWaitingForEmail();
  }
}

async function persistRegistrationEmailState(state = null, email, options = {}) {
  const currentState = state && typeof state === 'object' && !Array.isArray(state)
    ? state
    : await getState();
  const normalizedEmail = String(email || '').trim() || null;
  const currentEmail = String(currentState?.email || '').trim() || null;
  if (!Boolean(options?.preserveAccountIdentity)) {
    if (normalizedEmail === currentEmail) {
      return;
    }
    await setEmailState(normalizedEmail, options);
    return;
  }

  const updates = normalizedEmail === currentEmail
    ? (() => {
        const preservedPhoneIdentity = getPreservedPhoneIdentity(currentState);
        return preservedPhoneIdentity
          ? {
              phoneNumber: '',
              ...preservedPhoneIdentity,
            }
          : {};
      })()
    : buildFlowRegistrationEmailStateUpdates(currentState, {
        currentEmail: normalizedEmail,
        preservePrevious: Boolean(options?.preservePrevious),
        preserveAccountIdentity: true,
        source: options?.source || '',
      });

  if (!Object.keys(updates).length || !statePatchHasChanges(currentState, updates)) {
    return;
  }
  await setState(updates);
  broadcastDataUpdate(updates);
}

async function setSignupPhoneStateSilently(phoneNumber) {
  const normalizedPhoneNumber = String(phoneNumber || '').trim();
  const currentState = await getState();
  const updates = {
    signupPhoneNumber: normalizedPhoneNumber,
  };

  if (normalizedPhoneNumber) {
    updates.accountIdentifierType = 'phone';
    updates.accountIdentifier = normalizedPhoneNumber;
    updates.phoneNumber = '';
    if (!isPhoneActivationForNumber(currentState?.signupPhoneActivation, normalizedPhoneNumber)) {
      updates.signupPhoneActivation = null;
      updates.signupPhoneVerificationRequestedAt = null;
      updates.signupPhoneVerificationPurpose = '';
    }
    if (!isPhoneActivationForNumber(currentState?.signupPhoneCompletedActivation, normalizedPhoneNumber)) {
      updates.signupPhoneCompletedActivation = null;
    }
  } else if (String(currentState?.accountIdentifierType || '').trim().toLowerCase() === 'phone') {
    updates.accountIdentifierType = null;
    updates.accountIdentifier = '';
    updates.signupPhoneActivation = null;
    updates.signupPhoneCompletedActivation = null;
    updates.signupPhoneVerificationRequestedAt = null;
    updates.signupPhoneVerificationPurpose = '';
  }

  await setState(updates);
  broadcastDataUpdate(updates);
}

async function setSignupPhoneState(phoneNumber) {
  await setSignupPhoneStateSilently(phoneNumber);
  if (String(phoneNumber || '').trim()) {
    const latestState = await getState();
    const recordStatus = shouldMarkAccountRunRecordRunning(latestState) ? 'running' : 'node:submit-signup-email:stopped';
    const recordReason = recordStatus === 'running' ? '正在运行' : '节点 submit-signup-email 已使用手机号，流程尚未完成。';
    await appendManualAccountRunRecordIfNeeded(recordStatus, latestState, recordReason);
  }
}

function shouldMarkAccountRunRecordRunning(state = {}) {
  const phase = String(state.autoRunPhase || '').trim().toLowerCase();
  return Boolean(state.autoRunning)
    && ['running', 'waiting_step', 'waiting_email', 'retrying'].includes(phase);
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

function buildContributionModeState(enabled, persistedSettings = {}, currentState = {}) {
  const currentContributionState = {};
  for (const key of CONTRIBUTION_RUNTIME_KEYS) {
    currentContributionState[key] = currentState[key] !== undefined
      ? currentState[key]
      : CONTRIBUTION_RUNTIME_DEFAULTS[key];
  }

  if (enabled) {
    const routing = resolveContributionModeRoutingState({
      ...persistedSettings,
      ...currentState,
      ...currentContributionState,
    });
    return {
      ...currentContributionState,
      contributionMode: true,
      contributionModeExpected: true,
      contributionSource: routing.source,
      contributionTargetGroupName: routing.targetGroupName,
      panelMode: routing.source,
      customPassword: '',
      accountRunHistoryTextEnabled: false,
    };
  }

  return {
    ...CONTRIBUTION_RUNTIME_DEFAULTS,
    contributionMode: false,
    contributionModeExpected: false,
    panelMode: persistedSettings.panelMode || DEFAULT_STATE.panelMode,
    customPassword: persistedSettings.customPassword || '',
    accountRunHistoryTextEnabled: Boolean(persistedSettings.accountRunHistoryTextEnabled),
  };
}

async function setContributionMode(enabled) {
  const normalizedEnabled = Boolean(enabled);
  const [persistedSettings, currentState] = await Promise.all([
    getPersistedSettings(),
    getState(),
  ]);

  const updates = buildContributionModeState(normalizedEnabled, persistedSettings, currentState);

  await setState(updates);
  const nextState = await getState();
  const contributionBroadcast = {};
  for (const key of CONTRIBUTION_RUNTIME_KEYS) {
    contributionBroadcast[key] = nextState[key];
  }
  broadcastDataUpdate({
    ...contributionBroadcast,
    panelMode: nextState.panelMode,
    customPassword: nextState.customPassword,
    accountRunHistoryTextEnabled: nextState.accountRunHistoryTextEnabled,
    accountRunHistoryHelperBaseUrl: nextState.accountRunHistoryHelperBaseUrl,
  });
  return nextState;
}

function getLuckmailUsedPurchases(state = {}) {
  return normalizeLuckmailUsedPurchases(state?.luckmailUsedPurchases);
}

function getLuckmailPreserveTagInfo(state = {}) {
  return {
    id: Number(state?.luckmailPreserveTagId) || 0,
    name: String(state?.luckmailPreserveTagName || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  };
}

async function setLuckmailUsedPurchasesState(usedPurchases) {
  const normalizedUsedPurchases = normalizeLuckmailUsedPurchases(usedPurchases);
  await setPersistentSettings({ luckmailUsedPurchases: normalizedUsedPurchases });
  await setState({ luckmailUsedPurchases: normalizedUsedPurchases });
  broadcastDataUpdate({ luckmailUsedPurchases: normalizedUsedPurchases });
  return normalizedUsedPurchases;
}

async function setLuckmailPurchaseUsedState(purchaseId, used) {
  const normalizedPurchaseId = normalizeLuckmailPurchaseId(purchaseId);
  if (!normalizedPurchaseId) {
    throw new Error('LuckMail 邮箱 ID 无效。');
  }

  const state = await getState();
  const usedPurchases = getLuckmailUsedPurchases(state);
  if (used) {
    usedPurchases[normalizedPurchaseId] = true;
  } else {
    delete usedPurchases[normalizedPurchaseId];
  }

  await setLuckmailUsedPurchasesState(usedPurchases);
  return {
    purchaseId: Number(normalizedPurchaseId),
    used: Boolean(used),
  };
}

async function setLuckmailPreserveTagInfo(tag) {
  const normalizedTags = normalizeLuckmailTags([tag]);
  const normalizedTag = normalizedTags[0] || {
    id: 0,
    name: DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  };
  const updates = {
    luckmailPreserveTagId: Number(normalizedTag.id) || 0,
    luckmailPreserveTagName: String(normalizedTag.name || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  };
  await setPersistentSettings(updates);
  await setState(updates);
  broadcastDataUpdate(updates);
  return updates;
}

async function setLuckmailPurchaseState(purchase) {
  const normalizedPurchase = purchase ? normalizeLuckmailPurchase(purchase) : null;
  await setState({ currentLuckmailPurchase: normalizedPurchase });
  broadcastDataUpdate({ currentLuckmailPurchase: normalizedPurchase });
  return normalizedPurchase;
}

async function setLuckmailMailCursorState(cursor) {
  const normalizedCursor = cursor ? normalizeLuckmailMailCursor(cursor) : null;
  await setState({ currentLuckmailMailCursor: normalizedCursor });
  return normalizedCursor;
}

async function clearLuckmailRuntimeState(options = {}) {
  const { clearEmail = false } = options;
  const updates = {
    currentLuckmailPurchase: null,
    currentLuckmailMailCursor: null,
  };
  if (clearEmail) {
    updates.email = null;
  }
  await setState(updates);
  broadcastDataUpdate(updates);
}

function getManualAliasUsageMap(state) {
  return normalizeBooleanMap(state?.manualAliasUsage);
}

function getPreservedAliasMap(state) {
  return normalizeBooleanMap(state?.preservedAliases);
}

function isAliasPreserved(state, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return false;
  return Boolean(getPreservedAliasMap(state)[normalizedEmail]);
}

function getEffectiveUsedEmails(state) {
  return toNormalizedEmailSet(getManualAliasUsageMap(state));
}

function normalizeIcloudAliasCacheList(value = [], options = {}) {
  const aliases = Array.isArray(value) ? value : [];
  const usedEmails = toNormalizedEmailSet(options.usedEmails);
  const preservedEmails = toNormalizedEmailSet(options.preservedEmails);
  return aliases
    .map((alias) => normalizeIcloudAliasRecord(alias, { usedEmails, preservedEmails }))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.used !== right.used) return left.used ? 1 : -1;
      return String(left.email).localeCompare(String(right.email));
    });
}

function getIcloudAliasCacheFromState(state, options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || ICLOUD_ALIAS_CACHE_MAX_AGE_MS);
  const cachedAt = Number(state?.icloudAliasCacheAt || 0);
  if (!Array.isArray(state?.icloudAliasCache) || state.icloudAliasCache.length <= 0) {
    return [];
  }
  if (maxAgeMs > 0 && cachedAt > 0 && Date.now() - cachedAt > maxAgeMs) {
    return [];
  }
  return normalizeIcloudAliasCacheList(state.icloudAliasCache, {
    usedEmails: getEffectiveUsedEmails(state),
    preservedEmails: getPreservedAliasMap(state),
  });
}

function isLikelyIcloudAliasEmail(value = '') {
  const email = String(value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return false;
  }
  return /@(icloud\.com|me\.com|mac\.com|privaterelay\.appleid\.com)$/.test(email);
}

function buildIcloudAliasFallbackFromLocalState(state = {}) {
  const manualAliasUsage = getManualAliasUsageMap(state);
  const preservedAliases = getPreservedAliasMap(state);
  const candidates = new Set();

  for (const email of Object.keys(manualAliasUsage)) {
    if (isLikelyIcloudAliasEmail(email)) {
      candidates.add(String(email).trim().toLowerCase());
    }
  }
  for (const email of Object.keys(preservedAliases)) {
    if (isLikelyIcloudAliasEmail(email)) {
      candidates.add(String(email).trim().toLowerCase());
    }
  }

  const currentEmail = String(state?.email || '').trim().toLowerCase();
  if (isLikelyIcloudAliasEmail(currentEmail)) {
    candidates.add(currentEmail);
  }

  if (!candidates.size) {
    return [];
  }

  const aliases = Array.from(candidates, (email) => ({
    hme: email,
    email,
    state: 'active',
    active: true,
  }));
  return normalizeIcloudAliasCacheList(aliases, {
    usedEmails: getEffectiveUsedEmails(state),
    preservedEmails: preservedAliases,
  });
}

async function setIcloudAliasUsedState(payload = {}, options = {}) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('未提供 iCloud 隐私邮箱地址。');
  }

  const used = Boolean(payload.used);
  const state = await getState();
  const manualAliasUsage = getManualAliasUsageMap(state);
  manualAliasUsage[email] = used;
  await setState({ manualAliasUsage });
  if (!options.silentLog) {
    await addLog(`iCloud：已将 ${email} 标记为${used ? '已用' : '未用'}`, 'ok');
  }
  broadcastIcloudAliasesChanged({ reason: 'used-updated', email, used });
  return { email, used };
}

async function setIcloudAliasPreservedState(payload = {}) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('未提供 iCloud 隐私邮箱地址。');
  }

  const preserved = Boolean(payload.preserved);
  const state = await getState();
  const preservedAliases = getPreservedAliasMap(state);
  preservedAliases[email] = preserved;
  await setState({ preservedAliases });
  await addLog(`iCloud：已将 ${email} ${preserved ? '设为保留' : '取消保留'}`, 'ok');
  broadcastIcloudAliasesChanged({ reason: 'preserved-updated', email, preserved });
  return { email, preserved };
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const [prev, persistedSettings, persistedAliasState] = await Promise.all([
    chrome.storage.session.get([
      'seenCodes',
      'seenInbucketMailIds',
      'accounts',
      'tabRegistry',
      'sourceLastUrls',
      'reusablePhoneActivation',
      'freeReusablePhoneActivation',
      'phoneReusableActivationPool',
      'luckmailApiKey',
      'luckmailBaseUrl',
      'luckmailEmailType',
      'luckmailDomain',
      'luckmailUsedPurchases',
      'luckmailPreserveTagId',
      'luckmailPreserveTagName',
      'chatgptAccessTokenRecords',
      'chatgptAccessTokenHistory',
      'chatgptTotpRecords',
      'plusCheckoutConversionProxyPoolResults',
      'externalRedeemQueue',
      'externalRedeemLastSyncAt',
      'externalRedeemLastError',
      'externalRedeemRecords',
      'externalRedeemRecordsDbPath',
      'externalRedeemRecordsLastSyncAt',
      'externalRedeemRecordsLastError',
      'preferredIcloudHost',
      'automationWindowId',
      ...CONTRIBUTION_RUNTIME_KEYS,
    ]),
    getPersistedSettings(),
    getPersistedAliasState(),
  ]);
  const contributionModeState = buildContributionModeState(Boolean(prev.contributionMode), persistedSettings, prev);
  const reusablePhoneActivation = (
    prev.reusablePhoneActivation
    && typeof prev.reusablePhoneActivation === 'object'
    && !Array.isArray(prev.reusablePhoneActivation)
    && String(
      prev.reusablePhoneActivation.activationId
      ?? prev.reusablePhoneActivation.id
      ?? prev.reusablePhoneActivation.activation
      ?? ''
    ).trim()
    && String(
      prev.reusablePhoneActivation.phoneNumber
      ?? prev.reusablePhoneActivation.number
      ?? prev.reusablePhoneActivation.phone
      ?? ''
    ).trim()
  )
    ? prev.reusablePhoneActivation
    : null;
  const phoneReusableActivationPool = Array.isArray(prev.phoneReusableActivationPool)
    ? prev.phoneReusableActivationPool
      .map((entry) => normalizePhonePreferredActivation(entry))
      .filter(Boolean)
    : [];
  const freeReusablePhoneActivation = (
    prev.freeReusablePhoneActivation
    && typeof prev.freeReusablePhoneActivation === 'object'
    && !Array.isArray(prev.freeReusablePhoneActivation)
    && String(
      prev.freeReusablePhoneActivation.phoneNumber
      ?? prev.freeReusablePhoneActivation.number
      ?? prev.freeReusablePhoneActivation.phone
      ?? ''
    ).trim()
  )
    ? prev.freeReusablePhoneActivation
    : null;
  await chrome.storage.session.clear();
  const resetPayload = buildStatePatchWithRuntimeState({}, {
    ...DEFAULT_STATE,
    ...persistedSettings,
    ...persistedAliasState,
    ...contributionModeState,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    sourceLastUrls: prev.sourceLastUrls || {},
    luckmailApiKey: String(prev.luckmailApiKey || ''),
    luckmailBaseUrl: normalizeLuckmailBaseUrl(prev.luckmailBaseUrl),
    luckmailEmailType: normalizeLuckmailEmailType(prev.luckmailEmailType),
    luckmailDomain: String(prev.luckmailDomain || '').trim(),
    luckmailUsedPurchases: normalizeLuckmailUsedPurchases(prev.luckmailUsedPurchases),
    luckmailPreserveTagId: Number(prev.luckmailPreserveTagId) || 0,
    luckmailPreserveTagName: String(prev.luckmailPreserveTagName || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
    currentLuckmailPurchase: null,
    currentLuckmailMailCursor: null,
    // Keep reusable phone activation across round resets so the same number can be reactivated up to maxUses.
    reusablePhoneActivation,
    // Keep free reuse phone activation until the user clears or the flow retires it.
    freeReusablePhoneActivation,
    phoneReusableActivationPool,
    chatgptAccessTokenRecords: prev.chatgptAccessTokenRecords && typeof prev.chatgptAccessTokenRecords === 'object'
      ? prev.chatgptAccessTokenRecords
      : {},
    chatgptAccessTokenHistory: Array.isArray(prev.chatgptAccessTokenHistory) ? prev.chatgptAccessTokenHistory : [],
    chatgptTotpRecords: prev.chatgptTotpRecords && typeof prev.chatgptTotpRecords === 'object'
      ? prev.chatgptTotpRecords
      : {},
    plusCheckoutConversionProxyPoolResults: Array.isArray(prev.plusCheckoutConversionProxyPoolResults)
      ? prev.plusCheckoutConversionProxyPoolResults
      : [],
    externalRedeemQueue: Array.isArray(prev.externalRedeemQueue) ? prev.externalRedeemQueue : [],
    externalRedeemLastSyncAt: Number(prev.externalRedeemLastSyncAt) || 0,
    externalRedeemLastError: String(prev.externalRedeemLastError || ''),
    externalRedeemRecords: Array.isArray(prev.externalRedeemRecords) ? prev.externalRedeemRecords : [],
    externalRedeemRecordsDbPath: String(prev.externalRedeemRecordsDbPath || ''),
    externalRedeemRecordsLastSyncAt: Number(prev.externalRedeemRecordsLastSyncAt) || 0,
    externalRedeemRecordsLastError: String(prev.externalRedeemRecordsLastError || ''),
    preferredIcloudHost: prev.preferredIcloudHost || '',
    automationWindowId: Number.isInteger(Number(prev.automationWindowId))
      && Number(prev.automationWindowId) > 0
      ? Number(prev.automationWindowId)
      : null,
  });
  await chrome.storage.session.set(resetPayload);
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function normalizeHotmailAccount(account = {}) {
  const normalizedLastAuthAt = Number.isFinite(Number(account.lastAuthAt)) ? Number(account.lastAuthAt) : 0;
  const normalizedStatus = String(
    account.status
    || (normalizedLastAuthAt > 0 ? 'authorized' : 'pending')
  );
  return {
    id: String(account.id || crypto.randomUUID()),
    email: String(account.email || '').trim(),
    password: String(account.password || ''),
    clientId: String(account.clientId || '').trim(),
    refreshToken: String(account.refreshToken || ''),
    status: normalizedStatus,
    enabled: account.enabled !== undefined ? Boolean(account.enabled) : true,
    used: Boolean(account.used),
    lastUsedAt: Number.isFinite(Number(account.lastUsedAt)) ? Number(account.lastUsedAt) : 0,
    lastAuthAt: normalizedLastAuthAt,
    lastError: String(account.lastError || ''),
  };
}

function normalizeHotmailAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];

  const deduped = new Map();
  for (const account of accounts) {
    const normalized = normalizeHotmailAccount(account);
    if (!normalized.email && !normalized.id) continue;
    deduped.set(normalized.id, normalized);
  }
  return [...deduped.values()];
}

function normalizeEmailAddressForMatch(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isHotmailAliasEnabled(state = {}) {
  return Boolean(state?.hotmailAliasEnabled);
}

function getHotmailAliasUsageKey(account = {}) {
  return String(account?.id || account?.email || '').trim();
}

function normalizeHotmailAliasUsageEntry(entry = {}, fallbackEmail = '') {
  const email = String(entry?.email || fallbackEmail || '').trim();
  if (!email) {
    return null;
  }
  return {
    email,
    used: Boolean(entry?.used),
    lastCheckedAt: Number.isFinite(Number(entry?.lastCheckedAt)) ? Number(entry.lastCheckedAt) : 0,
    reason: String(entry?.reason || '').trim(),
  };
}

function normalizeHotmailAliasUsage(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [accountKey, rawBucket] of Object.entries(value)) {
    const key = String(accountKey || '').trim();
    if (!key) {
      continue;
    }
    const aliasesSource = rawBucket?.aliases && typeof rawBucket.aliases === 'object' && !Array.isArray(rawBucket.aliases)
      ? rawBucket.aliases
      : rawBucket;
    const aliases = {};
    for (const [aliasKey, rawEntry] of Object.entries(aliasesSource || {})) {
      const entry = normalizeHotmailAliasUsageEntry(rawEntry, rawEntry?.email || aliasKey);
      if (!entry) {
        continue;
      }
      aliases[normalizeEmailAddressForMatch(entry.email)] = entry;
    }
    normalized[key] = {
      aliases,
      updatedAt: Number.isFinite(Number(rawBucket?.updatedAt)) ? Number(rawBucket.updatedAt) : 0,
    };
  }
  return normalized;
}

function getHotmailAliasEntriesForAccount(usage = {}, account = {}) {
  const key = getHotmailAliasUsageKey(account);
  if (!key) {
    return [];
  }
  const normalized = normalizeHotmailAliasUsage(usage);
  return Object.values(normalized[key]?.aliases || {});
}

function parseEmailAddressParts(email = '') {
  const normalized = String(email || '').trim();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex >= normalized.length - 1) {
    return null;
  }
  return {
    local: normalized.slice(0, atIndex),
    domain: normalized.slice(atIndex + 1),
  };
}

function isOutlookPlusAliasForAccount(aliasEmail = '', account = {}) {
  const aliasParts = parseEmailAddressParts(aliasEmail);
  const baseParts = parseEmailAddressParts(account?.email);
  if (!aliasParts || !baseParts) {
    return false;
  }
  const aliasLocal = aliasParts.local.toLowerCase();
  const baseLocal = baseParts.local.toLowerCase();
  return aliasParts.domain.toLowerCase() === baseParts.domain.toLowerCase()
    && aliasLocal.startsWith(`${baseLocal}+`)
    && aliasLocal.length > baseLocal.length + 1;
}

function buildOutlookPlusAliasEmail(baseEmail = '', tag = '') {
  const parts = parseEmailAddressParts(baseEmail);
  if (!parts) {
    return '';
  }
  const cleanedTag = String(tag || generateRandomSuffix(6))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!cleanedTag) {
    return '';
  }
  return `${parts.local}+${cleanedTag}@${parts.domain}`;
}

function buildOutlookNumberedAliasEmail(baseEmail = '', index = 1) {
  const parts = parseEmailAddressParts(baseEmail);
  const numericIndex = Math.max(1, Math.floor(Number(index) || 1));
  if (!parts) {
    return '';
  }
  return `${parts.local}+alias${numericIndex}@${parts.domain}`;
}

function getOutlookNumberedAliasIndex(aliasEmail = '', account = {}) {
  const aliasParts = parseEmailAddressParts(aliasEmail);
  const baseParts = parseEmailAddressParts(account?.email);
  if (!aliasParts || !baseParts || aliasParts.domain.toLowerCase() !== baseParts.domain.toLowerCase()) {
    return null;
  }
  const prefix = `${baseParts.local}+alias`.toLowerCase();
  const local = aliasParts.local.toLowerCase();
  if (!local.startsWith(prefix)) {
    return null;
  }
  const numeric = Number(local.slice(prefix.length));
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isHotmailAliasUsed(usage = {}, account = {}, aliasEmail = '') {
  const key = getHotmailAliasUsageKey(account);
  const emailKey = normalizeEmailAddressForMatch(aliasEmail);
  if (!key || !emailKey) {
    return false;
  }
  const normalized = normalizeHotmailAliasUsage(usage);
  return Boolean(normalized[key]?.aliases?.[emailKey]?.used);
}

function countHotmailUsedAliases(usage = {}, account = {}) {
  return getHotmailAliasEntriesForAccount(usage, account)
    .filter((entry) => Boolean(entry?.used)).length;
}

function isHotmailAliasCapacityExhausted(account = {}, state = {}) {
  const maxAliases = normalizeOutlookAliasMaxPerAccount(state?.outlookAliasMaxPerAccount);
  return countHotmailUsedAliases(state?.hotmailAliasUsage, account) >= maxAliases;
}

function messageContainsSubscriptionKeyword(message = {}, keyword = OUTLOOK_SUBSCRIPTION_USED_KEYWORD) {
  const needle = String(keyword || '').trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const body = typeof message?.body === 'string'
    ? message.body
    : (message?.body?.content || '');
  const combined = [
    message?.subject,
    message?.bodyPreview,
    message?.preview,
    message?.text,
    body,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
  return combined.includes(needle);
}

function getMessageRecipientAddresses(message = {}) {
  const recipients = message?.recipients;
  const fromRecipientObject = Array.isArray(recipients?.all)
    ? recipients.all
    : [
        ...(Array.isArray(recipients?.to) ? recipients.to : []),
        ...(Array.isArray(recipients?.cc) ? recipients.cc : []),
        ...(Array.isArray(recipients?.bcc) ? recipients.bcc : []),
      ];
  const fallback = [
    message?.toRecipients,
    message?.ToRecipients,
    message?.to,
    message?.recipient,
    message?.recipients,
  ].flatMap((item) => (Array.isArray(item) ? item : (item ? [item] : [])));
  const source = fromRecipientObject.length ? fromRecipientObject : fallback;
  const addresses = [];
  const seen = new Set();
  for (const item of source) {
    const raw = typeof item === 'string'
      ? item
      : (
          item?.emailAddress?.address
          || item?.EmailAddress?.Address
          || item?.address
          || item?.email
          || ''
        );
    const address = normalizeEmailAddressForMatch(raw);
    if (!address || seen.has(address)) {
      continue;
    }
    seen.add(address);
    addresses.push(address);
  }
  return addresses;
}

function findSubscriptionMessageForAlias(messages = [], aliasEmail = '') {
  const aliasKey = normalizeEmailAddressForMatch(aliasEmail);
  let sawKeywordWithoutRecipients = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!messageContainsSubscriptionKeyword(message)) {
      continue;
    }
    const recipients = getMessageRecipientAddresses(message);
    if (!recipients.length) {
      sawKeywordWithoutRecipients = true;
      continue;
    }
    if (recipients.includes(aliasKey)) {
      return {
        matched: true,
        missingRecipients: false,
        message,
      };
    }
  }
  return {
    matched: false,
    missingRecipients: sawKeywordWithoutRecipients,
    message: null,
  };
}

async function setHotmailAliasUsageEntry(account = {}, aliasEmail = '', updates = {}) {
  const accountKey = getHotmailAliasUsageKey(account);
  const aliasKey = normalizeEmailAddressForMatch(aliasEmail);
  if (!accountKey || !aliasKey) {
    return null;
  }
  const state = await getState();
  const usage = normalizeHotmailAliasUsage(state.hotmailAliasUsage);
  const bucket = usage[accountKey] || { aliases: {}, updatedAt: 0 };
  const previous = bucket.aliases[aliasKey] || {};
  const nextEntry = normalizeHotmailAliasUsageEntry({
    ...previous,
    email: String(aliasEmail || previous.email || '').trim(),
    ...updates,
  }, aliasEmail);
  if (!nextEntry) {
    return null;
  }
  const nextUsage = {
    ...usage,
    [accountKey]: {
      aliases: {
        ...(bucket.aliases || {}),
        [aliasKey]: nextEntry,
      },
      updatedAt: Date.now(),
    },
  };
  await setPersistentSettings({ hotmailAliasUsage: nextUsage });
  await setState({ hotmailAliasUsage: nextUsage });
  broadcastDataUpdate({ hotmailAliasUsage: nextUsage });
  return nextEntry;
}

async function checkOutlookAliasSubscriptionUsage(account = {}, aliasEmail = '') {
  try {
    const result = await fetchHotmailMailboxMessages(account, ['INBOX']);
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const match = findSubscriptionMessageForAlias(messages, aliasEmail);
    if (match.matched) {
      await setHotmailAliasUsageEntry(account, aliasEmail, {
        used: true,
        lastCheckedAt: Date.now(),
        reason: 'subscription_keyword',
      });
      await addLog(`Hotmail/Outlook：别名 ${aliasEmail} 已存在 Plus 订阅邮件，已标记为已用。`, 'warn');
      return { used: true, checked: true, missingRecipients: false };
    }
    if (match.missingRecipients) {
      await addLog(`Hotmail/Outlook：检测到 Plus 订阅邮件，但邮件数据没有收件人字段，未将别名 ${aliasEmail} 标记为已用。`, 'warn');
    }
    return { used: false, checked: true, missingRecipients: Boolean(match.missingRecipients) };
  } catch (error) {
    await addLog(`Hotmail/Outlook：预检查别名 ${aliasEmail} 收件箱失败：${error?.message || error}，将继续尝试使用该别名。`, 'warn');
    return { used: false, checked: false, error };
  }
}

async function ensureOutlookAliasForHotmailAccount(account = {}, options = {}) {
  const state = await getState();
  if (!Boolean(state?.hotmailAliasEnabled)) {
    const baseEmail = String(account?.email || '').trim();
    await setEmailState(baseEmail || null, { source: 'hotmail-base-email' });
    return baseEmail;
  }
  const currentEmail = String(state.email || '').trim();
  if (
    currentEmail
    && isOutlookPlusAliasForAccount(currentEmail, account)
    && (options?.allowUsedCurrent || !isHotmailAliasUsed(state.hotmailAliasUsage, account, currentEmail))
  ) {
    return currentEmail;
  }

  const maxAliases = normalizeOutlookAliasMaxPerAccount(state.outlookAliasMaxPerAccount);
  let latestUsage = normalizeHotmailAliasUsage(state.hotmailAliasUsage);
  const reusableAliases = getHotmailAliasEntriesForAccount(latestUsage, account)
    .filter((entry) => !entry.used)
    .map((entry) => entry.email)
    .filter(Boolean)
    .sort((left, right) => {
      const leftIndex = getOutlookNumberedAliasIndex(left, account);
      const rightIndex = getOutlookNumberedAliasIndex(right, account);
      if (leftIndex !== null || rightIndex !== null) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return String(left || '').localeCompare(String(right || ''));
    });
  const generatedCandidates = [];
  const existingAliases = getHotmailAliasEntriesForAccount(latestUsage, account)
    .map((entry) => normalizeEmailAddressForMatch(entry.email))
    .filter(Boolean);
  const existingAliasSet = new Set(existingAliases);
  for (let index = 1; index <= maxAliases; index += 1) {
    if (existingAliasSet.size + generatedCandidates.length >= maxAliases) {
      break;
    }
    const candidate = buildOutlookNumberedAliasEmail(account.email, index);
    const candidateKey = normalizeEmailAddressForMatch(candidate);
    if (!candidate || existingAliasSet.has(candidateKey) || generatedCandidates.some((item) => normalizeEmailAddressForMatch(item) === candidateKey)) {
      continue;
    }
    generatedCandidates.push(candidate);
  }

  for (const aliasEmail of [...reusableAliases, ...generatedCandidates]) {
    const precheck = await checkOutlookAliasSubscriptionUsage(account, aliasEmail);
    if (precheck.used) {
      latestUsage = normalizeHotmailAliasUsage((await getState()).hotmailAliasUsage);
      continue;
    }
    await setHotmailAliasUsageEntry(account, aliasEmail, {
      used: false,
      lastCheckedAt: Date.now(),
      reason: precheck.checked ? 'allocated' : 'allocated_precheck_failed',
    });
    await setEmailState(aliasEmail, { source: 'generated:outlook-alias' });
    return aliasEmail;
  }

  throw new Error(`Hotmail/Outlook 账号 ${account.email || account.id} 的 ${maxAliases} 个别名都已使用。`);
}

function findHotmailAccount(accounts, accountId) {
  return normalizeHotmailAccounts(accounts).find((account) => account.id === accountId) || null;
}

function isHotmailProvider(stateOrProvider) {
  const provider = typeof stateOrProvider === 'string'
    ? stateOrProvider
    : stateOrProvider?.mailProvider;
  return provider === HOTMAIL_PROVIDER;
}

function isLuckmailProvider(stateOrProvider) {
  const provider = typeof stateOrProvider === 'string'
    ? stateOrProvider
    : stateOrProvider?.mailProvider;
  return provider === LUCKMAIL_PROVIDER;
}

function isCustomMailProvider(stateOrProvider) {
  const provider = typeof stateOrProvider === 'string'
    ? stateOrProvider
    : stateOrProvider?.mailProvider;
  return provider === 'custom';
}

function getMail2925Mode(stateOrMode) {
  if (typeof stateOrMode === 'string') {
    return normalizeMail2925Mode(stateOrMode);
  }
  return normalizeMail2925Mode(stateOrMode?.mail2925Mode);
}

async function syncHotmailAccounts(accounts) {
  const normalized = normalizeHotmailAccounts(accounts);
  await setPersistentSettings({ hotmailAccounts: normalized });
  await setState({ hotmailAccounts: normalized });
  broadcastDataUpdate({ hotmailAccounts: normalized });
  return normalized;
}

async function upsertHotmailAccount(input) {
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const normalizedEmail = String(input?.email || '').trim().toLowerCase();
  const existing = input?.id
    ? findHotmailAccount(accounts, input.id)
    : accounts.find((account) => account.email.toLowerCase() === normalizedEmail) || null;
  const credentialsChanged = !existing
    || (input?.clientId !== undefined && String(input.clientId).trim() !== existing.clientId)
    || (input?.refreshToken !== undefined && String(input.refreshToken).trim() !== existing.refreshToken)
    || (input?.email !== undefined && String(input.email).trim().toLowerCase() !== existing.email.toLowerCase());
  const normalized = normalizeHotmailAccount({
    ...(existing || {}),
    ...(credentialsChanged ? {
      status: 'pending',
      lastAuthAt: 0,
      lastError: '',
    } : {}),
    ...input,
    id: input?.id || existing?.id || crypto.randomUUID(),
  });

  const nextAccounts = existing
    ? accounts.map((account) => (account.id === normalized.id ? normalized : account))
    : [...accounts, normalized];

  await syncHotmailAccounts(nextAccounts);
  return normalized;
}

async function deleteHotmailAccount(accountId) {
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const nextAccounts = accounts.filter((account) => account.id !== accountId);
  await syncHotmailAccounts(nextAccounts);

  if (state.currentHotmailAccountId === accountId) {
    await setState({ currentHotmailAccountId: null });
    if (isHotmailProvider(state)) {
      await setEmailState(null);
    }
    broadcastDataUpdate({ currentHotmailAccountId: null });
  }
}

async function deleteHotmailAccounts(mode = 'all') {
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const targets = filterHotmailAccountsByUsage(accounts, mode);
  const targetIds = new Set(targets.map((account) => account.id));
  const nextAccounts = mode === 'used'
    ? accounts.filter((account) => !targetIds.has(account.id))
    : [];

  await syncHotmailAccounts(nextAccounts);

  if (state.currentHotmailAccountId && targetIds.has(state.currentHotmailAccountId)) {
    await setState({ currentHotmailAccountId: null });
    if (isHotmailProvider(state)) {
      await setEmailState(null);
    }
    broadcastDataUpdate({ currentHotmailAccountId: null });
  }

  return {
    deletedCount: targets.length,
    remainingCount: nextAccounts.length,
  };
}

async function patchHotmailAccount(accountId, updates = {}, options = {}) {
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const account = findHotmailAccount(accounts, accountId);
  if (!account) {
    throw new Error('未找到对应的 Hotmail 账号。');
  }

  const nextAccount = normalizeHotmailAccount({
    ...account,
    ...updates,
    id: account.id,
  });

  await syncHotmailAccounts(accounts.map((item) => (item.id === account.id ? nextAccount : item)));

  if (!options?.preserveCurrentSelection && state.currentHotmailAccountId === account.id && shouldClearHotmailCurrentSelection(nextAccount)) {
    await setState({ currentHotmailAccountId: null });
    broadcastDataUpdate({ currentHotmailAccountId: null });
    if (isHotmailProvider(state)) {
      await setEmailState(null);
    }
  }

  return nextAccount;
}

async function setCurrentHotmailAccount(accountId, options = {}) {
  const { markUsed = false, syncEmail = true } = options;
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const account = findHotmailAccount(accounts, accountId);
  if (!account) {
    throw new Error('未找到对应的 Hotmail 账号。');
  }

  if (markUsed) {
    account.lastUsedAt = Date.now();
    await syncHotmailAccounts(accounts.map((item) => (item.id === account.id ? account : item)));
  }

  await setState({ currentHotmailAccountId: account.id });
  broadcastDataUpdate({ currentHotmailAccountId: account.id });
  if (syncEmail) {
    await setEmailState(account.email || null);
  }
  return account;
}

function isAuthorizedHotmailRunAccount(candidate) {
  return Boolean(candidate)
    && candidate.status === 'authorized'
    && !candidate.used
    && Boolean(candidate.refreshToken);
}

function isPendingHotmailVerificationCandidate(candidate) {
  return Boolean(candidate)
    && candidate.status === 'pending'
    && !candidate.used
    && Boolean(candidate.refreshToken);
}

function compareHotmailAccountAllocationPriority(left, right) {
  const leftUsedAt = Number(left?.lastUsedAt) || 0;
  const rightUsedAt = Number(right?.lastUsedAt) || 0;
  if (leftUsedAt !== rightUsedAt) {
    return leftUsedAt - rightUsedAt;
  }

  return String(left?.email || '').localeCompare(String(right?.email || ''));
}

function pickPendingHotmailAccountForVerification(accounts, options = {}) {
  const excludeIds = new Set((options.excludeIds || []).filter(Boolean));
  const candidates = normalizeHotmailAccounts(accounts)
    .filter((candidate) => isPendingHotmailVerificationCandidate(candidate) && !excludeIds.has(candidate.id));
  if (!candidates.length) {
    return null;
  }

  const preferredAccountId = String(options.preferredAccountId || '').trim();
  if (preferredAccountId) {
    const preferredCandidate = candidates.find((candidate) => candidate.id === preferredAccountId);
    if (preferredCandidate) {
      return preferredCandidate;
    }
  }

  return candidates
    .slice()
    .sort(compareHotmailAccountAllocationPriority)[0] || null;
}

async function ensureHotmailAccountForFlow(options = {}) {
  const {
    allowAllocate = true,
    markUsed = false,
    preferredAccountId = null,
    excludeIds = [],
    allowUsedCurrent = false,
  } = options;
  const state = await getState();
  const accounts = normalizeHotmailAccounts(state.hotmailAccounts);
  const excludedAccountIds = new Set((excludeIds || []).filter(Boolean));
  const hotmailAliasEnabled = Boolean(state?.hotmailAliasEnabled);
  const isAliasCapacityExhausted = (candidate, sourceState = state) => (
    hotmailAliasEnabled && typeof isHotmailAliasCapacityExhausted === 'function'
      ? isHotmailAliasCapacityExhausted(candidate, sourceState)
      : false
  );
  const availableAccounts = accounts.filter((candidate) => (
    isAuthorizedHotmailRunAccount(candidate)
    && !excludedAccountIds.has(candidate.id)
    && !isAliasCapacityExhausted(candidate, state)
  ));
  const isReusableAuthorizedHotmailAccount = (account) => Boolean(account)
    && account.status === 'authorized'
    && Boolean(account.refreshToken);

  const orderedCandidates = [];
  const addCandidate = (candidate) => {
    if (!candidate?.id || excludedAccountIds.has(candidate.id)) {
      return;
    }
    if (!orderedCandidates.some((item) => item.id === candidate.id)) {
      orderedCandidates.push(candidate);
    }
  };
  if (preferredAccountId && !excludedAccountIds.has(preferredAccountId)) {
    addCandidate(findHotmailAccount(accounts, preferredAccountId));
  }
  if (state.currentHotmailAccountId && !excludedAccountIds.has(state.currentHotmailAccountId)) {
    addCandidate(findHotmailAccount(accounts, state.currentHotmailAccountId));
  }
  if (allowAllocate) {
    for (const candidate of availableAccounts.slice().sort(compareHotmailAccountAllocationPriority)) {
      addCandidate(candidate);
    }
  }

  let lastAllocationError = null;
  for (const candidate of orderedCandidates) {
    if (!candidate) {
      continue;
    }
    if (!isAuthorizedHotmailRunAccount(candidate) && !(allowUsedCurrent && isReusableAuthorizedHotmailAccount(candidate))) {
      lastAllocationError = new Error(`Hotmail 账号 ${candidate.email || candidate.id} 尚未就绪，无法读取邮件。`);
      continue;
    }
    if (!allowUsedCurrent && isAliasCapacityExhausted(candidate, state)) {
      lastAllocationError = new Error(`Hotmail/Outlook 账号 ${candidate.email || candidate.id} 的别名已用完。`);
      continue;
    }
    try {
      const selectedAccount = await setCurrentHotmailAccount(candidate.id, { markUsed, syncEmail: false });
      const aliasEmail = typeof ensureOutlookAliasForHotmailAccount === 'function'
        ? await ensureOutlookAliasForHotmailAccount(selectedAccount, options)
        : selectedAccount.email;
      return {
        ...selectedAccount,
        registrationAliasEmail: hotmailAliasEnabled ? aliasEmail : selectedAccount.email,
      };
    } catch (error) {
      lastAllocationError = error;
      if (isAliasCapacityExhausted(candidate, await getState())) {
        await patchHotmailAccount(candidate.id, {
          used: true,
          lastUsedAt: Date.now(),
        }, {
          preserveCurrentSelection: true,
        });
        await addLog(`Hotmail/Outlook：账号 ${candidate.email || candidate.id} 的别名额度已用完，已跳过该基邮箱。`, 'warn');
      }
    }
  }

  if (lastAllocationError) {
    throw lastAllocationError;
  }
  throw new Error('没有可用的 Hotmail 账号。请先在侧边栏添加至少一个带刷新令牌（refresh token）的账号。');
}

function buildHotmailLocalEndpoint(baseUrl, path) {
  const normalizedBaseUrl = normalizeHotmailLocalBaseUrl(baseUrl);
  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

async function requestHotmailRemoteMailbox(account, mailbox = 'INBOX') {
  if (!account?.email) {
    throw new Error('Hotmail 账号缺少邮箱地址。');
  }
  if (!account?.clientId) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少客户端 ID。`);
  }
  if (!account?.refreshToken) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少刷新令牌（refresh token）。`);
  }

  const { timeoutMs } = getHotmailMailApiRequestConfig();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const result = await fetchMicrosoftMailboxMessages({
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      mailbox,
      top: 10,
      signal: controller.signal,
    });

    return {
      mailbox,
      payload: {
        source: 'microsoft-api',
        transport: result.transport,
        tokenStrategy: result.tokenStrategy,
      },
      messages: normalizeHotmailMailApiMessages(result.messages).map((message) => ({
        ...message,
        mailbox: message?.mailbox || mailbox,
      })),
      nextRefreshToken: result.nextRefreshToken,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Hotmail API 对接请求超时（>${Math.round(timeoutMs / 1000)} 秒）：${mailbox}`);
    }
    throw new Error(`Hotmail API 对接请求失败：${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function applyHotmailApiResultToAccount(account, apiResult) {
  const nextRefreshToken = String(apiResult?.nextRefreshToken || '').trim();
  return {
    ...account,
    refreshToken: nextRefreshToken || account.refreshToken,
    status: 'authorized',
    lastAuthAt: Date.now(),
    lastError: '',
  };
}

function buildHotmailMailApiFailureAccount(account, errorMessage) {
  return normalizeHotmailAccount({
    ...account,
    status: 'error',
    lastError: String(errorMessage || ''),
  });
}

async function fetchHotmailMailboxMessagesFromRemoteService(account, mailboxes = HOTMAIL_MAILBOXES) {
  let workingAccount = normalizeHotmailAccount(account);
  const mailboxResults = [];

  try {
    for (const mailbox of mailboxes) {
      const result = await requestHotmailRemoteMailbox(workingAccount, mailbox);
      workingAccount = applyHotmailApiResultToAccount(workingAccount, result);
      mailboxResults.push({
        mailbox,
        count: result.messages.length,
        messages: result.messages.map((message) => ({
          ...message,
          mailbox: message?.mailbox || mailbox,
        })),
      });
    }
  } catch (err) {
    const failedAccount = buildHotmailMailApiFailureAccount(workingAccount, err.message);
    await upsertHotmailAccount(failedAccount);
    throw err;
  }

  const savedAccount = await upsertHotmailAccount(workingAccount);
  return {
    account: savedAccount,
    mailboxResults,
    messages: mailboxResults.flatMap((item) => item.messages),
  };
}

async function requestHotmailLocalMessages(account, mailboxes = HOTMAIL_MAILBOXES) {
  if (!account?.email) {
    throw new Error('Hotmail 账号缺少邮箱地址。');
  }
  if (!account?.clientId) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少客户端 ID。`);
  }
  if (!account?.refreshToken) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少刷新令牌（refresh token）。`);
  }

  const serviceSettings = getHotmailServiceSettings(await getState());
  const { timeoutMs } = getHotmailMailApiRequestConfig();
  const requestTimeoutMs = Math.max(timeoutMs, HOTMAIL_LOCAL_HELPER_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), requestTimeoutMs);

  let response;
  try {
    response = await fetch(buildHotmailLocalEndpoint(serviceSettings.localBaseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: account.email,
        clientId: account.clientId,
        refreshToken: account.refreshToken,
        mailboxes,
        top: 5,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Hotmail 本地助手请求超时（>${Math.round(requestTimeoutMs / 1000)} 秒）`);
    }
    throw new Error(`Hotmail 本地助手请求失败：${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || payload?.ok === false) {
    const errorText = payload?.error || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`Hotmail 本地助手返回失败：${errorText}`);
  }

  const rawMessages = Array.isArray(payload?.messages) ? payload.messages : [];
  const normalizedMessages = normalizeHotmailMailApiMessages(rawMessages).map((message, index) => ({
    ...message,
    mailbox: rawMessages[index]?.mailbox || 'INBOX',
    receivedTimestamp: Number(rawMessages[index]?.receivedTimestamp || 0) || 0,
  }));
  const mailboxResults = Array.isArray(payload?.mailboxResults)
    ? payload.mailboxResults.map((item) => ({
      mailbox: String(item?.mailbox || 'INBOX'),
      count: Number(item?.count || 0),
      messages: normalizedMessages.filter((message) => String(message.mailbox || 'INBOX') === String(item?.mailbox || 'INBOX')),
    }))
    : mailboxes.map((mailbox) => ({
      mailbox,
      count: normalizedMessages.filter((message) => String(message.mailbox || 'INBOX') === mailbox).length,
      messages: normalizedMessages.filter((message) => String(message.mailbox || 'INBOX') === mailbox),
    }));

  const nextAccount = applyHotmailApiResultToAccount(account, {
    nextRefreshToken: String(payload?.nextRefreshToken || '').trim(),
  });
  const savedAccount = await upsertHotmailAccount(nextAccount);
  return {
    account: savedAccount,
    mailboxResults,
    messages: normalizedMessages,
  };
}

async function requestHotmailLocalCode(account, pollPayload = {}) {
  if (!account?.email) {
    throw new Error('Hotmail 账号缺少邮箱地址。');
  }
  if (!account?.clientId) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少客户端 ID。`);
  }
  if (!account?.refreshToken) {
    throw new Error(`Hotmail 账号 ${account.email || account.id} 缺少刷新令牌（refresh token）。`);
  }

  const serviceSettings = getHotmailServiceSettings(await getState());
  const { timeoutMs } = getHotmailMailApiRequestConfig();
  const requestTimeoutMs = Math.max(timeoutMs, HOTMAIL_LOCAL_HELPER_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), requestTimeoutMs);

  let response;
  try {
    response = await fetch(buildHotmailLocalEndpoint(serviceSettings.localBaseUrl, '/code'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        email: account.email,
        clientId: account.clientId,
        refreshToken: account.refreshToken,
        mailboxes: HOTMAIL_MAILBOXES,
        top: 5,
        senderFilters: pollPayload.senderFilters || [],
        subjectFilters: pollPayload.subjectFilters || [],
        requiredKeywords: pollPayload.requiredKeywords || [],
        codePatterns: pollPayload.codePatterns || [],
        excludeCodes: pollPayload.excludeCodes || [],
        filterAfterTimestamp: Number(pollPayload.filterAfterTimestamp || 0) || 0,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Hotmail 本地助手请求超时（>${Math.round(requestTimeoutMs / 1000)} 秒）`);
    }
    throw new Error(`Hotmail 本地助手请求失败：${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || payload?.ok === false) {
    const errorText = payload?.error || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(`Hotmail 本地助手返回失败：${errorText}`);
  }

  const normalizedMessage = payload?.message
    ? {
      ...normalizeHotmailMailApiMessages([payload.message])[0],
      mailbox: payload?.message?.mailbox || 'INBOX',
      receivedTimestamp: Number(payload?.message?.receivedTimestamp || 0) || 0,
    }
    : null;
  const nextAccount = applyHotmailApiResultToAccount(account, {
    nextRefreshToken: String(payload?.nextRefreshToken || '').trim(),
  });
  const savedAccount = await upsertHotmailAccount(nextAccount);
  return {
    account: savedAccount,
    code: String(payload?.code || ''),
    message: normalizedMessage,
    usedTimeFallback: Boolean(payload?.usedTimeFallback),
    selectionSource: String(payload?.selectionSource || ''),
  };
}

async function pollHotmailVerificationCodeViaLocalHelper(step, account, pollPayload = {}) {
  const maxAttempts = Number(pollPayload.maxAttempts) || 5;
  const intervalMs = Number(pollPayload.intervalMs) || 3000;
  let workingAccount = account;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    try {
      await addLog(`步骤 ${step}：正在通过本地助手轮询 Hotmail 验证码（${attempt}/${maxAttempts}）...`, 'info');
      const fetchResult = await requestHotmailLocalCode(workingAccount, pollPayload);
      workingAccount = fetchResult.account;

      if (fetchResult.code) {
        const mailboxLabel = fetchResult.message?.mailbox || 'INBOX';
        if (fetchResult.usedTimeFallback) {
          await addLog(`步骤 ${step}：本地助手使用时间回退后命中 Hotmail ${mailboxLabel} 验证码。`, 'warn');
        }
        await addLog(`步骤 ${step}：已通过本地助手在 Hotmail ${mailboxLabel} 中找到验证码：${fetchResult.code}`, 'ok');
        return {
          ok: true,
          code: fetchResult.code,
          emailTimestamp: fetchResult.message?.receivedTimestamp || Date.now(),
          mailId: fetchResult.message?.id || '',
        };
      }

      lastError = new Error(`步骤 ${step}：本地助手暂未返回匹配验证码（${attempt}/${maxAttempts}）。`);
      await addLog(lastError.message, attempt === maxAttempts ? 'warn' : 'info');
    } catch (err) {
      lastError = err;
      await addLog(`步骤 ${step}：本地助手轮询 Hotmail 失败：${err.message}`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw lastError || new Error(`步骤 ${step}：本地助手未返回新的匹配验证码。`);
}

async function fetchHotmailMailboxMessages(account, mailboxes = HOTMAIL_MAILBOXES) {
  const serviceSettings = getHotmailServiceSettings(await getState());
  if (serviceSettings.mode === HOTMAIL_SERVICE_MODE_LOCAL) {
    return requestHotmailLocalMessages(account, mailboxes);
  }
  return fetchHotmailMailboxMessagesFromRemoteService(account, mailboxes);
}

async function verifyHotmailAccount(accountId) {
  const state = await getState();
  const account = findHotmailAccount(state.hotmailAccounts, accountId);
  if (!account) {
    throw new Error('未找到需要校验的 Hotmail 账号。');
  }

  const result = await fetchHotmailMailboxMessages(account, ['INBOX']);
  return {
    account: result.account,
    messageCount: result.mailboxResults[0]?.count || 0,
  };
}

async function ensureHotmailMailboxReadyForAutoRunRound(options = {}) {
  const {
    targetRun = 0,
    totalRuns = 0,
    attemptRun = 1,
  } = options;
  const state = await getState();
  if (!isHotmailProvider(state)) {
    return null;
  }

  const buildRoundLabel = () => {
    if (targetRun > 0 && totalRuns > 0) {
      return `第 ${targetRun}/${totalRuns} 轮`;
    }
    return '当前轮';
  };
  const exhaustedAccountIds = new Set();
  let preferredAccountId = state.currentHotmailAccountId || null;
  let lastError = null;

  while (true) {
    throwIfStopped();
    const latestState = await getState();
    const latestAccounts = normalizeHotmailAccounts(latestState.hotmailAccounts);
    const remainingAuthorizedAccounts = latestAccounts
      .filter((candidate) => isAuthorizedHotmailRunAccount(candidate) && !exhaustedAccountIds.has(candidate.id));
    const remainingPendingAccounts = latestAccounts
      .filter((candidate) => isPendingHotmailVerificationCandidate(candidate) && !exhaustedAccountIds.has(candidate.id));
    if (!remainingAuthorizedAccounts.length && !remainingPendingAccounts.length) {
      if (lastError) {
        throw new Error(`自动运行${buildRoundLabel()}开始前未找到可通过校验的 Hotmail 账号：${lastError.message}`);
      }
      throw new Error('没有可用的 Hotmail 账号。请先在侧边栏添加至少一个带刷新令牌（refresh token）的账号。');
    }

    let account = null;
    if (remainingAuthorizedAccounts.length) {
      account = await ensureHotmailAccountForFlow({
        allowAllocate: true,
        markUsed: false,
        preferredAccountId,
        excludeIds: [...exhaustedAccountIds],
      });
    } else {
      const pendingAccount = pickPendingHotmailAccountForVerification(latestAccounts, {
        preferredAccountId,
        excludeIds: [...exhaustedAccountIds],
      });
      if (!pendingAccount) {
        throw new Error('没有可用的 Hotmail 账号。请先在侧边栏添加至少一个带刷新令牌（refresh token）的账号。');
      }
      account = await setCurrentHotmailAccount(pendingAccount.id, {
        markUsed: false,
        syncEmail: true,
      });
      await addLog(
        `自动运行${buildRoundLabel()}开始前未找到已校验 Hotmail 账号，正在尝试校验待校验账号 ${account.email}。`,
        'warn'
      );
    }

    try {
      await addLog(
        `自动运行${buildRoundLabel()}第 ${attemptRun} 次尝试开始前，正在校验 Hotmail 账号 ${account.email} 的邮箱可用性。`,
        'info'
      );
      const result = await verifyHotmailAccount(account.id);
      await addLog(
        `自动运行${buildRoundLabel()}开始前已校验 Hotmail 账号 ${result.account?.email || account.email}，INBOX 当前 ${result.messageCount} 封邮件。`,
        'ok'
      );
      return result.account;
    } catch (error) {
      lastError = error;
      exhaustedAccountIds.add(account.id);
      preferredAccountId = null;
      const latestErrorMessage = error?.message || '未知错误';
      await addLog(
        `自动运行${buildRoundLabel()}开始前校验 Hotmail 账号 ${account.email} 失败：${latestErrorMessage}`,
        'warn'
      );
      const nextState = await getState();
      const hasRemainingAccounts = normalizeHotmailAccounts(nextState.hotmailAccounts)
        .some((candidate) => (
          isAuthorizedHotmailRunAccount(candidate) || isPendingHotmailVerificationCandidate(candidate)
        ) && !exhaustedAccountIds.has(candidate.id));
      if (hasRemainingAccounts) {
        await addLog(`自动运行${buildRoundLabel()}开始前将切换下一个 Hotmail 账号并重试。`, 'warn');
      }
    }
  }
}

async function testHotmailAccountMailAccess(accountId) {
  const state = await getState();
  const account = findHotmailAccount(state.hotmailAccounts, accountId);
  if (!account) {
    throw new Error('未找到需要测试的 Hotmail 账号。');
  }

  const result = await fetchHotmailMailboxMessages(account, HOTMAIL_MAILBOXES);
  const latestMessage = getLatestHotmailMessage(result.messages);
  const latestCode = latestMessage ? extractVerificationCodeFromMessage(latestMessage) : null;

  return {
    account: result.account,
    accountId: result.account.id,
    email: result.account.email,
    messageCount: result.messages.length,
    latestSubject: latestMessage?.subject || '',
    latestMailbox: latestMessage?.mailbox || '',
    latestCode: latestCode || '',
    inboxCount: result.mailboxResults.find((item) => item.mailbox === 'INBOX')?.count || 0,
    junkCount: result.mailboxResults.find((item) => item.mailbox === 'Junk')?.count || 0,
  };
}

async function pollHotmailVerificationCode(step, state, pollPayload = {}) {
  await addLog(`步骤 ${step}：正在确定 Hotmail 收信账号...`, 'info');
  let account = await ensureHotmailAccountForFlow({
    allowAllocate: true,
    markUsed: false,
    preferredAccountId: state.currentHotmailAccountId || null,
    allowUsedCurrent: true,
  });
  await addLog(`步骤 ${step}：当前使用 Hotmail 账号 ${account.email} 轮询收件箱。`, 'info');

  const serviceSettings = getHotmailServiceSettings(state);
  if (serviceSettings.mode === HOTMAIL_SERVICE_MODE_LOCAL) {
    return pollHotmailVerificationCodeViaLocalHelper(step, account, pollPayload);
  }

  const maxAttempts = Number(pollPayload.maxAttempts) || 5;
  const intervalMs = Number(pollPayload.intervalMs) || 3000;
  let lastError = null;

  function summarizeMessagesForLog(messages) {
    return (messages || [])
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.receivedDateTime || '') || 0;
        const rightTime = Date.parse(right.receivedDateTime || '') || 0;
        return rightTime - leftTime;
      })
      .slice(0, 3)
      .map((message) => {
        const receivedAt = message?.receivedDateTime || '未知时间';
        const sender = message?.from?.emailAddress?.address || '未知发件人';
        const subject = message?.subject || '（无主题）';
        const preview = String(message?.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return `[${message.mailbox || 'INBOX'}] ${receivedAt} | ${sender} | ${subject} | ${preview}`;
      })
      .join(' || ');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    try {
      await addLog(`步骤 ${step}：正在通过 API对接 轮询 Hotmail 邮件（${attempt}/${maxAttempts}）...`, 'info');
      const fetchResult = await fetchHotmailMailboxMessages(account, HOTMAIL_MAILBOXES);
      account = fetchResult.account;
      const matchResult = pickVerificationMessageWithTimeFallback(fetchResult.messages, {
        afterTimestamp: pollPayload.filterAfterTimestamp || 0,
        senderFilters: pollPayload.senderFilters || [],
        subjectFilters: pollPayload.subjectFilters || [],
        requiredKeywords: pollPayload.requiredKeywords || [],
        codePatterns: pollPayload.codePatterns || [],
        excludeCodes: pollPayload.excludeCodes || [],
      });
      const match = matchResult.match;

      if (match?.code) {
        const mailboxLabel = match.message?.mailbox || 'INBOX';
        if (matchResult.usedRelaxedFilters) {
          const fallbackLabel = matchResult.usedTimeFallback ? '宽松匹配 + 时间回退' : '宽松匹配';
          await addLog(`步骤 ${step}：严格规则未命中，已改用 ${fallbackLabel} 并命中 Hotmail ${mailboxLabel} 验证码。`, 'warn');
        }
        await addLog(`步骤 ${step}：已通过 API对接 在 Hotmail ${mailboxLabel} 中找到验证码：${match.code}`, 'ok');
        return {
          ok: true,
          code: match.code,
          emailTimestamp: match.receivedAt || Date.now(),
          mailId: match.message?.id || '',
        };
      }

      lastError = new Error(`步骤 ${step}：暂未在 Hotmail 收件箱中找到匹配验证码（${attempt}/${maxAttempts}）。`);
      await addLog(lastError.message, attempt === maxAttempts ? 'warn' : 'info');
      const mailSummary = summarizeMessagesForLog(fetchResult.messages);
      if (mailSummary) {
        await addLog(`步骤 ${step}：最近邮件样本：${mailSummary}`, 'info');
      }
    } catch (err) {
      lastError = err;
      await addLog(`步骤 ${step}：Hotmail API 对接轮询失败：${err.message}`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw lastError || new Error(`步骤 ${step}：未在 Hotmail 收件箱中找到新的匹配验证码。`);
}

function generateRandomSuffix(length = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return suffix;
}

const GMAIL_ALIAS_WORDS = [
  'amber', 'apple', 'ash', 'berry', 'birch', 'blue', 'brook', 'cedar',
  'cloud', 'clover', 'coast', 'cocoa', 'coral', 'dawn', 'delta', 'echo',
  'ember', 'field', 'flint', 'flora', 'forest', 'frost', 'glade', 'harbor',
  'hazel', 'honey', 'ivory', 'jade', 'lake', 'leaf', 'light', 'lilac',
  'lotus', 'lunar', 'maple', 'meadow', 'mist', 'moon', 'nova', 'oasis',
  'olive', 'opal', 'pearl', 'pine', 'pixel', 'plum', 'quartz', 'rain',
  'raven', 'river', 'rose', 'sage', 'shore', 'sky', 'solar', 'spark',
  'stone', 'storm', 'sun', 'terra', 'vale', 'wave', 'willow', 'zephyr',
];

function generateRandomWordAliasTag(parts = 3) {
  const selected = [];
  for (let i = 0; i < parts; i++) {
    selected.push(GMAIL_ALIAS_WORDS[Math.floor(Math.random() * GMAIL_ALIAS_WORDS.length)]);
  }
  return selected.join('');
}

function parseGmailBaseEmail(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  const match = value.match(/^([^@\s+]+)@((?:gmail|googlemail)\.com)$/i);
  if (!match) return null;
  return {
    localPart: match[1],
    domain: match[2].toLowerCase(),
  };
}

function isGeneratedAliasProvider(stateOrProvider, mail2925Mode = undefined) {
  if (
    stateOrProvider
    && typeof stateOrProvider === 'object'
    && !Array.isArray(stateOrProvider)
    && normalizeEmailGenerator(stateOrProvider.emailGenerator) === (
      typeof CUSTOM_EMAIL_POOL_GENERATOR === 'string'
        ? CUSTOM_EMAIL_POOL_GENERATOR
        : 'custom-pool'
    )
  ) {
    return false;
  }
  const provider = typeof stateOrProvider === 'string'
    ? stateOrProvider
    : stateOrProvider?.mailProvider;
  const resolvedMail2925Mode = mail2925Mode !== undefined
    ? normalizeMail2925Mode(mail2925Mode)
    : getMail2925Mode(stateOrProvider);
  const utils = (typeof self !== 'undefined' ? self : globalThis).MultiPageManagedAliasUtils || null;
  if (utils?.usesManagedAliasGeneration) {
    return utils.usesManagedAliasGeneration(provider, { mail2925Mode: resolvedMail2925Mode });
  }
  if (utils?.isManagedAliasProvider) {
    if (String(provider || '').trim().toLowerCase() === '2925') {
      return utils.isManagedAliasProvider(provider) && resolvedMail2925Mode === MAIL_2925_MODE_PROVIDE;
    }
    return utils.isManagedAliasProvider(provider);
  }
  return provider === GMAIL_PROVIDER
    || (provider === '2925' && resolvedMail2925Mode === MAIL_2925_MODE_PROVIDE);
}

function shouldUseCustomRegistrationEmail(state = {}) {
  return isCustomMailProvider(state)
    || (!isHotmailProvider(state)
      && !isGeneratedAliasProvider(state)
      && normalizeEmailGenerator(state.emailGenerator) === 'custom');
}

function buildGeneratedAliasEmail(state) {
  const provider = state.mailProvider || '163';
  const emailPrefix = (state.emailPrefix || '').trim();

  if (provider === GMAIL_PROVIDER) {
    if (!emailPrefix) {
      throw new Error('Gmail 原邮箱未设置，请先在侧边栏填写。');
    }
    const parsed = parseGmailBaseEmail(emailPrefix);
    if (!parsed) {
      throw new Error('Gmail 原邮箱格式不正确，请填写类似 name@gmail.com 的地址。');
    }
    return `${parsed.localPart}+${generateRandomWordAliasTag()}@${parsed.domain}`;
  }

  if (!emailPrefix) {
    throw new Error('2925 邮箱前缀未设置，请先在侧边栏填写。');
  }

  if (provider === '2925' && isGeneratedAliasProvider(state)) {
    return `${emailPrefix}${generateRandomSuffix(6)}@2925.com`;
  }

  throw new Error(`未支持的别名邮箱类型：${provider}`);
}

function getManagedAliasUtils() {
  return (typeof self !== 'undefined' ? self : globalThis).MultiPageManagedAliasUtils || null;
}

function parseGmailBaseEmail(rawValue) {
  const utils = getManagedAliasUtils();
  if (utils?.parseManagedAliasBaseEmail) {
    return utils.parseManagedAliasBaseEmail(rawValue, GMAIL_PROVIDER);
  }

  const value = String(rawValue || '').trim().toLowerCase();
  const match = value.match(/^([^@\s+]+)@((?:gmail|googlemail)\.com)$/i);
  if (!match) return null;
  return {
    localPart: match[1],
    domain: match[2].toLowerCase(),
  };
}

function parseManagedAliasBaseEmail(rawValue, provider) {
  const utils = getManagedAliasUtils();
  if (utils?.parseManagedAliasBaseEmail) {
    return utils.parseManagedAliasBaseEmail(rawValue, provider);
  }

  if (provider === GMAIL_PROVIDER) {
    return parseGmailBaseEmail(rawValue);
  }

  const value = String(rawValue || '').trim().toLowerCase();
  const match = value.match(/^([^@\s+]+)@(2925\.com)$/i);
  if (!match) return null;
  return {
    localPart: match[1],
    domain: match[2].toLowerCase(),
  };
}

function isManagedAliasEmail(value, provider, baseEmail = '') {
  const utils = getManagedAliasUtils();
  if (utils?.isManagedAliasEmail) {
    return utils.isManagedAliasEmail(value, provider, baseEmail);
  }

  const normalizedValue = String(value || '').trim().toLowerCase();
  if (!normalizedValue) return false;
  const parsedEmail = normalizedValue.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!parsedEmail) return false;

  const candidateLocalPart = parsedEmail[1];
  const candidateDomain = parsedEmail[2];
  if (provider === GMAIL_PROVIDER) {
    if (!/^(?:gmail|googlemail)\.com$/i.test(candidateDomain)) {
      return false;
    }
    const parsedBaseEmail = parseManagedAliasBaseEmail(baseEmail, provider);
    if (!parsedBaseEmail) {
      return true;
    }
    return candidateDomain === parsedBaseEmail.domain
      && candidateLocalPart.split('+')[0] === parsedBaseEmail.localPart;
  }

  if (provider !== '2925' || candidateDomain !== '2925.com') {
    return false;
  }

  const parsedBaseEmail = parseManagedAliasBaseEmail(baseEmail, provider);
  if (!parsedBaseEmail) {
    return true;
  }

  return candidateLocalPart === parsedBaseEmail.localPart || candidateLocalPart.startsWith(parsedBaseEmail.localPart);
}

function getManagedAliasBaseEmail(state = {}, provider = state?.mailProvider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const legacyEmailPrefix = String(state?.emailPrefix || '').trim();
  if (normalizedProvider === GMAIL_PROVIDER) {
    const gmailBaseEmail = String(state?.gmailBaseEmail || '').trim();
    if (gmailBaseEmail) {
      return gmailBaseEmail;
    }
    return parseManagedAliasBaseEmail(legacyEmailPrefix, normalizedProvider) ? legacyEmailPrefix : '';
  }

  if (normalizedProvider === '2925') {
    const currentAccount = Boolean(state?.mail2925UseAccountPool)
      ? getCurrentMail2925Account(state)
      : null;
    if (currentAccount?.email) {
      return currentAccount.email;
    }
    const mail2925BaseEmail = String(state?.mail2925BaseEmail || '').trim();
    if (mail2925BaseEmail) {
      return mail2925BaseEmail;
    }
    return parseManagedAliasBaseEmail(legacyEmailPrefix, normalizedProvider) ? legacyEmailPrefix : '';
  }

  return '';
}

function isGeneratedAliasProvider(stateOrProvider, mail2925Mode = undefined) {
  if (
    stateOrProvider
    && typeof stateOrProvider === 'object'
    && !Array.isArray(stateOrProvider)
    && normalizeEmailGenerator(stateOrProvider.emailGenerator) === (
      typeof CUSTOM_EMAIL_POOL_GENERATOR === 'string'
        ? CUSTOM_EMAIL_POOL_GENERATOR
        : 'custom-pool'
    )
  ) {
    return false;
  }
  const provider = typeof stateOrProvider === 'string'
    ? stateOrProvider
    : stateOrProvider?.mailProvider;
  const resolvedMail2925Mode = mail2925Mode !== undefined
    ? normalizeMail2925Mode(mail2925Mode)
    : getMail2925Mode(stateOrProvider);
  const utils = getManagedAliasUtils();
  if (utils?.usesManagedAliasGeneration) {
    return utils.usesManagedAliasGeneration(provider, { mail2925Mode: resolvedMail2925Mode });
  }
  if (utils?.isManagedAliasProvider) {
    if (String(provider || '').trim().toLowerCase() === '2925') {
      return utils.isManagedAliasProvider(provider) && resolvedMail2925Mode === MAIL_2925_MODE_PROVIDE;
    }
    return utils.isManagedAliasProvider(provider);
  }
  return provider === GMAIL_PROVIDER
    || (provider === '2925' && resolvedMail2925Mode === MAIL_2925_MODE_PROVIDE);
}

function shouldUseCustomRegistrationEmail(state = {}) {
  return isCustomMailProvider(state)
    || (!isHotmailProvider(state)
      && !isGeneratedAliasProvider(state)
      && normalizeEmailGenerator(state.emailGenerator) === 'custom');
}

function isReusableGeneratedAliasEmail(state = {}, email = state?.email) {
  if (!isGeneratedAliasProvider(state)) {
    return false;
  }

  return isManagedAliasEmail(email, state?.mailProvider, getManagedAliasBaseEmail(state));
}

function buildGeneratedAliasEmail(state) {
  const provider = state.mailProvider || '163';
  const baseEmail = getManagedAliasBaseEmail(state, provider);
  const baseLabel = provider === GMAIL_PROVIDER ? 'Gmail 原邮箱' : '2925 基邮箱';
  const exampleEmail = provider === GMAIL_PROVIDER ? 'name@gmail.com' : 'name@2925.com';

  if (!baseEmail) {
    throw new Error(`${baseLabel}未设置，请先在侧边栏填写，或直接在“注册邮箱”中手动填写完整邮箱。`);
  }

  if (!parseManagedAliasBaseEmail(baseEmail, provider)) {
    throw new Error(`${baseLabel}格式不正确，请填写类似 ${exampleEmail} 的地址。`);
  }

  const utils = getManagedAliasUtils();
  if (utils?.buildManagedAliasEmail) {
    return utils.buildManagedAliasEmail(
      provider,
      baseEmail,
      provider === GMAIL_PROVIDER ? generateRandomWordAliasTag() : generateRandomSuffix(6)
    );
  }

  const parsedBaseEmail = parseManagedAliasBaseEmail(baseEmail, provider);
  if (provider === GMAIL_PROVIDER) {
    return `${parsedBaseEmail.localPart}+${generateRandomWordAliasTag()}@${parsedBaseEmail.domain}`;
  }
  if (provider === '2925') {
    return `${parsedBaseEmail.localPart}${generateRandomSuffix(6)}@${parsedBaseEmail.domain}`;
  }

  throw new Error(`未支持的别名邮箱类型：${provider}`);
}

function getLuckmailSessionConfig(state = {}) {
  return {
    apiKey: String(state.luckmailApiKey || ''),
    baseUrl: normalizeLuckmailBaseUrl(state.luckmailBaseUrl),
    emailType: normalizeLuckmailEmailType(state.luckmailEmailType),
    domain: String(state.luckmailDomain || '').trim(),
  };
}

function ensureLuckmailApiKey(state = {}) {
  const apiKey = String(state.luckmailApiKey || '').trim();
  if (!apiKey) {
    throw new Error('LuckMail API Key 为空，请先在侧边栏填写。');
  }
  return apiKey;
}

async function requestLuckmail(method, path, { baseUrl, apiKey, params, jsonData, timeout = 30000 } = {}) {
  const requestUrl = new URL(`${normalizeLuckmailBaseUrl(baseUrl)}${path}`);
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      requestUrl.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const headers = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const upperMethod = String(method || 'GET').toUpperCase();
  const fetchOptions = {
    method: upperMethod,
    headers,
    signal: controller.signal,
  };
  if (jsonData !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(jsonData || {});
  }

  let response = null;
  try {
    response = await fetch(requestUrl.toString(), fetchOptions);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`LuckMail 请求超时：${path}`);
    }
    throw new Error(`LuckMail 请求失败：${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`LuckMail 返回了无法解析的响应：${path}`);
  }

  if (!response.ok) {
    const errorText = String(payload?.message || response.statusText || 'HTTP error');
    throw new Error(`LuckMail 请求失败：${errorText}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`LuckMail 返回数据无效：${path}`);
  }

  if (payload.code !== 0) {
    const errorText = String(payload.message || 'Unknown error');
    throw new Error(`LuckMail 接口返回失败：${errorText}`);
  }

  return payload.data;
}

function createLuckmailClient(state = {}) {
  const config = getLuckmailSessionConfig(state);
  const apiKey = ensureLuckmailApiKey(state);
  const request = (method, path, options = {}) => requestLuckmail(method, path, {
    baseUrl: config.baseUrl,
    apiKey,
    ...options,
  });

  return {
    user: {
      async purchaseEmails(projectCode, quantity, { emailType, domain } = {}) {
        const body = {
          project_code: projectCode,
          quantity,
          email_type: normalizeLuckmailEmailType(emailType),
        };
        if (domain) {
          body.domain = String(domain).trim();
        }
        return request('POST', '/api/v1/openapi/email/purchase', {
          jsonData: body,
        });
      },
      async getPurchases({ page = 1, pageSize = 100, projectId, tagId, keyword, userDisabled } = {}) {
        return normalizeLuckmailPurchaseListPage(await request('GET', '/api/v1/openapi/email/purchases', {
          params: {
            page,
            page_size: pageSize,
            project_id: projectId,
            tag_id: tagId,
            keyword,
            user_disabled: userDisabled,
          },
        }));
      },
      async getTokenCode(token) {
        return normalizeLuckmailTokenCode(await request(
          'GET',
          `/api/v1/openapi/email/token/${encodeURIComponent(token)}/code`
        ));
      },
      async checkTokenAlive(token) {
        const data = await request(
          'GET',
          `/api/v1/openapi/email/token/${encodeURIComponent(token)}/alive`
        );
        return {
          email_address: String(data?.email_address || ''),
          project: String(data?.project || ''),
          alive: Boolean(data?.alive),
          status: String(data?.status || ''),
          message: String(data?.message || ''),
          mail_count: Number(data?.mail_count) || 0,
        };
      },
      async getTokenMails(token) {
        const data = await request('GET', `/api/v1/openapi/email/token/${encodeURIComponent(token)}/mails`);
        return {
          email_address: String(data?.email_address || ''),
          project: String(data?.project || ''),
          warranty_until: String(data?.warranty_until || ''),
          mails: normalizeLuckmailTokenMails(data?.mails || []),
        };
      },
      async getTokenMailDetail(token, messageId) {
        return normalizeLuckmailTokenMail(await request(
          'GET',
          `/api/v1/openapi/email/token/${encodeURIComponent(token)}/mails/${encodeURIComponent(messageId)}`
        ));
      },
      async setPurchaseDisabled(purchaseId, disabled) {
        await request('PUT', `/api/v1/openapi/email/purchases/${encodeURIComponent(purchaseId)}/disabled`, {
          jsonData: {
            disabled: disabled ? 1 : 0,
          },
        });
      },
      async batchSetPurchaseDisabled(ids, disabled) {
        await request('POST', '/api/v1/openapi/email/purchases/batch-disabled', {
          jsonData: {
            ids: (Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
            disabled: disabled ? 1 : 0,
          },
        });
      },
      async setPurchaseTag(purchaseId, { tagId, tagName } = {}) {
        const body = {};
        if (tagId !== undefined) {
          body.tag_id = Number(tagId) || 0;
        }
        if (tagName !== undefined) {
          body.tag_name = String(tagName || '').trim();
        }
        await request('PUT', `/api/v1/openapi/email/purchases/${encodeURIComponent(purchaseId)}/tag`, {
          jsonData: body,
        });
      },
      async batchSetPurchaseTag(ids, { tagId, tagName } = {}) {
        const body = {
          ids: (Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
        };
        if (tagId !== undefined) {
          body.tag_id = Number(tagId) || 0;
        }
        if (tagName !== undefined) {
          body.tag_name = String(tagName || '').trim();
        }
        await request('POST', '/api/v1/openapi/email/purchases/batch-tag', {
          jsonData: body,
        });
      },
      async getTags() {
        return normalizeLuckmailTags(await request('GET', '/api/v1/openapi/email/tags'));
      },
      async createTag(name, limitType, remark) {
        const body = {
          name: String(name || '').trim(),
          limit_type: Number(limitType) || 0,
        };
        if (remark !== undefined) {
          body.remark = String(remark || '').trim();
        }
        return normalizeLuckmailTags([await request('POST', '/api/v1/openapi/email/tags', {
          jsonData: body,
        })])[0] || null;
      },
    },
  };
}

function getCurrentLuckmailPurchase(state = {}) {
  return state.currentLuckmailPurchase
    ? normalizeLuckmailPurchase(state.currentLuckmailPurchase)
    : null;
}

function buildLuckmailPurchaseView(purchase, state = {}) {
  const normalizedPurchase = normalizeLuckmailPurchase(purchase);
  const usedPurchases = getLuckmailUsedPurchases(state);
  const preserveTagInfo = getLuckmailPreserveTagInfo(state);

  return {
    id: normalizedPurchase.id,
    email_address: normalizedPurchase.email_address,
    project_name: normalizeLuckmailProjectName(normalizedPurchase.project_name) || DEFAULT_LUCKMAIL_PROJECT_CODE,
    price: normalizedPurchase.price,
    status: normalizedPurchase.status,
    tag_id: normalizedPurchase.tag_id,
    tag_name: normalizedPurchase.tag_name,
    user_disabled: normalizedPurchase.user_disabled,
    warranty_hours: normalizedPurchase.warranty_hours,
    warranty_until: normalizedPurchase.warranty_until,
    created_at: normalizedPurchase.created_at,
    used: Boolean(usedPurchases[normalizeLuckmailPurchaseId(normalizedPurchase.id)]),
    preserved: isLuckmailPurchasePreserved(normalizedPurchase, {
      preserveTagId: preserveTagInfo.id,
      preserveTagName: preserveTagInfo.name,
    }),
    disabled: normalizedPurchase.user_disabled === 1,
    current: Number(getCurrentLuckmailPurchase(state)?.id) === normalizedPurchase.id,
    reusable: isLuckmailPurchaseReusable(normalizedPurchase, {
      projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
      usedPurchases,
      preserveTagId: preserveTagInfo.id,
      preserveTagName: preserveTagInfo.name,
      now: Date.now(),
    }),
  };
}

async function getAllLuckmailPurchases(state, options = {}) {
  const client = options.client || createLuckmailClient(state);
  const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 100));
  const maxPages = Math.max(1, Number(options.maxPages) || 50);
  const purchases = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const pageResult = await client.user.getPurchases({
      page,
      pageSize,
      keyword: options.keyword,
      projectId: options.projectId,
      tagId: options.tagId,
      userDisabled: options.userDisabled,
    });
    const normalizedPage = normalizeLuckmailPurchaseListPage(pageResult);
    purchases.push(...normalizedPage.list);

    if (normalizedPage.list.length === 0) {
      break;
    }
    if (normalizedPage.total > 0 && purchases.length >= normalizedPage.total) {
      break;
    }
    if (normalizedPage.list.length < normalizedPage.page_size) {
      break;
    }
  }

  return purchases;
}

async function listLuckmailPurchasesByProject(state, options = {}) {
  const projectCode = normalizeLuckmailProjectName(options.projectCode || DEFAULT_LUCKMAIL_PROJECT_CODE)
    || DEFAULT_LUCKMAIL_PROJECT_CODE;
  const purchases = await getAllLuckmailPurchases(state, options);
  return purchases.filter((purchase) => isLuckmailPurchaseForProject(purchase, projectCode));
}

async function getLuckmailPurchaseById(state, purchaseId, options = {}) {
  const normalizedPurchaseId = Number(normalizeLuckmailPurchaseId(purchaseId)) || 0;
  if (!normalizedPurchaseId) {
    throw new Error('LuckMail 邮箱 ID 无效。');
  }

  const purchases = await listLuckmailPurchasesByProject(state, options);
  const purchase = purchases.find((item) => item.id === normalizedPurchaseId) || null;
  if (!purchase) {
    throw new Error(`未找到 ID=${normalizedPurchaseId} 的 openai LuckMail 邮箱。`);
  }
  return purchase;
}

async function listLuckmailPurchasesForManagement() {
  const state = await getState();
  const purchases = await listLuckmailPurchasesByProject(state, {
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });
  return purchases.map((purchase) => buildLuckmailPurchaseView(purchase, state));
}

async function ensureLuckmailPreserveTag(client, state = null) {
  const resolvedState = state || await getState();
  const preserveTagInfo = getLuckmailPreserveTagInfo(resolvedState);
  if (preserveTagInfo.id > 0) {
    return preserveTagInfo;
  }

  const tags = normalizeLuckmailTags(await client.user.getTags());
  let preserveTag = tags.find(
    (tag) => normalizeLuckmailProjectName(tag.name) === normalizeLuckmailProjectName(preserveTagInfo.name)
  ) || null;

  if (!preserveTag) {
    preserveTag = await client.user.createTag(
      DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
      0,
      '保留邮箱（不参与自动复用）'
    );
  }

  await setLuckmailPreserveTagInfo(preserveTag);
  return {
    id: Number(preserveTag?.id) || 0,
    name: String(preserveTag?.name || '').trim() || DEFAULT_LUCKMAIL_PRESERVE_TAG_NAME,
  };
}

async function activateLuckmailPurchaseForFlow(state, client, purchase, options = {}) {
  const normalizedPurchase = normalizeLuckmailPurchase(purchase);
  if (!normalizedPurchase?.email_address || !normalizedPurchase?.token) {
    throw new Error('LuckMail 邮箱缺少 email/token，无法用于当前流程。');
  }

  let baselineCursor = null;
  if (options.initializeCursor !== false) {
    const mailList = await client.user.getTokenMails(normalizedPurchase.token);
    baselineCursor = buildLuckmailBaselineCursor(mailList?.mails || []);
  }

  await setLuckmailPurchaseState(normalizedPurchase);
  await setLuckmailMailCursorState(baselineCursor);
  await setEmailState(normalizedPurchase.email_address);

  if (options.logMessage) {
    await addLog(options.logMessage, options.logLevel || 'ok');
  }

  return normalizedPurchase;
}

async function findReusableLuckmailPurchaseForFlow(state, client) {
  const preserveTagInfo = getLuckmailPreserveTagInfo(state);
  const reusablePurchases = filterReusableLuckmailPurchases(
    await listLuckmailPurchasesByProject(state, {
      client,
      projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
    }),
    {
      projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
      usedPurchases: getLuckmailUsedPurchases(state),
      preserveTagId: preserveTagInfo.id,
      preserveTagName: preserveTagInfo.name,
      now: Date.now(),
    }
  );

  for (const candidate of reusablePurchases) {
    try {
      const aliveResult = await client.user.checkTokenAlive(candidate.token);
      if (!aliveResult?.alive) {
        await addLog(
          `LuckMail：跳过不可复用邮箱 ${candidate.email_address}：${aliveResult?.message || aliveResult?.status || 'token 不可用'}`,
          'warn'
        );
        continue;
      }
      return candidate;
    } catch (err) {
      await addLog(`LuckMail：检测复用邮箱 ${candidate.email_address} 失败：${err.message}`, 'warn');
    }
  }

  return null;
}

async function selectLuckmailPurchase(purchaseId) {
  const state = await ensureManualInteractionAllowed('切换 LuckMail 邮箱');
  const client = createLuckmailClient(state);
  const purchase = await getLuckmailPurchaseById(state, purchaseId, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });

  if (purchase.user_disabled === 1) {
    throw new Error(`LuckMail 邮箱 ${purchase.email_address} 已禁用，无法使用。`);
  }

  const aliveResult = await client.user.checkTokenAlive(purchase.token);
  if (!aliveResult?.alive) {
    throw new Error(`LuckMail 邮箱 ${purchase.email_address} 当前不可用：${aliveResult?.message || aliveResult?.status || 'token 已失效'}`);
  }

  const activatedPurchase = await activateLuckmailPurchaseForFlow(state, client, purchase, {
    initializeCursor: true,
    logMessage: `LuckMail：已切换当前邮箱为 ${purchase.email_address}`,
  });
  const nextState = await getState();
  return buildLuckmailPurchaseView(activatedPurchase, nextState);
}

async function setLuckmailPurchasePreservedState(purchaseId, preserved) {
  const state = await ensureManualInteractionAllowed('设置 LuckMail 邮箱保留状态');
  const client = createLuckmailClient(state);
  const purchase = await getLuckmailPurchaseById(state, purchaseId, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });

  if (preserved) {
    const preserveTag = await ensureLuckmailPreserveTag(client, state);
    await client.user.setPurchaseTag(purchase.id, { tagId: preserveTag.id });
  } else {
    await client.user.setPurchaseTag(purchase.id, { tagId: 0 });
  }

  await addLog(`LuckMail：已将 ${purchase.email_address} ${preserved ? '设为保留' : '取消保留'}`, 'ok');
  const refreshedState = await getState();
  const refreshedPurchase = await getLuckmailPurchaseById(refreshedState, purchase.id, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });
  return buildLuckmailPurchaseView(refreshedPurchase, await getState());
}

async function setLuckmailPurchaseDisabledState(purchaseId, disabled) {
  const state = await ensureManualInteractionAllowed(disabled ? '禁用 LuckMail 邮箱' : '启用 LuckMail 邮箱');
  const client = createLuckmailClient(state);
  const purchase = await getLuckmailPurchaseById(state, purchaseId, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });

  await client.user.setPurchaseDisabled(purchase.id, disabled ? 1 : 0);

  const currentPurchase = getCurrentLuckmailPurchase(await getState());
  if (disabled && currentPurchase?.id === purchase.id) {
    await clearLuckmailRuntimeState({ clearEmail: isLuckmailProvider(await getState()) });
  }

  await addLog(`LuckMail：已将 ${purchase.email_address} ${disabled ? '禁用' : '启用'}`, 'ok');
  const refreshedState = await getState();
  const refreshedPurchase = await getLuckmailPurchaseById(refreshedState, purchase.id, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });
  return buildLuckmailPurchaseView(refreshedPurchase, await getState());
}

async function batchUpdateLuckmailPurchases(input = {}) {
  const action = String(input.action || '').trim();
  const selectedIds = Array.isArray(input.ids)
    ? [...new Set(input.ids.map((id) => Number(normalizeLuckmailPurchaseId(id)) || 0).filter((id) => id > 0))]
    : [];
  if (!selectedIds.length) {
    throw new Error('请先选择至少一个 LuckMail 邮箱。');
  }

  const state = await ensureManualInteractionAllowed('批量更新 LuckMail 邮箱');
  const client = createLuckmailClient(state);
  const purchases = await listLuckmailPurchasesByProject(state, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });
  const purchaseMap = new Map(purchases.map((purchase) => [purchase.id, purchase]));
  const targetPurchases = selectedIds.map((id) => purchaseMap.get(id)).filter(Boolean);

  if (!targetPurchases.length) {
    throw new Error('未找到可批量处理的 openai LuckMail 邮箱。');
  }

  const targetIds = targetPurchases.map((purchase) => purchase.id);

  if (action === 'used' || action === 'unused') {
    const nextUsedState = getLuckmailUsedPurchases(state);
    targetIds.forEach((id) => {
      const key = normalizeLuckmailPurchaseId(id);
      if (!key) return;
      if (action === 'used') {
        nextUsedState[key] = true;
      } else {
        delete nextUsedState[key];
      }
    });
    await setLuckmailUsedPurchasesState(nextUsedState);
    await addLog(`LuckMail：已批量${action === 'used' ? '标记已用' : '标记未用'} ${targetIds.length} 个邮箱`, 'ok');
  } else if (action === 'preserve' || action === 'unpreserve') {
    if (action === 'preserve') {
      const preserveTag = await ensureLuckmailPreserveTag(client, state);
      await client.user.batchSetPurchaseTag(targetIds, { tagId: preserveTag.id });
    } else {
      await client.user.batchSetPurchaseTag(targetIds, { tagId: 0 });
    }
    await addLog(`LuckMail：已批量${action === 'preserve' ? '保留' : '取消保留'} ${targetIds.length} 个邮箱`, 'ok');
  } else if (action === 'disable' || action === 'enable') {
    await client.user.batchSetPurchaseDisabled(targetIds, action === 'disable' ? 1 : 0);
    const currentPurchase = getCurrentLuckmailPurchase(await getState());
    if (action === 'disable' && currentPurchase?.id && targetIds.includes(currentPurchase.id)) {
      await clearLuckmailRuntimeState({ clearEmail: isLuckmailProvider(await getState()) });
    }
    await addLog(`LuckMail：已批量${action === 'disable' ? '禁用' : '启用'} ${targetIds.length} 个邮箱`, 'ok');
  } else {
    throw new Error(`不支持的 LuckMail 批量操作：${action}`);
  }

  return {
    updatedIds: targetIds,
  };
}

async function disableUsedLuckmailPurchases() {
  const state = await ensureManualInteractionAllowed('禁用已用 LuckMail 邮箱');
  const usedPurchases = getLuckmailUsedPurchases(state);
  const preserveTagInfo = getLuckmailPreserveTagInfo(state);
  const client = createLuckmailClient(state);
  const purchases = await listLuckmailPurchasesByProject(state, {
    client,
    projectCode: DEFAULT_LUCKMAIL_PROJECT_CODE,
  });
  const targets = purchases.filter((purchase) => {
    const purchaseId = normalizeLuckmailPurchaseId(purchase.id);
    return Boolean(purchaseId && usedPurchases[purchaseId])
      && !isLuckmailPurchasePreserved(purchase, {
        preserveTagId: preserveTagInfo.id,
        preserveTagName: preserveTagInfo.name,
      })
      && purchase.user_disabled !== 1;
  });

  if (!targets.length) {
    return { disabledIds: [] };
  }

  const targetIds = targets.map((purchase) => purchase.id);
  await client.user.batchSetPurchaseDisabled(targetIds, 1);
  const currentPurchase = getCurrentLuckmailPurchase(await getState());
  if (currentPurchase?.id && targetIds.includes(currentPurchase.id)) {
    await clearLuckmailRuntimeState({ clearEmail: isLuckmailProvider(await getState()) });
  }
  await addLog(`LuckMail：已禁用 ${targetIds.length} 个本地已用邮箱`, 'ok');
  return { disabledIds: targetIds };
}

async function ensureLuckmailPurchaseForFlow(options = {}) {
  const { allowReuse = true } = options;
  const state = await getState();
  const existingPurchase = getCurrentLuckmailPurchase(state);
  if (allowReuse && existingPurchase?.email_address && existingPurchase?.token) {
    if (state.email !== existingPurchase.email_address) {
      await setEmailState(existingPurchase.email_address);
    }
    return existingPurchase;
  }

  const config = getLuckmailSessionConfig(state);
  const client = createLuckmailClient(state);
  if (allowReuse) {
    const reusablePurchase = await findReusableLuckmailPurchaseForFlow(state, client);
    if (reusablePurchase) {
      return activateLuckmailPurchaseForFlow(state, client, reusablePurchase, {
        initializeCursor: true,
        logMessage: `LuckMail：已复用 openai 邮箱 ${reusablePurchase.email_address}`,
      });
    }
  }

  const result = await client.user.purchaseEmails(DEFAULT_LUCKMAIL_PROJECT_CODE, 1, {
    emailType: config.emailType,
    domain: config.domain || undefined,
  });
  const purchases = normalizeLuckmailPurchases(result);
  const purchase = purchases[0] || null;
  if (!purchase?.email_address || !purchase?.token) {
    throw new Error('LuckMail 购邮成功，但未返回可用邮箱或 token。');
  }

  return activateLuckmailPurchaseForFlow(state, client, purchase, {
    initializeCursor: false,
    logMessage: `LuckMail：已购买邮箱 ${purchase.email_address}（类型：${config.emailType}，项目：${DEFAULT_LUCKMAIL_PROJECT_CODE}）`,
  });
}

async function resolveLuckmailVerificationMail(client, token, filters = {}, tokenCodeResult = null) {
  const tokenCode = tokenCodeResult ? normalizeLuckmailTokenCode(tokenCodeResult) : null;
  if (tokenCode?.mail) {
    const tokenMail = tokenCode.verification_code && !tokenCode.mail.verification_code
      ? {
        ...tokenCode.mail,
        verification_code: tokenCode.verification_code,
      }
      : tokenCode.mail;
    const inlineMatch = pickLuckmailVerificationMail([tokenMail], filters);
    if (inlineMatch) {
      return inlineMatch;
    }
  }

  const mailList = await client.user.getTokenMails(token);
  let match = pickLuckmailVerificationMail(mailList.mails, filters);
  if (match?.mail?.message_id && !match.mail.verification_code) {
    const detail = await client.user.getTokenMailDetail(token, match.mail.message_id);
    match = pickLuckmailVerificationMail([detail], filters);
  }
  return match || null;
}

async function legacyPollLuckmailVerificationCode(step, state, pollPayload = {}) {
  const purchase = getCurrentLuckmailPurchase(state);
  if (!purchase?.token) {
    throw new Error('LuckMail 当前没有可用 token，请先执行步骤 3 购买邮箱。');
  }

  const client = createLuckmailClient(state);
  const maxAttempts = Math.max(1, Number(pollPayload.maxAttempts) || 3);
  const intervalMs = Math.max(15000, Number(pollPayload.intervalMs) || 15000);
  const excludedCodes = new Set((pollPayload.excludeCodes || []).filter(Boolean));

  const initialCursor = normalizeLuckmailMailCursor((await getState()).currentLuckmailMailCursor);
  if (!initialCursor.messageId && !initialCursor.receivedAt) {
    const mailList = await client.user.getTokenMails(purchase.token);
    const baselineCursor = buildLuckmailBaselineCursor(mailList?.mails || []);
    await setLuckmailMailCursorState(baselineCursor);
    if (baselineCursor?.messageId || baselineCursor?.receivedAt) {
      await addLog(`步骤 ${step}：LuckMail 已保存当前邮箱旧邮件快照，后续仅使用新收到的验证码。`, 'info');
    }
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    await addLog(`步骤 ${step}：正在通过 LuckMail 轮询验证码（${attempt}/${maxAttempts}）...`, 'info');

    try {
      const tokenCode = await client.user.getTokenCode(purchase.token);
      const cursor = normalizeLuckmailMailCursor((await getState()).currentLuckmailMailCursor);
      if (tokenCode.verification_code && tokenCode.mail && !isLuckmailMailNewerThanCursor(tokenCode.mail, cursor)) {
        throw new Error(`步骤 ${step}：LuckMail 返回的最新邮件仍是旧验证码。`);
      }

      let match = null;
      if (tokenCode.has_new_mail || tokenCode.verification_code) {
        match = await resolveLuckmailVerificationMail(client, purchase.token, filters, tokenCode);
      }
      if (!match) {
        match = await resolveLuckmailVerificationMail(client, purchase.token, filters, null);
      }

      if (match?.mail) {
        const cursor = normalizeLuckmailMailCursor((await getState()).currentLuckmailMailCursor);
        if (!isLuckmailMailNewerThanCursor(match.mail, cursor)) {
          throw new Error(`步骤 ${step}：LuckMail 命中的邮件不是新邮件。`);
        }

        await setLuckmailMailCursorState(buildLuckmailMailCursor(match.mail));
        return {
          ok: true,
          code: match.code,
          emailTimestamp: normalizeLuckmailTimestamp(match.mail.received_at) || Date.now(),
          mailId: match.mail.message_id,
        };
      }

      lastError = new Error(`步骤 ${step}：暂未在 LuckMail 邮箱中找到新的匹配验证码。`);
    } catch (err) {
      if (isStopError(err)) {
        throw err;
      }
      lastError = err;
      await addLog(`步骤 ${step}：LuckMail 轮询失败：${err.message}`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw lastError || new Error(`步骤 ${step}：未在 LuckMail 邮箱中找到新的匹配验证码。`);
}

async function pollLuckmailVerificationCode(step, state, pollPayload = {}) {
  const purchase = getCurrentLuckmailPurchase(state);
  if (!purchase?.token) {
    throw new Error('LuckMail 当前没有可用 token，请先执行步骤 3 购买邮箱。');
  }

  const client = createLuckmailClient(state);
  const maxAttempts = Math.max(1, Number(pollPayload.maxAttempts) || 3);
  const intervalMs = Math.max(15000, Number(pollPayload.intervalMs) || 15000);
  const excludedCodes = new Set((pollPayload.excludeCodes || []).filter(Boolean));

  const initialCursor = normalizeLuckmailMailCursor((await getState()).currentLuckmailMailCursor);
  if (!initialCursor.messageId && !initialCursor.receivedAt) {
    const mailList = await client.user.getTokenMails(purchase.token);
    const baselineCursor = buildLuckmailBaselineCursor(mailList?.mails || []);
    await setLuckmailMailCursorState(baselineCursor);
    if (baselineCursor?.messageId || baselineCursor?.receivedAt) {
      await addLog(`步骤 ${step}：LuckMail 已保存当前邮箱旧邮件快照，后续仅使用新收到的验证码。`, 'info');
    }
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfStopped();
    await addLog(`步骤 ${step}：正在通过 LuckMail /code 接口轮询验证码（${attempt}/${maxAttempts}）...`, 'info');

    try {
      const tokenCode = await client.user.getTokenCode(purchase.token);
      const remoteEmail = String(tokenCode?.email_address || '').trim().toLowerCase();
      const expectedEmail = String(purchase.email_address || state?.email || '').trim().toLowerCase();
      if (remoteEmail && expectedEmail && remoteEmail !== expectedEmail) {
        throw new Error(`步骤 ${step}：LuckMail token 对应邮箱与当前邮箱不一致。当前邮箱：${expectedEmail}；token 邮箱：${remoteEmail}`);
      }

      const tokenMail = tokenCode.verification_code && tokenCode.mail && !tokenCode.mail.verification_code
        ? {
          ...tokenCode.mail,
          verification_code: tokenCode.verification_code,
        }
        : tokenCode.mail;
      const code = String(tokenCode?.verification_code || tokenMail?.verification_code || '').trim();
      const cursor = normalizeLuckmailMailCursor((await getState()).currentLuckmailMailCursor);

      if (!code || !tokenMail) {
        lastError = new Error(`步骤 ${step}：LuckMail /code 接口暂未返回新的验证码。`);
      } else if (excludedCodes.has(code)) {
        lastError = new Error(`步骤 ${step}：LuckMail 返回的验证码 ${code} 已试过，等待 15 秒后再次轮询。`);
      } else if (!isLuckmailMailNewerThanCursor(tokenMail, cursor)) {
        lastError = new Error(`步骤 ${step}：LuckMail /code 返回的最新邮件仍是旧验证码。`);
      } else {
        await setLuckmailMailCursorState(buildLuckmailMailCursor(tokenMail));
        return {
          ok: true,
          code,
          emailTimestamp: normalizeLuckmailTimestamp(tokenMail.received_at) || Date.now(),
          mailId: tokenMail.message_id,
        };
      }
    } catch (err) {
      if (isStopError(err)) {
        throw err;
      }
      lastError = err;
      await addLog(`步骤 ${step}：LuckMail /code 轮询失败：${err.message}`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw lastError || new Error(`步骤 ${step}：未在 LuckMail /code 接口中获取到新的验证码。`);
}

function summarizeCloudflareTempEmailMessagesForLog(messages) {
  return (messages || [])
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(left.receivedDateTime || '') || 0;
      const rightTime = Date.parse(right.receivedDateTime || '') || 0;
      return rightTime - leftTime;
    })
    .slice(0, 3)
    .map((message) => {
      const receivedAt = message?.receivedDateTime || '未知时间';
      const sender = message?.from?.emailAddress?.address || '未知发件人';
      const subject = message?.subject || '（无主题）';
      const preview = String(message?.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const address = message?.address || '未知地址';
      return `[${address}] ${receivedAt} | ${sender} | ${subject} | ${preview}`;
    })
    .join(' || ');
}

async function deleteCloudflareTempEmailMail(config, mailId) {
  const normalizedMailId = String(mailId || '').trim();
  if (!normalizedMailId) return false;

  await requestCloudflareTempEmailJson(config, `/admin/mails/${encodeURIComponent(normalizedMailId)}`, {
    method: 'DELETE',
  });
  return true;
}

async function listCloudflareTempEmailMessages(state, options = {}) {
  const config = ensureCloudflareTempEmailConfig(state, { requireAdminAuth: true });
  const address = normalizeCloudflareTempEmailAddress(options.address);
  const lookupMode = normalizeCloudflareTempEmailLookupMode(options.lookupMode || config.lookupMode);
  const originalRecipient = normalizeCloudflareTempEmailReceiveMailbox(options.originalRecipient);
  const useRegistrationLookup = lookupMode === CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL
    && Boolean(originalRecipient);
  const queryAddress = useRegistrationLookup ? '' : address;
  const payload = await requestCloudflareTempEmailJson(config, '/admin/mails', {
    method: 'GET',
    searchParams: {
      limit: Number(options.limit) || CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE,
      offset: Number(options.offset) || 0,
      address: queryAddress,
    },
  });

  const normalizedMessages = normalizeCloudflareTempEmailMailApiMessages(payload);
  const hasOriginalRecipient = normalizedMessages.some((message) => normalizeCloudflareTempEmailReceiveMailbox(message.originalRecipient));
  const messages = normalizedMessages.filter((message) => {
    if (useRegistrationLookup) {
      return normalizeCloudflareTempEmailReceiveMailbox(message.originalRecipient) === originalRecipient;
    }
    if (!address) return true;
    return !message.address || normalizeCloudflareTempEmailAddress(message.address) === address;
  });

  return {
    config,
    messages,
    lookupMode,
    originalRecipient,
    missingOriginalRecipient: useRegistrationLookup && normalizedMessages.length > 0 && !hasOriginalRecipient,
  };
}

async function pollCloudflareTempEmailVerificationCode(step, state, pollPayload = {}) {
  const config = ensureCloudflareTempEmailConfig(state, { requireAdminAuth: true });
  const targetEmail = resolveCloudflareTempEmailPollTargetEmail(state, pollPayload, config);
  const registrationEmail = normalizeCloudflareTempEmailReceiveMailbox(state.email);
  const lookupMode = normalizeCloudflareTempEmailLookupMode(config.lookupMode);
  const mailProvider = String(state?.mailProvider || '').trim().toLowerCase();
  const emailGenerator = String(state?.emailGenerator || '').trim().toLowerCase();
  const useRegistrationLookup = mailProvider === 'cloudflare-temp-email'
    && emailGenerator !== 'cloudflare-temp-email'
    && lookupMode === CLOUDFLARE_TEMP_EMAIL_LOOKUP_MODE_REGISTRATION_EMAIL;
  const originalRecipient = normalizeCloudflareTempEmailReceiveMailbox(pollPayload.targetEmail)
    || registrationEmail
    || targetEmail;
  if (!targetEmail) {
    throw new Error('Cloudflare Temp Email 轮询前缺少目标邮箱地址，请先填写注册邮箱或“邮件接收”邮箱。');
  }

  if (useRegistrationLookup) {
    await addLog(`步骤 ${step}：正在按注册邮箱筛选 Cloudflare Temp Email 邮件（${originalRecipient}）...`, 'info');
  } else if (registrationEmail && registrationEmail !== targetEmail) {
    await addLog(`步骤 ${step}：正在轮询 Cloudflare Temp Email 收件邮箱（${targetEmail}），注册邮箱为 ${registrationEmail}...`, 'info');
  } else {
    await addLog(`步骤 ${step}：正在轮询 Cloudflare Temp Email 邮件（${targetEmail}）...`, 'info');
  }
  const maxAttempts = Number(pollPayload.maxAttempts) || 5;
  const intervalMs = Number(pollPayload.intervalMs) || 3000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfStopped();
    try {
      const { messages, missingOriginalRecipient } = await listCloudflareTempEmailMessages(state, {
        address: useRegistrationLookup ? '' : targetEmail,
        lookupMode,
        originalRecipient,
        limit: pollPayload.limit || CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE,
        offset: pollPayload.offset || 0,
      });
      if (useRegistrationLookup && missingOriginalRecipient) {
        throw new Error('Cloudflare Temp Email 当前接口未返回 original_recipient，注册邮箱查信需要部署本扩展作者修改后的 Cloudflare Temp Email，或切回“邮件接收”。');
      }
      const matchResult = pickVerificationMessageWithTimeFallback(messages, {
        afterTimestamp: pollPayload.filterAfterTimestamp || 0,
        senderFilters: pollPayload.senderFilters || [],
        subjectFilters: pollPayload.subjectFilters || [],
        requiredKeywords: pollPayload.requiredKeywords || [],
        codePatterns: pollPayload.codePatterns || [],
        excludeCodes: pollPayload.excludeCodes || [],
      });
      const match = matchResult.match;

      if (match?.code) {
        if (matchResult.usedRelaxedFilters) {
          const fallbackLabel = matchResult.usedTimeFallback ? '宽松匹配 + 时间回退' : '宽松匹配';
          await addLog(`步骤 ${step}：严格规则未命中，已改用 ${fallbackLabel} 并命中 Cloudflare Temp Email 验证码。`, 'warn');
        }
        try {
          await deleteCloudflareTempEmailMail(config, match.message?.id);
        } catch (err) {
          await addLog(`步骤 ${step}：删除 Cloudflare Temp Email 邮件失败：${err.message}`, 'warn');
        }
        return {
          ok: true,
          code: match.code,
          emailTimestamp: match.receivedAt || Date.now(),
          mailId: match.message?.id || '',
        };
      }

      lastError = new Error(`步骤 ${step}：暂未在 Cloudflare Temp Email 中找到匹配验证码（${attempt}/${maxAttempts}）。`);
      await addLog(lastError.message, attempt === maxAttempts ? 'warn' : 'info');
      const sample = summarizeCloudflareTempEmailMessagesForLog(messages);
      if (sample) {
        await addLog(`步骤 ${step}：最近邮件样本：${sample}`, 'info');
      }
    } catch (err) {
      lastError = err;
      await addLog(`步骤 ${step}：Cloudflare Temp Email 轮询失败：${err.message}`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleepWithStop(intervalMs);
    }
  }

  throw lastError || new Error(`步骤 ${step}：未在 Cloudflare Temp Email 中找到新的匹配验证码。`);
}

async function getOpenIcloudHostPreference() {
  try {
    const tabs = await queryTabsInAutomationWindow({
      url: ICLOUD_TAB_URL_PATTERNS,
    });

    const activeTab = tabs.find((tab) => tab.active);
    const candidates = activeTab ? [activeTab, ...tabs.filter((tab) => tab.id !== activeTab.id)] : tabs;
    for (const tab of candidates) {
      try {
        const host = normalizeIcloudHost(new URL(tab.url).host);
        if (host) return host;
      } catch {}
    }
  } catch {}

  return '';
}

async function getPreferredIcloudLoginUrl(error = null, state = null) {
  const currentState = state || await getState();
  const configuredHost = getConfiguredIcloudHostPreference(currentState);
  if (configuredHost) {
    return getIcloudLoginUrlForHost(configuredHost);
  }

  const openHost = await getOpenIcloudHostPreference();
  if (openHost) {
    return getIcloudLoginUrlForHost(openHost);
  }

  const savedHost = normalizeIcloudHost(currentState?.preferredIcloudHost);
  if (savedHost) {
    return getIcloudLoginUrlForHost(savedHost);
  }

  const messageHint = getIcloudHostHintFromMessage(getErrorMessage(error));
  if (messageHint) {
    return getIcloudLoginUrlForHost(messageHint);
  }

  return getIcloudLoginUrlForHost('icloud.com') || ICLOUD_LOGIN_URLS[0];
}

async function getPreferredIcloudSetupUrls(state = null, error = null) {
  const currentState = state || await getState();
  const configuredHost = getConfiguredIcloudHostPreference(currentState);
  if (configuredHost) {
    const forcedSetupUrl = getIcloudSetupUrlForHost(configuredHost);
    if (forcedSetupUrl) {
      return [forcedSetupUrl];
    }
  }
  const preferredLoginUrl = await getPreferredIcloudLoginUrl(error, state);
  const preferredHost = normalizeIcloudHost(new URL(preferredLoginUrl).host);
  const preferredSetupUrl = getIcloudSetupUrlForHost(preferredHost);
  if (!preferredSetupUrl) {
    return [...ICLOUD_SETUP_URLS];
  }
  return [
    preferredSetupUrl,
    ...ICLOUD_SETUP_URLS.filter((url) => url !== preferredSetupUrl),
  ];
}

function isIcloudLoginRequiredError(error) {
  const message = getErrorMessage(error).toLowerCase();
  const hasAuthStatus401 = /\bstatus 401\b/.test(message);
  const hasAuthStatus403 = /\bstatus 403\b/.test(message);
  const hasTransientStatus = /\bstatus (409|421|429|5\d\d)\b/.test(message);
  const hasTransientNetworkHint = message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('cors')
    || message.includes('address space');
  const hasExplicitLoginHint = message.includes('please sign in')
    || message.includes('sign in required')
    || message.includes('not logged in')
    || message.includes('login required')
    || message.includes('re-authentication required')
    || message.includes('unauthenticated')
    || message.includes('authentication required')
    || message.includes('需要先登录')
    || message.includes('请先登录');
  const hasSelfPromptHint = message.includes('请先在新打开的 icloud 页面中完成登录')
    || message.includes('请先在当前浏览器登录');
  const hasAuthStatusWithExplicitLoginHint = (hasAuthStatus401 || hasAuthStatus403)
    && hasExplicitLoginHint;

  // Keep transient validate/network/cors errors out of login-required path.
  if (message.includes('could not validate icloud session')) {
    return false;
  }
  if (message.includes('page_context:')) {
    return false;
  }
  if (hasSelfPromptHint) {
    return false;
  }
  if (hasTransientStatus || hasTransientNetworkHint) {
    return false;
  }

  if (hasAuthStatusWithExplicitLoginHint) {
    return true;
  }

  if (hasExplicitLoginHint) {
    return true;
  }

  return false;
}

function isIcloudTransientContextError(error) {
  const message = getErrorMessage(error).toLowerCase();
  return /\bstatus (401|403|409|421|429|5\d\d)\b/.test(message)
    || message.includes('could not validate icloud session')
    || message.includes('page_context:')
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('cors')
    || message.includes('address space')
    || message.includes('timeout')
    || message.includes('timed out');
}

let lastIcloudLoginPromptAt = 0;
const activeIcloudRequestControllers = new Set();
let lastResolvedIcloudServiceUrl = '';
const icloudTransientLogThrottle = new Map();

function shouldEmitIcloudTransientLog(key, windowMs = 1500) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return true;
  }
  const now = Date.now();
  const lastAt = Number(icloudTransientLogThrottle.get(normalizedKey) || 0);
  if (now - lastAt < Math.max(200, Number(windowMs) || 1500)) {
    return false;
  }
  icloudTransientLogThrottle.set(normalizedKey, now);
  return true;
}

async function openIcloudLoginPage(preferredUrl) {
  const tabs = await queryTabsInAutomationWindow({
    url: ICLOUD_TAB_URL_PATTERNS,
  });
  const preferredHost = new URL(preferredUrl).host;
  const preferredIcloudHost = normalizeIcloudHost(preferredHost);
  const existingSameHost = tabs.find((tab) => {
    try {
      return normalizeIcloudHost(new URL(tab.url).host) === preferredIcloudHost;
    } catch {
      return false;
    }
  });
  const existingAnyIcloudTab = tabs.find((tab) => Number.isInteger(tab?.id));

  if (existingSameHost?.id) {
    await chrome.tabs.update(existingSameHost.id, { active: true });
    return existingSameHost.id;
  }

  if (existingAnyIcloudTab?.id) {
    await chrome.tabs.update(existingAnyIcloudTab.id, { active: true });
    return existingAnyIcloudTab.id;
  }

  const created = await createAutomationTab({ url: preferredUrl, active: true });
  return created.id;
}

async function promptIcloudLogin(error, actionLabel = 'iCloud 操作') {
  const now = Date.now();
  const preferredUrl = await getPreferredIcloudLoginUrl(error);
  const originalError = getErrorMessage(error);

  chrome.runtime.sendMessage({
    type: 'ICLOUD_LOGIN_REQUIRED',
    payload: {
      actionLabel,
      loginUrl: preferredUrl,
      message: '需要先登录 iCloud，我已经为你打开登录页。',
      detail: originalError,
    },
  }).catch(() => { });

  if (now - lastIcloudLoginPromptAt < 15000) {
    return;
  }
  lastIcloudLoginPromptAt = now;

  await addLog(`iCloud：${actionLabel}时需要登录，正在打开 ${new URL(preferredUrl).host} ...`, 'warn');

  try {
    await openIcloudLoginPage(preferredUrl);
  } catch (tabErr) {
    await addLog(`iCloud：自动打开登录页失败：${getErrorMessage(tabErr)}`, 'warn');
  }
}

async function withIcloudLoginHelp(actionLabel, action) {
  const safeActionLabel = String(actionLabel || 'iCloud 操作').trim() || 'iCloud 操作';
  const maxTransientAttempts = Math.max(1, Number(ICLOUD_TRANSIENT_RETRY_MAX_ATTEMPTS) || 1);
  const retryDelayMs = Math.max(300, Number(ICLOUD_TRANSIENT_RETRY_DELAY_MS) || 1200);
  for (let attempt = 1; attempt <= maxTransientAttempts; attempt += 1) {
    try {
      return await action();
    } catch (err) {
      if (isIcloudLoginRequiredError(err)) {
        await promptIcloudLogin(err, actionLabel);
        throw new Error('请先在新打开的 iCloud 页面中完成登录，再回来点击“我已登录”。');
      }
      if (isIcloudTransientContextError(err)) {
        if (attempt < maxTransientAttempts) {
          if (shouldEmitIcloudTransientLog(`${safeActionLabel}:retry:${attempt}/${maxTransientAttempts}`)) {
            await addLog(`iCloud：${safeActionLabel}受网络/上下文波动影响，正在重试（${attempt}/${maxTransientAttempts}）...`, 'warn');
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
          continue;
        }
        if (shouldEmitIcloudTransientLog(`${safeActionLabel}:final`)) {
          await addLog(`iCloud：${safeActionLabel}受网络/上下文波动影响：${getErrorMessage(err)}`, 'warn');
        }
        const transientError = new Error(`iCloud：${safeActionLabel}受网络/上下文波动影响，请稍后重试。`);
        transientError.code = 'ICLOUD_TRANSIENT_CONTEXT';
        transientError.actionLabel = safeActionLabel;
        transientError.cause = err;
        throw transientError;
      }
      throw err;
    }
  }
  throw new Error('iCloud 操作失败：未知错误。');
}

function isIcloudApiUrl(url = '') {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) {
    return false;
  }
  try {
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== 'https:') {
      return false;
    }
    const hostname = String(parsedUrl.hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (!hostname) {
      return false;
    }
    return hostname === 'icloud.com'
      || hostname.endsWith('.icloud.com')
      || hostname === 'icloud.com.cn'
      || hostname.endsWith('.icloud.com.cn');
  } catch {
    return false;
  }
}

function normalizeIcloudServiceUrl(rawUrl = '') {
  const value = String(rawUrl || '').trim();
  if (!value) {
    return '';
  }
  try {
    const parsedUrl = new URL(value);
    if ((parsedUrl.protocol === 'https:' && parsedUrl.port === '443')
      || (parsedUrl.protocol === 'http:' && parsedUrl.port === '80')) {
      parsedUrl.port = '';
    }
    return parsedUrl.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/\/$/, '');
  }
}

function rememberIcloudServiceUrl(rawUrl = '') {
  const normalized = normalizeIcloudServiceUrl(rawUrl);
  if (normalized) {
    lastResolvedIcloudServiceUrl = normalized;
  }
  return normalized;
}

function isIcloudMaildomainwsHost(rawHost = '') {
  const host = String(rawHost || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) {
    return false;
  }
  return host.endsWith('maildomainws.icloud.com') || host.endsWith('maildomainws.icloud.com.cn');
}

function appendIcloudClientQueryParams(rawUrl = '') {
  const input = String(rawUrl || '').trim();
  if (!input) {
    return '';
  }
  try {
    const parsed = new URL(input);
    if (!isIcloudMaildomainwsHost(parsed.hostname)) {
      return input;
    }

    if (!parsed.searchParams.has('clientBuildNumber')) {
      parsed.searchParams.set('clientBuildNumber', ICLOUD_MAILDOMAINWS_CLIENT_BUILD_NUMBER);
    }
    if (!parsed.searchParams.has('clientMasteringNumber')) {
      parsed.searchParams.set('clientMasteringNumber', ICLOUD_MAILDOMAINWS_CLIENT_BUILD_NUMBER);
    }
    if (!parsed.searchParams.has('clientId')) {
      parsed.searchParams.set('clientId', '');
    }
    if (!parsed.searchParams.has('dsid')) {
      parsed.searchParams.set('dsid', '');
    }
    return parsed.toString();
  } catch {
    return input;
  }
}

function isIcloudMailPageUrl(rawUrl = '') {
  try {
    const parsedUrl = new URL(String(rawUrl || '').trim());
    if (!normalizeIcloudHost(parsedUrl.hostname)) {
      return false;
    }
    const pathname = String(parsedUrl.pathname || '').toLowerCase();
    return pathname === '/mail' || pathname.startsWith('/mail/');
  } catch {
    return false;
  }
}

async function waitForIcloudMailTabReady(tabId, timeoutMs = 8000) {
  if (!Number.isInteger(tabId)) {
    return false;
  }
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 8000);
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const status = String(tab?.status || '');
      if (isIcloudMailPageUrl(tab?.url) && status === 'complete') {
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureIcloudMailContextTab(tabs = [], targetHost = '', preferredHost = '') {
  const tabList = Array.isArray(tabs) ? tabs : [];
  const normalizedTargetHost = normalizeIcloudHost(targetHost);
  const normalizedPreferredHost = normalizeIcloudHost(preferredHost);
  const fallbackHost = normalizedTargetHost
    || normalizedPreferredHost
    || await getOpenIcloudHostPreference()
    || 'icloud.com';
  const fallbackMailUrl = getIcloudMailUrlForHost(fallbackHost) || getIcloudMailUrlForHost('icloud.com');
  if (!fallbackMailUrl) {
    return tabList;
  }

  const readHostFromTab = (tab) => {
    try {
      return normalizeIcloudHost(new URL(String(tab?.url || '')).hostname);
    } catch {
      return '';
    }
  };

  const mailTabs = tabList.filter((tab) => isIcloudMailPageUrl(tab?.url));
  if (mailTabs.length > 0) {
    if (fallbackHost) {
      const hasTargetHostMailTab = mailTabs.some((tab) => readHostFromTab(tab) === fallbackHost);
      if (!hasTargetHostMailTab && Number.isInteger(mailTabs[0]?.id)) {
        try {
          await chrome.tabs.update(mailTabs[0].id, { url: fallbackMailUrl, active: false });
          await waitForIcloudMailTabReady(mailTabs[0].id, 9000);
          try {
            return await queryTabsInAutomationWindow({
              url: ICLOUD_TAB_URL_PATTERNS,
            });
          } catch {
            return tabList;
          }
        } catch {}
      }
    }
    return tabList;
  }

  const sameHostIcloudTab = tabList.find((tab) => (
    Number.isInteger(tab?.id) && readHostFromTab(tab) === fallbackHost
  ));
  const anyIcloudTab = tabList.find((tab) => Number.isInteger(tab?.id));

  try {
    if (sameHostIcloudTab?.id) {
      await chrome.tabs.update(sameHostIcloudTab.id, { url: fallbackMailUrl, active: false });
      await waitForIcloudMailTabReady(sameHostIcloudTab.id, 9000);
    } else if (anyIcloudTab?.id) {
      await chrome.tabs.update(anyIcloudTab.id, { url: fallbackMailUrl, active: false });
      await waitForIcloudMailTabReady(anyIcloudTab.id, 9000);
    } else {
      const created = await createAutomationTab({ url: fallbackMailUrl, active: false });
      await waitForIcloudMailTabReady(created?.id, 9000);
    }
  } catch {}

  try {
    return await queryTabsInAutomationWindow({
      url: ICLOUD_TAB_URL_PATTERNS,
    });
  } catch {
    return tabList;
  }
}

function shouldTryIcloudRequestPageContextFallback(url, status, errorMessage = '') {
  if (!isIcloudApiUrl(url)) {
    return false;
  }

  const normalizedStatus = Number(status) || 0;
  if (normalizedStatus === 401
    || normalizedStatus === 403
    || normalizedStatus === 409
    || normalizedStatus === 421
    || normalizedStatus === 429
    || normalizedStatus >= 500) {
    return true;
  }

  const message = String(errorMessage || '').toLowerCase();
  return message.includes('failed to fetch')
    || message.includes('network request failed')
    || message.includes('networkerror')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('cors')
    || message.includes('address space');
}

async function icloudRequestViaPageContext(method, url, options = {}) {
  const {
    data,
    contentType = '',
  } = options;
  const state = await getState();
  const configuredHost = getConfiguredIcloudHostPreference(state);
  const targetHost = configuredHost || normalizeIcloudHost(new URL(url).hostname);
  const preferredHost = configuredHost || normalizeIcloudHost(state?.preferredIcloudHost);

  let tabs = await queryTabsInAutomationWindow({
    url: ICLOUD_TAB_URL_PATTERNS,
  });
  tabs = await ensureIcloudMailContextTab(tabs, targetHost, preferredHost);
  if (!tabs.length) {
    throw new Error('page_context:no_icloud_tab');
  }

  const sortedTabs = [...tabs].sort((left, right) => {
    const score = (tab) => {
      let tabHost = '';
      try {
        tabHost = normalizeIcloudHost(new URL(String(tab?.url || '')).hostname);
      } catch {}
      return (isIcloudMailPageUrl(tab?.url) ? 8 : 0)
        + (tab?.active ? 4 : 0)
        + (tabHost && tabHost === targetHost ? 2 : 0)
        + (tabHost && tabHost === preferredHost ? 1 : 0);
    };
    return score(right) - score(left);
  });
  const mailTabs = sortedTabs.filter((tab) => isIcloudMailPageUrl(tab?.url));
  const candidateTabs = mailTabs.length ? mailTabs : sortedTabs;

  const errors = [];
  for (const tab of candidateTabs) {
    if (!Number.isInteger(tab?.id)) {
      continue;
    }
    try {
      const injections = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        world: 'MAIN',
        func: async (requestConfig) => {
          const timeoutMs = 15000;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const headers = requestConfig.hasData
              ? { 'Content-Type': requestConfig.contentType || 'application/json' }
              : undefined;
            const response = await fetch(requestConfig.url, {
              method: requestConfig.method,
              credentials: 'include',
              cache: 'no-store',
              mode: 'cors',
              headers,
              body: requestConfig.hasData ? JSON.stringify(requestConfig.data) : undefined,
              signal: controller.signal,
            });
            const text = await response.text();
            return {
              ok: Boolean(response.ok),
              status: Number(response.status) || 0,
              text,
              error: '',
            };
          } catch (err) {
            return {
              ok: false,
              status: 0,
              text: '',
              error: String(err?.message || err || 'unknown error'),
            };
          } finally {
            clearTimeout(timeoutId);
          }
        },
        args: [{
          method,
          url,
          hasData: data !== undefined,
          data: data === undefined ? null : data,
          contentType: contentType || '',
        }],
      });

      const result = injections?.[0]?.result || null;
      if (!result) {
        throw new Error('empty result');
      }
      if (!result.ok) {
        if (result.status) {
          throw new Error(`status ${result.status}`);
        }
        throw new Error(result.error || 'page context request failed');
      }

      if (!String(result.text || '').trim()) {
        return {};
      }

      try {
        return JSON.parse(result.text);
      } catch (parseErr) {
        throw new Error(`invalid json: ${getErrorMessage(parseErr)}`);
      }
    } catch (err) {
      errors.push(`tab_${tab.id}:${getErrorMessage(err)}`);
    }
  }

  throw new Error(errors.length ? errors.join(' | ') : 'page_context:unknown');
}

function getIcloudRequestTargetLabel(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

function getIcloudRetryDelay(attemptIndex) {
  if (attemptIndex <= 0) return ICLOUD_RETRY_DELAYS_MS[0];
  return ICLOUD_RETRY_DELAYS_MS[Math.min(attemptIndex - 1, ICLOUD_RETRY_DELAYS_MS.length - 1)];
}

function isIcloudRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}

function isIcloudRetryableError(error) {
  const status = Number(error?.status || error?.responseStatus || 0);
  if (status && isIcloudRetryableStatus(status)) {
    return true;
  }
  if (error?.timedOut || error?.networkFailure) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network error')
    || message.includes('fetch failed')
    || message.includes('timed out')
    || message.includes('timeout')
    || (error?.name === 'AbortError' && !stopRequested);
}

function abortActiveIcloudRequests() {
  for (const controller of [...activeIcloudRequestControllers]) {
    try {
      controller.abort();
    } catch {}
  }
  activeIcloudRequestControllers.clear();
}

async function icloudRequest(method, url, options = {}) {
  const {
    data,
    timeoutMs = ICLOUD_REQUEST_TIMEOUT_MS,
    maxAttempts = 1,
    retryLabel = '',
    logRetries = false,
  } = options;
  const requestUrl = appendIcloudClientQueryParams(url);
  const requestContentType = (() => {
    if (data === undefined) {
      return '';
    }
    try {
      return isIcloudMaildomainwsHost(new URL(requestUrl).hostname)
        ? 'text/plain;charset=UTF-8'
        : 'application/json';
    } catch {
      return 'application/json';
    }
  })();

  let lastError = null;
  const totalAttempts = Math.max(1, Number(maxAttempts) || 1);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    throwIfStopped();

    const controller = new AbortController();
    let response = null;
    let timeoutTriggered = false;
    let timeoutId = null;
    activeIcloudRequestControllers.add(controller);

    try {
      timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        try {
          controller.abort();
        } catch {}
      }, Math.max(1000, Number(timeoutMs) || ICLOUD_REQUEST_TIMEOUT_MS));

      response = await fetch(requestUrl, {
        method,
        credentials: 'include',
        headers: requestContentType ? { 'Content-Type': requestContentType } : undefined,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let responseText = '';
        try {
          responseText = normalizeText(await response.text()).slice(0, 240);
        } catch {}

        const error = new Error(
          responseText
            ? `iCloud 请求失败：${method} ${requestUrl}，status ${response.status}，body: ${responseText}`
            : `iCloud 请求失败：${method} ${requestUrl}，status ${response.status}`
        );
        error.status = response.status;
        throw error;
      }

      const rawText = await response.text();
      if (!rawText) {
        return {};
      }

      try {
        return JSON.parse(rawText);
      } catch (err) {
        throw new Error(`iCloud 返回的 JSON 无法解析：${method} ${requestUrl}，${err.message}`);
      }
    } catch (err) {
      if (stopRequested) {
        throw new Error(STOP_ERROR_MESSAGE);
      }

      let requestError = err;
      if (timeoutTriggered || err?.name === 'AbortError') {
        requestError = new Error(`iCloud 请求超时：${method} ${url}，${timeoutMs}ms`);
        requestError.name = 'IcloudTimeoutError';
        requestError.timedOut = true;
      } else if (!requestError?.status) {
        const message = getErrorMessage(requestError);
        if (/failed to fetch|networkerror|network error|fetch failed/i.test(message)) {
          requestError.networkFailure = true;
        }
      }

      const directErrorMessage = getErrorMessage(requestError)
        || `iCloud 请求失败：${method} ${requestUrl}`;
      const shouldTryPageContext = shouldTryIcloudRequestPageContextFallback(
        requestUrl,
        Number(requestError?.status) || 0,
        directErrorMessage
      );
      if (shouldTryPageContext) {
        try {
          return await icloudRequestViaPageContext(method, requestUrl, {
            data,
            contentType: requestContentType || undefined,
          });
        } catch (pageContextError) {
          const pageContextMessage = getErrorMessage(pageContextError);
          if (!pageContextMessage.includes('page_context:no_icloud_tab')) {
            const mergedError = new Error(`${directErrorMessage} | page_context:${pageContextMessage}`);
            if (requestError?.status) {
              mergedError.status = requestError.status;
            }
            requestError = mergedError;
          }
        }
      }

      lastError = requestError;
      const shouldRetry = attempt < totalAttempts && isIcloudRetryableError(requestError);
      if (!shouldRetry) {
        throw requestError;
      }

      if (logRetries) {
        const delayMs = getIcloudRetryDelay(attempt);
        await addLog(
          `iCloud：${retryLabel || getIcloudRequestTargetLabel(requestUrl)} 第 ${attempt}/${totalAttempts} 次失败：${getErrorMessage(requestError)}，${Math.round(delayMs / 1000)} 秒后重试...`,
          'warn'
        );
      }

      await sleepWithStop(getIcloudRetryDelay(attempt));
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      activeIcloudRequestControllers.delete(controller);
    }
  }

  throw lastError || new Error(`iCloud 请求失败：${method} ${requestUrl}`);
}

async function validateIcloudSession(setupUrl) {
  const data = await icloudRequest('POST', `${setupUrl}/validate`);
  if (!data?.webservices?.premiummailsettings?.url) {
    throw new Error('Could not validate iCloud session. Hide My Email service was unavailable.');
  }
  return data;
}

function shouldTryIcloudPageContextFallback(errors = []) {
  const combinedMessage = String((errors || []).join(' | ')).toLowerCase();
  if (!combinedMessage) {
    return false;
  }
  return combinedMessage.includes('status 401')
    || combinedMessage.includes('status 403')
    || combinedMessage.includes('status 421')
    || combinedMessage.includes('networkerror')
    || combinedMessage.includes('network request failed')
    || combinedMessage.includes('failed to fetch')
    || combinedMessage.includes('timed out')
    || combinedMessage.includes('timeout')
    || combinedMessage.includes('cors');
}

async function validateIcloudSessionViaPageContext(tabId, setupUrl) {
  const host = new URL(setupUrl).host;
  try {
    const injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: async (targetSetupUrl) => {
        const timeoutMs = 12000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${targetSetupUrl}/validate`, {
            method: 'POST',
            credentials: 'include',
            cache: 'no-store',
            mode: 'cors',
            signal: controller.signal,
          });
          const text = await response.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {}
          return {
            ok: Boolean(response.ok),
            status: Number(response.status) || 0,
            data,
            error: '',
          };
        } catch (err) {
          return {
            ok: false,
            status: 0,
            data: null,
            error: String(err?.message || err || 'unknown error'),
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      args: [setupUrl],
    });

    const result = injections?.[0]?.result || null;
    if (result?.ok && result?.data?.webservices?.premiummailsettings?.url) {
      return {
        setupUrl,
        serviceUrl: normalizeIcloudServiceUrl(result.data.webservices.premiummailsettings.url),
        resolvedBy: 'page_context',
      };
    }

    if (result?.status) {
      throw new Error(`status ${result.status}`);
    }
    throw new Error(result?.error || 'page context validate failed');
  } catch (err) {
    throw new Error(`${host}: ${getErrorMessage(err)}`);
  }
}

async function resolveIcloudPremiumMailServiceViaPageContext(setupUrls, state, options = {}) {
  const errors = [];
  let tabs = [];
  try {
    tabs = await queryTabsInAutomationWindow({
      url: ICLOUD_TAB_URL_PATTERNS,
    });
  } catch (err) {
    errors.push(`page_context:query_tabs:${getErrorMessage(err)}`);
    return { service: null, errors, noTab: false };
  }

  const explicitHost = normalizeIcloudHost(options?.hostPreference || options?.preferredHost || '');
  const configuredHost = getConfiguredIcloudHostPreference(state);
  const preferredHost = explicitHost
    || configuredHost
    || normalizeIcloudHost(state?.preferredIcloudHost);
  tabs = await ensureIcloudMailContextTab(tabs, preferredHost, preferredHost);
  if (!tabs.length) {
    return { service: null, errors: [], noTab: true };
  }
  const sortedTabs = [...tabs].sort((left, right) => {
    const leftActive = left?.active ? 1 : 0;
    const rightActive = right?.active ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    const leftMail = isIcloudMailPageUrl(left?.url) ? 1 : 0;
    const rightMail = isIcloudMailPageUrl(right?.url) ? 1 : 0;
    if (leftMail !== rightMail) return rightMail - leftMail;
    let leftHost = '';
    let rightHost = '';
    try { leftHost = normalizeIcloudHost(new URL(String(left?.url || '')).host); } catch {}
    try { rightHost = normalizeIcloudHost(new URL(String(right?.url || '')).host); } catch {}
    const leftPreferred = leftHost && leftHost === preferredHost ? 1 : 0;
    const rightPreferred = rightHost && rightHost === preferredHost ? 1 : 0;
    return rightPreferred - leftPreferred;
  });

  for (const tab of sortedTabs) {
    if (!Number.isInteger(tab?.id)) {
      continue;
    }
    for (const setupUrl of setupUrls) {
      try {
        const service = await validateIcloudSessionViaPageContext(tab.id, setupUrl);
        return { service, errors };
      } catch (err) {
        errors.push(`page_context:tab_${tab.id}:${getErrorMessage(err)}`);
      }
    }
  }

  return { service: null, errors, noTab: false };
}

async function resolveIcloudPremiumMailService(options = {}) {
  const errors = [];
  const state = await getState();
  const explicitHost = normalizeIcloudHost(options?.hostPreference || options?.preferredHost || '');
  const configuredHost = getConfiguredIcloudHostPreference(state);
  const effectiveHost = explicitHost || configuredHost;
  const setupUrls = effectiveHost
    ? (() => {
        const forcedSetupUrl = getIcloudSetupUrlForHost(effectiveHost);
        return forcedSetupUrl ? [forcedSetupUrl] : [];
      })()
    : await getPreferredIcloudSetupUrls(state);

  for (const setupUrl of setupUrls) {
    try {
      const data = await validateIcloudSession(setupUrl);
      const preferredIcloudHost = normalizeIcloudHost(new URL(setupUrl).host);
      if (preferredIcloudHost && preferredIcloudHost !== normalizeIcloudHost(state.preferredIcloudHost)) {
        await setState({ preferredIcloudHost });
      }
      return {
        setupUrl,
        serviceUrl: rememberIcloudServiceUrl(data.webservices.premiummailsettings.url),
      };
    } catch (err) {
      errors.push(`${new URL(setupUrl).host}: ${getErrorMessage(err)}`);
    }
  }

  if (shouldTryIcloudPageContextFallback(errors)) {
    const {
      service,
      errors: pageContextErrors,
      noTab: pageContextNoTab = false,
    } = await resolveIcloudPremiumMailServiceViaPageContext(setupUrls, state, {
      hostPreference: effectiveHost,
    });
    if (service) {
      const preferredIcloudHost = normalizeIcloudHost(new URL(service.setupUrl).host);
      if (preferredIcloudHost && preferredIcloudHost !== normalizeIcloudHost(state.preferredIcloudHost)) {
        await setState({ preferredIcloudHost });
      }
      await addLog(`iCloud：后台会话校验失败，已切换页面上下文校验（${new URL(service.setupUrl).host}）。`, 'warn');
      return {
        ...service,
        serviceUrl: rememberIcloudServiceUrl(service.serviceUrl),
      };
    }
    if (!pageContextNoTab && Array.isArray(pageContextErrors) && pageContextErrors.length) {
      errors.push(...pageContextErrors);
    }
  }

  throw new Error(errors.length
    ? `Could not validate iCloud session. ${errors.join(' | ')}`
    : `Could not validate iCloud session. 请先在当前浏览器登录 ${effectiveHost || 'icloud.com 或 icloud.com.cn'}。`);
}

function getIcloudAliasLabel() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `MultiPage ${dateStr}`;
}

async function checkIcloudSession(options = {}) {
  const actionLabel = String(options?.actionLabel || '检查 iCloud 会话').trim() || '检查 iCloud 会话';
  const { actionLabel: _ignoredActionLabel, ...resolveOptions } = options || {};
  return withIcloudLoginHelp(actionLabel, async () => {
    const { setupUrl } = await resolveIcloudPremiumMailService(resolveOptions);
    await addLog(`iCloud：会话校验通过（${new URL(setupUrl).host}）`, 'ok');
    return { ok: true, setupUrl };
  });
}

async function loadNormalizedIcloudAliases(options = {}) {
  const {
    resolveOptions = {},
    serviceUrl: initialServiceUrl = '',
    silent = false,
  } = options;

  let serviceUrl = String(initialServiceUrl || '').trim().replace(/\/$/, '');
  let lastError = null;

  for (let endpointAttempt = 1; endpointAttempt <= 2; endpointAttempt += 1) {
    throwIfStopped();

    if (!serviceUrl) {
      const resolved = await resolveIcloudPremiumMailService(resolveOptions);
      serviceUrl = resolved.serviceUrl;
    }

    try {
      if (!silent) {
        await addLog(`iCloud：正在从 ${new URL(serviceUrl).host} 加载 Hide My Email 别名列表...`, 'info');
      }
      const response = await icloudRequest('GET', `${serviceUrl}/v2/hme/list`, {
        timeoutMs: ICLOUD_REQUEST_TIMEOUT_MS,
        maxAttempts: ICLOUD_LIST_MAX_ATTEMPTS,
        retryLabel: '加载 iCloud 别名列表',
        logRetries: true,
      });
      const state = await getState();
      return {
        serviceUrl,
        aliases: normalizeIcloudAliasList(response, {
          usedEmails: getEffectiveUsedEmails(state),
          preservedEmails: getPreservedAliasMap(state),
        }),
      };
    } catch (err) {
      lastError = err;
      if (endpointAttempt >= 2 || !isIcloudRetryableError(err)) {
        throw err;
      }
      await addLog(`iCloud：${new URL(serviceUrl).host} 别名列表请求失败，正在刷新服务节点后重试...`, 'warn');
      serviceUrl = '';
    }
  }

  throw lastError || new Error('加载 iCloud 别名列表失败。');
}

async function listIcloudAliases(options = {}) {
  try {
    return await withIcloudLoginHelp('加载 iCloud 隐私邮箱列表', async () => {
      const { serviceUrl } = await resolveIcloudPremiumMailService(options);
      const response = await icloudRequest('GET', `${serviceUrl}/v2/hme/list`);
      const state = await getState();
      const aliases = normalizeIcloudAliasList(response, {
        usedEmails: getEffectiveUsedEmails(state),
        preservedEmails: getPreservedAliasMap(state),
      });
      await setState({
        icloudAliasCache: normalizeIcloudAliasCacheList(aliases),
        icloudAliasCacheAt: Date.now(),
      });
      return aliases;
    });
  } catch (err) {
    const message = getErrorMessage(err);
    const transientContextError = err?.code === 'ICLOUD_TRANSIENT_CONTEXT'
      || message.includes('网络/上下文波动');
    if (!transientContextError) {
      throw err;
    }
    const state = await getState();
    const freshCachedAliases = getIcloudAliasCacheFromState(state);
    if (freshCachedAliases.length) {
      await addLog(`iCloud：加载别名失败，已回退最近缓存（${freshCachedAliases.length} 条）。`, 'warn');
      return freshCachedAliases;
    }

    const staleCachedAliases = getIcloudAliasCacheFromState(state, { maxAgeMs: 0 });
    if (staleCachedAliases.length) {
      await addLog(`iCloud：加载别名失败，已回退历史缓存（${staleCachedAliases.length} 条）。`, 'warn');
      return staleCachedAliases;
    }

    const localFallbackAliases = buildIcloudAliasFallbackFromLocalState(state);
    if (localFallbackAliases.length) {
      await addLog(`iCloud：加载别名失败，已回退本地别名记录（${localFallbackAliases.length} 条）。`, 'warn');
      return localFallbackAliases;
    }

    throw err;
  }
}

async function deleteIcloudAlias(payload) {
  return withIcloudLoginHelp('删除 iCloud 隐私邮箱', async () => {
    const alias = typeof payload === 'string'
      ? { email: String(payload).trim().toLowerCase(), anonymousId: '' }
      : {
          email: String(payload?.email || '').trim().toLowerCase(),
          anonymousId: String(payload?.anonymousId || '').trim(),
        };

    if (!alias.email) {
      throw new Error('未提供需要删除的 iCloud 隐私邮箱。');
    }
    if (!alias.anonymousId) {
      throw new Error(`缺少 ${alias.email} 的 anonymousId，请先刷新 iCloud 别名列表。`);
    }

    let serviceUrl = '';
    try {
      ({ serviceUrl } = await resolveIcloudPremiumMailService());
    } catch (resolveErr) {
      const canFallbackToCachedService = isIcloudTransientContextError(resolveErr)
        && Boolean(lastResolvedIcloudServiceUrl);
      if (!canFallbackToCachedService) {
        throw resolveErr;
      }
      serviceUrl = lastResolvedIcloudServiceUrl;
      await addLog(`iCloud：会话校验暂时不可用，已回退最近可用服务节点 ${new URL(serviceUrl).host} 继续删除。`, 'warn');
    }

    try {
      const directDelete = await icloudRequest('POST', `${serviceUrl}/v1/hme/delete`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (directDelete?.success === false) {
        throw new Error(directDelete?.error?.errorMessage || 'delete failed');
      }
    } catch (err) {
      await addLog(`iCloud：直接删除 ${alias.email} 失败，尝试先停用再删除...`, 'warn');

      const deactivated = await icloudRequest('POST', `${serviceUrl}/v1/hme/deactivate`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (deactivated?.success === false) {
        throw new Error(deactivated?.error?.errorMessage || `停用 ${alias.email} 失败`);
      }

      const deleted = await icloudRequest('POST', `${serviceUrl}/v1/hme/delete`, {
        data: { anonymousId: alias.anonymousId },
      });
      if (deleted?.success === false) {
        throw new Error(deleted?.error?.errorMessage || `删除 ${alias.email} 失败`);
      }
    }

    const state = await getState();
    const manualAliasUsage = getManualAliasUsageMap(state);
    const preservedAliases = getPreservedAliasMap(state);
    delete manualAliasUsage[alias.email];
    delete preservedAliases[alias.email];
    await setState({ manualAliasUsage, preservedAliases });

    await addLog(`iCloud：已删除 ${alias.email}`, 'ok');
    broadcastIcloudAliasesChanged({ reason: 'deleted', email: alias.email });
    return { email: alias.email };
  });
}

async function deleteUsedIcloudAliases() {
  const aliases = await listIcloudAliases();
  const usedAliases = aliases.filter((alias) => alias.used);
  if (!usedAliases.length) {
    return { deleted: [], skipped: [] };
  }

  const deleted = [];
  const skipped = [];
  for (const alias of usedAliases) {
    if (alias.preserved) {
      skipped.push({ email: alias.email, error: 'preserved' });
      continue;
    }
    try {
      await deleteIcloudAlias(alias);
      deleted.push(alias.email);
    } catch (err) {
      skipped.push({ email: alias.email, error: getErrorMessage(err) });
    }
  }
  return { deleted, skipped };
}

async function fetchIcloudHideMyEmail(options = {}) {
  return withIcloudLoginHelp('获取 iCloud 隐私邮箱', async () => {
    throwIfStopped();
    const generateNew = Boolean(options?.generateNew);
    const preferredHost = String(options?.hostPreference || options?.preferredHost || '').trim();
    const persistSelectedIcloudEmail = async (email) => {
      if (typeof persistRegistrationEmailState === 'function') {
        await persistRegistrationEmailState(options?.state || null, email, {
          source: options?.source || '',
          preserveAccountIdentity: Boolean(options?.preserveAccountIdentity),
        });
        return;
      }
      await setEmailState(email, options?.source ? { source: options.source } : {});
    };
    await addLog('iCloud：正在加载别名列表并校验当前浏览器登录状态...', 'info');

    const { serviceUrl, setupUrl } = await resolveIcloudPremiumMailService(
      preferredHost ? { hostPreference: preferredHost } : {}
    );
    await addLog(`iCloud：已通过 ${new URL(setupUrl).host} 验证会话`, 'ok');
    await addLog(`iCloud：当前 Hide My Email 服务节点 ${new URL(serviceUrl).host}`, 'info');

    let activeServiceUrl = serviceUrl;
    const existingAliases = await listIcloudAliases();
    const existingAliasEmailSet = new Set(
      existingAliases
        .map((aliasItem) => String(aliasItem?.email || '').trim().toLowerCase())
        .filter(Boolean)
    );

    if (!generateNew) {
      const reusableAlias = pickReusableIcloudAlias(existingAliases);
      if (reusableAlias) {
        await persistSelectedIcloudEmail(reusableAlias.email);
        await addLog(`iCloud：复用未使用别名 ${reusableAlias.email}`, 'ok');
        broadcastIcloudAliasesChanged({ reason: 'selected', email: reusableAlias.email });
        return reusableAlias.email;
      }
    } else {
      await addLog('iCloud：已启用“始终创建新别名”，本次将跳过复用。', 'info');
    }

    await addLog('iCloud：没有可复用别名，开始生成新的 Hide My Email 地址...', 'warn');
    await addLog(`iCloud：正在向 ${new URL(activeServiceUrl).host} 请求新的 Hide My Email 候选地址...`, 'info');

    try {
      let generated = null;
      try {
        generated = await icloudRequest('POST', `${activeServiceUrl}/v1/hme/generate`, {
          timeoutMs: ICLOUD_REQUEST_TIMEOUT_MS,
          maxAttempts: ICLOUD_WRITE_MAX_ATTEMPTS,
          retryLabel: '生成 Hide My Email 地址',
          logRetries: true,
        });
      } catch (err) {
        if (!isIcloudRetryableError(err)) {
          throw err;
        }
        await addLog('iCloud：生成候选别名失败，正在刷新服务节点后再试一次...', 'warn');
        const refreshedService = await resolveIcloudPremiumMailService(
          preferredHost ? { hostPreference: preferredHost } : {}
        );
        activeServiceUrl = refreshedService.serviceUrl;
        generated = await icloudRequest('POST', `${activeServiceUrl}/v1/hme/generate`, {
          timeoutMs: ICLOUD_REQUEST_TIMEOUT_MS,
          maxAttempts: ICLOUD_WRITE_MAX_ATTEMPTS,
          retryLabel: '生成 Hide My Email 地址',
          logRetries: true,
        });
      }

      if (!generated?.success || !generated?.result?.hme) {
        throw new Error(generated?.error?.errorMessage || 'iCloud 隐私邮箱生成失败。');
      }

      const generatedHmeRaw = generated.result.hme;
      const generatedAlias = String(
        (typeof generatedHmeRaw === 'string'
          ? generatedHmeRaw
          : generatedHmeRaw?.hme
            || generatedHmeRaw?.email
            || generatedHmeRaw?.alias
            || generatedHmeRaw?.address
            || '')
      ).trim().toLowerCase();
      if (!generatedAlias) {
        throw new Error('iCloud 隐私邮箱生成失败：未返回可用别名。');
      }
      await addLog(`iCloud：已生成候选别名 ${generatedAlias}，正在保留...`, 'info');

      const reserveData = {
        ...(generatedHmeRaw && typeof generatedHmeRaw === 'object' && !Array.isArray(generatedHmeRaw)
          ? generatedHmeRaw
          : {}),
        hme: generatedAlias,
        label: getIcloudAliasLabel(),
        note: 'Generated through GuJumpgate',
      };

      let alias = '';
      try {
        const reserved = await icloudRequest('POST', `${activeServiceUrl}/v1/hme/reserve`, {
          data: reserveData,
          timeoutMs: ICLOUD_REQUEST_TIMEOUT_MS,
          maxAttempts: 1,
        });

        if (!reserved?.success || !reserved?.result?.hme?.hme) {
          throw new Error(reserved?.error?.errorMessage || 'iCloud 隐私邮箱保留失败。');
        }

        alias = String(reserved.result.hme.hme || '').trim().toLowerCase();
      } catch (reserveErr) {
        const reserveErrMessage = getErrorMessage(reserveErr);
        const shouldTryListFallback = isIcloudRetryableError(reserveErr)
          || /\bstatus (?:401|403|409)\b/i.test(reserveErrMessage)
          || /failed to fetch/i.test(reserveErrMessage);
        if (!shouldTryListFallback) {
          throw reserveErr;
        }

        await addLog('iCloud：保留别名返回鉴权/网络异常，正在回查别名列表确认是否已创建...', 'warn');
        const { aliases: aliasesAfterReserveFailure, serviceUrl: refreshedListServiceUrl } = await loadNormalizedIcloudAliases({
          serviceUrl: activeServiceUrl,
          silent: true,
        });
        activeServiceUrl = refreshedListServiceUrl || activeServiceUrl;

        let recoveredAlias = findIcloudAliasByEmail(aliasesAfterReserveFailure, generatedAlias);
        if (!recoveredAlias) {
          recoveredAlias = aliasesAfterReserveFailure.find(
            (aliasItem) => !existingAliasEmailSet.has(String(aliasItem?.email || '').trim().toLowerCase())
          ) || null;
        }

        if (recoveredAlias?.email) {
          alias = String(recoveredAlias.email || '').trim().toLowerCase();
          await addLog(`iCloud：保留请求异常，但已在列表确认别名 ${alias}，继续使用。`, 'warn');
        } else if (isIcloudRetryableError(reserveErr)) {
          await addLog(`iCloud：列表中尚未出现 ${generatedAlias}，正在刷新服务节点后重试保留一次...`, 'warn');
          const refreshedService = await resolveIcloudPremiumMailService(
            preferredHost ? { hostPreference: preferredHost } : {}
          );
          activeServiceUrl = refreshedService.serviceUrl;
          const reservedRetry = await icloudRequest('POST', `${activeServiceUrl}/v1/hme/reserve`, {
            data: reserveData,
            timeoutMs: ICLOUD_REQUEST_TIMEOUT_MS,
            maxAttempts: 1,
          });
          if (!reservedRetry?.success || !reservedRetry?.result?.hme?.hme) {
            throw new Error(reservedRetry?.error?.errorMessage || 'iCloud 隐私邮箱保留失败。');
          }
          alias = String(reservedRetry.result.hme.hme || '').trim().toLowerCase();
        } else {
          alias = generatedAlias;
          await addLog(`iCloud：保留请求异常，已回退使用生成别名 ${alias}。`, 'warn');
        }
      }

      await persistSelectedIcloudEmail(alias);
      await addLog(`iCloud：已创建并保留新别名 ${alias}`, 'ok');
      broadcastIcloudAliasesChanged({ reason: 'created', email: alias });
      return alias;
    } catch (err) {
      if (!shouldStopIcloudAutoFetchRetries(err)) {
        throw err;
      }

      const reusableAlias = pickReusableIcloudAlias(existingAliases);
      if (reusableAlias) {
        await persistSelectedIcloudEmail(reusableAlias.email);
        await addLog(
          `iCloud：当前网络/上下文波动，暂无法创建新别名，已临时回退复用 ${reusableAlias.email}。`,
          'warn'
        );
        broadcastIcloudAliasesChanged({ reason: 'selected', email: reusableAlias.email });
        return reusableAlias.email;
      }

      throw new Error(
        `iCloud 当前无法创建新别名：${getErrorMessage(err)}。请先确认 iCloud 页面已登录且网络可访问，再重试。`
      );
    }
  });
}

async function finalizeIcloudAliasAfterSuccessfulFlow(state) {
  const email = String(state?.email || '').trim().toLowerCase();
  if (!email) {
    return { handled: false, deleted: false };
  }

  const knownIcloudAlias = normalizeEmailGenerator(state?.emailGenerator) === 'icloud'
    || Object.prototype.hasOwnProperty.call(getManualAliasUsageMap(state), email)
    || Object.prototype.hasOwnProperty.call(getPreservedAliasMap(state), email);
  if (!knownIcloudAlias) {
    return { handled: false, deleted: false };
  }

  await setIcloudAliasUsedState({ email, used: true }, { silentLog: true });
  await addLog(`iCloud：流程成功后已标记 ${email} 为已用。`, 'ok');

  if (!state.autoDeleteUsedIcloudAlias) {
    return { handled: true, deleted: false };
  }

  if (isAliasPreserved(state, email)) {
    await addLog(`iCloud：${email} 已被标记为保留，跳过自动删除。`, 'info');
    return { handled: true, deleted: false };
  }

  try {
    const aliases = await listIcloudAliases();
    const alias = findIcloudAliasByEmail(aliases, email);
    if (!alias) {
      await addLog(`iCloud：自动删除跳过，列表中未找到 ${email}。`, 'warn');
      return { handled: true, deleted: false };
    }
    if (alias.preserved) {
      await addLog(`iCloud：${email} 在最新别名列表中已是保留状态，跳过自动删除。`, 'info');
      return { handled: true, deleted: false };
    }
    if (!alias.anonymousId) {
      await addLog(`iCloud：自动删除跳过，${email} 缺少 anonymousId，请先刷新列表后重试。`, 'warn');
      return { handled: true, deleted: false };
    }
    await deleteIcloudAlias(alias);
    await addLog(`iCloud：流程成功后已自动删除 ${email}。`, 'ok');
    return { handled: true, deleted: true };
  } catch (err) {
    if (isIcloudTransientContextError(err)) {
      await addLog(`iCloud：自动删除 ${email} 暂时跳过（网络/上下文波动），可稍后手动删除。`, 'info');
    } else {
      await addLog(`iCloud：自动删除 ${email} 失败：${getErrorMessage(err)}`, 'warn');
    }
    return { handled: true, deleted: false };
  }
}

async function finalizePhoneActivationAfterSuccessfulFlow(state) {
  if (typeof phoneVerificationHelpers?.finalizePendingPhoneActivationConfirmation !== 'function') {
    return null;
  }
  return phoneVerificationHelpers.finalizePendingPhoneActivationConfirmation(state);
}

async function clearFreeReusablePhoneActivation() {
  const state = await getState();
  if (isPhoneSignupIdentityStateForReuse(state)) {
    throw new Error('\u624b\u673a\u53f7\u6ce8\u518c\u6a21\u5f0f\u4e0b\u4e0d\u80fd\u4fee\u6539\u767d\u5ad6\u590d\u7528\u624b\u673a\u53f7\uff0c\u8bf7\u5207\u6362\u90ae\u7bb1\u6ce8\u518c\u540e\u518d\u4f7f\u7528\u3002');
  }
  await setState({ freeReusablePhoneActivation: null });
  broadcastDataUpdate({ freeReusablePhoneActivation: null });
  await addLog('已清除白嫖复用手机号记录。', 'ok');
  return { ok: true, freeReusablePhoneActivation: null };
}

function inferHeroSmsCountryFromPhoneNumber(phoneNumber = '') {
  const digits = String(phoneNumber || '').replace(/\D+/g, '');
  if (!digits) {
    return null;
  }
  const match = HERO_SMS_COUNTRY_BY_PHONE_PREFIX.find((entry) => digits.startsWith(entry.prefix));
  if (!match) {
    return null;
  }
  return {
    id: Math.max(1, Math.floor(Number(match.id) || 0)),
    label: String(match.label || '').trim() || `Country #${match.id}`,
  };
}

function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function phoneNumbersMatch(left = '', right = '') {
  const leftDigits = normalizePhoneDigits(left);
  const rightDigits = normalizePhoneDigits(right);
  return Boolean(leftDigits && rightDigits && leftDigits === rightDigits);
}

function normalizeLocalHeroSmsActivation(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }
  const activationId = String(record.activationId ?? record.id ?? record.activation ?? '').trim();
  const phoneNumber = String(record.phoneNumber ?? record.number ?? record.phone ?? '').trim();
  if (!activationId || !phoneNumber) {
    return null;
  }
  const rawProvider = String(record.provider ?? record.smsProvider ?? '').trim();
  const provider = rawProvider ? normalizePhoneSmsProvider(rawProvider) : PHONE_SMS_PROVIDER_HERO;
  if (provider !== PHONE_SMS_PROVIDER_HERO) {
    return null;
  }
  const countryId = Math.max(
    0,
    Math.floor(Number(record.countryId ?? record.country ?? record.countryCode) || 0)
  );
  const countryLabel = String(record.countryLabel || record.label || '').trim();
  const serviceCode = String(record.serviceCode || record.service || HERO_SMS_SERVICE_CODE).trim() || HERO_SMS_SERVICE_CODE;
  return {
    ...record,
    provider: PHONE_SMS_PROVIDER_HERO,
    activationId,
    phoneNumber,
    serviceCode,
    ...(countryId > 0 ? { countryId } : {}),
    ...(countryLabel ? { countryLabel } : {}),
  };
}

function findLocalHeroSmsActivationForPhone(state = {}, phoneNumber = '') {
  const candidates = [
    state.currentPhoneActivation,
    state.reusablePhoneActivation,
    state.pendingPhoneActivationConfirmation,
    state.signupPhoneActivation,
    state.signupPhoneCompletedActivation,
    state.phonePreferredActivation,
    state.freeReusablePhoneActivation,
  ];
  if (Array.isArray(state.phoneReusableActivationPool)) {
    candidates.push(...state.phoneReusableActivationPool);
  }
  for (const candidate of candidates) {
    const normalized = normalizeLocalHeroSmsActivation(candidate);
    if (normalized && phoneNumbersMatch(normalized.phoneNumber, phoneNumber)) {
      return normalized;
    }
  }
  return null;
}

async function setFreeReusablePhoneActivation(record = {}) {
  const phoneNumber = String(record.phoneNumber || record.number || record.phone || '').trim();
  if (!phoneNumber) {
    throw new Error('请先填写白嫖复用手机号。');
  }
  const state = await getState();
  if (isPhoneSignupIdentityStateForReuse(state)) {
    throw new Error('\u624b\u673a\u53f7\u6ce8\u518c\u6a21\u5f0f\u4e0b\u4e0d\u80fd\u8bb0\u5f55\u767d\u5ad6\u590d\u7528\u624b\u673a\u53f7\uff0c\u8bf7\u5207\u6362\u90ae\u7bb1\u6ce8\u518c\u540e\u518d\u4f7f\u7528\u3002');
  }
  const localActivation = findLocalHeroSmsActivationForPhone(state, phoneNumber);
  const activationId = String(
    record.activationId
    || record.id
    || record.activation
    || localActivation?.activationId
    || ''
  ).trim();
  const inferredCountry = inferHeroSmsCountryFromPhoneNumber(phoneNumber);
  const hasExplicitCountry = Number.isFinite(Number(record.countryId)) && Number(record.countryId) > 0;
  const countryId = Math.max(
    1,
    Math.floor(
      Number(record.countryId)
      || Number(localActivation?.countryId)
      || Number(inferredCountry?.id)
      || Number(state.heroSmsCountryId)
      || HERO_SMS_COUNTRY_ID
    )
  );
  const stateCountryLabel = Math.floor(Number(state.heroSmsCountryId) || 0) === countryId
    ? String(state.heroSmsCountryLabel || '').trim()
    : '';
  const countryLabel = String(
    record.countryLabel
    || (Number(localActivation?.countryId) === countryId ? localActivation?.countryLabel : '')
    || (!hasExplicitCountry && inferredCountry?.id === countryId ? inferredCountry.label : '')
    || stateCountryLabel
    || (countryId === HERO_SMS_COUNTRY_ID ? HERO_SMS_COUNTRY_LABEL : `Country #${countryId}`)
  ).trim();
  const activation = {
    ...(activationId ? { activationId } : {}),
    phoneNumber,
    provider: PHONE_SMS_PROVIDER_HERO,
    serviceCode: String(record.serviceCode || localActivation?.serviceCode || HERO_SMS_SERVICE_CODE).trim() || HERO_SMS_SERVICE_CODE,
    countryId,
    ...(countryLabel ? { countryLabel } : {}),
    successfulUses: Math.max(0, Math.floor(Number(record.successfulUses) || 0)),
    maxUses: Math.max(1, Math.floor(Number(record.maxUses) || 3)),
    source: 'free-manual-reuse',
    recordedAt: Date.now(),
    manualOnly: !activationId,
  };
  await setState({ freeReusablePhoneActivation: activation });
  broadcastDataUpdate({ freeReusablePhoneActivation: activation });
  await addLog(
    activationId
      ? `已手动记录白嫖复用手机号 ${phoneNumber}（#${activationId}）。`
      : `已手动记录白嫖复用手机号 ${phoneNumber}。未填写 HeroSMS 激活 ID，仅支持手动填号复用。`,
    'ok'
  );
  return { ok: true, freeReusablePhoneActivation: activation };
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  return tabRuntime.getTabRegistry();
}

async function registerTab(source, tabId) {
  return tabRuntime.registerTab(source, tabId);
}

async function isTabAlive(source) {
  return tabRuntime.isTabAlive(source);
}

async function getTabId(source) {
  return tabRuntime.getTabId(source);
}

async function getAutomationWindowId(options = {}) {
  return tabRuntime.getAutomationWindowId(options);
}

async function createAutomationTab(createProperties = {}, options = {}) {
  return tabRuntime.createAutomationTab(createProperties, options);
}

async function queryTabsInAutomationWindow(queryInfo = {}, options = {}) {
  return tabRuntime.queryTabsInAutomationWindow(queryInfo, options);
}

async function isTabInAutomationWindow(tabOrId, options = {}) {
  return tabRuntime.isTabInAutomationWindow(tabOrId, options);
}

function parseUrlSafely(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.parseUrlSafely) {
    return navigationUtils.parseUrlSafely(rawUrl);
  }
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function normalizeSub2ApiUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.normalizeSub2ApiUrl) {
    return navigationUtils.normalizeSub2ApiUrl(rawUrl);
  }
  const input = (rawUrl || '').trim() || DEFAULT_SUB2API_URL;
  if (!input) return '';
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(withProtocol);
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = '/admin/accounts';
  }
  parsed.hash = '';
  return parsed.toString();
}

function normalizeCodex2ApiUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.normalizeCodex2ApiUrl) {
    return navigationUtils.normalizeCodex2ApiUrl(rawUrl);
  }
  const input = (rawUrl || '').trim() || DEFAULT_CODEX2API_URL;
  const withProtocol = /^https?:\/\//i.test(input) ? input : `http://${input}`;
  const parsed = new URL(withProtocol);
  if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '/admin') {
    parsed.pathname = '/admin/accounts';
  }
  parsed.hash = '';
  return parsed.toString();
}

function getPanelMode(state = {}) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.getPanelMode) {
    return navigationUtils.getPanelMode(state);
  }
  return DEFAULT_PANEL_MODE;
}

function getPanelModeLabel(modeOrState) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.getPanelModeLabel) {
    return navigationUtils.getPanelModeLabel(modeOrState);
  }
  return '支付转换';
}

function isSupportedChatGptSessionUrl(rawUrl = '') {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (!/^https?:$/i.test(parsed.protocol)) {
      return false;
    }
    const hostname = String(parsed.hostname || '').trim().toLowerCase();
    return /(^|\.)chatgpt\.com$/.test(hostname)
      || hostname === 'chat.openai.com'
      || /(^|\.)openai\.com$/.test(hostname);
  } catch {
    return false;
  }
}

function getSessionTabHostPriority(rawUrl = '') {
  try {
    const hostname = String(new URL(String(rawUrl || '')).hostname || '').trim().toLowerCase();
    if (/(^|\.)chatgpt\.com$/.test(hostname)) {
      return 0;
    }
    if (hostname === 'chat.openai.com') {
      return 1;
    }
    if (/(^|\.)openai\.com$/.test(hostname)) {
      return 2;
    }
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

function sanitizeSessionExportFileSegment(value = '', fallback = 'chatgpt-session') {
  const normalized = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function pickPreferredSessionExportTab(tabs = []) {
  const candidates = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && isSupportedChatGptSessionUrl(tab.url));
  if (!candidates.length) {
    return null;
  }
  return candidates.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }
    const candidateHostPriority = getSessionTabHostPriority(candidate.url);
    const bestHostPriority = getSessionTabHostPriority(best.url);
    if (candidateHostPriority !== bestHostPriority) {
      return candidateHostPriority < bestHostPriority ? candidate : best;
    }
    if (Boolean(candidate.active) !== Boolean(best.active)) {
      return candidate.active ? candidate : best;
    }
    const candidateLastAccessed = Number(candidate.lastAccessed) || 0;
    const bestLastAccessed = Number(best.lastAccessed) || 0;
    if (candidateLastAccessed !== bestLastAccessed) {
      return candidateLastAccessed > bestLastAccessed ? candidate : best;
    }
    return Number(candidate.id) < Number(best.id) ? candidate : best;
  }, null);
}

async function resolveCurrentSessionExportTabs() {
  const candidates = [];
  const appendTab = (tab) => {
    if (!tab?.id || candidates.some((item) => item.id === tab.id)) {
      return;
    }
    candidates.push(tab);
  };

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  activeTabs.forEach(appendTab);

  const state = await getState().catch(() => ({}));
  const registeredTabId = await getTabId('plus-checkout').catch(() => null);
  if (registeredTabId) {
    appendTab(await chrome.tabs.get(registeredTabId).catch(() => null));
  }
  const checkoutTabId = Number(state?.plusCheckoutTabId) || 0;
  if (checkoutTabId) {
    appendTab(await chrome.tabs.get(checkoutTabId).catch(() => null));
  }

  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const preferredGlobal = pickPreferredSessionExportTab(allTabs);
  appendTab(preferredGlobal);
  allTabs.forEach(appendTab);

  return candidates.filter((tab) => tab?.id && isSupportedChatGptSessionUrl(tab.url));
}

async function readChatGptSessionFromTabForExport(tab) {
  if (!tab?.id) {
    throw new Error('未找到可读取 SESSION 的标签页。');
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const endpoints = [
        'https://chatgpt.com/api/auth/session',
        '/api/auth/session',
      ];
      let lastResult = null;
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint, { credentials: 'include' });
          const session = await response.json().catch(() => ({}));
          const accessToken = String(session?.accessToken || '').trim();
          lastResult = {
            ok: response.ok,
            status: response.status,
            session,
            accessToken,
            endpoint,
          };
          if (response.ok && accessToken) {
            return lastResult;
          }
        } catch (error) {
          lastResult = {
            ok: false,
            status: 0,
            session: {},
            accessToken: '',
            endpoint,
            error: error?.message || String(error || ''),
          };
        }
      }
      return lastResult || {
        ok: false,
        status: 0,
        session: {},
        accessToken: '',
        endpoint: '',
      };
    },
  });
  if (!result?.ok && !result?.accessToken) {
    throw new Error(`当前页面未返回可用 SESSION（HTTP ${result?.status || 'unknown'}）。`);
  }
  if (!result?.accessToken) {
    throw new Error('当前 SESSION 中没有 accessToken，请确认 ChatGPT / OpenAI 页面已登录。');
  }
  return {
    tabId: tab.id,
    url: tab.url || '',
    session: result.session && typeof result.session === 'object' ? result.session : {},
    accessToken: result.accessToken,
  };
}

async function readChatGptSessionTokenForTotp(tab = {}) {
  if (!tab?.id) {
    return '';
  }
  const candidates = [
    '__Secure-authjs.session-token',
    'authjs.session-token',
    '__Secure-next-auth.session-token',
    'next-auth.session-token',
  ];
  for (const url of ['https://chatgpt.com', 'https://chat.openai.com']) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const name of candidates) {
        const exact = cookies.find((cookie) => cookie.name === name);
        const exactValue = String(exact?.value || '').trim();
        if (exactValue) {
          return exactValue;
        }
        const chunks = cookies
          .filter((cookie) => cookie.name.startsWith(`${name}.`))
          .map((cookie) => ({
            index: Number(cookie.name.slice(name.length + 1)),
            value: String(cookie.value || ''),
          }))
          .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.value)
          .sort((a, b) => a.index - b.index);
        if (chunks.length) {
          return chunks.map((item) => item.value).join('');
        }
      }
    } catch {
      // Keep trying the other known hosts.
    }
  }
  return '';
}

async function readCurrentChatGptSessionForExport(options = {}) {
  const expectedEmail = String(options?.expectedEmail || '').trim().toLowerCase();
  const tabs = await resolveCurrentSessionExportTabs();
  if (!tabs.length) {
    throw new Error('未找到 ChatGPT / OpenAI 标签页，请先打开一个已登录页面后再导出。');
  }
  const orderedTabs = [
    pickPreferredSessionExportTab(tabs),
    ...tabs,
  ].filter(Boolean);
  const seen = new Set();
  const errors = [];
  const mismatchedSessions = [];
  for (const tab of orderedTabs) {
    if (!tab?.id || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    try {
      const sessionState = await readChatGptSessionFromTabForExport(tab);
      sessionState.sessionToken = await readChatGptSessionTokenForTotp(tab).catch(() => '');
      if (!expectedEmail) {
        return sessionState;
      }
      const sessionEmail = String(buildChatGptAccessTokenInfo(sessionState).email || '').trim().toLowerCase();
      if (sessionEmail === expectedEmail) {
        return sessionState;
      }
      mismatchedSessions.push(sessionEmail || `tab-${tab.id}`);
    } catch (error) {
      errors.push(error?.message || String(error || ''));
    }
  }
  if (expectedEmail && mismatchedSessions.length > 0) {
    throw new Error(`未找到目标邮箱 ${expectedEmail} 的 ChatGPT session；当前可读 session：${mismatchedSessions.join(', ')}。`);
  }
  throw new Error(errors.find(Boolean) || '读取当前 SESSION 失败，请确认 ChatGPT / OpenAI 页面已登录。');
}

function maskAccessTokenForDisplay(token = '') {
  const normalized = String(token || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= 24) {
    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
  }
  return `${normalized.slice(0, 12)}...${normalized.slice(-8)}`;
}

function decodeJwtPayloadSafely(token = '') {
  try {
    const segment = String(token || '').split('.')[1] || '';
    if (!segment) {
      return {};
    }
    const padded = segment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(segment.length / 4) * 4, '=');
    const text = atob(padded);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function formatTokenEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  const epochMs = numeric > 100000000000 ? numeric : numeric * 1000;
  return new Date(epochMs).toISOString();
}

function buildChatGptAccessTokenInfo(sessionState = {}) {
  const accessToken = String(sessionState?.accessToken || '').trim();
  const session = sessionState?.session && typeof sessionState.session === 'object'
    ? sessionState.session
    : {};
  const jwtPayload = decodeJwtPayloadSafely(accessToken);
  const authProfile = jwtPayload?.['https://api.openai.com/profile'] || {};
  const authMeta = jwtPayload?.['https://api.openai.com/auth'] || {};
  const tokenExpiresAt = formatTokenEpochMs(jwtPayload.exp);
  const sessionExpiresAt = String(session?.expires || '').trim();
  const email = String(
    session?.user?.email
    || authProfile?.email
    || jwtPayload?.email
    || ''
  ).trim();
  const accountId = String(
    authMeta?.chatgpt_account_id
    || authMeta?.user_id
    || jwtPayload?.sub
    || ''
  ).trim();
  return {
    hasAccessToken: Boolean(accessToken),
    accessTokenPreview: maskAccessTokenForDisplay(accessToken),
    accessTokenLength: accessToken.length,
    email,
    accountId,
    planType: String(authMeta?.chatgpt_plan_type || '').trim(),
    sourceUrl: String(sessionState?.url || '').trim(),
    tabId: Number(sessionState?.tabId) || null,
    sessionExpiresAt,
    tokenExpiresAt,
    issuedAt: formatTokenEpochMs(jwtPayload.iat),
    updatedAt: Date.now(),
  };
}

function normalizeChatGptAccessTokenCheckResponse(raw = {}, context = {}) {
  const response = raw && typeof raw === 'object' ? raw : {};
  const tokenOk = response.token_ok === true;
  const eligible = response.eligible === true;
  const status = Number(response.status) || 0;
  const reason = String(response.reason || '').trim();
  const couponState = String(response.coupon_state || '').trim();
  const jwtExpMs = Number(response.jwt_exp_ms) || 0;
  return {
    checked: true,
    ok: tokenOk && status >= 200 && status < 300,
    tokenOk,
    eligible,
    qualified: tokenOk && status >= 200 && status < 300 && eligible,
    reason,
    couponState,
    promoId: String(response.promo_id || context.promoId || '').trim(),
    status,
    email: String(response.email || context.email || '').trim(),
    accountId: String(response.account_id || context.accountId || '').trim(),
    planType: String(response.plan_type || context.planType || '').trim(),
    jwtExpired: response.jwt_expired === true,
    jwtExpMs,
    jwtExpInSec: Number(response.jwt_exp_in_sec) || 0,
    checkedAt: Date.now(),
  };
}

function buildChatGptAccessTokenCheckFailure(error, context = {}) {
  return {
    checked: true,
    ok: false,
    tokenOk: false,
    eligible: false,
    qualified: false,
    reason: 'check_failed',
    couponState: '',
    promoId: String(context.promoId || '').trim(),
    status: 0,
    email: String(context.email || '').trim(),
    accountId: String(context.accountId || '').trim(),
    planType: String(context.planType || '').trim(),
    jwtExpired: false,
    jwtExpMs: 0,
    jwtExpInSec: 0,
    error: String(error?.message || error || '资格检测失败').trim(),
    checkedAt: Date.now(),
  };
}

async function checkChatGptAccessTokenEligibility(accessToken, context = {}) {
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new Error('缺少 accessToken，无法检测资格。');
  }
  const promoId = String(context?.promoId || 'plus-1-month-free').trim() || 'plus-1-month-free';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('https://cha.nerver.cc/api/v1/check', {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token, promoId }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return normalizeChatGptAccessTokenCheckResponse({
      ...data,
      status: Number(data?.status) || response.status,
    }, {
      ...context,
      promoId,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('AC 资格检测请求超时。');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getAccessTokenCheckDisplayStatus(check = null) {
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

async function syncChatGptAccessTokenInfoToEmailPool(accessTokenInfo = {}, accessTokenCheck = {}) {
  const state = await getState().catch(() => ({}));
  const targetEmail = String(
    accessTokenCheck?.email
    || accessTokenInfo?.email
    || state?.email
    || state?.registrationEmailState?.current
    || ''
  ).trim().toLowerCase();
  if (!targetEmail) {
    return null;
  }
  const entries = Array.isArray(state?.customEmailPoolEntries) ? state.customEmailPoolEntries : [];
  if (!entries.length) {
    return null;
  }

  let changed = false;
  const summary = {
    status: getAccessTokenCheckDisplayStatus(accessTokenCheck),
    qualified: accessTokenCheck?.qualified === true,
    tokenOk: accessTokenCheck?.tokenOk === true,
    eligible: accessTokenCheck?.eligible === true,
    reason: String(accessTokenCheck?.reason || '').trim(),
    couponState: String(accessTokenCheck?.couponState || '').trim(),
    checkedAt: Number(accessTokenCheck?.checkedAt) || Date.now(),
    accessTokenPreview: String(accessTokenInfo?.accessTokenPreview || '').trim(),
    accessTokenLength: Number(accessTokenInfo?.accessTokenLength) || 0,
  };
  const nextEntries = entries.map((entry) => {
    const email = String(entry?.email || '').trim().toLowerCase();
    if (email !== targetEmail) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      accessTokenCheck: summary,
    };
  });
  if (!changed) {
    return null;
  }
  await setState({ customEmailPoolEntries: nextEntries });
  broadcastDataUpdate({ customEmailPoolEntries: nextEntries });
  return nextEntries;
}

function buildChatGptAccessTokenRecord(accessTokenInfo = {}, accessTokenCheck = {}, options = {}) {
  const email = String(accessTokenCheck?.email || accessTokenInfo?.email || '').trim().toLowerCase();
  if (!email) {
    return null;
  }
  const accessToken = String(options?.accessToken || '').trim();
  const checkedAt = Number(accessTokenCheck?.checkedAt || accessTokenInfo?.updatedAt || Date.now()) || Date.now();
  return {
    id: options?.id || `ac-${checkedAt}-${Math.random().toString(36).slice(2, 8)}`,
    email,
    accessToken,
    accessTokenPreview: String(accessTokenInfo?.accessTokenPreview || '').trim(),
    accessTokenLength: Number(accessTokenInfo?.accessTokenLength) || 0,
    hasAccessToken: accessTokenInfo?.hasAccessToken === true,
    info: accessTokenInfo && typeof accessTokenInfo === 'object'
      ? { ...accessTokenInfo }
      : {},
    check: accessTokenCheck && typeof accessTokenCheck === 'object'
      ? { ...accessTokenCheck }
      : null,
    checkedAt,
    updatedAt: Date.now(),
  };
}

async function syncChatGptAccessTokenRecord(accessTokenInfo = {}, accessTokenCheck = {}, options = {}) {
  const record = buildChatGptAccessTokenRecord(accessTokenInfo, accessTokenCheck, options);
  if (!record) {
    return {};
  }
  const state = await getState().catch(() => ({}));
  const records = {
    ...(state?.chatgptAccessTokenRecords && typeof state.chatgptAccessTokenRecords === 'object'
      ? state.chatgptAccessTokenRecords
      : {}),
    [record.email]: record,
  };
  const history = Array.isArray(state?.chatgptAccessTokenHistory)
    ? state.chatgptAccessTokenHistory.filter((item) => item && typeof item === 'object')
    : [];
  const nextHistory = [record, ...history].slice(0, 2000);
  const updates = {
    chatgptAccessTokenRecords: records,
    chatgptAccessTokenHistory: nextHistory,
  };
  await setState(updates);
  broadcastDataUpdate(updates);
  return records;
}

function getExternalRedeemQueueFromState(state = {}) {
  return Array.isArray(state?.externalRedeemQueue)
    ? state.externalRedeemQueue.filter((item) => item && typeof item === 'object')
    : [];
}

function getExternalRedeemRechargeFailureText(item = {}) {
  return [
    item?.reason,
    item?.errorMessage,
    item?.error_message,
    item?.displayStatus,
    item?.display_status,
    item?.message,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
}

function hasExternalRedeemRechargeFailureSignal(item = {}) {
  const status = String(item?.status || item?.redeemStatus || item?.redeem_status || '').trim().toLowerCase();
  const text = getExternalRedeemRechargeFailureText(item);
  if (/充值失败|支付失败|付款失败|cdk\s*(?:invalid|duplicate|already\s*used|not\s*purchased)|无效或未购买|不能重复|已被使用|recharge\s*failed|br\s*recharge\s*failed|payment\s*failed|failed\s*to\s*recharge/.test(text)) {
    return true;
  }
  if (status === 'success' || String(item?.transactionStatus || item?.transaction_status || '').trim().toLowerCase() === 'paid') {
    return false;
  }
  return /failed|失败|rejected|not_found/.test(`${status} ${text}`);
}

function normalizeExternalRedeemRechargeFailureItem(item = {}) {
  if (!hasExternalRedeemRechargeFailureSignal(item)) {
    return item;
  }
  const failureMessage = String(
    item?.reason
    || item?.errorMessage
    || item?.error_message
    || item?.displayStatus
    || item?.display_status
    || '充值失败'
  ).trim();
  return {
    ...item,
    status: 'failed',
    redeemStatus: item?.redeemStatus !== undefined ? 'failed' : item?.redeemStatus,
    redeem_status: item?.redeem_status !== undefined ? 'failed' : item?.redeem_status,
    displayStatus: '充值失败',
    display_status: item?.display_status !== undefined
      ? '充值失败'
      : item?.display_status,
    reason: failureMessage,
    finishedAt: item?.finishedAt || item?.finished_at || new Date().toISOString(),
    finished_at: item?.finished_at || item?.finishedAt || new Date().toISOString(),
  };
}

function getExternalRedeemPendingQueue(queue = []) {
  return queue.filter((item) => {
    if (hasExternalRedeemRechargeFailureSignal(item)) {
      return false;
    }
    const status = String(item?.status || '').trim().toLowerCase();
    return Boolean(item?.accepted) && status && !EXTERNAL_REDEEM_TERMINAL_STATUSES.has(status);
  });
}

function dedupeExternalRedeemPendingQueueByCdkey(queue = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of Array.isArray(queue) ? queue : []) {
    const cdkey = normalizeExternalRedeemCdkey(item?.cdkey);
    if (!cdkey || seen.has(cdkey)) {
      continue;
    }
    seen.add(cdkey);
    deduped.push(item);
  }
  return deduped;
}

function getExternalRedeemTaskId(item = {}) {
  return String(item?.taskId || item?.task_id || '').trim();
}

function countExternalRedeemPendingKeys(queue = [], getter = () => '') {
  const counts = new Map();
  for (const item of Array.isArray(queue) ? queue : []) {
    const key = String(getter(item) || '').trim();
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function getExternalRedeemStatusUpdateForQueueItem(item = {}, context = {}) {
  const cdkey = normalizeExternalRedeemCdkey(item?.cdkey);
  const taskId = getExternalRedeemTaskId(item);
  const {
    byTaskId = new Map(),
    byCdkey = new Map(),
    pendingTaskIdCounts = new Map(),
    pendingCdkeyCounts = new Map(),
  } = context || {};
  if (taskId && pendingTaskIdCounts.get(taskId) === 1 && byTaskId.has(taskId)) {
    return byTaskId.get(taskId);
  }
  if (cdkey && pendingCdkeyCounts.get(cdkey) === 1 && byCdkey.has(cdkey)) {
    return byCdkey.get(cdkey);
  }
  return null;
}

function getExternalRedeemCdkeysFromText(text = '') {
  return normalizeExternalRedeemCdkeyPoolText(text)
    .split(/\r?\n/)
    .map((line) => normalizeExternalRedeemCdkey(line))
    .filter(Boolean);
}

function isExternalRedeemCdkeyReserved(item = {}) {
  const status = String(item?.status || '').trim().toLowerCase();
  if (!normalizeExternalRedeemCdkey(item?.cdkey)) {
    return false;
  }
  if (hasExternalRedeemRechargeFailureSignal(item)) {
    return false;
  }
  if (status === 'success') {
    return true;
  }
  if (EXTERNAL_REDEEM_TERMINAL_STATUSES.has(status)) {
    return false;
  }
  if (item?.accepted === true || String(item?.taskId || item?.task_id || '').trim()) {
    return true;
  }
  return Boolean(status) && !['submit_failed', 'rejected', 'not_found'].includes(status);
}

function isAccessTokenQualifiedForExternalRedeem(check = {}) {
  return check?.tokenOk === true
    && Number(check?.status) === 200
    && check?.eligible === true
    && check?.couponState === 'eligible';
}

function normalizeExternalRedeemRecordFromAc(accessTokenInfo = {}, accessTokenCheck = {}, extra = {}) {
  const email = String(
    extra.email
    || accessTokenCheck?.email
    || accessTokenInfo?.email
    || ''
  ).trim().toLowerCase();
  if (!email) {
    return null;
  }
  return {
    email,
    accessTokenPreview: String(extra.accessTokenPreview || accessTokenInfo?.accessTokenPreview || '').trim(),
    accessTokenLength: Number(extra.accessTokenLength || accessTokenInfo?.accessTokenLength) || 0,
    qualified: accessTokenCheck?.qualified === true,
    tokenOk: accessTokenCheck?.tokenOk === true,
    eligible: accessTokenCheck?.eligible === true,
    checkStatus: Number(accessTokenCheck?.status) || 0,
    checkReason: String(accessTokenCheck?.reason || '').trim(),
    couponState: String(accessTokenCheck?.couponState || '').trim(),
    promoId: String(accessTokenCheck?.promoId || extra.promoId || '').trim(),
    planType: String(accessTokenCheck?.planType || accessTokenInfo?.planType || '').trim(),
    accountId: String(accessTokenCheck?.accountId || accessTokenInfo?.accountId || '').trim(),
    cdk: normalizeExternalRedeemCdkey(extra.cdkey || ''),
    taskId: String(extra.taskId || '').trim(),
    redeemStatus: String(extra.status || '').trim().toLowerCase(),
    displayStatus: String(extra.displayStatus || '').trim(),
    accepted: typeof extra.accepted === 'boolean' ? extra.accepted : null,
    transactionId: String(extra.transactionId || '').trim(),
    transactionStatus: String(extra.transactionStatus || '').trim(),
    reason: String(extra.reason || '').trim(),
    errorMessage: String(extra.errorMessage || '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeExternalRedeemRecordFromQueueItem(item = {}, fallback = {}) {
  const email = String(item?.email || fallback.email || '').trim().toLowerCase();
  if (!email) {
    return null;
  }
  return normalizeExternalRedeemRecordRuntime({
    email,
    accessTokenPreview: String(item?.accessTokenPreview || fallback.accessTokenPreview || '').trim(),
    qualified: item?.qualified === true || fallback.qualified === true,
    checkReason: String(item?.tokenReason || fallback.tokenReason || '').trim(),
    cdk: normalizeExternalRedeemCdkey(item?.cdkey || fallback.cdkey || ''),
    taskId: String(item?.taskId || '').trim(),
    redeemStatus: String(item?.status || '').trim().toLowerCase(),
    displayStatus: String(item?.displayStatus || '').trim(),
    accepted: item?.accepted === true,
    transactionId: String(item?.transactionId || '').trim(),
    transactionStatus: String(item?.transactionStatus || '').trim(),
    reason: String(item?.reason || '').trim(),
    errorMessage: String(item?.errorMessage || '').trim(),
    updatedAt: new Date().toISOString(),
  });
}

function normalizeExternalRedeemRecordRuntime(record = {}) {
  const normalized = {
    ...record,
    redeemStatus: String(record?.redeemStatus || record?.redeem_status || record?.status || '').trim().toLowerCase(),
    displayStatus: String(record?.displayStatus || record?.display_status || '').trim(),
    reason: String(record?.reason || '').trim(),
    errorMessage: String(record?.errorMessage || record?.error_message || '').trim(),
  };
  if (!hasExternalRedeemRechargeFailureSignal(normalized)) {
    return normalized;
  }
  const failed = normalizeExternalRedeemRechargeFailureItem({
    ...normalized,
    status: normalized.redeemStatus,
  });
  return {
    ...normalized,
    redeemStatus: 'failed',
    status: record?.status !== undefined ? 'failed' : record?.status,
    displayStatus: failed.displayStatus || '充值失败',
    reason: failed.reason || '充值失败',
    finishedAt: record?.finishedAt || record?.finished_at || failed.finishedAt || new Date().toISOString(),
  };
}

function buildStableExternalRedeemItemId(email = '', cdkey = '', taskId = '') {
  const source = [
    String(email || '').trim().toLowerCase(),
    normalizeExternalRedeemCdkey(cdkey || ''),
    String(taskId || '').trim(),
  ].filter(Boolean).join('::') || String(Date.now());
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return `redeem-record-${Math.abs(hash)}`;
}

function normalizeExternalRedeemQueueItemFromRecord(record = {}) {
  const email = String(record?.email || '').trim().toLowerCase();
  const cdkey = normalizeExternalRedeemCdkey(record?.cdk || record?.cdkey || '');
  const taskId = String(record?.taskId || record?.task_id || '').trim();
  if (!email || (!cdkey && !taskId)) {
    return null;
  }
  const status = String(record?.redeemStatus || record?.redeem_status || record?.status || '').trim().toLowerCase();
  const createdAt = record?.createdAt || record?.created_at || record?.updatedAt || record?.updated_at || Date.now();
  const updatedAt = record?.updatedAt || record?.updated_at || createdAt;
  const accepted = record?.accepted === true || Boolean(taskId);
  return normalizeExternalRedeemRechargeFailureItem({
    id: String(record?.id || '').trim() || buildStableExternalRedeemItemId(email, cdkey, taskId),
    email,
    cdkey,
    accessTokenPreview: String(record?.accessTokenPreview || record?.access_token_preview || '').trim(),
    qualified: record?.qualified === true,
    tokenReason: String(record?.checkReason || record?.check_reason || '').trim(),
    taskId,
    status: status || (accepted ? 'pending_dispatch' : ''),
    displayStatus: String(record?.displayStatus || record?.display_status || status || '').trim(),
    accepted,
    alreadySubmitted: record?.alreadySubmitted === true || record?.already_submitted === true,
    reason: String(record?.reason || '').trim(),
    errorCode: String(record?.errorCode || record?.error_code || '').trim(),
    errorMessage: String(record?.errorMessage || record?.error_message || '').trim(),
    transactionId: String(record?.transactionId || record?.transaction_id || '').trim(),
    transactionStatus: String(record?.transactionStatus || record?.transaction_status || '').trim(),
    found: true,
    createdAt,
    submittedAt: record?.submittedAt || record?.submitted_at || createdAt,
    updatedAt,
    finishedAt: record?.finishedAt || record?.finished_at || '',
    lastCheckedAt: record?.lastCheckedAt || record?.last_checked_at || 0,
  });
}

function getExternalRedeemQueueMergeKey(item = {}) {
  const email = String(item?.email || '').trim().toLowerCase();
  const cdkey = normalizeExternalRedeemCdkey(item?.cdkey || item?.cdk || '');
  const taskId = String(item?.taskId || item?.task_id || '').trim();
  if (email && cdkey) {
    return `${email}::${cdkey}`;
  }
  if (email && taskId) {
    return `${email}::${taskId}`;
  }
  const id = String(item?.id || '').trim();
  return id ? `id::${id}` : '';
}

function getExternalRedeemQueueItemUpdatedTime(item = {}) {
  const candidates = [
    item?.lastCheckedAt,
    item?.last_checked_at,
    item?.updatedAt,
    item?.updated_at,
    item?.finishedAt,
    item?.finished_at,
    item?.submittedAt,
    item?.submitted_at,
    item?.createdAt,
    item?.created_at,
  ];
  for (const value of candidates) {
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

function mergeExternalRedeemQueueWithRecords(queue = [], records = []) {
  const byKey = new Map();
  const append = (item, source = 'queue') => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const normalized = source === 'record'
      ? normalizeExternalRedeemQueueItemFromRecord(item)
      : item;
    if (!normalized) {
      return;
    }
    const key = getExternalRedeemQueueMergeKey(normalized);
    if (!key) {
      return;
    }
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, { ...normalized });
      return;
    }
    const previousTime = getExternalRedeemQueueItemUpdatedTime(previous);
    const nextTime = getExternalRedeemQueueItemUpdatedTime(normalized);
    if (!previousTime || nextTime >= previousTime) {
      byKey.set(key, {
        ...previous,
        ...normalized,
        id: previous.id || normalized.id,
        createdAt: previous.createdAt || normalized.createdAt,
        submittedAt: previous.submittedAt || normalized.submittedAt,
        accepted: previous.accepted === true || normalized.accepted === true,
      });
    }
  };
  (Array.isArray(queue) ? queue : []).forEach((item) => append(item, 'queue'));
  (Array.isArray(records) ? records : []).forEach((record) => append(record, 'record'));
  return Array.from(byKey.values())
    .sort((left, right) => getExternalRedeemQueueItemUpdatedTime(right) - getExternalRedeemQueueItemUpdatedTime(left))
    .slice(-500);
}

function getExternalRedeemRecordKey(record = {}) {
  const email = String(record?.email || '').trim().toLowerCase();
  const cdk = normalizeExternalRedeemCdkey(record?.cdk || record?.cdkey || '');
  const taskId = String(record?.taskId || '').trim();
  return [email, cdk || taskId || String(record?.updatedAt || '')].filter(Boolean).join('::');
}

function maskEmailForSafeLog(email = '') {
  const normalized = String(email || '').trim().toLowerCase();
  const match = normalized.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) {
    return normalized ? '***' : '';
  }
  const [, local, domain] = match;
  const localHead = local.slice(0, Math.min(3, local.length));
  const localTail = local.length > 6 ? local.slice(-2) : '';
  return `${localHead}${localTail ? '***' : '***'}${localTail}@${domain}`;
}

function buildShayuTaobaoEmailCodeUrl(email = '', queryCode = '') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
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

function normalizeShayuHttpUrl(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return '';
  }
  try {
    const parsed = new URL(rawValue);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function resolveShayuEmailCodeUrl(emailValue = '', state = {}) {
  const email = String(emailValue || '').trim().toLowerCase();
  if (!email) {
    return '';
  }
  const entries = normalizeCustomEmailPoolEntryObjects(state?.customEmailPoolEntries);
  const entry = entries.find((item) => String(item?.email || '').trim().toLowerCase() === email) || null;
  if (entry) {
    const directUrl = normalizeShayuHttpUrl(
      entry.emailCodeUrl
      || entry.verificationUrl
      || entry.url
      || entry.mailUrl
      || ''
    );
    if (directUrl) {
      return directUrl;
    }
    if (entry.queryCode) {
      return buildShayuTaobaoEmailCodeUrl(email, entry.queryCode);
    }
  }

  const rawPool = Array.isArray(state?.customEmailPool)
    ? state.customEmailPool
    : String(state?.customEmailPool || '').split(/[\r\n,，;；]+/);
  for (const item of rawPool) {
    const parsed = parseEmailWithOptionalVerificationUrl(item);
    if (parsed.email !== email) {
      continue;
    }
    const directUrl = normalizeShayuHttpUrl(parsed.verificationUrl);
    if (directUrl) {
      return directUrl;
    }
    if (parsed.queryCode) {
      return buildShayuTaobaoEmailCodeUrl(email, parsed.queryCode);
    }
  }

  return '';
}

function normalizeShayuRecordsPayload(payload = {}) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.records)) {
    return payload.records;
  }
  if (Array.isArray(payload?.data?.records)) {
    return payload.data.records;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (payload?.record && typeof payload.record === 'object') {
    return [payload.record];
  }
  if (payload?.data?.record && typeof payload.data.record === 'object') {
    return [payload.data.record];
  }
  return [];
}

function getShayuRecordAccount(record = {}) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {};
  return String(record?.account || record?.email || fields.account || fields['账号'] || '').trim().toLowerCase();
}

async function fetchShayuLedgerJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(options.timeoutMs) || 12000));
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const message = String(payload?.error || payload?.message || text || `HTTP ${response.status}`).trim();
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}${message ? `：${message}` : ''}`.trim());
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function findShayuLedgerRecordByEmail(email = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }
  const url = `${SHAYU_LEDGER_RECORDS_URL}?q=${encodeURIComponent(normalizedEmail)}`;
  const payload = await fetchShayuLedgerJson(url, { method: 'GET' });
  const records = normalizeShayuRecordsPayload(payload);
  return records.find((record) => getShayuRecordAccount(record) === normalizedEmail) || null;
}

async function createShayuLedgerRecord(input = {}) {
  const email = String(input?.email || '').trim().toLowerCase();
  const emailCodeUrl = normalizeShayuHttpUrl(input?.emailCodeUrl || '');
  const secretMasked = String(input?.secretMasked || '').trim();
  const password = String(input?.password || '').trim();
  if (!email) {
    throw new Error('缺少邮箱。');
  }
  if (!emailCodeUrl && !secretMasked) {
    throw new Error('缺少取码链接或 2FA 信息。');
  }
  const payload = {
    account: email,
    password,
    emailCodeUrl,
    phone: '',
    smsToken: '',
    longCodeUrl: '',
    rechargeUrl: '',
    exchangeCodes: [],
    secretMasked,
    note: String(input?.note || 'GuJumpgate 自动同步账号来源').trim(),
    source: SHAYU_LEDGER_SOURCE,
  };
  return fetchShayuLedgerJson(SHAYU_LEDGER_RECORDS_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function getShayuLedgerRecordId(record = {}) {
  return String(record?.id || record?._id || record?.recordId || record?.record_id || '').trim();
}

async function updateShayuLedgerRecord(record = {}, patch = {}) {
  const id = getShayuLedgerRecordId(record);
  if (!id) {
    throw new Error('台账记录缺少 ID，无法更新。');
  }
  const safePatch = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'emailCodeUrl')) {
    const emailCodeUrl = normalizeShayuHttpUrl(patch.emailCodeUrl || '');
    if (emailCodeUrl) {
      safePatch.emailCodeUrl = emailCodeUrl;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'secretMasked')) {
    const secretMasked = String(patch.secretMasked || '').trim();
    if (secretMasked) {
      safePatch.secretMasked = secretMasked;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'password')) {
    const password = String(patch.password || '').trim();
    if (password) {
      safePatch.password = password;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'source')) {
    safePatch.source = String(patch.source || SHAYU_LEDGER_SOURCE).trim();
  }
  if (!Object.keys(safePatch).length) {
    return { record };
  }
  return fetchShayuLedgerJson(`${SHAYU_LEDGER_RECORDS_URL}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(safePatch),
  });
}

async function syncShayuLedgerAfterExternalRedeemSuccess(input = {}, options = {}) {
  const state = options.state || await getState().catch(() => ({}));
  const email = String(
    input?.email
    || input?.redeemItem?.email
    || input?.item?.email
    || ''
  ).trim().toLowerCase();
  if (!email) {
    return { skipped: true, reason: 'missing_email' };
  }

  const emailCodeUrl = resolveShayuEmailCodeUrl(email, state);
  if (!emailCodeUrl) {
    if (!options.silent) {
      await addLog(`鲨鱼台账：${maskEmailForSafeLog(email)} 缺少邮箱取码链接，已跳过创建。`, 'warn');
    }
    return { skipped: true, reason: 'missing_email_code_url' };
  }

  try {
    const existing = await findShayuLedgerRecordByEmail(email);
    if (existing) {
      if (!normalizeShayuHttpUrl(existing.emailCodeUrl || '') && emailCodeUrl) {
        await updateShayuLedgerRecord(existing, {
          emailCodeUrl,
          source: SHAYU_LEDGER_SOURCE,
        }).catch(() => null);
      }
      if (!options.silent) {
        await addLog(`鲨鱼台账：${maskEmailForSafeLog(email)} 已存在，跳过重复创建。`, 'info');
      }
      return { ok: true, action: 'exists', record: existing };
    }
    const created = await createShayuLedgerRecord({ email, emailCodeUrl });
    if (!options.silent) {
      await addLog(`鲨鱼台账：${maskEmailForSafeLog(email)} 已创建邮箱取码记录。`, 'ok');
    }
    return { ok: true, action: 'created', record: created };
  } catch (error) {
    const errorMessage = String(error?.message || error || '同步失败').trim();
    if (!options.silent) {
      await addLog(`鲨鱼台账：同步失败，后续流程不受影响。原因：${errorMessage}`, 'warn');
    }
    return { ok: false, error: errorMessage };
  }
}

async function syncShayuLedgerTotpSecretMasked(input = {}, options = {}) {
  const state = options.state || await getState().catch(() => ({}));
  const email = String(input?.email || '').trim().toLowerCase();
  const secretMasked = String(input?.secretMasked || '').trim();
  const password = String(input?.password || state?.password || state?.customPassword || '').trim();
  if (!email || !secretMasked) {
    return { skipped: true, reason: !email ? 'missing_email' : 'missing_secret_masked' };
  }
  try {
    const emailCodeUrl = resolveShayuEmailCodeUrl(email, state);
    const existing = await findShayuLedgerRecordByEmail(email);
    if (existing) {
      const updated = await updateShayuLedgerRecord(existing, {
        secretMasked,
        password,
        emailCodeUrl: normalizeShayuHttpUrl(existing.emailCodeUrl || '') ? undefined : emailCodeUrl,
        source: SHAYU_LEDGER_SOURCE,
      });
      if (!options.silent) {
        await addLog(`鲨鱼台账：${maskEmailForSafeLog(email)} 已同步 2FA 与密码登录设置。`, 'ok');
      }
      return { ok: true, action: 'updated', record: updated?.record || updated };
    }
    const created = await createShayuLedgerRecord({
      email,
      emailCodeUrl,
      secretMasked,
      password,
      note: 'AC 合格后自动绑定 2FA 并同步密码登录设置',
    });
    if (!options.silent) {
      await addLog(`鲨鱼台账：${maskEmailForSafeLog(email)} 已创建并同步 2FA 与密码登录设置。`, 'ok');
    }
    return { ok: true, action: 'created', record: created };
  } catch (error) {
    const errorMessage = String(error?.message || error || '同步失败').trim();
    if (!options.silent) {
      await addLog(`鲨鱼台账：2FA 与密码登录设置同步失败，后续流程不受影响。原因：${errorMessage}`, 'warn');
    }
    return { ok: false, error: errorMessage };
  }
}

function normalizeChatGptTotpEnableResult(raw = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    ok: data.ok === true,
    reason: String(data.reason || '').trim(),
    alreadyEnabled: data.alreadyEnabled === true,
    mfaEnabled: data.mfaEnabled === true,
    secretMasked: String(data.secretMasked || '').trim(),
    factorId: String(data.factorId || data.factor_id || '').trim(),
    sessionId: String(data.sessionId || data.session_id || '').trim(),
    email: String(data.email || '').trim().toLowerCase(),
    accountId: String(data.account_id || data.accountId || '').trim(),
    planType: String(data.plan_type || data.planType || '').trim(),
    status: Number(data.status) || 0,
    persisted: data.persisted === true,
    updatedAt: Date.now(),
  };
}

async function fetchChatGptTotpEnable(accessToken = '', sessionToken = '') {
  const token = String(accessToken || '').trim();
  const normalizedSessionToken = String(sessionToken || '').trim();
  if (!token || !normalizedSessionToken) {
    throw new Error(!token ? '缺少 accessToken' : '缺少 sessionToken');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(CHATGPT_TOTP_ENABLE_URL, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token, sessionToken: normalizedSessionToken }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    const normalized = normalizeChatGptTotpEnableResult({
      ...data,
      status: Number(data?.status) || response.status,
    });
    if (!response.ok || normalized.ok !== true) {
      throw new Error(String(normalized.reason || data?.message || `HTTP ${response.status}`).trim());
    }
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChatGptTotpLookupResult(raw = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const code = String(data.code || '').replace(/\D/g, '').slice(0, 6);
  return {
    ok: data.ok === true,
    email: String(data.email || '').trim().toLowerCase(),
    accountId: String(data.account_id || data.accountId || '').trim(),
    planType: String(data.plan_type || data.planType || '').trim(),
    factorId: String(data.factor_id || data.factorId || '').trim(),
    secretMasked: String(data.secretMasked || '').trim(),
    hasCode: /^\d{6}$/.test(code),
    code,
    period: Number(data.period) || 30,
    secondsRemaining: Number(data.secondsRemaining) || 0,
    status: Number(data.status) || 0,
    reason: String(data.reason || data.message || '').trim(),
  };
}

async function fetchChatGptTotpLookup(email = '') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('缺少 2FA 查询邮箱。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(CHATGPT_TOTP_LOOKUP_URL, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: normalizedEmail }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    const normalized = normalizeChatGptTotpLookupResult({
      ...data,
      status: Number(data?.status) || response.status,
    });
    if (!response.ok || normalized.ok !== true || !normalized.hasCode) {
      throw new Error(String(normalized.reason || data?.message || `HTTP ${response.status}`).trim());
    }
    return normalized;
  } finally {
    clearTimeout(timer);
  }
}

async function syncChatGptTotpRecord(totpResult = {}) {
  const email = String(totpResult?.email || '').trim().toLowerCase();
  if (!email) {
    return {};
  }
  const state = await getState().catch(() => ({}));
  const records = {
    ...(state?.chatgptTotpRecords && typeof state.chatgptTotpRecords === 'object'
      ? state.chatgptTotpRecords
      : {}),
    [email]: {
      email,
      ok: totpResult.ok === true,
      alreadyEnabled: totpResult.alreadyEnabled === true,
      mfaEnabled: totpResult.mfaEnabled === true,
      secretMasked: String(totpResult.secretMasked || '').trim(),
      factorId: String(totpResult.factorId || '').trim(),
      accountId: String(totpResult.accountId || '').trim(),
      planType: String(totpResult.planType || '').trim(),
      status: Number(totpResult.status) || 0,
      persisted: totpResult.persisted === true,
      updatedAt: Number(totpResult.updatedAt) || Date.now(),
    },
  };
  const updates = { chatgptTotpRecords: records };
  await setState(updates);
  broadcastDataUpdate(updates);
  return records;
}

async function enableChatGptTotpForQualifiedAccessToken(result = {}, options = {}) {
  const state = options.state || await getState().catch(() => ({}));
  if (state?.chatgptTotpAutoEnable !== true) {
    return { skipped: true, reason: 'disabled' };
  }
  const accessToken = String(result?.accessToken || '').trim();
  const sessionToken = String(result?.sessionToken || '').trim();
  const accessTokenInfo = result?.accessTokenInfo || {};
  const accessTokenCheck = result?.accessTokenCheck || {};
  const email = String(
    accessTokenCheck?.email
    || accessTokenInfo?.email
    || ''
  ).trim().toLowerCase();
  if (!isAccessTokenQualifiedForExternalRedeem(accessTokenCheck)) {
    return { skipped: true, reason: 'not_qualified' };
  }
  if (!accessToken || !sessionToken) {
    if (!options.silent) {
      await addLog(`2FA 绑定：${email ? maskEmailForSafeLog(email) : '当前账号'} 缺少 ${accessToken ? 'sessionToken' : 'accessToken'}，已跳过。`, 'warn');
    }
    return { skipped: true, reason: accessToken ? 'missing_session_token' : 'missing_access_token' };
  }
  try {
    const totpResult = await fetchChatGptTotpEnable(accessToken, sessionToken);
    if (!totpResult.email && email) {
      totpResult.email = email;
    }
    await syncChatGptTotpRecord(totpResult);
    if (totpResult.secretMasked) {
      await syncShayuLedgerTotpSecretMasked(totpResult, {
        state,
        silent: options.silent,
      }).catch(() => null);
    }
    if (!options.silent) {
      await addLog(
        `2FA 绑定：${maskEmailForSafeLog(totpResult.email || email)} ${totpResult.alreadyEnabled ? '已存在' : '已启用'}，登录安全配置已同步。`,
        'ok'
      );
    }
    return { ok: true, totpResult };
  } catch (error) {
    const errorMessage = String(error?.message || error || '2FA 绑定失败').trim();
    if (!options.silent) {
      await addLog(`2FA 绑定：${email ? maskEmailForSafeLog(email) : '当前账号'} 绑定失败，后续流程不受影响。原因：${errorMessage}`, 'warn');
    }
    return { ok: false, error: errorMessage };
  }
}

async function upsertExternalRedeemRecordsInState(records = [], options = {}) {
  const normalizedRecords = (Array.isArray(records) ? records : [records])
    .filter((record) => record && typeof record === 'object' && String(record.email || '').trim())
    .map((record) => normalizeExternalRedeemRecordRuntime({
      ...record,
      email: String(record.email || '').trim().toLowerCase(),
      cdk: normalizeExternalRedeemCdkey(record.cdk || record.cdkey || ''),
      redeemStatus: String(record.redeemStatus || record.status || '').trim().toLowerCase(),
      updatedAt: String(record.updatedAt || new Date().toISOString()),
    }));
  if (!normalizedRecords.length) {
    return [];
  }

  const state = await getState().catch(() => ({}));
  const nextByKey = new Map();
  for (const record of normalizedRecords) {
    const key = getExternalRedeemRecordKey(record);
    if (key) nextByKey.set(key, record);
  }
  for (const record of Array.isArray(state?.externalRedeemRecords) ? state.externalRedeemRecords : []) {
    const key = getExternalRedeemRecordKey(record);
    if (key && !nextByKey.has(key)) {
      nextByKey.set(key, record);
    }
  }

  const updates = {
    externalRedeemRecords: Array.from(nextByKey.values()).slice(0, 1000),
    externalRedeemRecordsLastSyncAt: Date.now(),
  };
  if (Object.prototype.hasOwnProperty.call(options, 'lastError')) {
    updates.externalRedeemRecordsLastError = String(options.lastError || '').trim();
  }
  await setState(updates);
  broadcastDataUpdate(updates);
  return updates.externalRedeemRecords;
}

async function syncExternalRedeemRecordsToSqlite(records = [], options = {}) {
  const normalizedRecords = (Array.isArray(records) ? records : [records])
    .filter((record) => record && typeof record === 'object' && String(record.email || '').trim());
  if (!normalizedRecords.length) {
    return null;
  }
  await upsertExternalRedeemRecordsInState(normalizedRecords, { lastError: '' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(options.timeoutMs) || 8000));
  try {
    const response = await fetch(EXTERNAL_REDEEM_LOCAL_RECORDS_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ records: normalizedRecords }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    const responseRecords = Array.isArray(data.records) && data.records.length
      ? data.records
      : normalizedRecords;
    const mergedRecords = await upsertExternalRedeemRecordsInState(responseRecords, { lastError: '' });
    const updates = {
      externalRedeemRecords: mergedRecords,
      externalRedeemRecordsDbPath: String(data.dbPath || ''),
      externalRedeemRecordsLastSyncAt: Date.now(),
      externalRedeemRecordsLastError: '',
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    return data;
  } catch (error) {
    await upsertExternalRedeemRecordsInState(normalizedRecords, {
      lastError: error?.message || String(error || ''),
    }).catch(() => null);
    if (!options.silent) {
      await addLog(`外部兑换记录：同步 SQLite 失败：${error?.message || error}`, 'warn');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveChatGptTotpMfaChallenge(step = 4, state = {}, options = {}) {
  const visibleStep = Math.floor(Number(options?.visibleStep || step) || 0) || step || 4;
  const nodeId = String(options?.nodeId || (visibleStep === 4 ? 'fetch-signup-code' : 'fetch-login-code')).trim();
  const email = String(
    options?.email
    || state?.email
    || state?.registrationEmailState?.current
    || state?.step8VerificationTargetEmail
    || ''
  ).trim().toLowerCase();
  if (!email) {
    throw new Error(`步骤 ${visibleStep}：检测到 2FA 验证页，但当前状态缺少邮箱，无法查询一次性验证码。`);
  }
  await addLog(`步骤 ${visibleStep}：检测到 2FA 验证页，正在查询一次性验证码...`, 'info', {
    step: visibleStep,
    stepKey: nodeId,
  });
  const lookup = await fetchChatGptTotpLookup(email);
  await addLog(`步骤 ${visibleStep}：已获取 2FA 一次性验证码，正在提交。`, 'info', {
    step: visibleStep,
    stepKey: nodeId,
  });
  const submitResult = await verificationFlowHelpers.submitVerificationCode(step, lookup.code, {
    purpose: 'totp-mfa',
    visibleStep,
    completionStep: visibleStep,
  });
  if (submitResult?.invalidCode) {
    throw new Error(`步骤 ${visibleStep}：2FA 一次性验证码被页面拒绝。`);
  }
  if (submitResult?.mfaChallengeRequired) {
    const signupTabId = await getTabId('signup-page').catch(() => null);
    const tab = signupTabId ? await chrome.tabs.get(signupTabId).catch(() => null) : null;
    if (isLikelyPostMfaChatgptAppUrl(tab?.url || submitResult?.url || '')) {
      await addLog(`步骤 ${visibleStep}：2FA 提交后页面已进入 ChatGPT，按验证通过继续。`, 'ok', {
        step: visibleStep,
        stepKey: nodeId,
      });
      submitResult.mfaChallengeRequired = false;
      submitResult.skipProfileStep = step === 4 ? true : submitResult.skipProfileStep;
      submitResult.url = String(tab?.url || submitResult?.url || '');
    } else {
      throw new Error(`步骤 ${visibleStep}：2FA 一次性验证码提交后仍停留在 2FA 验证页。`);
    }
  }
  if (typeof completeNodeFromBackground === 'function') {
    await completeNodeFromBackground(nodeId, {
      mfaChallenge: true,
      totpSubmitted: true,
      ...(step === 4 && submitResult?.skipProfileStep ? { skipProfileStep: true } : {}),
      ...(step === 4 && submitResult?.skipProfileStepReason
        ? { skipProfileStepReason: submitResult.skipProfileStepReason }
        : {}),
    });
  }
  return {
    ok: true,
    mfaChallenge: true,
    totpSubmitted: true,
    url: submitResult?.url || '',
  };
}

async function readExternalRedeemRecordsFromSqlite(options = {}) {
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(options.limit) || 500)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(options.timeoutMs) || 8000));
  try {
    const response = await fetch(`${EXTERNAL_REDEEM_LOCAL_RECORDS_URL}?limit=${encodeURIComponent(String(limit))}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    const state = await getState().catch(() => ({}));
    const records = (Array.isArray(data.records) ? data.records : [])
      .map((record) => normalizeExternalRedeemRecordRuntime(record));
    const updates = {
      externalRedeemRecords: records,
      externalRedeemRecordsDbPath: String(data.dbPath || ''),
      externalRedeemRecordsLastSyncAt: Date.now(),
      externalRedeemRecordsLastError: '',
    };
    const mergedQueue = mergeExternalRedeemQueueWithRecords(state?.externalRedeemQueue, records);
    if (mergedQueue.length) {
      updates.externalRedeemQueue = mergedQueue;
      updates.externalRedeemLastSyncAt = Date.now();
      updates.externalRedeemLastError = '';
    }
    await setState(updates);
    broadcastDataUpdate(updates);
    return { ok: true, ...data };
  } catch (error) {
    const errorMessage = String(error?.message || error || '读取 SQLite 兑换记录失败').trim();
    const updates = {
      externalRedeemRecordsLastError: errorMessage,
      externalRedeemRecordsLastSyncAt: Date.now(),
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    if (!options.silent) {
      await addLog(`外部兑换记录：读取 SQLite 失败：${errorMessage}`, 'warn');
    }
    return { ok: false, error: errorMessage, state: await getState() };
  } finally {
    clearTimeout(timer);
  }
}

async function clearExternalRedeemRecordsFromSqlite(options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(options.timeoutMs) || 8000));
  try {
    const emails = Array.isArray(options.emails)
      ? options.emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean)
      : null;
    const response = await fetch(EXTERNAL_REDEEM_LOCAL_RECORDS_URL, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(emails && emails.length ? { emails } : {}),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || `HTTP ${response.status}`);
    }
    const updates = {
      externalRedeemRecords: (Array.isArray(data.records) ? data.records : [])
        .map((record) => normalizeExternalRedeemRecordRuntime(record)),
      externalRedeemRecordsDbPath: String(data.dbPath || ''),
      externalRedeemRecordsLastSyncAt: Date.now(),
      externalRedeemRecordsLastError: '',
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    await addLog('外部兑换记录：已清空 SQLite 历史记录。', 'ok');
    return { ok: true, ...data, state: await getState() };
  } catch (error) {
    const errorMessage = String(error?.message || error || '清空 SQLite 兑换记录失败').trim();
    const updates = {
      externalRedeemRecordsLastError: errorMessage,
      externalRedeemRecordsLastSyncAt: Date.now(),
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    if (!options.silent) {
      await addLog(`外部兑换记录：清空 SQLite 失败：${errorMessage}`, 'warn');
    }
    return { ok: false, error: errorMessage, state: await getState() };
  } finally {
    clearTimeout(timer);
  }
}

function buildExternalRedeemItemId(email = '', cdkey = '') {
  const source = `${String(email || '').trim().toLowerCase()}::${String(cdkey || '').trim()}::${Date.now()}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return `redeem-${Math.abs(hash)}-${Date.now()}`;
}

function getNextExternalRedeemCdkey(state = {}) {
  const cdkeys = getExternalRedeemCdkeysFromText(state?.externalRedeemCdkeyPoolText || '');
  if (!cdkeys.length) {
    return '';
  }
  const used = new Set(getExternalRedeemQueueFromState(state)
    .filter((item) => isExternalRedeemCdkeyReserved(item))
    .map((item) => normalizeExternalRedeemCdkey(item?.cdkey))
    .filter(Boolean));
  return cdkeys.find((cdkey) => !used.has(cdkey)) || '';
}

function buildExternalRedeemApiUrl(baseUrl = '', path = '') {
  const root = normalizeExternalRedeemBaseUrl(baseUrl).replace(/\/api$/i, '');
  return `${root}${String(path || '').startsWith('/') ? path : `/${path}`}`;
}

async function fetchExternalRedeemApi(path, body, options = {}) {
  const state = options.state || await getState().catch(() => ({}));
  const apiKey = String(state?.externalRedeemApiKey || '').trim();
  if (!apiKey) {
    throw new Error('外部兑换 API Key 为空。');
  }
  const url = buildExternalRedeemApiUrl(state?.externalRedeemBaseUrl, path);
  const proxyUrl = EXTERNAL_REDEEM_LOCAL_PROXY_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_REDEEM_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        apiKey,
        body: body || {},
      }),
      signal: controller.signal,
    });
    const rawText = await response.text().catch(() => '');
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }
    if (!response.ok || Number(data?.code) !== 0) {
      const bodySummary = rawText
        ? rawText.replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';
      const corsHint = /invalid cors request/i.test(bodySummary)
        ? 'hint=服务端 CORS 拒绝了扩展 Origin，已尝试移除 Origin 请求头；请重新加载扩展后再试，若仍失败需要服务端放行 chrome-extension:// 来源或改为后端代理调用'
        : '';
      const details = [
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        data?.code !== undefined ? `code=${data.code}` : '',
        data?.message ? `message=${data.message}` : '',
        bodySummary && !data?.message ? `body=${bodySummary}` : '',
        corsHint,
        `url=${url}`,
        `proxy=${proxyUrl}`,
      ].filter(Boolean).join('；');
      throw new Error(`外部兑换接口请求失败（${details}）。`);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`外部兑换本地代理请求超时，请确认本地代理已启动：${proxyUrl}`);
    }
    const message = String(error?.message || error || '').trim();
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      throw new Error(`外部兑换本地代理不可用，请先启动 Node 代理：npm run external-redeem-proxy（${proxyUrl}）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function updateExternalRedeemQueue(updater) {
  const state = await getState().catch(() => ({}));
  const currentQueue = getExternalRedeemQueueFromState(state);
  const nextQueue = typeof updater === 'function'
    ? updater(currentQueue, state)
    : currentQueue;
  const normalizedQueue = Array.isArray(nextQueue) ? nextQueue : currentQueue;
  const updates = {
    externalRedeemQueue: normalizedQueue.slice(-500),
    externalRedeemLastSyncAt: Date.now(),
    externalRedeemLastError: '',
  };
  await setState(updates);
  broadcastDataUpdate(updates);
  return updates.externalRedeemQueue;
}

async function ensureExternalRedeemMonitorAlarm(stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const queue = getExternalRedeemQueueFromState(state);
  const hasPending = getExternalRedeemPendingQueue(queue).length > 0;
  if (!hasPending) {
    await chrome.alarms.clear(EXTERNAL_REDEEM_MONITOR_ALARM_NAME);
    return false;
  }
  const periodInMinutes = normalizeExternalRedeemPollSeconds(state?.externalRedeemPollSeconds) / 60;
  await chrome.alarms.clear(EXTERNAL_REDEEM_MONITOR_ALARM_NAME);
  await chrome.alarms.create(EXTERNAL_REDEEM_MONITOR_ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  return true;
}

function normalizeExternalRedeemSubmitItem(item = {}, context = {}) {
  const accepted = item?.accepted === true;
  const status = String(item?.status || (accepted ? 'pending_dispatch' : 'rejected')).trim().toLowerCase();
  return {
    id: context.id || buildExternalRedeemItemId(context.email, item?.cdkey || context.cdkey),
    email: String(context.email || '').trim().toLowerCase(),
    cdkey: normalizeExternalRedeemCdkey(item?.cdkey || context.cdkey),
    accessTokenPreview: String(context.accessTokenPreview || '').trim(),
    qualified: context.qualified === true,
    tokenReason: String(context.tokenReason || '').trim(),
    taskId: String(item?.task_id || '').trim(),
    status,
    displayStatus: String(item?.display_status || (accepted ? '等待兑换' : '提交失败')).trim(),
    accepted,
    alreadySubmitted: item?.already_submitted === true,
    reason: String(item?.reason || item?.error_message || '').trim(),
    errorCode: String(item?.error_code || '').trim(),
    errorMessage: String(item?.error_message || '').trim(),
    transactionId: '',
    transactionStatus: '',
    found: accepted,
    createdAt: Date.now(),
    submittedAt: Date.now(),
    updatedAt: item?.updated_at || new Date().toISOString(),
    finishedAt: '',
  };
}

function normalizeExternalRedeemStatusItem(item = {}, previous = {}) {
  const status = String(item?.status || previous?.status || '').trim().toLowerCase();
  const transactionStatus = String(item?.transaction_status || previous?.transactionStatus || '').trim();
  const displayStatus = String(item?.display_status || previous?.displayStatus || status || '').trim();
  const isSuccessUpdate = status === 'success'
    || transactionStatus.toLowerCase() === 'paid'
    || /充值成功|兑换成功|success/i.test(displayStatus);
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(item, key);
  const reason = hasOwn('reason')
    ? String(item?.reason || '').trim()
    : (isSuccessUpdate ? '' : String(previous?.reason || '').trim());
  const errorMessage = hasOwn('error_message')
    ? String(item?.error_message || '').trim()
    : (isSuccessUpdate ? '' : String(previous?.errorMessage || '').trim());
  return normalizeExternalRedeemRechargeFailureItem({
    ...previous,
    taskId: String(item?.task_id || previous?.taskId || '').trim(),
    status,
    displayStatus,
    reason,
    transactionId: String(item?.transaction_id || previous?.transactionId || '').trim(),
    transactionStatus,
    found: item?.found !== false,
    updatedAt: item?.updated_at || previous?.updatedAt || new Date().toISOString(),
    finishedAt: item?.finished_at || previous?.finishedAt || '',
    errorMessage,
    lastCheckedAt: Date.now(),
  });
}

function isExternalRedeemQueueItemSuccessfulForFlow(item = {}) {
  const status = String(item?.status || '').trim().toLowerCase();
  return status === 'success' && !hasExternalRedeemRechargeFailureSignal(item);
}

function isExternalRedeemQueueItemPendingForFlow(item = {}) {
  if (hasExternalRedeemRechargeFailureSignal(item)) {
    return false;
  }
  const status = String(item?.status || '').trim().toLowerCase();
  return Boolean(item?.accepted)
    && Boolean(status)
    && !EXTERNAL_REDEEM_TERMINAL_STATUSES.has(status);
}

function isExternalRedeemQueueItemFailedTerminal(item = {}) {
  if (hasExternalRedeemRechargeFailureSignal(item)) {
    return true;
  }
  const status = String(item?.status || '').trim().toLowerCase();
  return Boolean(status)
    && EXTERNAL_REDEEM_TERMINAL_STATUSES.has(status)
    && status !== 'success';
}

function getExternalRedeemQueueItemFailureMessage(item = {}) {
  return String(
    item?.errorMessage
    || item?.reason
    || item?.displayStatus
    || item?.status
    || '外部兑换/充值失败'
  ).trim();
}

function findExternalRedeemQueueItemForFlow(queueOrState = {}, target = {}) {
  const queue = Array.isArray(queueOrState)
    ? queueOrState
    : getExternalRedeemQueueFromState(queueOrState);
  const targetId = String(target?.id || '').trim();
  const targetTaskId = String(target?.taskId || target?.task_id || '').trim();
  const targetCdkey = normalizeExternalRedeemCdkey(target?.cdkey || '');
  const targetEmail = String(target?.email || '').trim().toLowerCase();
  return queue.find((item) => {
    const itemId = String(item?.id || '').trim();
    const itemTaskId = String(item?.taskId || item?.task_id || '').trim();
    const itemCdkey = normalizeExternalRedeemCdkey(item?.cdkey || '');
    const itemEmail = String(item?.email || '').trim().toLowerCase();
    const emailMatches = !targetEmail || itemEmail === targetEmail;
    if (targetId && itemId === targetId) return emailMatches;
    if (targetTaskId && itemTaskId === targetTaskId) return emailMatches;
    return Boolean(targetCdkey && itemCdkey === targetCdkey && (!targetEmail || itemEmail === targetEmail));
  }) || null;
}

async function maybeStartReplacementRunForFailedExternalRedeem(failedItems = [], options = {}) {
  const items = Array.isArray(failedItems)
    ? failedItems.filter((item) => item && typeof item === 'object' && isExternalRedeemQueueItemFailedTerminal(item))
    : [];
  if (!items.length) {
    return { started: false, reason: 'no_failed_items' };
  }

  const state = await getState().catch(() => ({}));
  for (const item of items) {
    const email = String(item?.email || '').trim().toLowerCase();
    if (email) {
      await markCustomEmailPoolEntryUsedByEmail(email, {
        logPrefix: 'iCloud API 邮箱池：外部兑换/充值失败，',
        level: 'warn',
      }).catch(() => null);
    }
  }

  const latestState = await getState().catch(() => state || {});
  if (!hasUnusedCustomEmailPoolEntry(latestState)) {
    await addLog('外部兑换：检测到充值失败，但邮箱池没有未用邮箱可补位。', 'warn');
    return { started: false, reason: 'no_unused_email' };
  }
  if (autoRunActive || isAutoRunLockedState(latestState) || isAutoRunPausedState(latestState)) {
    await addLog('外部兑换：检测到充值失败，当前自动流程仍在运行，稍后将由后续轮次继续换邮箱。', 'warn');
    return { started: false, reason: 'auto_run_active' };
  }

  const unusedEmailCount = typeof getUnusedCustomEmailPoolCount === 'function'
    ? getUnusedCustomEmailPoolCount(latestState)
    : items.length;
  const replacementRunCount = Math.max(1, Math.min(items.length, unusedEmailCount || 1));
  const firstItem = items[0] || {};
  await addLog(
    `外部兑换：${firstItem.email || firstItem.cdkey || '任务'} 充值失败，失败 CDK 已释放为可再次选择；检测到邮箱池仍有未用邮箱，自动启动 ${replacementRunCount} 轮补位注册并重新提交兑换。`,
    'warn'
  );
  startAutoRunLoop(replacementRunCount, {
    autoRunSkipFailures: Boolean(latestState.autoRunSkipFailures),
    mode: 'restart',
    source: options.trigger || 'external-redeem-failed',
  });
  return { started: true };
}

let feishuTenantTokenCache = {
  token: '',
  expiresAt: 0,
  appId: '',
};
const feishuWikiBitableTokenCache = new Map();
const FEISHU_REQUIRED_FIELD_NAMES = [
  '邮箱',
  '执行状态',
  '失败原因',
  'AC资格',
  'AC检测原因',
  'CDK',
  '兑换状态',
  '更新时间',
];
const FEISHU_SYNC_CODE_VERSION = '20260607-field-check-v2';

function normalizeFeishuText(value = '') {
  return String(value || '').trim();
}

function buildFeishuApiErrorMessage(responseStatus, data = {}, context = {}) {
  const code = data?.code ?? '-';
  const message = data?.msg || data?.message || '-';
  const action = normalizeFeishuText(context.action || '');
  const url = normalizeFeishuText(context.url || '');
  const suffix = [action ? `action=${action}` : '', url ? `url=${url}` : ''].filter(Boolean).join('；');
  if (String(message || '').includes('FieldNameNotFound') || Number(code) === 1254045) {
    return `飞书表字段不存在（code=${code}）。请确认当前 Table ID 下已创建字段：${FEISHU_REQUIRED_FIELD_NAMES.join('、')}。`;
  }
  return `飞书 API 请求失败（HTTP ${responseStatus}；code=${code}；message=${message}${suffix ? `；${suffix}` : ''}）。`;
}

function isFeishuSyncEnabled(state = {}) {
  return Boolean(state?.feishuSyncEnabled)
    && normalizeFeishuText(state?.feishuAppId)
    && normalizeFeishuText(state?.feishuAppSecret)
    && normalizeFeishuText(state?.feishuBitableAppToken)
    && normalizeFeishuText(state?.feishuBitableTableId);
}

function getFeishuMissingConfigKeys(state = {}) {
  const missing = [];
  if (!Boolean(state?.feishuSyncEnabled)) missing.push('feishuSyncEnabled');
  if (!normalizeFeishuText(state?.feishuAppId)) missing.push('feishuAppId');
  if (!normalizeFeishuText(state?.feishuAppSecret)) missing.push('feishuAppSecret');
  if (!normalizeFeishuText(state?.feishuBitableAppToken)) missing.push('feishuBitableAppToken');
  if (!normalizeFeishuText(state?.feishuBitableTableId)) missing.push('feishuBitableTableId');
  return missing;
}

function getFeishuBitableApiBase(state = {}) {
  const appToken = encodeURIComponent(normalizeFeishuText(state?.feishuResolvedBitableAppToken || state?.feishuBitableAppToken));
  const tableId = encodeURIComponent(normalizeFeishuText(state?.feishuBitableTableId));
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
}

function getFeishuBitableTableApiBase(state = {}) {
  const appToken = encodeURIComponent(normalizeFeishuText(state?.feishuResolvedBitableAppToken || state?.feishuBitableAppToken));
  const tableId = encodeURIComponent(normalizeFeishuText(state?.feishuBitableTableId));
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`;
}

function getFeishuRecordEmail(record = {}) {
  const fields = record?.fields && typeof record.fields === 'object' ? record.fields : {};
  const raw = fields['邮箱'];
  if (Array.isArray(raw)) {
    return normalizeFeishuText(raw.map((item) => (
      typeof item === 'object' ? item?.text || item?.link || '' : item
    )).join('')).toLowerCase();
  }
  if (raw && typeof raw === 'object') {
    return normalizeFeishuText(raw.text || raw.link || raw.value || '').toLowerCase();
  }
  return normalizeFeishuText(raw).toLowerCase();
}

function getLatestExternalRedeemItemForEmail(state = {}, email = '') {
  const targetEmail = normalizeFeishuText(email).toLowerCase();
  if (!targetEmail) {
    return null;
  }
  const queue = getExternalRedeemQueueFromState(state)
    .filter((item) => normalizeFeishuText(item?.email).toLowerCase() === targetEmail)
    .sort((left, right) => (Number(right?.lastCheckedAt || right?.submittedAt || right?.createdAt) || 0)
      - (Number(left?.lastCheckedAt || left?.submittedAt || left?.createdAt) || 0));
  if (queue.length) {
    return queue[0];
  }
  const records = Array.isArray(state?.externalRedeemRecords) ? state.externalRedeemRecords : [];
  return records.find((item) => normalizeFeishuText(item?.email).toLowerCase() === targetEmail) || null;
}

function getFeishuStatusLabel(status = '') {
  const normalized = normalizeFeishuText(status).toLowerCase();
  const labels = {
    success: '成功',
    failed: '失败',
    stopped: '停止',
    running: '运行中',
    pending: '待执行',
    submit_failed: '提交失败',
    pending_dispatch: '等待充值',
    processing: '处理中',
    timeout: '超时',
    rejected: '拒绝',
    not_found: '未找到',
  };
  return labels[normalized] || normalizeFeishuText(status);
}

function buildFeishuSyncFields(input = {}, stateOverride = null) {
  const state = stateOverride || {};
  const accountRecord = input.accountRecord && typeof input.accountRecord === 'object' ? input.accountRecord : null;
  const inputEmail = normalizeFeishuText(input.email).toLowerCase();
  const email = normalizeFeishuText(
    inputEmail
    || accountRecord?.email
    || state?.email
    || state?.registrationEmailState?.current
    || ''
  ).toLowerCase();
  if (!email) {
    return null;
  }
  const acRecord = state?.chatgptAccessTokenRecords?.[email] || null;
  const acInfo = input.accessTokenInfo || state?.chatgptAccessTokenInfo || {};
  const acCheck = input.accessTokenCheck || acRecord?.check || state?.chatgptAccessTokenCheck || null;
  const redeemItem = input.redeemItem || getLatestExternalRedeemItemForEmail(state, email) || {};
  const finalStatus = normalizeFeishuText(accountRecord?.finalStatus || input.finalStatus || '');
  const failureReason = normalizeFeishuText(
    input.failureReason
    || accountRecord?.failureDetail
    || accountRecord?.failureLabel
    || ''
  );
  const acQualified = acCheck?.checked ? getAccessTokenCheckDisplayStatus(acCheck) : '';
  const acReason = normalizeFeishuText(acCheck?.error || acCheck?.reason || '');
  const redeemStatus = normalizeFeishuText(
    redeemItem?.displayStatus
    || redeemItem?.redeemStatus
    || redeemItem?.status
    || ''
  );
  const cdk = normalizeExternalRedeemCdkey(input.cdkey || redeemItem?.cdkey || '');
  return {
    邮箱: email,
    执行状态: finalStatus ? getFeishuStatusLabel(finalStatus) : '',
    失败原因: failureReason,
    AC资格: acQualified,
    AC检测原因: acReason,
    CDK: cdk,
    兑换状态: redeemStatus ? getFeishuStatusLabel(redeemStatus) : '',
    更新时间: Date.now(),
  };
}

async function getFeishuTenantAccessToken(stateOverride = null, options = {}) {
  const state = stateOverride || await getState().catch(() => ({}));
  const appId = normalizeFeishuText(state?.feishuAppId);
  const appSecret = normalizeFeishuText(state?.feishuAppSecret);
  if (!appId || !appSecret) {
    throw new Error('飞书同步缺少 App ID 或 App Secret。');
  }
  const now = Date.now();
  if (!options.forceRefresh
    && feishuTenantTokenCache.token
    && feishuTenantTokenCache.appId === appId
    && feishuTenantTokenCache.expiresAt - 60000 > now) {
    return feishuTenantTokenCache.token;
  }
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.code) !== 0 || !data?.tenant_access_token) {
    throw new Error(`飞书 tenant_access_token 获取失败（HTTP ${response.status}；code=${data?.code ?? '-'}；message=${data?.msg || data?.message || '-'}）。`);
  }
  feishuTenantTokenCache = {
    token: String(data.tenant_access_token || ''),
    expiresAt: now + Math.max(60, Number(data.expire) || 7200) * 1000,
    appId,
  };
  return feishuTenantTokenCache.token;
}

async function resolveFeishuBitableAppToken(stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const rawToken = normalizeFeishuText(state?.feishuBitableAppToken);
  if (!rawToken) {
    throw new Error('飞书同步缺少多维表格 App Token。');
  }
  if (/^bas/i.test(rawToken)) {
    return rawToken;
  }
  const cacheKey = `${normalizeFeishuText(state?.feishuAppId)}:${rawToken}`;
  const cached = feishuWikiBitableTokenCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const token = await getFeishuTenantAccessToken(state);
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(rawToken)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.code) !== 0) {
    throw new Error(`飞书 Wiki 节点解析失败（HTTP ${response.status}；code=${data?.code ?? '-'}；message=${data?.msg || data?.message || '-'}）。`);
  }
  const node = data?.data?.node || {};
  const objToken = normalizeFeishuText(node.obj_token || node.objToken || node.token || '');
  const objType = normalizeFeishuText(node.obj_type || node.objType || '');
  if (!objToken) {
    throw new Error('飞书 Wiki 节点解析失败：未返回多维表格 obj_token。');
  }
  if (objType && !['bitable', 'base'].includes(objType.toLowerCase())) {
    throw new Error(`飞书 Wiki 节点不是多维表格类型：${objType}`);
  }
  feishuWikiBitableTokenCache.set(cacheKey, objToken);
  return objToken;
}

async function fetchFeishuApi(pathOrUrl, options = {}, stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const token = await getFeishuTenantAccessToken(state);
  const resolvedBitableAppToken = /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? ''
    : await resolveFeishuBitableAppToken(state);
  const requestState = resolvedBitableAppToken
    ? { ...state, feishuResolvedBitableAppToken: resolvedBitableAppToken }
    : state;
  const url = /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? String(pathOrUrl)
    : `${getFeishuBitableApiBase(requestState)}${String(pathOrUrl || '')}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.code) !== 0) {
    throw new Error(buildFeishuApiErrorMessage(response.status, data, {
      action: options.action || `${options.method || 'GET'} records`,
      url,
    }));
  }
  return data;
}

async function fetchFeishuTableApi(pathOrUrl, options = {}, stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const token = await getFeishuTenantAccessToken(state);
  const resolvedBitableAppToken = /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? ''
    : await resolveFeishuBitableAppToken(state);
  const requestState = resolvedBitableAppToken
    ? { ...state, feishuResolvedBitableAppToken: resolvedBitableAppToken }
    : state;
  const url = /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? String(pathOrUrl)
    : `${getFeishuBitableTableApiBase(requestState)}${String(pathOrUrl || '')}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || Number(data?.code) !== 0) {
    throw new Error(buildFeishuApiErrorMessage(response.status, data, {
      action: options.action || `${options.method || 'GET'} table`,
      url,
    }));
  }
  return data;
}

async function listFeishuFieldNames(stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const names = new Set();
  let pageToken = '';
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) {
      params.set('page_token', pageToken);
    }
    const data = await fetchFeishuTableApi(`/fields?${params.toString()}`, {
      method: 'GET',
      action: 'list-fields',
    }, state);
    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    items.forEach((field) => {
      const name = normalizeFeishuText(field?.field_name || field?.fieldName || field?.name || '');
      if (name) {
        names.add(name);
      }
    });
    if (!data?.data?.has_more || !data?.data?.page_token) {
      break;
    }
    pageToken = String(data.data.page_token || '');
  }
  return names;
}

async function assertFeishuRequiredFields(stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const names = await listFeishuFieldNames(state);
  const missing = FEISHU_REQUIRED_FIELD_NAMES.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(`飞书表字段缺失：${missing.join('、')}。请在当前 Table ID 对应的数据表中创建这些字段。`);
  }
  return names;
}

async function findFeishuRecordByEmail(email = '', stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  const targetEmail = normalizeFeishuText(email).toLowerCase();
  if (!targetEmail) {
    return null;
  }
  let pageToken = '';
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      page_size: '500',
    });
    if (pageToken) {
      params.set('page_token', pageToken);
    }
    const data = await fetchFeishuApi(`?${params.toString()}`, {
      method: 'GET',
      action: 'list-records-for-upsert',
    }, state);
    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    const matched = items.find((record) => getFeishuRecordEmail(record) === targetEmail);
    if (matched) {
      return matched;
    }
    if (!data?.data?.has_more || !data?.data?.page_token) {
      return null;
    }
    pageToken = String(data.data.page_token || '');
  }
  return null;
}

async function upsertFeishuRecordByEmail(fields = {}, stateOverride = null) {
  const state = stateOverride || await getState().catch(() => ({}));
  if (!isFeishuSyncEnabled(state)) {
    return { skipped: true, reason: 'disabled_or_incomplete' };
  }
  const email = normalizeFeishuText(fields['邮箱']).toLowerCase();
  if (!email) {
    return { skipped: true, reason: 'missing_email' };
  }
  await assertFeishuRequiredFields(state);
  const existing = await findFeishuRecordByEmail(email, state);
  if (existing?.record_id) {
    const data = await fetchFeishuApi(`/${encodeURIComponent(existing.record_id)}`, {
      method: 'PUT',
      action: 'update-record',
      body: { fields },
    }, state);
    return { ok: true, action: 'updated', record: data?.data?.record || null };
  }
  const data = await fetchFeishuApi('', {
    method: 'POST',
    action: 'create-record',
    body: { fields },
  }, state);
  return { ok: true, action: 'created', record: data?.data?.record || null };
}

async function syncFeishuAccountResult(input = {}, options = {}) {
  const state = options.state || await getState().catch(() => ({}));
  if (!isFeishuSyncEnabled(state)) {
    return { skipped: true, missing: getFeishuMissingConfigKeys(state) };
  }
  const fields = buildFeishuSyncFields(input, state);
  if (!fields) {
    return { skipped: true, reason: 'missing_email' };
  }
  try {
    const result = await upsertFeishuRecordByEmail(fields, state);
    const updates = {
      feishuLastSyncAt: Date.now(),
      feishuLastSyncEmail: fields['邮箱'],
      feishuLastError: '',
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    if (!options.silent) {
      await addLog(`飞书同步：${fields['邮箱']} 已${result.action === 'created' ? '新增' : '更新'}。`, 'ok');
    }
    return { ...result, fields };
  } catch (error) {
    const errorMessage = normalizeFeishuText(error?.message || error || '飞书同步失败');
    const updates = {
      feishuLastSyncAt: Date.now(),
      feishuLastSyncEmail: fields['邮箱'],
      feishuLastError: errorMessage,
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    await addLog(`飞书同步：${fields['邮箱']} 同步失败：${errorMessage}`, 'warn');
    return { ok: false, error: errorMessage, fields };
  }
}

async function syncCurrentFeishuAccountResult(options = {}) {
  let state = await getState().catch(() => ({}));
  let records = Array.isArray(state?.externalRedeemRecords)
    ? state.externalRedeemRecords.filter((record) => record && String(record.email || '').trim())
    : [];
  if (!records.length && typeof readExternalRedeemRecordsFromSqlite === 'function') {
    await readExternalRedeemRecordsFromSqlite({
      limit: Math.max(1, Math.min(2000, Math.floor(Number(options.limit) || 500))),
      silent: true,
    });
    state = await getState().catch(() => state);
    records = Array.isArray(state?.externalRedeemRecords)
      ? state.externalRedeemRecords.filter((record) => record && String(record.email || '').trim())
      : [];
  }
  if (!records.length) {
    throw new Error('飞书同步失败：暂无可同步的历史兑换记录。');
  }
  let success = 0;
  const failures = [];
  for (const record of records.slice(0, Math.max(1, Math.min(2000, Math.floor(Number(options.limit) || 500))))) {
    const email = normalizeFeishuText(record?.email).toLowerCase();
    const result = await syncFeishuAccountResult({
      email,
      accessTokenCheck: {
        checked: true,
        qualified: record?.qualified === true,
        tokenOk: record?.tokenOk === true,
        eligible: record?.eligible === true,
        status: Number(record?.checkStatus) || 0,
        reason: normalizeFeishuText(record?.checkReason || record?.reason || ''),
        couponState: normalizeFeishuText(record?.couponState || ''),
        promoId: normalizeFeishuText(record?.promoId || ''),
        planType: normalizeFeishuText(record?.planType || ''),
        accountId: normalizeFeishuText(record?.accountId || ''),
        email,
      },
      redeemItem: {
        email,
        cdkey: normalizeExternalRedeemCdkey(record?.cdk || ''),
        taskId: normalizeFeishuText(record?.taskId || ''),
        status: normalizeFeishuText(record?.redeemStatus || ''),
        displayStatus: normalizeFeishuText(record?.displayStatus || ''),
        transactionId: normalizeFeishuText(record?.transactionId || ''),
        transactionStatus: normalizeFeishuText(record?.transactionStatus || ''),
        reason: normalizeFeishuText(record?.reason || record?.errorMessage || ''),
        accepted: record?.accepted === true,
        updatedAt: record?.updatedAt || '',
      },
      cdk: normalizeExternalRedeemCdkey(record?.cdk || ''),
    }, { state, silent: true });
    if (result?.ok === false) {
      failures.push({ email, error: result.error || '同步失败' });
    } else {
      success += 1;
    }
  }
  const errorMessage = failures.length ? failures[0].error : '';
  if (failures.length) {
    await addLog(`飞书同步：历史兑换记录同步完成，成功 ${success} 条，失败 ${failures.length} 条。首个失败：${errorMessage}`, 'warn');
  } else {
    await addLog(`飞书同步：历史兑换记录已同步 ${success} 条。`, 'ok');
  }
  return {
    ok: failures.length === 0,
    total: records.length,
    success,
    failed: failures.length,
    failures,
    error: errorMessage,
    state: await getState(),
  };
}

async function testFeishuSyncConnection() {
  const state = await getState().catch(() => ({}));
  const missing = getFeishuMissingConfigKeys({ ...state, feishuSyncEnabled: true });
  if (missing.length) {
    throw new Error(`飞书同步配置不完整：${missing.join(', ')}`);
  }
  await getFeishuTenantAccessToken(state, { forceRefresh: true });
  await assertFeishuRequiredFields(state);
  const params = new URLSearchParams({ page_size: '1' });
  await fetchFeishuApi(`?${params.toString()}`, {
    method: 'GET',
    action: 'test-list-records',
  }, state);
  const updates = {
    feishuLastSyncAt: Date.now(),
    feishuLastError: '',
    feishuSyncCodeVersion: FEISHU_SYNC_CODE_VERSION,
  };
  await setState(updates);
  broadcastDataUpdate(updates);
  await addLog(`飞书同步：测试连接成功（${FEISHU_SYNC_CODE_VERSION}）。`, 'ok');
  return { ok: true, codeVersion: FEISHU_SYNC_CODE_VERSION, state: await getState() };
}

async function submitExternalRedeemForAccessToken(result = {}, payload = {}) {
  const state = await getState().catch(() => ({}));
  if (!state?.externalRedeemEnabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const accessToken = String(result?.accessToken || '').trim();
  const accessTokenInfo = result?.accessTokenInfo || {};
  const accessTokenCheck = result?.accessTokenCheck || {};
  const email = String(accessTokenCheck?.email || accessTokenInfo?.email || state?.email || '').trim().toLowerCase();
  if (!accessToken || !email) {
    await addLog('外部兑换：缺少 AC 或邮箱，跳过本次兑换提交。', 'warn');
    return { skipped: true, reason: 'missing_token_or_email' };
  }
  if (!isAccessTokenQualifiedForExternalRedeem(accessTokenCheck)) {
    await addLog(`外部兑换：${email} AC 资格不通过，未提交兑换。`, 'info');
    return { skipped: true, reason: 'not_qualified' };
  }
  if (!String(state?.externalRedeemApiKey || '').trim()) {
    await addLog('外部兑换：AC 合格，但外部兑换 API Key 为空，跳过本次兑换提交。', 'warn');
    return { skipped: true, reason: 'missing_api_key' };
  }

  const queue = getExternalRedeemQueueFromState(state);
  const duplicate = queue.find((item) => String(item?.email || '').trim().toLowerCase() === email);
  if (duplicate?.accepted && isExternalRedeemQueueItemPendingForFlow(duplicate)) {
    await markCustomEmailPoolEntryUsedByEmail(email, {
      state,
      logPrefix: 'iCloud API 邮箱池：检测到邮箱已在兑换队列中，',
    }).catch(() => null);
    await addLog(`外部兑换：${email} 已在兑换队列中，未重复提交，将继续等待最终充值结果。`, 'info');
    return {
      ok: isExternalRedeemQueueItemSuccessfulForFlow(duplicate),
      submitted: true,
      pending: isExternalRedeemQueueItemPendingForFlow(duplicate),
      item: duplicate,
      error: isExternalRedeemQueueItemPendingForFlow(duplicate)
        ? ''
        : getExternalRedeemQueueItemFailureMessage(duplicate),
    };
  }

  const cdkey = getNextExternalRedeemCdkey(state);
  if (!cdkey) {
    await addLog('外部兑换：没有可用 CDK，跳过本次兑换提交。', 'warn');
    return { skipped: true, reason: 'missing_cdkey' };
  }

  const context = {
    email,
    cdkey,
    accessTokenPreview: String(accessTokenInfo?.accessTokenPreview || '').trim(),
    qualified: true,
    tokenReason: String(accessTokenCheck?.reason || '').trim(),
  };

  let queueItem = null;
  try {
    const response = await fetchExternalRedeemApi('/api/external/cdkey-redeems', {
      items: [{ cdkey, access_token: accessToken }],
    }, { state });
    const item = Array.isArray(response?.data?.items) ? response.data.items[0] : null;
    if (!item) {
      throw new Error('外部兑换接口未返回任务条目。');
    }
    queueItem = normalizeExternalRedeemSubmitItem(item, context);
    await updateExternalRedeemQueue((currentQueue) => [...currentQueue, queueItem]);
    await markCustomEmailPoolEntryUsedByEmail(email, {
      logPrefix: queueItem.accepted
        ? 'iCloud API 邮箱池：邮箱已参与外部兑换，'
        : 'iCloud API 邮箱池：邮箱已尝试提交外部兑换，',
    }).catch(() => null);
    await syncExternalRedeemRecordsToSqlite(
      normalizeExternalRedeemRecordFromQueueItem(queueItem, context),
      { silent: true }
    );
    await syncFeishuAccountResult({
      email,
      redeemItem: queueItem,
      cdkey,
    }, { silent: true });
    const successForFlow = isExternalRedeemQueueItemSuccessfulForFlow(queueItem);
    const pendingForFlow = isExternalRedeemQueueItemPendingForFlow(queueItem);
    if (successForFlow) {
      await syncShayuLedgerAfterExternalRedeemSuccess({
        email,
        redeemItem: queueItem,
      }, { state }).catch(() => null);
    }
    await addLog(
      successForFlow
        ? `外部兑换：${email} 已提交 CDK ${cdkey}，状态：${queueItem.displayStatus || queueItem.status}。`
        : pendingForFlow
          ? `外部兑换：${email} 已提交 CDK ${cdkey}，状态：${queueItem.displayStatus || queueItem.status}，等待最终充值结果。`
          : `外部兑换：${email} 提交被拒绝，CDK ${cdkey}，原因：${queueItem.errorMessage || queueItem.reason || queueItem.status}。`,
      successForFlow ? 'ok' : (pendingForFlow ? 'info' : 'warn')
    );
    await ensureExternalRedeemMonitorAlarm();
    return {
      ok: successForFlow,
      submitted: queueItem.accepted === true,
      pending: pendingForFlow,
      item: queueItem,
      error: successForFlow || pendingForFlow
        ? ''
        : (queueItem.errorMessage || queueItem.reason || queueItem.status || '外部兑换提交被拒绝'),
    };
  } catch (error) {
    const failedItem = {
      id: buildExternalRedeemItemId(email, cdkey),
      email,
      cdkey,
      accessTokenPreview: context.accessTokenPreview,
      qualified: true,
      tokenReason: context.tokenReason,
      taskId: '',
      status: 'submit_failed',
      displayStatus: '提交失败',
      accepted: false,
      alreadySubmitted: false,
      reason: String(error?.message || error || '提交失败').trim(),
      errorCode: 'submit_failed',
      errorMessage: String(error?.message || error || '提交失败').trim(),
      transactionId: '',
      transactionStatus: '',
      found: false,
      createdAt: Date.now(),
      submittedAt: Date.now(),
      updatedAt: new Date().toISOString(),
      finishedAt: '',
    };
    await updateExternalRedeemQueue((currentQueue) => [...currentQueue, failedItem]);
    await markCustomEmailPoolEntryUsedByEmail(email, {
      logPrefix: 'iCloud API 邮箱池：邮箱已参与外部兑换提交，',
    }).catch(() => null);
    await syncExternalRedeemRecordsToSqlite(
      normalizeExternalRedeemRecordFromQueueItem(failedItem, context),
      { silent: true }
    );
    await syncFeishuAccountResult({
      email,
      redeemItem: failedItem,
      cdkey,
    }, { silent: true });
    await addLog(`外部兑换：${email} 提交失败：${failedItem.errorMessage}`, 'warn');
    return { ok: false, error: failedItem.errorMessage, item: failedItem };
  }
}

async function retryExternalRedeemQueueItem(itemId = '') {
  const normalizedItemId = String(itemId || '').trim();
  if (!normalizedItemId) {
    throw new Error('缺少兑换队列项 ID。');
  }
  const state = await getState().catch(() => ({}));
  const queue = getExternalRedeemQueueFromState(state);
  const target = queue.find((item) => String(item?.id || '').trim() === normalizedItemId);
  if (!target) {
    throw new Error('未找到要重试的兑换记录。');
  }
  const email = String(target?.email || '').trim().toLowerCase();
  const cdkey = normalizeExternalRedeemCdkey(target?.cdkey);
  if (!email || !cdkey) {
    throw new Error('兑换记录缺少邮箱或 CDK，无法重试。');
  }
  const record = state?.chatgptAccessTokenRecords?.[email] || null;
  const accessToken = String(record?.accessToken || '').trim();
  if (!accessToken) {
    throw new Error(`没有找到 ${email} 的完整 AC，请先登录该账号并同步 AC 后再重试。`);
  }
  const accessTokenCheck = record?.check && typeof record.check === 'object'
    ? { ...record.check, checked: true }
    : {};
  if (!isAccessTokenQualifiedForExternalRedeem(accessTokenCheck)) {
    throw new Error(`${email} 的 AC 当前资格不通过，不能提交兑换。`);
  }
  await addLog(`外部兑换：正在重试 ${email} 的 CDK ${cdkey}。`, 'warn');
  try {
    const response = await fetchExternalRedeemApi('/api/external/cdkey-redeems', {
      items: [{ cdkey, access_token: accessToken }],
    }, { state });
    const item = Array.isArray(response?.data?.items) ? response.data.items[0] : null;
    if (!item) {
      throw new Error('外部兑换接口未返回任务条目。');
    }
    const nextItem = normalizeExternalRedeemSubmitItem(item, {
      id: normalizedItemId,
      email,
      cdkey,
      accessTokenPreview: String(record?.accessTokenPreview || target?.accessTokenPreview || '').trim(),
      qualified: true,
      tokenReason: String(accessTokenCheck?.reason || target?.tokenReason || '').trim(),
    });
    await updateExternalRedeemQueue((currentQueue) => currentQueue.map((queueItem) => (
      String(queueItem?.id || '').trim() === normalizedItemId ? nextItem : queueItem
    )));
    await markCustomEmailPoolEntryUsedByEmail(email, {
      logPrefix: 'iCloud API 邮箱池：邮箱已参与外部兑换重试，',
    }).catch(() => null);
    await syncExternalRedeemRecordsToSqlite(
      normalizeExternalRedeemRecordFromQueueItem(nextItem, {
        email,
        cdkey,
        accessTokenPreview: String(record?.accessTokenPreview || target?.accessTokenPreview || '').trim(),
        qualified: true,
        tokenReason: String(accessTokenCheck?.reason || target?.tokenReason || '').trim(),
      }),
      { silent: true }
    );
    await syncFeishuAccountResult({
      email,
      redeemItem: nextItem,
      cdkey,
    }, { silent: true });
    if (isExternalRedeemQueueItemSuccessfulForFlow(nextItem)) {
      await syncShayuLedgerAfterExternalRedeemSuccess({
        email,
        redeemItem: nextItem,
      }, { state }).catch(() => null);
    }
    await addLog(
      nextItem.accepted
        ? `外部兑换：${email} 重试已提交，状态：${nextItem.displayStatus || nextItem.status}。`
        : `外部兑换：${email} 重试被拒绝，原因：${nextItem.errorMessage || nextItem.reason || nextItem.status}。`,
      nextItem.accepted ? 'ok' : 'warn'
    );
    await ensureExternalRedeemMonitorAlarm();
    return { ok: true, item: nextItem, state: await getState() };
  } catch (error) {
    const errorMessage = String(error?.message || error || '重试失败').trim();
    const nextItem = {
      ...target,
      status: 'submit_failed',
      displayStatus: '提交失败',
      accepted: false,
      reason: errorMessage,
      errorCode: 'submit_failed',
      errorMessage,
      lastCheckedAt: Date.now(),
      updatedAt: new Date().toISOString(),
    };
    await updateExternalRedeemQueue((currentQueue) => currentQueue.map((queueItem) => (
      String(queueItem?.id || '').trim() === normalizedItemId ? nextItem : queueItem
    )));
    await markCustomEmailPoolEntryUsedByEmail(email, {
      logPrefix: 'iCloud API 邮箱池：邮箱已参与外部兑换重试，',
    }).catch(() => null);
    await syncExternalRedeemRecordsToSqlite(
      normalizeExternalRedeemRecordFromQueueItem(nextItem, {
        email,
        cdkey,
        accessTokenPreview: String(record?.accessTokenPreview || target?.accessTokenPreview || '').trim(),
        qualified: true,
        tokenReason: String(accessTokenCheck?.reason || target?.tokenReason || '').trim(),
      }),
      { silent: true }
    );
    await syncFeishuAccountResult({
      email,
      redeemItem: nextItem,
      cdkey,
    }, { silent: true });
    await addLog(`外部兑换：${email} 重试失败：${errorMessage}`, 'warn');
    return { ok: false, error: errorMessage, item: nextItem, state: await getState() };
  }
}

async function deleteExternalRedeemQueueItem(itemId = '') {
  const normalizedItemId = String(itemId || '').trim();
  if (!normalizedItemId) {
    throw new Error('缺少要删除的兑换队列项 ID。');
  }
  const state = await getState().catch(() => ({}));
  const queue = getExternalRedeemQueueFromState(state);
  const target = queue.find((item) => String(item?.id || '').trim() === normalizedItemId);
  if (!target) {
    throw new Error('未找到要删除的兑换记录。');
  }
  const targetCdkey = normalizeExternalRedeemCdkey(target?.cdkey);
  const currentCdkeys = getExternalRedeemCdkeysFromText(state?.externalRedeemCdkeyPoolText || '');
  const nextCdkeys = targetCdkey
    ? currentCdkeys.filter((cdkey) => normalizeExternalRedeemCdkey(cdkey) !== targetCdkey)
    : currentCdkeys;
  const updates = {
    externalRedeemQueue: queue.filter((item) => String(item?.id || '').trim() !== normalizedItemId),
    externalRedeemCdkeyPoolText: nextCdkeys.join('\n'),
    externalRedeemLastSyncAt: Date.now(),
    externalRedeemLastError: '',
  };
  await setPersistentSettings({ externalRedeemCdkeyPoolText: updates.externalRedeemCdkeyPoolText });
  await setState(updates);
  broadcastDataUpdate(updates);
  await ensureExternalRedeemMonitorAlarm({ ...state, ...updates });
  await addLog(
    `外部兑换：已删除 ${target.email || '-'} 的本地兑换记录${targetCdkey ? `，并从 CDK 池移除 ${targetCdkey}` : ''}。`,
    'warn'
  );
  return { ok: true, deleted: target, state: await getState() };
}

async function pollExternalRedeemQueue(trigger = 'alarm', options = {}) {
  const state = await getState().catch(() => ({}));
  const queue = getExternalRedeemQueueFromState(state);
  const pending = getExternalRedeemPendingQueue(queue);
  if (!pending.length) {
    await chrome.alarms.clear(EXTERNAL_REDEEM_MONITOR_ALARM_NAME);
    return { ok: true, checked: 0 };
  }
  if (!String(state?.externalRedeemApiKey || '').trim()) {
    const updates = {
      externalRedeemLastError: '外部兑换 API Key 为空，无法查询队列。',
      externalRedeemLastSyncAt: Date.now(),
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    await chrome.alarms.clear(EXTERNAL_REDEEM_MONITOR_ALARM_NAME);
    return { ok: false, checked: 0, error: updates.externalRedeemLastError };
  }

  const batch = dedupeExternalRedeemPendingQueueByCdkey(pending).slice(0, EXTERNAL_REDEEM_MAX_BATCH_SIZE);
  const cdkeys = batch.map((item) => normalizeExternalRedeemCdkey(item.cdkey)).filter(Boolean);
  if (!cdkeys.length) {
    await chrome.alarms.clear(EXTERNAL_REDEEM_MONITOR_ALARM_NAME);
    return { ok: true, checked: 0 };
  }

  try {
    const response = await fetchExternalRedeemApi('/api/external/cdkey-redeems/status', { cdkeys }, { state });
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    const byCdkey = new Map();
    const byTaskId = new Map();
    for (const item of items) {
      const itemCdkey = normalizeExternalRedeemCdkey(item?.cdkey);
      const itemTaskId = getExternalRedeemTaskId(item);
      if (itemCdkey && !byCdkey.has(itemCdkey)) {
        byCdkey.set(itemCdkey, item);
      }
      if (itemTaskId && !byTaskId.has(itemTaskId)) {
        byTaskId.set(itemTaskId, item);
      }
    }
    const pendingCdkeyCounts = countExternalRedeemPendingKeys(pending, (item) => normalizeExternalRedeemCdkey(item?.cdkey));
    const pendingTaskIdCounts = countExternalRedeemPendingKeys(pending, getExternalRedeemTaskId);
    const nextQueue = queue.map((item) => {
      const statusItem = getExternalRedeemStatusUpdateForQueueItem(item, {
        byTaskId,
        byCdkey,
        pendingTaskIdCounts,
        pendingCdkeyCounts,
      });
      if (!statusItem) {
        return item;
      }
      return normalizeExternalRedeemStatusItem(statusItem, item);
    });
    const updates = {
      externalRedeemQueue: nextQueue,
      externalRedeemLastSyncAt: Date.now(),
      externalRedeemLastError: '',
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    await syncExternalRedeemRecordsToSqlite(
      nextQueue.map((item) => normalizeExternalRedeemRecordFromQueueItem(item)).filter(Boolean),
      { silent: true }
    );
    for (const item of nextQueue) {
      if (String(item?.email || '').trim()) {
        const previous = queue.find((oldItem) => oldItem?.id === item?.id);
        const previousStatus = String(previous?.status || '').trim().toLowerCase();
        await markCustomEmailPoolEntryUsedByEmail(item.email, {
          log: false,
        }).catch(() => null);
        await syncFeishuAccountResult({
          email: item.email,
          redeemItem: item,
          cdkey: item.cdkey,
        }, { silent: true });
        if (isExternalRedeemQueueItemSuccessfulForFlow(item) && previousStatus === 'success') {
          await syncShayuLedgerAfterExternalRedeemSuccess({
            email: item.email,
            redeemItem: item,
          }, { state, silent: true }).catch(() => null);
        }
      }
    }
    const finished = nextQueue.filter((item) => {
      const previous = queue.find((oldItem) => oldItem?.id === item?.id);
      const status = String(item?.status || '').trim().toLowerCase();
      const previousStatus = String(previous?.status || '').trim().toLowerCase();
      const terminalNow = EXTERNAL_REDEEM_TERMINAL_STATUSES.has(status)
        || isExternalRedeemQueueItemFailedTerminal(item);
      const terminalBefore = EXTERNAL_REDEEM_TERMINAL_STATUSES.has(previousStatus)
        || isExternalRedeemQueueItemFailedTerminal(previous || {});
      return terminalNow && !terminalBefore;
    });
    const failedFinished = finished.filter((item) => isExternalRedeemQueueItemFailedTerminal(item));
    for (const item of finished) {
      await addLog(
        `外部兑换：${item.email || item.cdkey} 状态更新为 ${item.displayStatus || item.status}${item.reason ? `，原因：${item.reason}` : ''}。`,
        item.status === 'success' ? 'ok' : 'warn'
      );
      if (isExternalRedeemQueueItemSuccessfulForFlow(item)) {
        await syncShayuLedgerAfterExternalRedeemSuccess({
          email: item.email,
          redeemItem: item,
        }, { state }).catch(() => null);
      }
    }
    if (failedFinished.length && !options?.suppressReplacementRun) {
      await maybeStartReplacementRunForFailedExternalRedeem(failedFinished, { trigger });
    }
    await ensureExternalRedeemMonitorAlarm({ ...state, externalRedeemQueue: nextQueue });
    return { ok: true, checked: cdkeys.length, trigger, queue: nextQueue, finished, failedFinished };
  } catch (error) {
    const updates = {
      externalRedeemLastError: String(error?.message || error || '兑换队列查询失败').trim(),
      externalRedeemLastSyncAt: Date.now(),
    };
    await setState(updates);
    broadcastDataUpdate(updates);
    await addLog(`外部兑换：队列查询失败：${updates.externalRedeemLastError}`, 'warn');
    await ensureExternalRedeemMonitorAlarm(state);
    return { ok: false, checked: 0, error: updates.externalRedeemLastError };
  }
}

async function readChatGptAccessTokenInfo(options = {}) {
  const promoId = String(options?.promoId || 'plus-1-month-free').trim() || 'plus-1-month-free';
  const sessionState = await readCurrentChatGptSessionForExport({
    expectedEmail: options?.expectedEmail,
  });
  const accessTokenInfo = buildChatGptAccessTokenInfo(sessionState);
  let accessTokenCheck = null;
  try {
    accessTokenCheck = await checkChatGptAccessTokenEligibility(sessionState.accessToken, {
      promoId,
      email: accessTokenInfo.email,
      accountId: accessTokenInfo.accountId,
      planType: accessTokenInfo.planType,
    });
  } catch (error) {
    accessTokenCheck = buildChatGptAccessTokenCheckFailure(error, {
      promoId,
      email: accessTokenInfo.email,
      accountId: accessTokenInfo.accountId,
      planType: accessTokenInfo.planType,
    });
  }

  const updates = {
    chatgptAccessTokenInfo: accessTokenInfo,
    chatgptAccessTokenCheck: accessTokenCheck,
  };
  await setState(updates);
  broadcastDataUpdate(updates);
  await syncChatGptAccessTokenRecord(accessTokenInfo, accessTokenCheck, {
    accessToken: sessionState.accessToken,
  });
  await syncChatGptAccessTokenInfoToEmailPool(accessTokenInfo, accessTokenCheck);
  await syncFeishuAccountResult({
    email: accessTokenCheck?.email || accessTokenInfo?.email,
    accessTokenInfo,
    accessTokenCheck,
  }, { silent: true });
  await syncExternalRedeemRecordsToSqlite(
    normalizeExternalRedeemRecordFromAc(accessTokenInfo, accessTokenCheck),
    { silent: true }
  );
  const latestStateForTotp = await getState().catch(() => ({}));
  const totpEnable = latestStateForTotp?.chatgptTotpAutoEnable === true
    ? await enableChatGptTotpForQualifiedAccessToken({
      accessToken: sessionState.accessToken,
      sessionToken: sessionState.sessionToken,
      accessTokenInfo,
      accessTokenCheck,
    }, {
      state: latestStateForTotp,
      silent: options?.silent,
    })
    : { skipped: true, reason: 'disabled' };
  if (!options?.silent) {
    await addLog(
      `ChatGPT AC：已同步${accessTokenInfo.email ? ` ${accessTokenInfo.email}` : ''}，资格状态：${getAccessTokenCheckDisplayStatus(accessTokenCheck)}${accessTokenCheck?.reason ? `（${accessTokenCheck.reason}）` : ''}。`,
      accessTokenCheck?.qualified ? 'ok' : (accessTokenCheck?.error ? 'warn' : 'info')
    );
  }
  return {
    ok: true,
    accessToken: sessionState.accessToken,
    accessTokenInfo,
    accessTokenCheck,
    totpEnable,
    state: await getState(),
  };
}

async function syncChatGptAccessTokenAfterAutoRunRoundSuccess(payload = {}) {
  try {
    const state = await getState().catch(() => ({}));
    const expectedEmail = String(state?.email || state?.registrationEmailState?.current || '').trim();
    const result = await readChatGptAccessTokenInfo({
      promoId: 'plus-1-month-free',
      expectedEmail,
      silent: true,
    });
    const email = String(result?.accessTokenCheck?.email || result?.accessTokenInfo?.email || '').trim();
    await addLog(
      `第 ${Number(payload?.targetRun) || '?'} 轮：已自动同步 AC${email ? `（${email}）` : ''}，资格状态：${getAccessTokenCheckDisplayStatus(result?.accessTokenCheck)}。`,
      result?.accessTokenCheck?.qualified ? 'ok' : 'info'
    );
    await submitExternalRedeemForAccessToken(result, payload);
    return result;
  } catch (error) {
    await addLog(`第 ${Number(payload?.targetRun) || '?'} 轮：自动同步 AC 失败：${error?.message || error}`, 'warn');
    return null;
  }
}

async function waitForExternalRedeemFinalResult(initialItem = {}, options = {}) {
  const nodeId = String(options?.nodeId || 'chatgpt-ac-external-redeem').trim();
  let currentItem = initialItem && typeof initialItem === 'object' ? initialItem : {};
  let checkedCount = 0;

  while (true) {
    throwIfStopped();
    if (isExternalRedeemQueueItemSuccessfulForFlow(currentItem)) {
      return { ok: true, item: currentItem };
    }
    if (isExternalRedeemQueueItemFailedTerminal(currentItem)) {
      return {
        ok: false,
        item: currentItem,
        error: getExternalRedeemQueueItemFailureMessage(currentItem),
      };
    }

    checkedCount += 1;
    await addLog(
      `步骤 7：外部兑换已提交，等待充值最终结果（第 ${checkedCount} 次查询）...`,
      'info',
      { nodeId }
    );
    const pollResult = await pollExternalRedeemQueue('step7-wait', { suppressReplacementRun: true });
    if (pollResult?.ok === false && pollResult?.error) {
      await addLog(`步骤 7：外部兑换队列暂时查询失败，将继续等待。原因：${pollResult.error}`, 'warn', { nodeId });
    }

    const latestState = await getState().catch(() => ({}));
    const latestItem = findExternalRedeemQueueItemForFlow(latestState, currentItem);
    if (latestItem) {
      currentItem = latestItem;
    }

    if (isExternalRedeemQueueItemSuccessfulForFlow(currentItem)) {
      return { ok: true, item: currentItem };
    }
    if (isExternalRedeemQueueItemFailedTerminal(currentItem)) {
      return {
        ok: false,
        item: currentItem,
        error: getExternalRedeemQueueItemFailureMessage(currentItem),
      };
    }

    const latestPollSeconds = normalizeExternalRedeemPollSeconds(
      latestState?.externalRedeemPollSeconds || options?.pollSeconds || EXTERNAL_REDEEM_DEFAULT_POLL_SECONDS
    );
    await sleepWithStop(latestPollSeconds * 1000);
  }
}

async function executeChatGptAcExternalRedeemNode(state = {}) {
  const nodeId = 'chatgpt-ac-external-redeem';
  const expectedEmail = String(state?.email || state?.registrationEmailState?.current || '').trim();
  const latestConfigState = await getState().catch(() => state || {});
  const step7CdkeyCount = getExternalRedeemCdkeysFromText(latestConfigState?.externalRedeemCdkeyPoolText || '').length;
  await addLog(
    `步骤 7：外部兑换配置：${latestConfigState?.externalRedeemEnabled ? '已启用' : '未启用'}；API Key ${String(latestConfigState?.externalRedeemApiKey || '').trim() ? '已配置' : '未配置'}；可用 CDK ${step7CdkeyCount} 个。`,
    step7CdkeyCount > 0 && latestConfigState?.externalRedeemEnabled && String(latestConfigState?.externalRedeemApiKey || '').trim() ? 'info' : 'warn',
    { nodeId }
  );
  await addLog('步骤 7：正在读取 ChatGPT AC，并检查外部兑换资格...', 'info', { nodeId });
  const result = await readChatGptAccessTokenInfo({
    promoId: 'plus-1-month-free',
    expectedEmail,
    silent: false,
  });
  const redeemResult = await submitExternalRedeemForAccessToken(result, {
    ...state,
    source: nodeId,
  });
  let finalRedeemResult = redeemResult;
  if (redeemResult?.skipped) {
    const reason = String(redeemResult.reason || 'unknown').trim();
    if (reason === 'not_qualified') {
      const email = String(
        result?.accessTokenCheck?.email
        || result?.accessTokenInfo?.email
        || expectedEmail
        || ''
      ).trim().toLowerCase();
      const failureMessage = String(result?.accessTokenCheck?.reason || 'AC 资格不通过').trim();
      await addLog(`步骤 7：AC 资格不通过，当前邮箱将标记不可再用并换下一个未用邮箱。原因：${failureMessage}`, 'warn', { nodeId });
      await markCustomEmailPoolEntryUsedByEmail(email, {
        logPrefix: 'iCloud API 邮箱池：AC 资格不通过，',
        level: 'warn',
      }).catch(() => null);
      const qualifiedFailureError = createExternalRedeemQualifiedFailureError(
        `AC 资格不通过：${failureMessage}`,
        { email, redeemResult }
      );
      throw qualifiedFailureError;
    } else if (reason === 'missing_cdkey' || reason === 'disabled') {
      const onlySyncReason = reason === 'disabled'
        ? '外部兑换未启用'
        : '没有可用 CDK';
      await addLog(`步骤 7：${onlySyncReason}，本轮只同步 AC${state?.chatgptTotpAutoEnable === true ? ' 与 2FA+密码登录设置' : ''}，不提交外部兑换。`, 'warn', { nodeId });
      await completeNodeFromBackground(nodeId, {
        accessTokenInfo: result?.accessTokenInfo || null,
        accessTokenCheck: result?.accessTokenCheck || null,
        redeemResult: redeemResult || null,
      });
      return {
        ok: true,
        ...result,
        redeemResult,
      };
    } else {
      const failureMessage = `外部兑换未提交（${reason}）`;
      await addLog(`步骤 7：${failureMessage}，本轮不会计为成功。`, 'warn', { nodeId });
      throw new Error(failureMessage);
    }
  } else if (redeemResult?.pending) {
    await addLog('步骤 7：AC 合格，已提交外部兑换队列，开始等待最终充值结果。', 'info', { nodeId });
    finalRedeemResult = await waitForExternalRedeemFinalResult(redeemResult.item, { nodeId });
    if (finalRedeemResult?.ok) {
      await addLog('步骤 7：外部兑换/充值成功，本轮完成。', 'ok', { nodeId });
    }
  } else if (redeemResult?.ok) {
    await addLog('步骤 7：AC 合格，外部兑换/充值已成功。', 'ok', { nodeId });
  }
  if (!redeemResult?.skipped && finalRedeemResult?.ok === false) {
    const email = String(
      result?.accessTokenCheck?.email
      || result?.accessTokenInfo?.email
      || expectedEmail
      || ''
    ).trim().toLowerCase();
    const failureMessage = String(finalRedeemResult?.error || redeemResult?.error || '外部兑换/充值失败').trim();
    await addLog(`步骤 7：AC 合格但外部兑换/充值失败，当前邮箱将标记不可再用并换下一个未用邮箱。原因：${failureMessage}`, 'warn', { nodeId });
    await markCustomEmailPoolEntryUsedByEmail(email, {
      logPrefix: 'iCloud API 邮箱池：AC 合格但外部兑换/充值失败，',
      level: 'warn',
    }).catch(() => null);
    const qualifiedFailureError = createExternalRedeemQualifiedFailureError(
      `AC 合格但外部兑换/充值失败：${failureMessage}`,
      { email, redeemResult: finalRedeemResult }
    );
    throw qualifiedFailureError;
  }
  await completeNodeFromBackground(nodeId, {
    accessTokenInfo: result?.accessTokenInfo || null,
    accessTokenCheck: result?.accessTokenCheck || null,
    redeemResult: finalRedeemResult,
  });
  return {
    ok: true,
    ...result,
    redeemResult: finalRedeemResult,
  };
}

function getCpaSessionExportApi() {
  const factory = self.MultiPageBackgroundCpaApi?.createCpaApi;
  if (typeof factory !== 'function') {
    throw new Error('CPA JSON 转换模块未加载。');
  }
  return factory({ addLog });
}

function getSub2SessionExportApi() {
  const factory = self.MultiPageBackgroundSub2ApiApi?.createSub2ApiApi;
  if (typeof factory !== 'function') {
    throw new Error('SUB2 JSON 转换模块未加载。');
  }
  return factory({
    addLog,
    normalizeSub2ApiUrl,
    DEFAULT_SUB2API_GROUP_NAME,
  });
}

async function exportCurrentSessionJson(options = {}) {
  const format = String(options?.format || '').trim().toLowerCase() === 'sub2' ? 'sub2' : 'cpa';
  const sessionState = await readCurrentChatGptSessionForExport();
  const state = {
    ...await getState().catch(() => ({})),
    session: sessionState.session,
    accessToken: sessionState.accessToken,
  };

  if (format === 'sub2') {
    const sub2Api = getSub2SessionExportApi();
    const rawContent = sub2Api.buildCodexSessionImportContent(sessionState.session, sessionState.accessToken);
    let fileContent = rawContent;
    let parsedContent = null;
    try {
      parsedContent = JSON.parse(rawContent);
      fileContent = JSON.stringify(parsedContent, null, 2);
    } catch {
      parsedContent = { accessToken: rawContent };
      fileContent = JSON.stringify(parsedContent, null, 2);
    }
    const email = sanitizeSessionExportFileSegment(
      parsedContent?.user?.email || parsedContent?.email || '',
      'chatgpt-session'
    );
    return {
      ok: true,
      format,
      fileName: `sub2api-${email}.json`,
      fileContent,
      warnings: [],
    };
  }

  const cpaApi = getCpaSessionExportApi();
  const sessionAuth = cpaApi.buildCpaSessionAuthJson(state, { now: new Date() });
  return {
    ok: true,
    format,
    fileName: sessionAuth.fileName,
    fileContent: JSON.stringify(sessionAuth.authJson, null, 2),
    warnings: sessionAuth.hasRefreshToken ? [] : ['当前 SESSION 未包含 refresh_token，导出的 CPA JSON 无法自动续期。'],
  };
}

function isSignupPageHost(hostname = '') {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isSignupPageHost) {
    return navigationUtils.isSignupPageHost(hostname);
  }
  return ['auth0.openai.com', 'auth.openai.com', 'accounts.openai.com'].includes(hostname);
}

function isSignupEntryHost(hostname = '') {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isSignupEntryHost) {
    return navigationUtils.isSignupEntryHost(hostname);
  }
  return ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'].includes(hostname);
}

function isLikelyLoggedInChatgptHomeUrl(rawUrl) {
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!isSignupEntryHost(String(parsed.hostname || '').toLowerCase())) {
    return false;
  }
  const path = String(parsed.pathname || '');
  if (path === '/' || path === '') {
    return false;
  }
  return !/^\/(?:auth(?:\/.*)?|create-account(?:\/.*)?|email-verification(?:\/.*)?|log-in(?:\/.*)?|add-phone(?:\/.*)?)(?:[?#]|$)/i.test(path);
}

function isLikelyPostMfaChatgptAppUrl(rawUrl) {
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed || !isSignupEntryHost(String(parsed.hostname || '').toLowerCase())) {
    return false;
  }
  const path = String(parsed.pathname || '/');
  return !/^\/(?:auth(?:\/.*)?|create-account(?:\/.*)?|email-verification(?:\/.*)?|log-in(?:\/.*)?|add-phone(?:\/.*)?)(?:[?#]|$)/i.test(path);
}

function isSignupPasswordPageUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isSignupPasswordPageUrl) {
    return navigationUtils.isSignupPasswordPageUrl(rawUrl);
  }
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  return isSignupPageHost(parsed.hostname)
    && /\/(?:create-account|log-in)\/password(?:[/?#]|$)/i.test(parsed.pathname || '');
}

function isSignupEmailVerificationPageUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isSignupEmailVerificationPageUrl) {
    return navigationUtils.isSignupEmailVerificationPageUrl(rawUrl);
  }
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  return isSignupPageHost(parsed.hostname)
    && /\/email-verification(?:[/?#]|$)/i.test(parsed.pathname || '');
}

function is163MailHost(hostname = '') {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.is163MailHost) {
    return navigationUtils.is163MailHost(hostname);
  }
  return hostname === 'mail.163.com'
    || hostname.endsWith('.mail.163.com')
    || hostname === 'mail.126.com'
    || hostname.endsWith('.mail.126.com')
    || hostname === 'webmail.vip.163.com';
}

function isLocalhostOAuthCallbackUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isLocalhostOAuthCallbackUrl) {
    return navigationUtils.isLocalhostOAuthCallbackUrl(rawUrl);
  }
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) return false;
  if (!['/auth/callback', '/codex/callback'].includes(parsed.pathname)) return false;
  const code = (parsed.searchParams.get('code') || '').trim();
  const state = (parsed.searchParams.get('state') || '').trim();
  return Boolean(code && state);
}

function isLocalCpaUrl(rawUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.isLocalCpaUrl) {
    return navigationUtils.isLocalCpaUrl(rawUrl);
  }
  const parsed = parseUrlSafely(rawUrl);
  if (!parsed) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  return ['localhost', '127.0.0.1'].includes(parsed.hostname);
}

function shouldBypassStep9ForLocalCpa(state) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.shouldBypassStep9ForLocalCpa) {
    return navigationUtils.shouldBypassStep9ForLocalCpa(state);
  }
  return normalizeLocalCpaStep9Mode(state?.localCpaStep9Mode) === 'bypass'
    && Boolean(state?.localhostUrl)
    && isLocalCpaUrl(state?.vpsUrl);
}

function matchesSourceUrlFamily(source, candidateUrl, referenceUrl) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.matchesSourceUrlFamily) {
    return navigationUtils.matchesSourceUrlFamily(source, candidateUrl, referenceUrl);
  }
  const candidate = parseUrlSafely(candidateUrl);
  if (!candidate) return false;
  const reference = parseUrlSafely(referenceUrl);
  switch (source) {
    case 'openai-auth':
    case 'signup-page':
      return isSignupPageHost(candidate.hostname) || isSignupEntryHost(candidate.hostname);
    case 'duck-mail':
      return candidate.hostname === 'duckduckgo.com' && candidate.pathname.startsWith('/email/');
    case 'qq-mail':
      return candidate.hostname === 'mail.qq.com' || candidate.hostname === 'wx.mail.qq.com';
    case 'mail-163':
      return is163MailHost(candidate.hostname);
    case 'gmail-mail':
      return candidate.hostname === 'mail.google.com';
    case 'icloud-mail':
      return candidate.hostname === 'www.icloud.com' || candidate.hostname === 'www.icloud.com.cn';
    case 'inbucket-mail':
      return Boolean(reference) && candidate.origin === reference.origin && candidate.pathname.startsWith('/m/');
    case 'mail-2925':
      return candidate.hostname === '2925.com' || candidate.hostname === 'www.2925.com';
    case 'vps-panel':
      return Boolean(reference) && candidate.origin === reference.origin && candidate.pathname === reference.pathname;
    case 'sub2api-panel':
      return Boolean(reference)
        && candidate.origin === reference.origin
        && (candidate.pathname.startsWith('/admin/accounts') || candidate.pathname.startsWith('/login') || candidate.pathname === '/');
    case 'codex2api-panel':
      return Boolean(reference)
        && candidate.origin === reference.origin
        && (candidate.pathname.startsWith('/admin/accounts') || candidate.pathname === '/admin' || candidate.pathname === '/');
    default:
      return false;
  }
}

function sourcesMatch(leftSource, rightSource) {
  if (sourceRegistry?.resolveCanonicalSource) {
    const left = sourceRegistry.resolveCanonicalSource(leftSource);
    const right = sourceRegistry.resolveCanonicalSource(rightSource);
    return Boolean(left && right && left === right);
  }
  return String(leftSource || '').trim() === String(rightSource || '').trim();
}

async function rememberSourceLastUrl(source, url) {
  return tabRuntime.rememberSourceLastUrl(source, url);
}

async function closeConflictingTabsForSource(source, currentUrl, options = {}) {
  return tabRuntime.closeConflictingTabsForSource(source, currentUrl, options);
}

function isLocalhostOAuthCallbackTabMatch(callbackUrl, candidateUrl) {
  return tabRuntime.isLocalhostOAuthCallbackTabMatch(callbackUrl, candidateUrl);
}

async function closeLocalhostCallbackTabs(callbackUrl, options = {}) {
  return tabRuntime.closeLocalhostCallbackTabs(callbackUrl, options);
}

function buildLocalhostCleanupPrefix(rawUrl) {
  return tabRuntime.buildLocalhostCleanupPrefix(rawUrl);
}

async function closeTabsByUrlPrefix(prefix, options = {}) {
  return tabRuntime.closeTabsByUrlPrefix(prefix, options);
}

async function pingContentScriptOnTab(tabId) {
  return tabRuntime.pingContentScriptOnTab(tabId);
}

async function waitForTabUrlFamily(source, tabId, referenceUrl, options = {}) {
  return tabRuntime.waitForTabUrlFamily(source, tabId, referenceUrl, options);
}

async function waitForTabUrlMatch(tabId, matcher, options = {}) {
  return tabRuntime.waitForTabUrlMatch(tabId, matcher, options);
}

async function waitForTabUrlMatchUntilStopped(tabId, matcher, options = {}) {
  const retryDelayMs = Math.max(100, Math.floor(Number(options.retryDelayMs) || 300));
  while (true) {
    throwIfStopped();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('目标标签页已关闭，无法继续等待页面跳转。');
    }
    if (typeof matcher === 'function' && matcher(tab.url || '', tab)) {
      return tab;
    }
    await sleepWithStop(retryDelayMs);
  }
}

async function waitForTabComplete(tabId, options = {}) {
  return tabRuntime.waitForTabComplete(tabId, options);
}

async function waitForTabStableComplete(tabId, options = {}) {
  return tabRuntime.waitForTabStableComplete(tabId, options);
}

function isAuthOpenAiHttp500TabSnapshot(snapshot = {}) {
  const url = String(snapshot?.url || '').trim();
  const pendingUrl = String(snapshot?.pendingUrl || '').trim();
  const title = String(snapshot?.title || '').trim();
  const text = String(snapshot?.text || '').trim();
  const scriptError = String(snapshot?.scriptError || '').trim();
  const combined = `${title} ${text} ${scriptError} ${url} ${pendingUrl}`.replace(/\s+/g, ' ').trim();
  const parsed = parseUrlSafely(url);
  const host = String(parsed?.hostname || snapshot?.host || '').toLowerCase();
  const chromeErrorUrl = /^chrome-error:\/\/chromewebdata\/?/i.test(url)
    || /^chrome-error:\/\/chromewebdata\/?/i.test(pendingUrl);
  const mentionsAuthOpenAi = /auth\.openai\.com/i.test(combined)
    || host === 'auth.openai.com'
    || (chromeErrorUrl && /auth\.openai\.com/i.test(`${url} ${pendingUrl}`));
  const mentionsHttp500 = /HTTP\s+ERROR\s+500|currently\s+unable\s+to\s+handle\s+this\s+request|目前无法处理此请求|该网页无法正常运作|This page isn['’]?t working/i.test(combined);
  const scriptBlockedByChromeError = /Cannot access contents of url "chrome-error:\/\/chromewebdata|The extensions gallery cannot be scripted|Cannot access a chrome:\/\//i.test(scriptError);
  const hasChromeNetErrorMarker = Boolean(snapshot?.isNetError)
    || /neterror|main-frame-error|chromewebdata/i.test(combined)
    || chromeErrorUrl
    || scriptBlockedByChromeError;
  const authEmailVerificationUrl = host === 'auth.openai.com' && /\/email-verification(?:[/?#]|$)/i.test(String(parsed?.pathname || ''));
  const cannotReadChromeErrorDom = Boolean(scriptError && !text && (hasChromeNetErrorMarker || (authEmailVerificationUrl && scriptBlockedByChromeError)));
  return mentionsAuthOpenAi && hasChromeNetErrorMarker && (mentionsHttp500 || cannotReadChromeErrorDom);
}

async function readTabHttp500NetErrorSnapshot(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return null;
  }

  const baseSnapshot = {
    tabId,
    status: tab.status || '',
    title: tab.title || '',
    url: tab.url || '',
    pendingUrl: tab.pendingUrl || '',
    text: '',
    isNetError: /^chrome-error:\/\/chromewebdata\/?/i.test(String(tab.url || ''))
      || /^chrome-error:\/\/chromewebdata\/?/i.test(String(tab.pendingUrl || '')),
  };

  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = String(document?.body?.innerText || document?.body?.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          title: String(document?.title || ''),
          url: String(location?.href || ''),
          host: String(location?.hostname || ''),
          text: bodyText.slice(0, 1200),
          isNetError: Boolean(
            document?.body?.classList?.contains('neterror')
            || document?.querySelector?.('#main-frame-error')
            || document?.querySelector?.('#main-message .error-code')
          ),
        };
      },
    });
    return {
      ...baseSnapshot,
      ...(execution?.result || {}),
    };
  } catch (error) {
    return {
      ...baseSnapshot,
      scriptError: String(error?.message || error || '').trim(),
    };
  }
}

function getAuthOpenAiHttp500RecoveryGetUrl(snapshot = {}, options = {}) {
  const candidates = [
    options?.getUrl,
    snapshot?.url,
    snapshot?.pendingUrl,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const parsed = parseUrlSafely(candidate);
    if (String(parsed?.hostname || '').toLowerCase() === 'auth.openai.com') {
      return candidate;
    }
  }

  return 'https://auth.openai.com/email-verification';
}

async function recoverAuthOpenAiHttp500Page(tabId, options = {}) {
  if (!Number.isInteger(tabId) || !chrome?.tabs?.update) {
    return false;
  }

  const snapshot = await readTabHttp500NetErrorSnapshot(tabId);
  if (!snapshot || !isAuthOpenAiHttp500TabSnapshot(snapshot)) {
    if (options?.logMiss) {
      const snapshotSummary = snapshot
        ? [
          `url=${String(snapshot.url || '').slice(0, 180) || '-'}`,
          `pending=${String(snapshot.pendingUrl || '').slice(0, 180) || '-'}`,
          `title=${String(snapshot.title || '').slice(0, 80) || '-'}`,
          `text=${String(snapshot.text || '').replace(/\s+/g, ' ').slice(0, 120) || '-'}`,
          `scriptError=${String(snapshot.scriptError || '').replace(/\s+/g, ' ').slice(0, 160) || '-'}`,
        ].join('；')
        : 'snapshot=null';
      await addLog(
        `步骤 ${Number(options?.step) || 4}：未识别为 auth.openai.com HTTP 500，快照：${snapshotSummary}`,
        'warn',
        {
          step: Number(options?.step) || 4,
          stepKey: String(options?.stepKey || 'fetch-signup-code'),
        }
      );
    }
    return false;
  }

  const getNavigationUrl = getAuthOpenAiHttp500RecoveryGetUrl(snapshot, options);
  const getNavigationUrlForLog = getNavigationUrl.length > 180
    ? `${getNavigationUrl.slice(0, 177)}...`
    : getNavigationUrl;
  await addLog(
    `步骤 ${Number(options?.step) || 4}：检测到 auth.openai.com HTTP 500 网络错误页，不刷新 POST 表单结果页，正在用 GET 导航重新打开认证地址：${getNavigationUrlForLog}`,
    'warn',
    {
      step: Number(options?.step) || 4,
      stepKey: String(options?.stepKey || 'fetch-signup-code'),
    }
  );
  await chrome.tabs.update(tabId, {
    active: true,
    url: getNavigationUrl,
  });
  try {
    await waitForTabStableComplete(tabId, {
      timeoutMs: 45000,
      retryDelayMs: 300,
      stableMs: 1000,
      initialDelayMs: 800,
    });
  } catch (error) {
    await addLog(
      `步骤 ${Number(options?.step) || 4}：GET 导航认证页后等待加载超时，继续检查页面状态：${error?.message || error}`,
      'warn',
      {
        step: Number(options?.step) || 4,
        stepKey: String(options?.stepKey || 'fetch-signup-code'),
      }
    );
  }

  const afterGetSnapshot = await readTabHttp500NetErrorSnapshot(tabId);
  if (!afterGetSnapshot || !isAuthOpenAiHttp500TabSnapshot(afterGetSnapshot)) {
    return {
      recovered: true,
      action: 'get-navigation',
      reloginRequired: false,
      url: getNavigationUrl,
    };
  }

  const reloginUrl = String(options?.reloginUrl || SIGNUP_ENTRY_URL || 'https://chatgpt.com/auth/login').trim()
    || 'https://chatgpt.com/auth/login';
  await addLog(
    `步骤 ${Number(options?.step) || 4}：GET 导航后仍是 auth.openai.com HTTP 500，正在切回登录入口以重新登录当前账号。`,
    'warn',
    {
      step: Number(options?.step) || 4,
      stepKey: String(options?.stepKey || 'fetch-signup-code'),
    }
  );
  await chrome.tabs.update(tabId, {
    active: true,
    url: reloginUrl,
  });
  await waitForTabStableComplete(tabId, {
    timeoutMs: 45000,
    retryDelayMs: 300,
    stableMs: 1000,
    initialDelayMs: 800,
  });
  return {
    recovered: true,
    action: 'relogin',
    reloginRequired: true,
    url: reloginUrl,
  };
}

async function waitForTabCompleteUntilStopped(tabId, options = {}) {
  const retryDelayMs = Math.max(100, Math.floor(Number(options.retryDelayMs) || 300));
  while (true) {
    throwIfStopped();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('目标标签页已关闭，无法继续等待页面加载完成。');
    }
    if (tab.status === 'complete') {
      return tab;
    }
    await sleepWithStop(retryDelayMs);
  }
}

async function ensureContentScriptReadyOnTab(source, tabId, options = {}) {
  return tabRuntime.ensureContentScriptReadyOnTab(source, tabId, options);
}

function isContentScriptReadyPong(source, pong) {
  if (!pong?.ok) return false;
  if (pong.source && !sourcesMatch(pong.source, source)) return false;
  if (source === 'plus-checkout') {
    return Boolean(pong.plusCheckoutReady);
  }
  return true;
}

function isUnrecoverableContentScriptInjectError(error) {
  return /Could not load file/i.test(String(error?.message || error || ''));
}

async function ensureContentScriptReadyOnTabUntilStopped(source, tabId, options = {}) {
  const {
    inject = null,
    injectSource = null,
    retryDelayMs = 700,
    logMessage = '',
  } = options;
  let logged = false;

  while (true) {
    throwIfStopped();
    const pong = await pingContentScriptOnTab(tabId);
    if (isContentScriptReadyPong(source, pong)) {
      await registerTab(source, tabId);
      return;
    }

    if (!inject || !inject.length) {
      throw new Error(`${getSourceLabel(source)} 内容脚本未就绪，且未提供可用的注入文件。`);
    }

    try {
      if (injectSource) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (injectedSource) => {
            window.__MULTIPAGE_SOURCE = injectedSource;
          },
          args: [injectSource],
        });
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        files: inject,
      });
    } catch (error) {
      console.warn(LOG_PREFIX, `[ensureContentScriptReadyOnTabUntilStopped] inject failed for ${source}:`, error?.message || error);
      if (isUnrecoverableContentScriptInjectError(error)) {
        throw new Error(`${getSourceLabel(source)} 内容脚本文件加载失败：${error?.message || error}。请在扩展管理页重新加载当前扩展，确认文件已包含在已加载的扩展目录中。`);
      }
    }

    const pongAfterInject = await pingContentScriptOnTab(tabId);
    if (isContentScriptReadyPong(source, pongAfterInject)) {
      await registerTab(source, tabId);
      return;
    }

    if (logMessage && !logged) {
      logged = true;
      await addLog(logMessage, 'warn');
    }
    await sleepWithStop(retryDelayMs);
  }
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function getContentScriptResponseTimeoutMs(message) {
  return tabRuntime.getContentScriptResponseTimeoutMs(message);
}

function getMessageDebugLabel(source, message, tabId = null) {
  return tabRuntime.getMessageDebugLabel(source, message, tabId);
}

function summarizeMessageResultForDebug(result) {
  return tabRuntime.summarizeMessageResultForDebug(result);
}

function sendTabMessageWithTimeout(tabId, source, message, responseTimeoutMs = getContentScriptResponseTimeoutMs(message)) {
  return tabRuntime.sendTabMessageWithTimeout(tabId, source, message, responseTimeoutMs);
}

async function sendTabMessageUntilStopped(tabId, source, message, options = {}) {
  const retryDelayMs = Math.max(100, Math.floor(Number(options.retryDelayMs) || 300));
  while (true) {
    throwIfStopped();
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (!isRetryableContentScriptTransportError(error)) {
        throw error;
      }
      await sleepWithStop(retryDelayMs);
    }
  }
}

function queueCommand(source, message, timeout = 15000) {
  return tabRuntime.queueCommand(source, message, timeout);
}

function flushCommand(source, tabId) {
  return tabRuntime.flushCommand(source, tabId);
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  return tabRuntime.cancelPendingCommands(reason);
}

// ============================================================
// Reuse or create tab
// ============================================================

async function reuseOrCreateTab(source, url, options = {}) {
  return tabRuntime.reuseOrCreateTab(source, url, options);
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message, options = {}) {
  return tabRuntime.sendToContentScript(source, message, options);
}

async function sendToContentScriptResilient(source, message, options = {}) {
  return tabRuntime.sendToContentScriptResilient(source, message, options);
}

async function sendToMailContentScriptResilient(mail, message, options = {}) {
  return tabRuntime.sendToMailContentScriptResilient(mail, message, options);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info', options = {}) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.addLog) {
    return loggingStatus.addLog(message, level, options);
  }
  const state = await getState();
  const logs = state.logs || [];
  const step = Math.floor(Number(options?.step) || 0);
  const entry = {
    message: String(message || ''),
    level,
    timestamp: Date.now(),
    step: step > 0 ? step : null,
    stepKey: String(options?.stepKey || '').trim(),
  };
  logs.push(entry);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => { });
}

function sanitizeK12WorkspaceLogMessage(message = '') {
  return String(message || '')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[access_token]')
    .replace(/((?:access|refresh|id)_?token|authorization|password|client_?secret|api_?key)\s*[:=]\s*["']?[^,\s"'，。;；]+/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[redacted]')
    .slice(0, 800);
}

async function addK12WorkspaceLog(message, level = 'info', options = {}) {
  const timestamp = Date.now();
  const entry = {
    id: `${timestamp}-${Math.random().toString(16).slice(2)}`,
    message: sanitizeK12WorkspaceLogMessage(message),
    level: String(level || 'info').toLowerCase(),
    timestamp,
    phase: String(options?.phase || '').trim(),
    email: String(options?.email || '').trim(),
  };
  const state = await getState();
  const logs = Array.isArray(state?.k12WorkspaceLogs) ? state.k12WorkspaceLogs.slice() : [];
  logs.push(entry);
  if (logs.length > 300) logs.splice(0, logs.length - 300);
  await setState({ k12WorkspaceLogs: logs });
  broadcastDataUpdate({ k12WorkspaceLogs: logs });
  return entry;
}

function getStep8CallbackUrlFromNavigation(details, signupTabId) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.getStep8CallbackUrlFromNavigation) {
    return navigationUtils.getStep8CallbackUrlFromNavigation(details, signupTabId);
  }
  if (!Number.isInteger(signupTabId) || !details) return '';
  if (details.tabId !== signupTabId) return '';
  if (details.frameId !== 0) return '';
  return isLocalhostOAuthCallbackUrl(details.url) ? details.url : '';
}

function getStep8CallbackUrlFromTabUpdate(tabId, changeInfo, tab, signupTabId) {
  if (typeof navigationUtils !== 'undefined' && navigationUtils?.getStep8CallbackUrlFromTabUpdate) {
    return navigationUtils.getStep8CallbackUrlFromTabUpdate(tabId, changeInfo, tab, signupTabId);
  }
  if (!Number.isInteger(signupTabId) || tabId !== signupTabId) return '';
  const candidates = [changeInfo?.url, tab?.url];
  for (const candidate of candidates) {
    if (isLocalhostOAuthCallbackUrl(candidate)) return candidate;
  }
  return '';
}

function getSourceLabel(source) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.getSourceLabel) {
    return loggingStatus.getSourceLabel(source);
  }
  const labels = {
    'openai-auth': '认证页',
    'gmail-mail': 'Gmail 邮箱',
    'sidepanel': '侧边栏',
    'signup-page': '认证页',
    'vps-panel': 'CPA 面板',
    'sub2api-panel': 'SUB2API 后台',
    'codex2api-panel': 'Codex2API 后台',
    'qq-mail': 'QQ 邮箱',
    'mail-163': '163 邮箱',
    'mail-2925': '2925 邮箱',
    'inbucket-mail': 'Inbucket 邮箱',
    'duck-mail': 'Duck 邮箱',
    'hotmail-api': 'Hotmail（API对接/本地助手）',
    'luckmail-api': 'LuckMail（API 购邮）',
    'cloudflare-temp-email': 'Cloudflare Temp Email',
    'cloudmail': 'Cloud Mail',
    'plus-checkout': 'Plus Checkout',
    'unknown-source': '未知来源',
  };
  return labels[source] || source || '未知来源';
}

// ============================================================
// Step Status Management
// ============================================================

async function setNodeStatus(nodeId, status) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('setNodeStatus 缺少 nodeId。');
  }
  const state = await getState();
  const nodeStatuses = { ...(state.nodeStatuses || {}) };
  nodeStatuses[normalizedNodeId] = status;
  await setState({
    nodeStatuses,
    currentNodeId: normalizedNodeId,
  });
  chrome.runtime.sendMessage({
    type: 'NODE_STATUS_CHANGED',
    payload: { nodeId: normalizedNodeId, status },
  }).catch(() => { });
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isRetryableContentScriptTransportError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /back\/forward cache|message channel is closed|Receiving end does not exist|port closed before a response was received|A listener indicated an asynchronous response|内容脚本\s+\d+(?:\.\d+)?\s*秒内未响应|did not respond in \d+s|failed to fetch|networkerror|network error|fetch failed|load failed/i.test(message);
}

function isStepFetchNetworkRetryableError(error) {
  const message = String(getErrorMessage(error) || '').toLowerCase();
  return /failed to fetch|networkerror|network error|fetch failed|load failed|net::err_/i.test(message);
}

function getStepFetchNetworkRetryPolicy(step) {
  if (typeof STEP_FETCH_NETWORK_RETRY_POLICIES === 'undefined' || !(STEP_FETCH_NETWORK_RETRY_POLICIES instanceof Map)) {
    return null;
  }

  const policy = STEP_FETCH_NETWORK_RETRY_POLICIES.get(Number(step));
  if (!policy) {
    return null;
  }

  return {
    maxAttempts: Math.max(1, Math.floor(Number(policy.maxAttempts) || 1)),
    cooldownMs: Math.max(0, Math.floor(Number(policy.cooldownMs) || 0)),
  };
}

const sourceRegistry = self.MultiPageSourceRegistry?.createSourceRegistry?.() || null;
const flowCapabilityRegistry = self.MultiPageFlowCapabilities?.createFlowCapabilityRegistry?.({
  defaultFlowId: DEFAULT_ACTIVE_FLOW_ID,
}) || null;
const workflowEngine = self.MultiPageBackgroundWorkflowEngine?.createWorkflowEngine?.({
  defaultFlowId: DEFAULT_ACTIVE_FLOW_ID,
  workflowDefinitions: self.MultiPageStepDefinitions,
}) || null;

const navigationUtils = self.MultiPageBackgroundNavigationUtils?.createNavigationUtils({
  DEFAULT_CODEX2API_URL,
  DEFAULT_SUB2API_URL,
  normalizeLocalCpaStep9Mode,
  sourceRegistry,
});

const loggingStatus = self.MultiPageBackgroundLoggingStatus?.createLoggingStatus({
  chrome,
  DEFAULT_STATE,
  getStepDefinitionForState,
  getStepIdByNodeIdForState,
  getState,
  isRecoverableStep9AuthFailure,
  LOG_PREFIX,
  setState,
  sourceRegistry,
  STOP_ERROR_MESSAGE,
});

const tabRuntime = self.MultiPageBackgroundTabRuntime?.createTabRuntime({
  addLog,
  chrome,
  getSourceLabel,
  getState,
  isLocalhostOAuthCallbackUrl,
  isRetryableContentScriptTransportError,
  LOG_PREFIX,
  matchesSourceUrlFamily,
  sourceRegistry,
  setState,
  sleepWithStop,
  STOP_ERROR_MESSAGE,
  throwIfStopped,
});

function getErrorMessage(error) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.getErrorMessage) {
    return loggingStatus.getErrorMessage(error);
  }
  return String(typeof error === 'string' ? error : error?.message || '')
    .replace(/^ICLOUD_API_AUTH_FAILED::/i, '')
    .replace(/^AUTO_RUN_STEP_IDLE_RESTART::/i, '');
}

function isIcloudApiAuthFailureError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return Boolean(error?.icloudApiAuthFailed)
    || /^ICLOUD_API_AUTH_FAILED::/i.test(message)
    || /iCloud API 鉴权失败|淘宝版查询码\/接口凭证不可用|Authentication failed/i.test(message);
}

function createExternalRedeemQualifiedFailureError(message = '', details = {}) {
  const reason = String(message || 'AC 或外部兑换未成功，当前邮箱不可继续使用。').trim();
  const error = new Error(`${EXTERNAL_REDEEM_QUALIFIED_FAILURE_ERROR_PREFIX}${reason}`);
  error.externalRedeemQualifiedFailure = true;
  error.email = String(details?.email || '').trim().toLowerCase();
  error.redeemResult = details?.redeemResult || null;
  return error;
}

function isExternalRedeemQualifiedFailureError(error) {
  const message = getErrorMessage(error);
  return Boolean(error?.externalRedeemQualifiedFailure)
    || message.startsWith(EXTERNAL_REDEEM_QUALIFIED_FAILURE_ERROR_PREFIX);
}

function getExternalRedeemQualifiedFailureMessage(error) {
  const message = getErrorMessage(error);
  if (message.startsWith(EXTERNAL_REDEEM_QUALIFIED_FAILURE_ERROR_PREFIX)) {
    return message.slice(EXTERNAL_REDEEM_QUALIFIED_FAILURE_ERROR_PREFIX.length).trim()
      || 'AC 或外部兑换未成功，当前邮箱不可继续使用。';
  }
  return message || 'AC 或外部兑换未成功，当前邮箱不可继续使用。';
}

function isCloudflareSecurityBlockedError(error) {
  return getErrorMessage(error).startsWith(CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX);
}

function isTerminalSecurityBlockedError(error) {
  return isCloudflareSecurityBlockedError(error);
}

function getCloudflareSecurityBlockedMessage(error) {
  const message = getErrorMessage(error);
  if (message.startsWith(CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX)) {
    return message.slice(CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX.length).trim() || CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE;
  }
  return CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE;
}

function getTerminalSecurityBlockedMessage(error) {
  return getCloudflareSecurityBlockedMessage(error);
}

function getTerminalSecurityBlockedAlertText(error) {
  return '检测到 Cloudflare 风控，请暂停当前操作。';
}

function getTerminalSecurityBlockedTitle(error) {
  return 'Cloudflare 风控拦截';
}

function isBrowserSwitchRequiredError(error) {
  return getErrorMessage(error).startsWith(BROWSER_SWITCH_REQUIRED_ERROR_PREFIX);
}

function getBrowserSwitchRequiredMessage(error) {
  const message = getErrorMessage(error);
  return message.startsWith(BROWSER_SWITCH_REQUIRED_ERROR_PREFIX)
    ? message.slice(BROWSER_SWITCH_REQUIRED_ERROR_PREFIX.length).trim()
    : message;
}

function broadcastSecurityBlockedAlert(title = '流程已完全停止', message = CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE, alertText = '检测到 Cloudflare 风控，请暂停当前操作。') {
  chrome.runtime.sendMessage({
    type: 'SECURITY_BLOCKED_ALERT',
    payload: {
      title,
      message,
      alert: {
        text: alertText,
        tone: 'danger',
      },
    },
  }).catch(() => { });
}

async function handleCloudflareSecurityBlocked(error) {
  const title = getTerminalSecurityBlockedTitle(error);
  const message = getTerminalSecurityBlockedMessage(error);
  const alertText = getTerminalSecurityBlockedAlertText(error);
  await requestStop({ logMessage: message });
  broadcastSecurityBlockedAlert(title, message, alertText);
  return message;
}

async function handleBrowserSwitchRequired(error) {
  const message = getBrowserSwitchRequiredMessage(error)
    || '检测到第 10 步的特殊冲突状态，请更换浏览器后重新进行注册登录。';
  await requestStop({ logMessage: message });
  return message;
}

function isVerificationMailPollingError(error) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.isVerificationMailPollingError) {
    return loggingStatus.isVerificationMailPollingError(error);
  }
  const message = getErrorMessage(error);
  if (/^AUTH_HTTP_500_RELOGIN_CURRENT_ACCOUNT::/i.test(message)) {
    return false;
  }
  return /未在 .*邮箱中找到新的匹配邮件|未在 Hotmail 收件箱中找到新的匹配验证码|邮箱轮询结束，但未获取到验证码|无法获取新的(?:注册|登录)验证码|页面未能重新就绪|页面通信异常|did not respond in \d+s/i.test(message);
}

function isAddPhoneAuthFailure(error) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.isAddPhoneAuthFailure) {
    return loggingStatus.isAddPhoneAuthFailure(error);
  }
  const message = getErrorMessage(error);
  if (/\u624b\u673a\u53f7\u8f93\u5165\u6a21\u5f0f|phone\s+entry/i.test(message)) {
    return false;
  }
  return /https:\/\/auth\.openai\.com\/add-phone(?:[/?#]|$)|\badd-phone\b|\u6dfb\u52a0\u624b\u673a\u53f7|\u624b\u673a\u53f7\u7801|\u8fdb\u5165\u624b\u673a\u53f7\u9875\u9762|\u624b\u673a\u53f7\u9875|\u624b\u673a\u53f7\u9875\u9762|phone\s+number|telephone/i.test(message);
}

function getLoginAuthStateLabel(state) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.getLoginAuthStateLabel) {
    return loggingStatus.getLoginAuthStateLabel(state);
  }
  switch (state) {
    case 'verification_page': return '登录验证码页';
    case 'phone_verification_page': return '手机验证码页';
    case 'password_page': return '密码页';
    case 'email_page': return '邮箱输入页';
    case 'phone_entry_page': return '手机号输入页';
    case 'login_timeout_error_page': return '登录超时报错页';
    case 'oauth_consent_page': return 'OAuth 授权页';
    case 'add_phone_page': return '手机号页';
    case 'add_email_page': return '添加邮箱页';
    default: return '未知页面';
  }
}

function isRestartCurrentAttemptError(error) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.isRestartCurrentAttemptError) {
    return loggingStatus.isRestartCurrentAttemptError(error);
  }
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /当前邮箱已存在，需要重新开始新一轮|SIGNUP_PHONE_PASSWORD_MISMATCH::/i.test(message);
}

function isSignupPhonePasswordMismatchFailure(error) {
  const message = getErrorMessage(error);
  return /SIGNUP_PHONE_PASSWORD_MISMATCH::/i.test(message);
}

function getSignupPhonePasswordMismatchRestartPayload(preservedState = {}) {
  const preservedEmail = String(preservedState.email || '').trim();
  const preservedPassword = String(preservedState.password || '').trim();
  const accountIdentifierType = String(preservedState.accountIdentifierType || '').trim().toLowerCase();
  const activeSignupPhoneNumber = String(
    preservedState.signupPhoneNumber
    || preservedState.signupPhoneActivation?.phoneNumber
    || preservedState.signupPhoneCompletedActivation?.phoneNumber
    || (accountIdentifierType === 'phone' ? preservedState.accountIdentifier : '')
    || ''
  ).trim();
  const shouldClearSignupPhoneRuntime = Boolean(
    activeSignupPhoneNumber
    || preservedState.signupPhoneActivation
    || preservedState.signupPhoneCompletedActivation
    || preservedState.signupPhoneVerificationRequestedAt
    || preservedState.signupPhoneVerificationPurpose
    || accountIdentifierType === 'phone'
  );
  const restorePayload = {};
  if (preservedEmail) restorePayload.email = preservedEmail;
  if (preservedPassword) restorePayload.password = preservedPassword;
  if (shouldClearSignupPhoneRuntime) {
    restorePayload.signupPhoneNumber = '';
    restorePayload.signupPhoneActivation = null;
    restorePayload.signupPhoneCompletedActivation = null;
    restorePayload.signupPhoneVerificationRequestedAt = null;
    restorePayload.signupPhoneVerificationPurpose = '';
    if (accountIdentifierType === 'phone') {
      restorePayload.accountIdentifierType = null;
      restorePayload.accountIdentifier = '';
    }
  }
  return {
    activeSignupPhoneNumber,
    preservedEmail,
    restorePayload,
    shouldClearSignupPhoneRuntime,
  };
}

async function restartSignupPhonePasswordMismatchAttemptFromNode(nodeId, restartCount, error) {
  const preservedState = await getState();
  const {
    activeSignupPhoneNumber,
    preservedEmail,
    restorePayload,
    shouldClearSignupPhoneRuntime,
  } = getSignupPhonePasswordMismatchRestartPayload(preservedState);
  const emailSuffix = preservedEmail ? `当前邮箱：${preservedEmail}；` : '';
  const phoneSuffix = activeSignupPhoneNumber ? `当前手机号：${activeSignupPhoneNumber}；` : '';
  const errorMessage = getErrorMessage(error);
  const reasonLabel = /PHONE_RESEND_BANNED_NUMBER::|无法向此(?:电话|手机)号码发送短信|无法发送短信到此(?:电话|手机)号码|unable\s+to\s+send\s+(?:an?\s+)?(?:sms|text(?:\s+message)?)\s+to\s+(?:this|that)\s+(?:phone\s+)?number/i
    .test(errorMessage)
    ? '当前注册手机号无法接收短信'
    : (/与此(?:电话|手机)号码相关联的帐户已存在|account\s+associated\s+with\s+this\s+phone\s+number\s+already\s+exists/i
      .test(errorMessage)
      ? '注册手机号异常'
      : '手机号/密码不匹配');
  const normalizedNodeId = String(nodeId || '').trim() || 'fetch-signup-code';
  await addLog(
    `节点 ${normalizedNodeId}：检测到${reasonLabel}，准备丢弃当前注册手机号并回到节点 open-chatgpt 重新开始（第 ${restartCount} 次重开）。${phoneSuffix}${emailSuffix}原因：${errorMessage}`,
    'warn'
  );
  if (typeof invalidateDownstreamAfterNodeRestart === 'function') {
    await invalidateDownstreamAfterNodeRestart('open-chatgpt', {
      logLabel: `节点 ${normalizedNodeId} 检测到${reasonLabel}后准备回到 open-chatgpt 重新获取手机号重试（第 ${restartCount} 次重开）`,
    });
  } else {
    await invalidateDownstreamAfterStepRestart(1, {
      logLabel: `节点 ${normalizedNodeId} 检测到${reasonLabel}后准备回到 open-chatgpt 重新获取手机号重试（第 ${restartCount} 次重开）`,
    });
  }
  if (shouldClearSignupPhoneRuntime) {
    await addLog(`节点 ${normalizedNodeId}：已清空本轮注册手机号与接码订单，下一次重开将重新获取号码。`, 'warn');
  }
  if (Object.keys(restorePayload).length) {
    await setState(restorePayload);
  }
}

function isSignupUserAlreadyExistsFailure(error) {
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.isSignupUserAlreadyExistsFailure) {
    return loggingStatus.isSignupUserAlreadyExistsFailure(error);
  }
  const message = getErrorMessage(error);
  return /SIGNUP_USER_ALREADY_EXISTS::|user_already_exists/i.test(message);
}

function isStep4Route405RecoveryLimitFailure(error) {
  const message = getErrorMessage(error);
  return /STEP4_405_RECOVERY_LIMIT::|步骤\s*4：检测到\s*405\s*错误页面，已连续点击“重试”恢复/i.test(message);
}

function isPhoneSmsPlatformRateLimitFailure(error) {
  const message = getErrorMessage(error);
  return /FIVE_SIM_RATE_LIMIT::|5sim[\s\S]*(?:限流|rate\s*limit)/i.test(message);
}

function isPlusCheckoutNonFreeTrialFailure(error) {
  const message = getErrorMessage(error);
  return /PLUS_CHECKOUT_NON_FREE_TRIAL::|今日应付金额不是\s*0|没有免费试用资格|该账号已经开通过\s*ChatGPT\s*订阅套餐，不能重复订阅(?:。)?(?:（\s*checkout_order\s*）|\(\s*checkout_order\s*\))?/i.test(message);
}

function isPlusCheckoutRestartStep(step, stepExecutionKey = '', state = {}) {
  const normalizedKey = String(stepExecutionKey || '').trim();
  if (normalizedKey) {
    return normalizedKey === 'plus-checkout-create';
  }
  const numericStep = Number(step);
  return Boolean(state?.plusModeEnabled) && (numericStep === 6 || numericStep === 7);
}

function isPlusCheckoutRestartRequiredFailure(error) {
  return !isPlusCheckoutNonFreeTrialFailure(error);
}

function isStep9RecoverableAuthError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /STEP9_OAUTH_RETRY::/i.test(message)
    || isRecoverableStep9AuthFailure(message);
}

function isLegacyStep9RecoverableAuthError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /STEP9_OAUTH_TIMEOUT::|认证失败:\s*(?:Timeout waiting for OAuth callback|timeout of \d+ms exceeded)/i.test(message);
}

function isStepDoneStatus(status) {
  return status === 'completed' || status === 'manual_completed' || status === 'skipped';
}

function normalizeStatusMapForNodes(statuses = {}, state = {}) {
  const candidate = statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : {};
  const nodeIds = new Set(getNodeIdsForState(state));
  const hasNodeKey = Object.keys(candidate).some((key) => nodeIds.has(key));
  const hasStepKey = Object.keys(candidate).some((key) => Number.isInteger(Number(key)) && Number(key) > 0);
  if (hasNodeKey || !hasStepKey) {
    return { ...DEFAULT_STATE.nodeStatuses, ...(state.nodeStatuses || {}), ...candidate };
  }

  const projected = { ...DEFAULT_STATE.nodeStatuses, ...(state.nodeStatuses || {}) };
  for (const [step, status] of Object.entries(candidate)) {
    const nodeId = getNodeIdByStepForState(step, state);
    if (nodeId) {
      projected[nodeId] = status;
    }
  }
  return projected;
}

function getFirstUnfinishedNodeId(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  const nodeStatuses = normalizeStatusMapForNodes(statuses, state);
  const nodeIds = getNodeIdsForState(state);
  for (const nodeId of nodeIds) {
    if (!isStepDoneStatus(nodeStatuses[nodeId] || 'pending')) {
      return nodeId;
    }
  }
  return '';
}

function getFirstUnfinishedStep(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  const firstNodeId = getFirstUnfinishedNodeId(statuses, state);
  if (firstNodeId) {
    return getStepIdByNodeIdForState(firstNodeId, state);
  }
  return null;
}

function hasSavedNodeProgress(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  const nodeStatuses = normalizeStatusMapForNodes(statuses, state);
  const merged = { ...DEFAULT_STATE.nodeStatuses, ...nodeStatuses };
  return getNodeIdsForState(state).some((nodeId) => (merged[nodeId] || 'pending') !== 'pending');
}

function hasSavedProgress(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  return hasSavedNodeProgress(statuses, state);
}

function getDownstreamStateResets(step, state = {}) {
  const stepKey = getStepExecutionKeyForState(step, state);
  const plusRuntimeResets = {
    plusCheckoutTabId: null,
    plusCheckoutUrl: null,
    plusCheckoutCountry: 'DE',
    plusCheckoutCurrency: 'EUR',
    plusCheckoutSource: '',
    plusBillingCountryText: '',
    plusBillingAddress: null,
    plusReturnUrl: '',
    plusManualConfirmationPending: false,
    plusManualConfirmationRequestId: '',
    plusManualConfirmationStep: 0,
    plusManualConfirmationMethod: '',
    plusManualConfirmationTitle: '',
    plusManualConfirmationMessage: '',
  };

  if (step <= 1) {
    return {
      ...plusRuntimeResets,
      oauthUrl: null,
      localCpaJsonOAuthState: null,
      localCpaJsonPkceCodes: null,
      cpaOAuthState: null,
      cpaManagementOrigin: null,
      sub2apiSessionId: null,
      sub2apiOAuthState: null,
      sub2apiGroupId: null,
      sub2apiGroupIds: [],
      sub2apiDraftName: null,
      sub2apiProxyId: null,
      codex2apiSessionId: null,
      codex2apiOAuthState: null,
      flowStartTime: null,
      password: null,
      lastEmailTimestamp: null,
      signupVerificationRequestedAt: null,
      loginVerificationRequestedAt: null,
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
      pendingPhoneActivationConfirmation: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (step === 2) {
    return {
      ...plusRuntimeResets,
      password: null,
      lastEmailTimestamp: null,
      signupVerificationRequestedAt: null,
      loginVerificationRequestedAt: null,
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
      pendingPhoneActivationConfirmation: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (step === 3 || step === 4) {
    return {
      ...plusRuntimeResets,
      lastEmailTimestamp: null,
      signupVerificationRequestedAt: null,
      loginVerificationRequestedAt: null,
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
      pendingPhoneActivationConfirmation: null,
      lastSignupCode: null,
      lastLoginCode: null,
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (step === 5 || step === 6 || step === 7 || step === 8) {
    return {
      ...(step <= 6 ? plusRuntimeResets : {}),
      ...(step === 7 ? {
        plusBillingCountryText: '',
        plusBillingAddress: null,
        plusReturnUrl: '',
        plusManualConfirmationPending: false,
        plusManualConfirmationRequestId: '',
        plusManualConfirmationStep: 0,
        plusManualConfirmationMethod: '',
        plusManualConfirmationTitle: '',
        plusManualConfirmationMessage: '',
      } : {}),
      ...(step === 8 ? {
        plusReturnUrl: '',
      } : {}),
      lastLoginCode: null,
      loginVerificationRequestedAt: null,
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
      pendingPhoneActivationConfirmation: null,
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (step === 9) {
    return {
      pendingPhoneActivationConfirmation: null,
      plusReturnUrl: '',
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (
    stepKey === 'oauth-login'
    || stepKey === 'fetch-login-code'
    || stepKey === 'relogin-bound-email'
    || stepKey === 'fetch-bound-email-login-code'
  ) {
    return {
      lastLoginCode: null,
      loginVerificationRequestedAt: null,
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
      pendingPhoneActivationConfirmation: null,
      localhostUrl: null,
      currentPhoneVerificationCode: '',
      currentPhoneVerificationCountdownEndsAt: 0,
      currentPhoneVerificationCountdownWindowIndex: 0,
      currentPhoneVerificationCountdownWindowTotal: 0,
    };
  }
  if (stepKey === 'confirm-oauth') {
    return {
      pendingPhoneActivationConfirmation: null,
      localhostUrl: null,
    };
  }
  return {};
}

async function invalidateDownstreamAfterStepRestart(step, options = {}) {
  const { logLabel = `步骤 ${step} 重新执行` } = options;
  const state = await getState();
  const nodeStatuses = { ...(state.nodeStatuses || {}) };
  const changedNodes = [];
  const activeNodeIds = getNodeIdsForState(state);
  const currentNodeId = getNodeIdByStepForState(step, state);
  const currentIndex = activeNodeIds.indexOf(currentNodeId);

  if (currentIndex >= 0) {
    for (let index = currentIndex + 1; index < activeNodeIds.length; index += 1) {
      const downstreamNodeId = activeNodeIds[index];
      if (nodeStatuses[downstreamNodeId] === 'pending') {
        continue;
      }
      nodeStatuses[downstreamNodeId] = 'pending';
      changedNodes.push(downstreamNodeId);
    }
  }

  if (changedNodes.length) {
    await setState({ nodeStatuses });
    for (const nodeId of changedNodes) {
      chrome.runtime.sendMessage({
        type: 'NODE_STATUS_CHANGED',
        payload: { nodeId, status: 'pending' },
      }).catch(() => { });
    }
    await addLog(`${logLabel}，已重置后续节点状态：${changedNodes.join(', ')}`, 'warn');
  }

  const resets = getDownstreamStateResets(step, state);
  if (Object.keys(resets).length) {
    await setState(resets);
    broadcastDataUpdate(resets);
  }
}

async function invalidateDownstreamAfterNodeRestart(nodeId, options = {}) {
  const state = await getState();
  const step = getStepIdByNodeIdForState(nodeId, state);
  if (Number.isInteger(step) && step > 0) {
    return invalidateDownstreamAfterStepRestart(step, options);
  }

  const normalizedNodeId = String(nodeId || '').trim();
  const logLabel = options.logLabel || `节点 ${normalizedNodeId} 重新执行`;
  const nodeStatuses = { ...(state.nodeStatuses || {}) };
  const activeNodeIds = getNodeIdsForState(state);
  const currentIndex = activeNodeIds.indexOf(normalizedNodeId);
  const changedNodes = [];
  if (currentIndex >= 0) {
    for (let index = currentIndex + 1; index < activeNodeIds.length; index += 1) {
      const downstreamNodeId = activeNodeIds[index];
      if (nodeStatuses[downstreamNodeId] === 'pending') {
        continue;
      }
      nodeStatuses[downstreamNodeId] = 'pending';
      changedNodes.push(downstreamNodeId);
    }
  }
  if (changedNodes.length) {
    await setState({ nodeStatuses });
    for (const changedNodeId of changedNodes) {
      chrome.runtime.sendMessage({
        type: 'NODE_STATUS_CHANGED',
        payload: { nodeId: changedNodeId, status: 'pending' },
      }).catch(() => { });
    }
    await addLog(`${logLabel}，已重置后续节点状态：${changedNodes.join(', ')}`, 'warn');
  }
}

function clearStopRequest() {
  stopRequested = false;
}

function getRunningNodeIds(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  const nodeStatuses = normalizeStatusMapForNodes(statuses, state);
  const merged = { ...DEFAULT_STATE.nodeStatuses, ...nodeStatuses };
  return getNodeIdsForState(state).filter((nodeId) => merged[nodeId] === 'running');
}

function getRunningSteps(statuses = {}, stateOverride = null) {
  const state = stateOverride || {};
  return getRunningNodeIds(statuses, state)
    .map((nodeId) => getStepIdByNodeIdForState(nodeId, state))
    .filter((step) => Number.isInteger(step) && step > 0)
    .sort((a, b) => a - b);
}

function inferStoppedRecordNode(state = {}) {
  const nodeStatuses = normalizeStatusMapForNodes(state?.nodeStatuses || {}, state);
  const nodeIds = getNodeIdsForState(state);
  const runningNode = nodeIds.find((nodeId) => nodeStatuses[nodeId] === 'running');
  if (runningNode) {
    return runningNode;
  }

  const currentNodeId = String(state?.currentNodeId || '').trim();
  if (currentNodeId && nodeIds.includes(currentNodeId)) {
    const currentStatus = String(nodeStatuses[currentNodeId] || '').trim();
    if (!isStepDoneStatus(currentStatus)) {
      return currentNodeId;
    }
  }

  const hasProgress = nodeIds.some((nodeId) => String(nodeStatuses[nodeId] || 'pending') !== 'pending');
  if (!hasProgress) {
    return '';
  }

  return nodeIds.find((nodeId) => !isStepDoneStatus(nodeStatuses[nodeId] || 'pending')) || '';
}

function inferStoppedRecordStep(state = {}) {
  const nodeId = inferStoppedRecordNode(state);
  return nodeId ? getStepIdByNodeIdForState(nodeId, state) : null;
}

function resolveAccountRunRecordStatusForStop(status, state = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'stopped') {
    const inferredNodeId = inferStoppedRecordNode(state);
    if (inferredNodeId) {
      return `node:${inferredNodeId}:stopped`;
    }
  }
  return status;
}

function extractStoppedNodeFromRecordStatus(status = '') {
  const match = String(status || '').trim().match(/^node:([^:]+):stopped$/i);
  return match ? String(match[1] || '').trim() : '';
}

function extractStoppedStepFromRecordStatus(status = '') {
  const match = String(status || '').trim().toLowerCase().match(/^step(\d+)_stopped$/);
  if (!match) {
    return null;
  }
  const step = Number(match[1]);
  return Number.isInteger(step) && step > 0 ? step : null;
}

function resolveAccountRunRecordReasonForStop(status, reason = '') {
  const text = String(reason || '').trim();
  const stoppedNodeId = extractStoppedNodeFromRecordStatus(status);
  if (stoppedNodeId) {
    if (!text || text === STOP_ERROR_MESSAGE || /^流程已被用户停止。?$/.test(text)) {
      return `节点 ${stoppedNodeId} 已被用户停止。`;
    }
    if (/流程尚未完成/.test(text) || /已使用(?:邮箱|手机号)/.test(text)) {
      return text.replace(/^步骤\s*\d+/, `节点 ${stoppedNodeId}`);
    }
    return text;
  }

  const stoppedStep = extractStoppedStepFromRecordStatus(status);

  if (!stoppedStep) {
    if (!text || text === STOP_ERROR_MESSAGE || /^流程已被用户停止。?$/.test(text)) {
      return '流程已停止。';
    }
    return text;
  }

  if (!text || text === STOP_ERROR_MESSAGE || /^流程已被用户停止。?$/.test(text)) {
    return `步骤 ${stoppedStep} 已被用户停止。`;
  }

  if (/流程尚未完成/.test(text) || /已使用邮箱/.test(text)) {
    return `步骤 ${stoppedStep} 已停止：邮箱已设置，流程尚未完成。`;
  }

  if (/步骤\s*\d+\s*已(?:被用户)?停止/.test(text)) {
    return text.replace(/步骤\s*\d+/, `步骤 ${stoppedStep}`);
  }

  return text;
}

function getAutoRunStatusPayload(phase, payload = {}) {
  const normalizedPayload = {
    ...payload,
    currentRun: payload.currentRun ?? autoRunCurrentRun,
    totalRuns: payload.totalRuns ?? autoRunTotalRuns,
    attemptRun: payload.attemptRun ?? autoRunAttemptRun,
    sessionId: payload.sessionId ?? payload.autoRunSessionId ?? autoRunSessionId,
  };
  if (typeof loggingStatus !== 'undefined' && loggingStatus?.getAutoRunStatusPayload) {
    return loggingStatus.getAutoRunStatusPayload(phase, normalizedPayload);
  }
  return {
    autoRunning: phase === 'scheduled'
      || phase === 'running'
      || phase === 'waiting_step'
      || phase === 'waiting_email'
      || phase === 'retrying'
      || phase === 'waiting_interval',
    autoRunPhase: phase,
    autoRunCurrentRun: normalizedPayload.currentRun ?? 0,
    autoRunTotalRuns: normalizedPayload.totalRuns ?? 1,
    autoRunAttemptRun: normalizedPayload.attemptRun ?? 0,
    autoRunSessionId: normalizeAutoRunSessionId(normalizedPayload.sessionId),
    scheduledAutoRunAt: Number.isFinite(Number(normalizedPayload.scheduledAt)) ? Number(normalizedPayload.scheduledAt) : null,
    autoRunCountdownAt: Number.isFinite(Number(normalizedPayload.countdownAt)) ? Number(normalizedPayload.countdownAt) : null,
    autoRunCountdownTitle: normalizedPayload.countdownTitle === undefined ? '' : String(normalizedPayload.countdownTitle || ''),
    autoRunCountdownNote: normalizedPayload.countdownNote === undefined ? '' : String(normalizedPayload.countdownNote || ''),
  };
}

async function broadcastAutoRunStatus(phase, payload = {}, extraState = {}) {
  const rawScheduledAt = phase === 'scheduled'
    ? (payload.scheduledAt ?? payload.scheduledAutoRunAt ?? null)
    : null;
  const rawCountdownAt = payload.countdownAt ?? payload.autoRunCountdownAt ?? null;
  const statusPayload = {
    phase,
    currentRun: payload.currentRun ?? autoRunCurrentRun,
    totalRuns: payload.totalRuns ?? autoRunTotalRuns,
    attemptRun: payload.attemptRun ?? autoRunAttemptRun,
    sessionId: payload.sessionId ?? payload.autoRunSessionId ?? autoRunSessionId,
    scheduledAt: rawScheduledAt === null ? null : Number(rawScheduledAt),
    countdownAt: rawCountdownAt === null ? null : Number(rawCountdownAt),
    countdownTitle: payload.countdownTitle === undefined ? '' : String(payload.countdownTitle || ''),
    countdownNote: payload.countdownNote === undefined ? '' : String(payload.countdownNote || ''),
  };

  await setState({
    ...extraState,
    ...getAutoRunStatusPayload(phase, statusPayload),
  });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: statusPayload,
  }).catch(() => { });
}

function isAutoRunLockedState(state) {
  return Boolean(state.autoRunning)
    && (
      state.autoRunPhase === 'running'
      || state.autoRunPhase === 'waiting_step'
      || state.autoRunPhase === 'retrying'
      || state.autoRunPhase === 'waiting_interval'
    );
}

function isAutoRunPausedState(state) {
  return Boolean(state.autoRunning) && state.autoRunPhase === 'waiting_email';
}

function isAutoRunScheduledState(state) {
  const plan = normalizeAutoRunTimerPlanFromState(state);
  const scheduledAt = state.scheduledAutoRunAt === null ? null : Number(state.scheduledAutoRunAt);
  return Boolean(state.autoRunning)
    && state.autoRunPhase === 'scheduled'
    && Number.isFinite(scheduledAt)
    && plan?.kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START;
}

function getPendingAutoRunTimerPlan(state = {}) {
  return normalizeAutoRunTimerPlanFromState(state);
}

function formatAutoRunScheduleTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: DISPLAY_TIMEZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function setAutoRunDelayEnabledState(enabled) {
  const normalized = Boolean(enabled);
  await setPersistentSettings({ autoRunDelayEnabled: normalized });
  await setState({ autoRunDelayEnabled: normalized });
  broadcastDataUpdate({ autoRunDelayEnabled: normalized });
}

async function ensureAutoRunTimerAlarm(fireAt) {
  if (!Number.isFinite(fireAt) || fireAt <= Date.now()) {
    return false;
  }

  const existingAlarm = await chrome.alarms.get(AUTO_RUN_TIMER_ALARM_NAME);
  if (!existingAlarm || Math.abs((existingAlarm.scheduledTime || 0) - fireAt) > 1000) {
    await chrome.alarms.clear(AUTO_RUN_TIMER_ALARM_NAME);
    await chrome.alarms.create(AUTO_RUN_TIMER_ALARM_NAME, { when: fireAt });
  }

  return true;
}

async function clearAutoRunTimerAlarm() {
  await chrome.alarms.clear(AUTO_RUN_TIMER_ALARM_NAME);
}

async function persistAutoRunTimerPlan(plan, extraState = {}) {
  const normalizedPlan = normalizeAutoRunTimerPlan(plan);
  if (!normalizedPlan) {
    throw new Error('自动运行计时计划无效。');
  }

  const statusPayload = getAutoRunTimerStatusPayload(normalizedPlan);
  await broadcastAutoRunStatus(
    statusPayload.phase,
    statusPayload,
    {
      ...extraState,
      autoRunTimerPlan: normalizedPlan,
      scheduledAutoRunPlan: null,
    }
  );
  await ensureAutoRunTimerAlarm(normalizedPlan.fireAt);
  return normalizedPlan;
}

function getAutoRunTimerResumeOptions(plan) {
  const normalizedPlan = normalizeAutoRunTimerPlan(plan);
  if (!normalizedPlan) {
    return null;
  }

  if (normalizedPlan.kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START) {
    return {
      loopOptions: {
        autoRunSessionId: normalizedPlan.autoRunSessionId,
        autoRunSkipFailures: normalizedPlan.autoRunSkipFailures,
        mode: normalizedPlan.mode,
      },
      statusPayload: {
        currentRun: 0,
        totalRuns: normalizedPlan.totalRuns,
        attemptRun: 0,
        sessionId: normalizedPlan.autoRunSessionId,
      },
    };
  }

  if (normalizedPlan.kind === AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS) {
    const nextRun = Math.min(normalizedPlan.currentRun + 1, normalizedPlan.totalRuns);
    return {
      loopOptions: {
        autoRunSessionId: normalizedPlan.autoRunSessionId,
        autoRunSkipFailures: normalizedPlan.autoRunSkipFailures,
        mode: 'restart',
        resumeCurrentRun: nextRun,
        resumeAttemptRun: 1,
        resumeRoundSummaries: normalizedPlan.roundSummaries,
      },
      statusPayload: {
        currentRun: nextRun,
        totalRuns: normalizedPlan.totalRuns,
        attemptRun: 1,
        sessionId: normalizedPlan.autoRunSessionId,
      },
    };
  }

  return {
    loopOptions: {
      autoRunSessionId: normalizedPlan.autoRunSessionId,
      autoRunSkipFailures: normalizedPlan.autoRunSkipFailures,
      mode: 'restart',
      resumeCurrentRun: normalizedPlan.currentRun,
      resumeAttemptRun: normalizedPlan.attemptRun,
      resumeRoundSummaries: normalizedPlan.roundSummaries,
    },
    statusPayload: {
      currentRun: normalizedPlan.currentRun,
      totalRuns: normalizedPlan.totalRuns,
      attemptRun: normalizedPlan.attemptRun,
      sessionId: normalizedPlan.autoRunSessionId,
    },
  };
}

let autoRunTimerLaunching = false;

async function launchAutoRunTimerPlan(trigger = 'alarm', options = {}) {
  const { expectedKinds = [] } = options;
  if (autoRunTimerLaunching) {
    return false;
  }

  autoRunTimerLaunching = true;
  try {
    const state = await getState();
    const plan = getPendingAutoRunTimerPlan(state);
    if (!plan) {
      return false;
    }
    if (expectedKinds.length && !expectedKinds.includes(plan.kind)) {
      return false;
    }
    if (autoRunActive) {
      return false;
    }
    if (plan.autoRunSessionId && !isCurrentAutoRunSessionId(plan.autoRunSessionId)) {
      return false;
    }

    const resumeOptions = getAutoRunTimerResumeOptions(plan);
    if (!resumeOptions) {
      await clearAutoRunTimerAlarm();
      await broadcastAutoRunStatus('idle', {
        currentRun: 0,
        totalRuns: 1,
        attemptRun: 0,
      }, {
        autoRunRoundSummaries: [],
        autoRunTimerPlan: null,
        scheduledAutoRunPlan: null,
      });
      return false;
    }

    if (plan.kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START) {
      const autoRunStartValidation = typeof validateAutoRunStartState === 'function'
        ? validateAutoRunStartState(state, { state })
        : { ok: true, errors: [] };
      if (autoRunStartValidation?.ok === false) {
        const validationMessage = autoRunStartValidation.errors?.[0]?.message || '当前设置不支持启动自动流程。';
        await clearAutoRunTimerAlarm();
        await broadcastAutoRunStatus('idle', {
          currentRun: 0,
          totalRuns: 1,
          attemptRun: 0,
        }, {
          autoRunRoundSummaries: [],
          autoRunTimerPlan: null,
          scheduledAutoRunPlan: null,
        });
        await addLog(`自动运行计划已取消：${validationMessage}`, 'error');
        if (trigger === 'manual') {
          throw new Error(validationMessage);
        }
        return false;
      }
    }

    await clearAutoRunTimerAlarm();
    if (plan.autoRunSessionId && !isCurrentAutoRunSessionId(plan.autoRunSessionId)) {
      return false;
    }
    autoRunCurrentRun = resumeOptions.statusPayload.currentRun;
    autoRunTotalRuns = plan.totalRuns;
    autoRunAttemptRun = resumeOptions.statusPayload.attemptRun;
    autoRunSessionId = normalizeAutoRunSessionId(plan.autoRunSessionId);
    if (plan.kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START && trigger !== 'manual' && state.autoRunDelayEnabled) {
      await setAutoRunDelayEnabledState(false);
    }
    await broadcastAutoRunStatus(
      'running',
      resumeOptions.statusPayload,
      {
        autoRunSkipFailures: plan.autoRunSkipFailures,
        autoRunRoundSummaries: serializeAutoRunRoundSummaries(plan.totalRuns, plan.roundSummaries),
        autoRunTimerPlan: null,
        scheduledAutoRunPlan: null,
      }
    );

    if (plan.autoRunSessionId && !isCurrentAutoRunSessionId(plan.autoRunSessionId)) {
      return false;
    }
    clearStopRequest();
    let logMessage = '倒计时结束，自动运行开始执行。';
    if (plan.kind === AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS) {
      logMessage = trigger === 'manual'
        ? '已手动跳过线程间隔，自动流程立即开始下一轮。'
        : '线程间隔结束，自动流程开始下一轮。';
    } else if (plan.kind === AUTO_RUN_TIMER_KIND_BEFORE_RETRY) {
      logMessage = trigger === 'manual'
        ? `已手动跳过线程间隔，立即开始第 ${plan.currentRun}/${plan.totalRuns} 轮第 ${plan.attemptRun} 次尝试。`
        : `线程间隔结束，开始第 ${plan.currentRun}/${plan.totalRuns} 轮第 ${plan.attemptRun} 次尝试。`;
    } else if (trigger === 'manual') {
      logMessage = '已手动跳过倒计时，自动运行立即开始。';
    }
    await addLog(logMessage, 'info');
    if (plan.autoRunSessionId && !isCurrentAutoRunSessionId(plan.autoRunSessionId)) {
      return false;
    }

    startAutoRunLoop(plan.totalRuns, resumeOptions.loopOptions);
    return true;
  } finally {
    autoRunTimerLaunching = false;
  }
}

async function scheduleAutoRun(totalRuns, options = {}) {
  const state = await getState();
  if (isAutoRunLockedState(state) || isAutoRunPausedState(state) || autoRunActive) {
    throw new Error('自动运行已在进行中，请先停止后再重新计划。');
  }
  if (getPendingAutoRunTimerPlan(state)) {
    throw new Error('已有自动运行倒计时计划，请先取消或立即开始。');
  }

  const delayMinutes = normalizeAutoRunDelayMinutes(options.delayMinutes);
  const sessionId = createAutoRunSessionId();
  const timerPlan = normalizeAutoRunTimerPlan({
    kind: AUTO_RUN_TIMER_KIND_SCHEDULED_START,
    fireAt: Date.now() + delayMinutes * 60 * 1000,
    totalRuns,
    autoRunSkipFailures: options.autoRunSkipFailures,
    autoRunSessionId: sessionId,
    mode: options.mode,
  });

  autoRunCurrentRun = 0;
  autoRunTotalRuns = timerPlan.totalRuns;
  autoRunAttemptRun = 0;
  autoRunSessionId = sessionId;

  await persistAutoRunTimerPlan(timerPlan, {
    autoRunSkipFailures: timerPlan.autoRunSkipFailures,
    autoRunRoundSummaries: serializeAutoRunRoundSummaries(timerPlan.totalRuns, []),
  });
  await addLog(
    `自动运行已计划：${delayMinutes} 分钟后启动（${formatAutoRunScheduleTime(timerPlan.fireAt)}），目标 ${timerPlan.totalRuns} 轮。`,
    'info'
  );
  return { ok: true, scheduledAt: timerPlan.fireAt };
}

async function cancelScheduledAutoRun(options = {}) {
  const state = await getState();
  const plan = getPendingAutoRunTimerPlan(state);
  if (!plan || plan.kind !== AUTO_RUN_TIMER_KIND_SCHEDULED_START) {
    return false;
  }

  autoRunCurrentRun = 0;
  autoRunTotalRuns = plan.totalRuns;
  autoRunAttemptRun = 0;
  clearCurrentAutoRunSessionId(plan.autoRunSessionId);
  await broadcastAutoRunStatus(
    'idle',
    {
      currentRun: 0,
      totalRuns: plan.totalRuns,
      attemptRun: 0,
      sessionId: 0,
    },
    {
      autoRunSessionId: 0,
      autoRunRoundSummaries: [],
      autoRunTimerPlan: null,
      scheduledAutoRunPlan: null,
    }
  );
  await clearAutoRunTimerAlarm();
  if (options.logMessage !== false) {
    await addLog(options.logMessage || '已取消自动运行倒计时计划。', 'warn');
  }
  return true;
}

async function restoreAutoRunTimerIfNeeded() {
  const state = await getState();
  let plan = getPendingAutoRunTimerPlan(state);
  if (!plan) {
    clearCurrentAutoRunSessionId();
    if (state.autoRunPhase === 'scheduled' || state.autoRunPhase === 'waiting_interval') {
      await clearAutoRunTimerAlarm();
      await broadcastAutoRunStatus('idle', {
        currentRun: 0,
        totalRuns: 1,
        attemptRun: 0,
        sessionId: 0,
      }, {
        autoRunSessionId: 0,
        autoRunRoundSummaries: [],
        autoRunTimerPlan: null,
        scheduledAutoRunPlan: null,
      });
    }
    return;
  }

  if (!plan.autoRunSessionId) {
    const restoredSessionId = createAutoRunSessionId();
    plan = await persistAutoRunTimerPlan({
      ...plan,
      autoRunSessionId: restoredSessionId,
    }, {
      autoRunSkipFailures: plan.autoRunSkipFailures,
      autoRunRoundSummaries: serializeAutoRunRoundSummaries(plan.totalRuns, plan.roundSummaries),
    });
  } else {
    setCurrentAutoRunSessionId(plan.autoRunSessionId);
  }

  if (plan.fireAt <= Date.now()) {
    await launchAutoRunTimerPlan('restore');
    return;
  }

  const statusPayload = getAutoRunTimerStatusPayload(plan);
  await broadcastAutoRunStatus(
    statusPayload.phase,
    statusPayload,
    {
      autoRunSessionId: plan.autoRunSessionId,
      autoRunSkipFailures: plan.autoRunSkipFailures,
      autoRunRoundSummaries: serializeAutoRunRoundSummaries(plan.totalRuns, plan.roundSummaries),
      autoRunTimerPlan: plan,
      scheduledAutoRunPlan: null,
    }
  );
  await ensureAutoRunTimerAlarm(plan.fireAt);
}

async function ensureManualInteractionAllowed(actionLabel) {
  const state = await getState();

  if (isAutoRunLockedState(state)) {
    throw new Error(`自动流程运行中，请先停止后再${actionLabel}。`);
  }
  if (isAutoRunPausedState(state)) {
    throw new Error(`自动流程当前已暂停。请点击“继续”，或先确认接管自动流程后再${actionLabel}。`);
  }
  if (isAutoRunScheduledState(state)) {
    throw new Error(`自动流程已计划启动。请先取消计划，或立即开始后再${actionLabel}。`);
  }

  return state;
}

async function skipNode(nodeId) {
  const state = await ensureManualInteractionAllowed('跳过步骤');
  const normalizedNodeId = String(nodeId || '').trim();
  const activeNodeIds = getNodeIdsForState(state);

  if (!normalizedNodeId || !activeNodeIds.includes(normalizedNodeId)) {
    throw new Error(`无效节点：${normalizedNodeId || nodeId}`);
  }

  const statuses = normalizeStatusMapForNodes(state.nodeStatuses || {}, state);
  const currentStatus = statuses[normalizedNodeId];
  if (currentStatus === 'running') {
    throw new Error(`节点 ${normalizedNodeId} 正在运行中，不能跳过。`);
  }
  if (isStepDoneStatus(currentStatus)) {
    throw new Error(`节点 ${normalizedNodeId} 已完成，无需再跳过。`);
  }

  const currentIndex = activeNodeIds.indexOf(normalizedNodeId);
  if (currentIndex > 0) {
    const prevNodeId = activeNodeIds[currentIndex - 1];
    const prevStatus = statuses[prevNodeId];
    if (!isStepDoneStatus(prevStatus)) {
      throw new Error(`请先完成节点 ${prevNodeId}，再跳过节点 ${normalizedNodeId}。`);
    }
  }

  await setNodeStatus(normalizedNodeId, 'skipped');
  await addLog(`节点 ${normalizedNodeId} 已跳过`, 'warn');

  if (normalizedNodeId === 'open-chatgpt') {
    const latestState = await getState();
    const skippedNodes = [];
    for (const linkedNodeId of ['submit-signup-email', 'fill-password', 'fetch-signup-code', 'fill-profile']) {
      const linkedStatus = latestState.nodeStatuses?.[linkedNodeId];
      if (!isStepDoneStatus(linkedStatus) && linkedStatus !== 'running') {
        await setNodeStatus(linkedNodeId, 'skipped');
        skippedNodes.push(linkedNodeId);
      }
    }
    if (skippedNodes.length) {
      await addLog(`节点 open-chatgpt 已跳过，节点 ${skippedNodes.join('、')} 也已同时跳过。`, 'warn');
    }
  }

  return { ok: true, nodeId: normalizedNodeId, status: 'skipped' };
}

function throwIfStopped(error = null) {
  const errorMessage = typeof error === 'string' ? error : error?.message;
  if (errorMessage === STOP_ERROR_MESSAGE) {
    throw error instanceof Error ? error : new Error(STOP_ERROR_MESSAGE);
  }
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect, options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  throwIfStopped();
  if (!tabId) {
    throw new Error('未找到用于调试点击的认证页面标签页。');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error(`步骤 ${visibleStep} 的调试器兜底点击需要有效的按钮坐标。`);
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `步骤 ${visibleStep} 的调试器兜底点击附加失败：${err.message}。` +
      '如果认证页标签已打开 DevTools，请先关闭后重试。'
    );
  }

  try {
    throwIfStopped();
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    throwIfStopped();
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    throwIfStopped();
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    throwIfStopped();
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => { });
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch { }
  }
}

let stopRequested = false;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  return messageRouter.handleMessage(message, sender);
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  if (typeof messageRouter !== 'undefined' && messageRouter?.handleStepData) {
    return messageRouter.handleStepData(step, payload);
  }

  function shouldPreservePhoneIdentityForStepEmailPayload(state = {}, stepPayload = {}) {
    if (String(stepPayload.accountIdentifierType || '').trim().toLowerCase() === 'email') {
      return false;
    }
    return Boolean(
      String(state.signupPhoneNumber || '').trim()
      || (String(state.accountIdentifierType || '').trim().toLowerCase() === 'phone'
        && String(state.accountIdentifier || '').trim())
      || state.signupPhoneActivation
      || state.signupPhoneCompletedActivation
    );
  }

  async function persistStepEmailPayload(email, stepPayload = {}, source = 'step_identity') {
    if (!email) {
      return;
    }
    const currentState = await getState();
    if (shouldPreservePhoneIdentityForStepEmailPayload(currentState, stepPayload)) {
      await persistRegistrationEmailState(currentState, email, {
        source,
        preserveAccountIdentity: true,
      });
      return;
    }
    await setEmailState(email);
  }

  switch (step) {
    case 1: {
      const updates = {};
      if (payload.oauthUrl) {
        updates.oauthUrl = payload.oauthUrl;
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl });
      }
      if (payload.localCpaJsonOAuthState !== undefined) updates.localCpaJsonOAuthState = payload.localCpaJsonOAuthState || null;
      if (payload.localCpaJsonPkceCodes !== undefined) updates.localCpaJsonPkceCodes = payload.localCpaJsonPkceCodes || null;
      if (payload.sub2apiSessionId !== undefined) updates.sub2apiSessionId = payload.sub2apiSessionId || null;
      if (payload.sub2apiOAuthState !== undefined) updates.sub2apiOAuthState = payload.sub2apiOAuthState || null;
      if (payload.sub2apiGroupId !== undefined) updates.sub2apiGroupId = payload.sub2apiGroupId || null;
      if (payload.sub2apiGroupIds !== undefined) updates.sub2apiGroupIds = Array.isArray(payload.sub2apiGroupIds)
        ? payload.sub2apiGroupIds
        : [];
      if (payload.sub2apiDraftName !== undefined) updates.sub2apiDraftName = payload.sub2apiDraftName || null;
      if (payload.sub2apiProxyId !== undefined) updates.sub2apiProxyId = payload.sub2apiProxyId || null;
      if (payload.cpaOAuthState !== undefined) updates.cpaOAuthState = payload.cpaOAuthState || null;
      if (payload.cpaManagementOrigin !== undefined) updates.cpaManagementOrigin = payload.cpaManagementOrigin || null;
      if (payload.codex2apiSessionId !== undefined) updates.codex2apiSessionId = payload.codex2apiSessionId || null;
      if (payload.codex2apiOAuthState !== undefined) updates.codex2apiOAuthState = payload.codex2apiOAuthState || null;
      if (payload.sub2apiGroupIds !== undefined) updates.sub2apiGroupIds = Array.isArray(payload.sub2apiGroupIds)
        ? payload.sub2apiGroupIds
        : [];
      if (Object.keys(updates).length) {
        await setState(updates);
      }
      break;
    }
    case 2:
      await persistStepEmailPayload(payload.email, payload, 'step2_identity');
      if (!payload.email && (payload.accountIdentifierType || payload.accountIdentifier || payload.signupPhoneNumber || payload.signupPhoneActivation)) {
        await setState({
          accountIdentifierType: payload.accountIdentifierType || null,
          accountIdentifier: String(payload.accountIdentifier || '').trim(),
          signupPhoneNumber: String(payload.signupPhoneNumber || '').trim(),
          signupPhoneActivation: payload.signupPhoneActivation || null,
        });
      }
      if (payload.skippedPasswordStep) {
        const latestState = await getState();
        const step3NodeId = getNodeIdByStepForState(3, latestState);
        const step3Status = step3NodeId ? latestState.nodeStatuses?.[step3NodeId] : '';
        if (step3NodeId && step3Status !== 'running' && step3Status !== 'completed' && step3Status !== 'manual_completed') {
          await setNodeStatus(step3NodeId, 'skipped');
          const identityLabel = payload.accountIdentifierType === 'phone' ? '手机号' : '邮箱';
          await addLog(`步骤 2：提交${identityLabel}后页面直接进入验证码页，已自动跳过步骤 3。`, 'warn');
        }
      }
      break;
    case 3:
      await persistStepEmailPayload(payload.email, payload, 'step3_identity');
      if (payload.signupVerificationRequestedAt) {
        await setState({ signupVerificationRequestedAt: payload.signupVerificationRequestedAt });
      }
      if (payload.skipProfileStep) {
        const latestState = await getState();
        const step5NodeId = getNodeIdByStepForState(5, latestState);
        const step5Status = step5NodeId ? latestState.nodeStatuses?.[step5NodeId] : '';
        if (step5NodeId && step5Status !== 'running' && step5Status !== 'completed' && step5Status !== 'manual_completed') {
          await setNodeStatus(step5NodeId, 'skipped');
          await addLog('步骤 3：页面已直接进入已登录态，已自动跳过步骤 5。', 'warn');
        }
      }
      if (payload.loginVerificationRequestedAt) {
        await setState({ loginVerificationRequestedAt: payload.loginVerificationRequestedAt });
      }
      break;
    case 7:
      if (payload.accountIdentifierType || payload.accountIdentifier || payload.signupPhoneNumber || payload.signupPhoneActivation || payload.signupPhoneCompletedActivation) {
        await setState({
          accountIdentifierType: payload.accountIdentifierType || null,
          accountIdentifier: String(payload.accountIdentifier || '').trim(),
          signupPhoneNumber: String(payload.signupPhoneNumber || '').trim(),
          signupPhoneActivation: payload.signupPhoneActivation || null,
          signupPhoneCompletedActivation: payload.signupPhoneCompletedActivation || null,
        });
      }
      if (payload.loginVerificationRequestedAt) {
        await setState({ loginVerificationRequestedAt: payload.loginVerificationRequestedAt });
      }
      break;
    case 4:
      await setState({
    ...(payload.phoneVerification ? {
          currentPhoneVerificationCode: '',
          signupPhoneVerificationRequestedAt: null,
          signupPhoneVerificationPurpose: '',
        } : {
          lastEmailTimestamp: payload.emailTimestamp || null,
        }),
        signupVerificationRequestedAt: null,
      });
      break;
    case 8:
      await setState({
        ...(payload.phoneVerification || payload.loginPhoneVerification ? {
          currentPhoneVerificationCode: '',
          signupPhoneVerificationRequestedAt: null,
          signupPhoneVerificationPurpose: '',
        } : {
          lastEmailTimestamp: payload.emailTimestamp || null,
        }),
        loginVerificationRequestedAt: null,
      });
      break;
    case 9:
      if (payload.localhostUrl) {
        if (!isLocalhostOAuthCallbackUrl(payload.localhostUrl)) {
          throw new Error('步骤 9 返回了无效的 localhost OAuth 回调地址。');
        }
        await setState({
          localhostUrl: payload.localhostUrl,
          oauthFlowDeadlineAt: null,
          oauthFlowDeadlineSourceUrl: null,
        });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
  }
}

async function handleNodeData(nodeId, payload) {
  const state = await getState();
  const step = getStepIdByNodeIdForState(nodeId, state);
  if (!Number.isInteger(step) || step <= 0) {
    return;
  }
  return handleStepData(step, payload);
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of nodeId -> { resolve, reject } for waiting on node completion
const nodeWaiters = new Map();
// Legacy boundary waiters are kept only for callers that still pass a display step.
const stepWaiters = new Map();
let resumeWaiter = null;
const AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS = 120000;
const AUTO_RUN_STEP_IDLE_LOG_TIMEOUT_MS = 5 * 60 * 1000;
const AUTO_RUN_STEP_IDLE_LOG_CHECK_INTERVAL_MS = 5000;
const CHECKOUT_FINAL_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const AUTO_RUN_STEP_IDLE_RESTART_MAX_ATTEMPTS = 3;
const AUTO_RUN_STEP_IDLE_RESTART_ERROR_PREFIX = 'AUTO_RUN_STEP_IDLE_RESTART::';
const AUTO_RUN_BACKGROUND_COMPLETED_STEPS = new Set([1, 2, 4, 6, 7, 8, 9]);
const STEP_COMPLETION_SIGNAL_STEPS = new Set([3, 5, 10, 12]);
const AUTO_RUN_BACKGROUND_COMPLETED_STEP_KEYS = new Set([
  'open-chatgpt',
  'submit-signup-email',
  'fetch-signup-code',
  'wait-registration-success',
  'oauth-login',
  'fetch-login-code',
  'post-login-phone-verification',
  'bind-email',
  'fetch-bind-email-code',
  'relogin-bound-email',
  'fetch-bound-email-login-code',
  'post-bound-email-phone-verification',
  'confirm-oauth',
  'chatgpt-ac-external-redeem',
]);
const STEP_COMPLETION_SIGNAL_STEP_KEYS = new Set([
  'fill-password',
  'fill-profile',
  'plus-checkout-create',
  'platform-verify',
]);
const STEP_COMPLETION_SIGNAL_TIMEOUTS_BY_STEP_KEY = new Map([
  ['fill-profile', 150000],
]);
const AUTO_RUN_PRE_EXECUTION_DELAYS_BY_STEP_KEY = new Map([
  ['plus-checkout-create', 5000],
]);

function waitForNodeComplete(nodeId, timeoutMs = 120000) {
  throwIfStopped();
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    return Promise.reject(new Error('等待节点完成失败：缺少 nodeId。'));
  }
  const existingWaiter = nodeWaiters.get(normalizedNodeId);
  if (existingWaiter?.promise) {
    console.log(LOG_PREFIX, `[waitForNodeComplete] reuse existing waiter for node ${normalizedNodeId}`);
    return existingWaiter.promise;
  }

  console.log(LOG_PREFIX, `[waitForNodeComplete] register node ${normalizedNodeId}, timeout=${timeoutMs}ms`);
  const waiter = {
    promise: null,
    resolve: null,
    reject: null,
  };

  waiter.promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (nodeWaiters.get(normalizedNodeId) === waiter) {
        nodeWaiters.delete(normalizedNodeId);
      }
      console.warn(LOG_PREFIX, `[waitForNodeComplete] timeout for node ${normalizedNodeId} after ${timeoutMs}ms`);
      reject(new Error(`节点 ${normalizedNodeId} 等待超时（>${timeoutMs / 1000} 秒）`));
    }, timeoutMs);

    waiter.resolve = (data) => {
      clearTimeout(timer);
      if (nodeWaiters.get(normalizedNodeId) === waiter) {
        nodeWaiters.delete(normalizedNodeId);
      }
      resolve(data);
    };
    waiter.reject = (err) => {
      clearTimeout(timer);
      if (nodeWaiters.get(normalizedNodeId) === waiter) {
        nodeWaiters.delete(normalizedNodeId);
      }
      reject(err);
    };
  });

  nodeWaiters.set(normalizedNodeId, waiter);
  return waiter.promise;
}

function waitForStepComplete(step, timeoutMs = 120000) {
  return getState().then((state) => {
    const nodeId = getNodeIdByStepForState(step, state);
    if (!nodeId) {
      throw new Error(`等待步骤 ${step} 完成失败：当前 flow 中未找到对应节点。`);
    }
    return waitForNodeComplete(nodeId, timeoutMs);
  });
}

function getStepExecutionKeyForState(step, state = {}) {
  if (typeof getStepDefinitionForState !== 'function') {
    return '';
  }
  return String(getStepDefinitionForState(step, state)?.key || '').trim();
}

function getNodeExecutionKeyForState(nodeId, state = {}) {
  return String(getNodeDefinitionForState(nodeId, state)?.executeKey || nodeId || '').trim();
}

function doesNodeUseBackgroundCompletion(nodeId, state = {}) {
  const executionKey = getNodeExecutionKeyForState(nodeId, state);
  return AUTO_RUN_BACKGROUND_COMPLETED_STEP_KEYS.has(executionKey || nodeId);
}

function doesStepUseBackgroundCompletion(step, state = {}) {
  return doesNodeUseBackgroundCompletion(getNodeIdByStepForState(step, state), state);
}

function doesNodeUseCompletionSignal(nodeId, state = {}) {
  const executionKey = getNodeExecutionKeyForState(nodeId, state);
  return STEP_COMPLETION_SIGNAL_STEP_KEYS.has(executionKey || nodeId);
}

function doesStepUseCompletionSignal(step, state = {}) {
  return doesNodeUseCompletionSignal(getNodeIdByStepForState(step, state), state);
}

function getAutoRunPreExecutionDelayMsForNode(nodeId, state = {}) {
  const executionKey = getNodeExecutionKeyForState(nodeId, state);
  return AUTO_RUN_PRE_EXECUTION_DELAYS_BY_STEP_KEY.get(executionKey || nodeId) || 0;
}

function getAutoRunPreExecutionDelayMs(step, state = {}) {
  return getAutoRunPreExecutionDelayMsForNode(getNodeIdByStepForState(step, state), state);
}

function isCheckoutConversionCompletionNode(nodeId, state = {}) {
  const executionKey = getNodeExecutionKeyForState(nodeId, state);
  if ((executionKey || nodeId) !== 'plus-checkout-create') {
    return false;
  }
  const plusModeEnabled = Boolean(state?.plusModeEnabled);
  const plusPaymentMethod = String(state?.plusPaymentMethod || '').trim().toLowerCase();
  return plusModeEnabled
    && plusPaymentMethod === PLUS_PAYMENT_METHOD_CHECKOUT_CONVERSION;
}

function getNodeCompletionSignalTimeoutMs(nodeId, state = {}) {
  if (isCheckoutConversionCompletionNode(nodeId, state)) {
    return CHECKOUT_FINAL_WAIT_TIMEOUT_MS;
  }
  const executionKey = getNodeExecutionKeyForState(nodeId, state);
  return STEP_COMPLETION_SIGNAL_TIMEOUTS_BY_STEP_KEY.get(executionKey || nodeId) || AUTO_RUN_SIGNAL_COMPLETION_TIMEOUT_MS;
}

function getStepCompletionSignalTimeoutMs(step, state = {}) {
  return getNodeCompletionSignalTimeoutMs(getNodeIdByStepForState(step, state), state);
}

function getAutoRunNodeIdleLogTimeoutMs(nodeId, state = {}) {
  if (isCheckoutConversionCompletionNode(nodeId, state)) {
    return CHECKOUT_FINAL_WAIT_TIMEOUT_MS;
  }
  return AUTO_RUN_STEP_IDLE_LOG_TIMEOUT_MS;
}

function notifyNodeComplete(nodeId, payload) {
  const normalizedNodeId = String(nodeId || '').trim();
  const waiter = nodeWaiters.get(normalizedNodeId);
  console.log(LOG_PREFIX, `[notifyNodeComplete] node ${normalizedNodeId}, hasWaiter=${Boolean(waiter)}`);
  if (waiter) waiter.resolve(payload);
}

function notifyStepComplete(step, payload) {
  getState().then((state) => {
    const nodeId = getNodeIdByStepForState(step, state);
    if (nodeId) {
      notifyNodeComplete(nodeId, payload);
    }
  }).catch(() => {});
  const waiter = stepWaiters.get(step);
  console.log(LOG_PREFIX, `[notifyStepComplete] step ${step}, hasWaiter=${Boolean(waiter)}`);
  if (waiter) waiter.resolve(payload);
}

function notifyNodeError(nodeId, error) {
  const normalizedNodeId = String(nodeId || '').trim();
  const waiter = nodeWaiters.get(normalizedNodeId);
  console.warn(LOG_PREFIX, `[notifyNodeError] node ${normalizedNodeId}, hasWaiter=${Boolean(waiter)}, error=${error}`);
  if (waiter) waiter.reject(new Error(error));
}

function notifyStepError(step, error) {
  getState().then((state) => {
    const nodeId = getNodeIdByStepForState(step, state);
    if (nodeId) {
      notifyNodeError(nodeId, error);
    }
  }).catch(() => {});
  const waiter = stepWaiters.get(step);
  console.warn(LOG_PREFIX, `[notifyStepError] step ${step}, hasWaiter=${Boolean(waiter)}, error=${error}`);
  if (waiter) waiter.reject(new Error(error));
}

async function runCompletedStepSideEffects(step, payload, completionState, lastStepId) {
  const state = await getState();
  const nodeId = getNodeIdByStepForState(step, state);
  const lastNodeId = getNodeIdByStepForState(lastStepId, state);
  return runCompletedNodeSideEffects(nodeId, payload, completionState, lastNodeId);
}

async function reportCompletedStepSideEffectError(step, error) {
  const state = await getState();
  return reportCompletedNodeSideEffectError(getNodeIdByStepForState(step, state), error);
}

async function runCompletedNodeSideEffects(nodeId, payload, completionState, lastNodeId) {
  await handleNodeData(nodeId, payload);
  if (nodeId === lastNodeId) {
    await appendAndBroadcastAccountRunRecord('success', completionState);
  }
}

async function reportCompletedNodeSideEffectError(nodeId, error) {
  const message = getErrorMessage(error);
  console.warn(LOG_PREFIX, `[completeNodeFromBackground] node ${nodeId} post-completion side effect failed:`, error);
  await addLog(`已完成，但完成后的收尾处理失败：${message}`, 'warn', { nodeId });
}

async function completeNodeFromBackground(nodeId, payload = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('completeNodeFromBackground 缺少 nodeId。');
  }
  if (stopRequested) {
    await setNodeStatus(normalizedNodeId, 'stopped');
    await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:stopped`, null, STOP_ERROR_MESSAGE);
    notifyNodeError(normalizedNodeId, STOP_ERROR_MESSAGE);
    return;
  }

  const latestState = await getState();
  const lastNodeId = getLastNodeIdForState(latestState);
  const completionState = normalizedNodeId === lastNodeId ? latestState : null;
  await setNodeStatus(normalizedNodeId, 'completed');
  await addLog('已完成', 'ok', { nodeId: normalizedNodeId });

  if (normalizedNodeId === lastNodeId) {
    notifyNodeComplete(normalizedNodeId, payload);
    void runCompletedNodeSideEffects(normalizedNodeId, payload, completionState, lastNodeId)
      .catch((error) => reportCompletedNodeSideEffectError(normalizedNodeId, error));
    return;
  }

  await runCompletedNodeSideEffects(normalizedNodeId, payload, completionState, lastNodeId);
  notifyNodeComplete(normalizedNodeId, payload);
}

async function skipNodeFromBackground(nodeId, payload = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('skipNodeFromBackground 缺少 nodeId。');
  }
  if (stopRequested) {
    await setNodeStatus(normalizedNodeId, 'stopped');
    notifyNodeError(normalizedNodeId, STOP_ERROR_MESSAGE);
    return;
  }

  const latestState = await getState();
  const lastNodeId = getLastNodeIdForState(latestState);
  const completionState = normalizedNodeId === lastNodeId ? latestState : null;
  await setNodeStatus(normalizedNodeId, 'skipped');
  await addLog('已跳过', 'warn', { nodeId: normalizedNodeId });
  if (normalizedNodeId === lastNodeId) {
    notifyNodeComplete(normalizedNodeId, payload);
    void runCompletedNodeSideEffects(normalizedNodeId, payload, completionState, lastNodeId)
      .catch((error) => reportCompletedNodeSideEffectError(normalizedNodeId, error));
    return;
  }

  await runCompletedNodeSideEffects(normalizedNodeId, payload, completionState, lastNodeId);
  notifyNodeComplete(normalizedNodeId, payload);
}

async function failNodeFromBackground(nodeId, errorLike = '未知错误') {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('failNodeFromBackground 缺少 nodeId。');
  }
  const message = getErrorMessage(errorLike) || '未知错误';
  if (stopRequested || isStopError(errorLike)) {
    await setNodeStatus(normalizedNodeId, 'stopped');
    await addLog('已被用户停止', 'warn', { nodeId: normalizedNodeId });
    await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:stopped`, null, message);
    notifyNodeError(normalizedNodeId, STOP_ERROR_MESSAGE);
    return;
  }

  const latestState = await getState();
  await setNodeStatus(normalizedNodeId, 'failed');
  await addLog(`失败：${message}`, 'error', { nodeId: normalizedNodeId });
  await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:failed`, latestState, message);
  notifyNodeError(normalizedNodeId, message);
}

async function appendManualAccountRunRecordIfNeeded(status, stateOverride = null, reason = '') {
  if (!accountRunHistoryHelpers?.appendAccountRunRecord) {
    return null;
  }

  const state = stateOverride || await getState();
  return appendAndBroadcastAccountRunRecord(status, state, reason);
}

async function finalizeDeferredNodeExecutionError(nodeId, error) {
  const latestState = await getState();
  const normalizedNodeId = String(nodeId || '').trim();
  const currentStatus = latestState.nodeStatuses?.[normalizedNodeId];
  if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'stopped') {
    return;
  }

  if (isStopError(error)) {
    await setNodeStatus(normalizedNodeId, 'stopped');
    await addLog('已被用户停止', 'warn', { nodeId: normalizedNodeId });
    await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:stopped`, latestState, getErrorMessage(error));
    return;
  }

  await setNodeStatus(normalizedNodeId, 'failed');
  await addLog(`失败：${getErrorMessage(error)}`, 'error', { nodeId: normalizedNodeId });
  await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:failed`, latestState, getErrorMessage(error));
}

async function finalizeDeferredStepExecutionError(step, error) {
  const latestState = await getState();
  const nodeId = getNodeIdByStepForState(step, latestState);
  if (!nodeId) {
    return;
  }
  return finalizeDeferredNodeExecutionError(nodeId, error);
}

async function executeNodeViaCompletionSignal(nodeId, timeoutMs = 0) {
  const normalizedNodeId = String(nodeId || '').trim();
  const executionState = await getState();
  const resolvedTimeoutMs = Number(timeoutMs) > 0
    ? timeoutMs
    : getNodeCompletionSignalTimeoutMs(normalizedNodeId, executionState);
  const completionResultPromise = waitForNodeComplete(normalizedNodeId, resolvedTimeoutMs).then(
    payload => ({ ok: true, payload }),
    error => ({ ok: false, error }),
  );

  let executeError = null;
  try {
    await executeNode(normalizedNodeId, { deferRetryableTransportError: true });
  } catch (err) {
    executeError = err;
    if (isStopError(err) || !isRetryableContentScriptTransportError(err)) {
      notifyNodeError(normalizedNodeId, getErrorMessage(err));
    }
  }

  const completionResult = await completionResultPromise;
  if (completionResult.ok) {
    if (executeError) {
      console.warn(
        LOG_PREFIX,
        `[executeNodeViaCompletionSignal] node ${normalizedNodeId} completed after deferred execute error: ${getErrorMessage(executeError)}`
      );
    }
    return completionResult.payload;
  }

  if (executeError && isRetryableContentScriptTransportError(executeError)) {
    const completionMessage = getErrorMessage(completionResult.error);
    if (/等待超时/.test(completionMessage)) {
      await finalizeDeferredNodeExecutionError(normalizedNodeId, executeError);
      throw executeError;
    }
    throw completionResult.error;
  }

  if (executeError) {
    throw executeError;
  }

  throw completionResult.error;
}

async function executeStepViaCompletionSignal(step, timeoutMs = 0) {
  const state = await getState();
  const nodeId = getNodeIdByStepForState(step, state);
  if (!nodeId) {
    throw new Error(`执行步骤 ${step} 失败：当前 flow 中未找到对应节点。`);
  }
  return executeNodeViaCompletionSignal(nodeId, timeoutMs);
}

function getLatestLogTimestamp(logs = [], fallback = 0) {
  if (!Array.isArray(logs) || !logs.length) {
    return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  }
  return logs.reduce((latest, entry) => {
    const timestamp = Number(entry?.timestamp);
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, Number.isFinite(Number(fallback)) ? Number(fallback) : 0);
}

function buildAutoRunNodeIdleRestartError(nodeId, idleMs = AUTO_RUN_STEP_IDLE_LOG_TIMEOUT_MS) {
  const seconds = Math.max(1, Math.round((Number(idleMs) || AUTO_RUN_STEP_IDLE_LOG_TIMEOUT_MS) / 1000));
  const normalizedNodeId = String(nodeId || '').trim();
  const error = new Error(`${AUTO_RUN_STEP_IDLE_RESTART_ERROR_PREFIX}节点 ${normalizedNodeId} 已连续 ${seconds} 秒没有新日志，准备重新开始当前节点。`);
  error.autoRunStepIdleRestart = true;
  error.failedNodeId = normalizedNodeId;
  return error;
}

function isAutoRunStepIdleRestartError(error) {
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return Boolean(error?.autoRunStepIdleRestart) || message.startsWith(AUTO_RUN_STEP_IDLE_RESTART_ERROR_PREFIX);
}

function startAutoRunNodeIdleLogWatchdog(nodeId, options = {}) {
  const idleTimeoutMs = Math.max(1000, Math.floor(Number(options.idleTimeoutMs) || AUTO_RUN_STEP_IDLE_LOG_TIMEOUT_MS));
  const checkIntervalMs = Math.max(250, Math.min(idleTimeoutMs, Math.floor(Number(options.checkIntervalMs) || AUTO_RUN_STEP_IDLE_LOG_CHECK_INTERVAL_MS)));
  const normalizedNodeId = String(nodeId || '').trim();
  let cancelled = false;
  let timer = null;
  let lastActivityAt = Date.now();

  const promise = new Promise((_, reject) => {
    const schedule = () => {
      if (cancelled) {
        return;
      }
      const idleForMs = Math.max(0, Date.now() - lastActivityAt);
      const delayMs = Math.max(50, Math.min(checkIntervalMs, idleTimeoutMs - idleForMs));
      timer = setTimeout(check, delayMs);
    };

    const check = async () => {
      if (cancelled) {
        return;
      }
      try {
        const state = await getState();
        if (state?.plusManualConfirmationPending) {
          lastActivityAt = Date.now();
          schedule();
          return;
        }

        const latestLogAt = getLatestLogTimestamp(state?.logs || [], lastActivityAt);
        if (latestLogAt > lastActivityAt) {
          lastActivityAt = latestLogAt;
        }

        const idleForMs = Date.now() - lastActivityAt;
        if (idleForMs >= idleTimeoutMs) {
          reject(buildAutoRunNodeIdleRestartError(normalizedNodeId, idleForMs));
          return;
        }
      } catch (_err) {
        // Watchdog read failures should not break the real step; retry the check.
      }
      schedule();
    };

    schedule();
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

async function runAutoNodeActionWithIdleLogWatchdog(nodeId, action, options = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  const executionPromise = Promise.resolve().then(action);
  const watchdog = startAutoRunNodeIdleLogWatchdog(normalizedNodeId, options);
  try {
    return await Promise.race([
      executionPromise,
      watchdog.promise,
    ]);
  } catch (error) {
    if (isAutoRunStepIdleRestartError(error)) {
      void executionPromise.catch((lateError) => {
        const lateMessage = getErrorMessage(lateError);
        if (!lateMessage || isStopError(lateError) || isAutoRunStepIdleRestartError(lateError)) {
          return;
        }
        addLog(`节点 ${normalizedNodeId}：无日志重开后收到原执行失败：${lateMessage}`, 'warn').catch(() => {});
      });
    }
    throw error;
  } finally {
    watchdog.cancel();
  }
}

async function executeNodeAndWaitWithAutoRunIdleLogWatchdog(nodeId, delayAfter = 2000, options = {}) {
  const executionState = await getState();
  return runAutoNodeActionWithIdleLogWatchdog(
    nodeId,
    () => executeNodeAndWait(nodeId, delayAfter),
    {
      ...options,
      idleTimeoutMs: Number(options.idleTimeoutMs) > 0
        ? Number(options.idleTimeoutMs)
        : getAutoRunNodeIdleLogTimeoutMs(nodeId, executionState),
    }
  );
}

async function waitForRunningNodesToFinish(payload = {}) {
  let currentState = await getState();
  let runningNodes = getRunningNodeIds(currentState.nodeStatuses, currentState);
  if (!runningNodes.length) {
    return currentState;
  }

  await addLog(`自动继续：检测到节点 ${runningNodes.join(', ')} 正在运行，等待完成后再继续自动流程...`, 'info');
  await broadcastAutoRunStatus('waiting_step', payload);

  while (runningNodes.length) {
    await sleepWithStop(250);
    currentState = await getState();
    runningNodes = getRunningNodeIds(currentState.nodeStatuses, currentState);
  }

  await addLog('自动继续：当前运行节点已结束，准备按最新进度继续自动流程...', 'info');
  return currentState;
}

async function waitForRunningStepsToFinish(payload = {}) {
  return waitForRunningNodesToFinish(payload);
}

const AUTH_CHAIN_NODE_IDS = new Set([
  'oauth-login',
  'fetch-login-code',
  'post-login-phone-verification',
  'bind-email',
  'fetch-bind-email-code',
  'relogin-bound-email',
  'fetch-bound-email-login-code',
  'post-bound-email-phone-verification',
  'confirm-oauth',
  'platform-verify',
]);
let activeTopLevelAuthChainExecution = null;

function isAuthChainNode(nodeId) {
  return AUTH_CHAIN_NODE_IDS.has(String(nodeId || '').trim());
}

function isAuthChainStep(step, state = {}) {
  return isAuthChainNode(getNodeIdByStepForState(step, state));
}

async function acquireTopLevelAuthChainExecutionForNode(nodeId, state = {}) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!isAuthChainNode(normalizedNodeId)) {
    return {
      joined: false,
      release() {},
    };
  }

  if (activeTopLevelAuthChainExecution) {
    const activeExecution = activeTopLevelAuthChainExecution;
    await addLog(
      `节点 ${normalizedNodeId}：检测到节点 ${activeExecution.nodeId} 正在运行，本次请求将复用当前授权链，不再重复启动。`,
      'warn'
    );
    const result = await activeExecution.promise;
    if (result?.error) {
      throw result.error;
    }
    return {
      joined: true,
      release() {},
    };
  }

  let settleExecution = () => {};
  const promise = new Promise((resolve) => {
    settleExecution = (error = null) => resolve({ error });
  });
  const execution = {
    nodeId: normalizedNodeId,
    promise,
  };
  activeTopLevelAuthChainExecution = execution;

  return {
    joined: false,
    release(error = null) {
      if (activeTopLevelAuthChainExecution === execution) {
        activeTopLevelAuthChainExecution = null;
      }
      settleExecution(error);
    },
  };
}

async function markRunningNodesStopped() {
  const state = await getState();
  const runningNodes = getRunningNodeIds(state.nodeStatuses, state);

  for (const nodeId of runningNodes) {
    await setNodeStatus(nodeId, 'stopped');
  }
}

async function markRunningStepsStopped() {
  return markRunningNodesStopped();
}

async function requestStop(options = {}) {
  const { logMessage = '已收到停止请求，正在取消当前操作...' } = options;
  const state = await getState();
  const runningNodes = getRunningNodeIds(state.nodeStatuses, state);
  const inferredStopNode = inferStoppedRecordNode(state);
  const timerPlan = getPendingAutoRunTimerPlan(state);

  if (timerPlan?.kind === AUTO_RUN_TIMER_KIND_SCHEDULED_START && !autoRunActive) {
    await cancelScheduledAutoRun({
      logMessage: options.logMessage === false
        ? false
        : (options.logMessage || '已取消自动运行倒计时计划。'),
    });
    return;
  }

  if (timerPlan && !autoRunActive) {
    autoRunCurrentRun = timerPlan.currentRun;
    autoRunTotalRuns = timerPlan.totalRuns;
    autoRunAttemptRun = timerPlan.attemptRun;
    clearCurrentAutoRunSessionId(timerPlan.autoRunSessionId);
    if (options.logMessage !== false) {
      await addLog(options.logMessage || '已停止等待中的自动流程。', 'warn');
    }
    await broadcastAutoRunStatus('stopped', {
      currentRun: timerPlan.currentRun,
      totalRuns: timerPlan.totalRuns,
      attemptRun: timerPlan.attemptRun,
      sessionId: 0,
    }, {
      autoRunSessionId: 0,
      autoRunSkipFailures: timerPlan.autoRunSkipFailures,
      autoRunRoundSummaries: serializeAutoRunRoundSummaries(timerPlan.totalRuns, timerPlan.roundSummaries),
      autoRunTimerPlan: null,
      scheduledAutoRunPlan: null,
    });
    await clearAutoRunTimerAlarm();
    clearStopRequest();
    return;
  }

  if (stopRequested) return;

  stopRequested = true;
  clearCurrentAutoRunSessionId();
  cancelPendingCommands();
  abortActiveIcloudRequests();
  cleanupStep8NavigationListeners();
  rejectPendingStep8(new Error(STOP_ERROR_MESSAGE));

  await addLog(logMessage, 'warn');
  await broadcastStopToContentScripts();

  if (!runningNodes.length && inferredStopNode) {
    await appendAndBroadcastAccountRunRecord('stopped', state, STOP_ERROR_MESSAGE);
  }

  for (const waiter of nodeWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  nodeWaiters.clear();
  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (state.plusManualConfirmationPending) {
    const clearManualConfirmationState = {
      plusManualConfirmationPending: false,
      plusManualConfirmationRequestId: '',
      plusManualConfirmationStep: 0,
      plusManualConfirmationMethod: '',
      plusManualConfirmationTitle: '',
      plusManualConfirmationMessage: '',
    };
    await setState(clearManualConfirmationState);
    broadcastDataUpdate(clearManualConfirmationState);
  }

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningNodesStopped();
  autoRunActive = false;
  await broadcastAutoRunStatus('stopped', {
    currentRun: autoRunCurrentRun,
    totalRuns: autoRunTotalRuns,
    attemptRun: autoRunAttemptRun,
    sessionId: 0,
  }, {
    autoRunSessionId: 0,
    autoRunTimerPlan: null,
    scheduledAutoRunPlan: null,
  });
  await restoreRunScopedCheckoutConversionProxy('用户停止插件流程');
}

// ============================================================
// Step Execution
// ============================================================

const STEP_FETCH_NETWORK_RETRY_POLICIES = new Map([
  [4, { maxAttempts: 3, cooldownMs: 12000 }],
  [8, { maxAttempts: 3, cooldownMs: 12000 }],
  [9, { maxAttempts: 3, cooldownMs: 12000 }],
]);

async function executeNode(nodeId, options = {}) {
  const { deferRetryableTransportError = false } = options;
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('executeNode 缺少 nodeId。');
  }
  console.log(LOG_PREFIX, `Executing node ${normalizedNodeId}`);
  let state = await getState();
  const step = getStepIdByNodeIdForState(normalizedNodeId, state);
  const authChainClaim = await acquireTopLevelAuthChainExecutionForNode(normalizedNodeId, state);
  if (authChainClaim.joined) {
    return;
  }

  let executionError = null;
  throwIfStopped();
  try {
    await setNodeStatus(normalizedNodeId, 'running');
    await addLog('开始执行', 'info', { nodeId: normalizedNodeId });
    await humanStepDelay();
    const fetchRetryPolicy = typeof getStepFetchNetworkRetryPolicy === 'function'
      ? getStepFetchNetworkRetryPolicy(step)
      : null;
    const isFetchRetryable = (error) => {
      if (typeof isStepFetchNetworkRetryableError === 'function') {
        return isStepFetchNetworkRetryableError(error);
      }
      return isRetryableContentScriptTransportError(error);
    };
    let attempt = 1;

    while (true) {
      state = await getState();

      // Set flow start time on first step
      if (normalizedNodeId === 'open-chatgpt' && !state.flowStartTime) {
        await setState({ flowStartTime: Date.now() });
      }

      const activeStepRegistry = getStepRegistryForState(state);
      if (!activeStepRegistry?.getNodeDefinition?.(normalizedNodeId)) {
        throw new Error(`当前模式下不存在节点：${normalizedNodeId}`);
      }

      try {
        await activeStepRegistry.executeNode(normalizedNodeId, {
          ...state,
          visibleStep: Number(step),
          nodeId: normalizedNodeId,
          nodeDefinition: getNodeDefinitionForState(normalizedNodeId, state),
          stepDefinition: getStepDefinitionForState(step, state),
        });

        if (attempt > 1) {
          await addLog(
            `[NETWORK_FETCH_RETRY] 节点 ${normalizedNodeId}：网络请求异常已恢复，当前重试成功（${attempt}/${fetchRetryPolicy?.maxAttempts || attempt}）。`,
            'ok'
          );
        }
        break;
      } catch (attemptError) {
        if (!fetchRetryPolicy || !isFetchRetryable(attemptError) || attempt >= fetchRetryPolicy.maxAttempts) {
          throw attemptError;
        }

        const nextAttempt = attempt + 1;
        const cooldownMs = fetchRetryPolicy.cooldownMs;
        const cooldownSeconds = Math.max(1, Math.ceil(cooldownMs / 1000));
        await addLog(
          `[NETWORK_FETCH_RETRY] 节点 ${normalizedNodeId}：检测到网络请求异常（${getErrorMessage(attemptError)}），${cooldownSeconds} 秒后重试（${nextAttempt}/${fetchRetryPolicy.maxAttempts}）。`,
          'warn'
        );
        if (cooldownMs > 0) {
          await sleepWithStop(cooldownMs);
        }
        attempt = nextAttempt;
      }
    }
  } catch (err) {
    executionError = err;
    const errorState = await getState();
    if (isStopError(err)) {
      await setNodeStatus(normalizedNodeId, 'stopped');
      await addLog('已被用户停止', 'warn', { nodeId: normalizedNodeId });
      await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:stopped`, errorState, getErrorMessage(err));
      throw err;
    }
    if (isTerminalSecurityBlockedError(err)) {
      await handleCloudflareSecurityBlocked(err);
      throw new Error(STOP_ERROR_MESSAGE);
    }
    if (isBrowserSwitchRequiredError(err)) {
      await handleBrowserSwitchRequired(err);
      throw new Error(STOP_ERROR_MESSAGE);
    }
    if (!(deferRetryableTransportError && doesNodeUseCompletionSignal(normalizedNodeId, errorState) && isRetryableContentScriptTransportError(err))) {
      await setNodeStatus(normalizedNodeId, 'failed');
      await addLog(`失败：${err.message}`, 'error', { nodeId: normalizedNodeId });
      await appendManualAccountRunRecordIfNeeded(`node:${normalizedNodeId}:failed`, errorState, getErrorMessage(err));
    } else {
      console.warn(
        LOG_PREFIX,
        `[executeNode] deferring retryable transport error for node ${normalizedNodeId}: ${getErrorMessage(err)}`
      );
    }
    throw err;
  } finally {
    authChainClaim.release(executionError);
  }
}

async function executeNodeAndWait(nodeId, delayAfter = 2000) {
  throwIfStopped();
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) {
    throw new Error('executeNodeAndWait 缺少 nodeId。');
  }
  let completionPayload = null;

  const delaySeconds = normalizeAutoStepDelaySeconds((await getState()).autoStepDelaySeconds, null);
  if (delaySeconds > 0) {
    await addLog(
      `自动运行：节点 ${normalizedNodeId} 执行前额外等待 ${delaySeconds} 秒，避免节奏过快。`,
      'info'
    );
    await sleepWithStop(delaySeconds * 1000);
  }

  let executionState = await getState();
  const step = getStepIdByNodeIdForState(normalizedNodeId, executionState);
  const preExecutionDelayMs = getAutoRunPreExecutionDelayMsForNode(normalizedNodeId, executionState);
  if (preExecutionDelayMs > 0) {
    await addLog(
      `自动运行：节点 ${normalizedNodeId} 执行前固定等待 ${Math.round(preExecutionDelayMs / 1000)} 秒，确保 Plus Checkout 创建前页面稳定。`,
      'info'
    );
    await sleepWithStop(preExecutionDelayMs);
    executionState = await getState();
  }

  if (doesNodeUseBackgroundCompletion(normalizedNodeId, executionState)) {
    await addLog(`自动运行：节点 ${normalizedNodeId} 由后台流程负责收尾，执行函数返回后将直接进入下一步。`, 'info');
    await executeNode(normalizedNodeId);
    const latestState = await getState();
    await addLog(`自动运行：节点 ${normalizedNodeId} 已执行返回，当前状态为 ${latestState.nodeStatuses?.[normalizedNodeId] || 'pending'}，准备继续后续节点。`, 'info');
  } else if (doesNodeUseCompletionSignal(normalizedNodeId, executionState)) {
    const completionSignalTimeoutMs = getNodeCompletionSignalTimeoutMs(normalizedNodeId, executionState);
    await addLog(`自动运行：节点 ${normalizedNodeId} 已发起，正在等待完成信号（超时 ${Math.round(completionSignalTimeoutMs / 1000)} 秒）。`, 'info');
    completionPayload = await executeNodeViaCompletionSignal(normalizedNodeId, completionSignalTimeoutMs);
    await addLog(`自动运行：节点 ${normalizedNodeId} 已收到完成信号，准备继续后续节点。`, 'info');
  } else {
    await executeNode(normalizedNodeId);
  }

  if (normalizedNodeId === 'fill-profile') {
    const signupTabId = await getTabId('signup-page');
    if (signupTabId && !completionPayload?.skipPostCompletionValidation) {
      await addLog('自动运行：填写资料节点已收到完成信号，正在等待当前页面完成加载并稳定...', 'info');
      await waitForTabStableComplete(signupTabId, {
        timeoutMs: 120000,
        retryDelayMs: 300,
        stableMs: 1000,
        initialDelayMs: 800,
      });
      try {
        await validateStep5PostCompletion(signupTabId, completionPayload || {});
      } catch (step5ValidationError) {
        await setNodeStatus(normalizedNodeId, 'failed');
        await addLog(`失败：${getErrorMessage(step5ValidationError)}`, 'error', { nodeId: normalizedNodeId });
        throw step5ValidationError;
      }
    }
  }

  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

function getEmailGeneratorLabel(generator) {
  const customEmailPoolGenerator = typeof CUSTOM_EMAIL_POOL_GENERATOR === 'string'
    ? CUSTOM_EMAIL_POOL_GENERATOR
    : 'custom-pool';
  const gmailAliasGenerator = typeof GMAIL_ALIAS_GENERATOR === 'string'
    ? GMAIL_ALIAS_GENERATOR
    : 'gmail-alias';
  if (generator === 'custom') {
    return '自定义邮箱';
  }
  if (generator === gmailAliasGenerator) {
    return 'Gmail +tag 邮箱';
  }
  if (generator === customEmailPoolGenerator) {
    return '自定义邮箱池';
  }
  if (generator === 'icloud') {
    return 'iCloud 隐私邮箱';
  }
  if (generator === 'cloudflare') return 'Cloudflare 邮箱';
  if (generator === CLOUDFLARE_TEMP_EMAIL_GENERATOR) return 'Cloudflare Temp Email';
  if (generator === CLOUD_MAIL_GENERATOR) return 'Cloud Mail';
  return 'Duck 邮箱';
}
const mail2925SessionManager = self.MultiPageBackgroundMail2925Session?.createMail2925SessionManager({
  addLog,
  broadcastDataUpdate,
  chrome,
  findMail2925Account,
  getMail2925AccountStatus,
  getState,
  isAutoRunLockedState,
  isMail2925AccountAvailable: self.Mail2925Utils?.isMail2925AccountAvailable,
  MAIL2925_LIMIT_COOLDOWN_MS,
  normalizeMail2925Account,
  normalizeMail2925Accounts,
  pickMail2925AccountForRun,
  requestStop,
  ensureContentScriptReadyOnTab,
  reuseOrCreateTab,
  sendToContentScriptResilient,
  sendToMailContentScriptResilient,
  setPersistentSettings,
  setState,
  sleepWithStop,
  throwIfStopped,
  upsertMail2925AccountInList,
  waitForTabComplete,
  waitForTabUrlMatch,
});

async function upsertMail2925Account(input = {}) {
  return mail2925SessionManager.upsertMail2925Account(input);
}

async function deleteMail2925Account(accountId) {
  return mail2925SessionManager.deleteMail2925Account(accountId);
}

async function deleteMail2925Accounts(mode = 'all') {
  return mail2925SessionManager.deleteMail2925Accounts(mode);
}

async function patchMail2925Account(accountId, updates = {}) {
  return mail2925SessionManager.patchMail2925Account(accountId, updates);
}

async function setCurrentMail2925Account(accountId, options = {}) {
  return mail2925SessionManager.setCurrentMail2925Account(accountId, options);
}

function getCurrentMail2925Account(state = null) {
  return mail2925SessionManager.getCurrentMail2925Account(state || {});
}

async function ensureMail2925AccountForFlow(options = {}) {
  return mail2925SessionManager.ensureMail2925AccountForFlow(options);
}

async function ensureMail2925MailboxSession(options = {}) {
  return mail2925SessionManager.ensureMail2925MailboxSession(options);
}

async function handleMail2925LimitReachedError(step, error) {
  return mail2925SessionManager.handleMail2925LimitReachedError(step, error);
}

function isMail2925LimitReachedError(error) {
  if (typeof mail2925SessionManager !== 'undefined' && mail2925SessionManager?.isMail2925LimitReachedError) {
    return mail2925SessionManager.isMail2925LimitReachedError(error);
  }
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /^MAIL2925_LIMIT_REACHED::/.test(message)
    || /子邮箱.{0,12}已达上限|已达上限邮箱|子邮箱上限|邮箱已达上限/i.test(message);
}

function isMail2925ThreadTerminatedError(error) {
  if (typeof mail2925SessionManager !== 'undefined' && mail2925SessionManager?.isMail2925ThreadTerminatedError) {
    return mail2925SessionManager.isMail2925ThreadTerminatedError(error);
  }
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /^MAIL2925_THREAD_TERMINATED::/.test(message);
}

function isMail2925PoolExhaustedPauseError(error) {
  if (typeof mail2925SessionManager !== 'undefined' && mail2925SessionManager?.isMail2925PoolExhaustedPauseError) {
    return mail2925SessionManager.isMail2925PoolExhaustedPauseError(error);
  }
  const message = String(typeof error === 'string' ? error : error?.message || '');
  return /^MAIL2925_POOL_EXHAUSTED_PAUSE::/.test(message);
}

const generatedEmailHelpers = self.MultiPageGeneratedEmailHelpers?.createGeneratedEmailHelpers({
  addLog,
  buildGeneratedAliasEmail,
  buildCloudflareTempEmailHeaders,
  CLOUDFLARE_TEMP_EMAIL_GENERATOR,
  CUSTOM_EMAIL_POOL_GENERATOR,
  DUCK_AUTOFILL_URL,
  fetch,
  fetchIcloudHideMyEmail,
  getCloudflareTempEmailAddressFromResponse,
  getCloudflareTempEmailConfig,
  getCustomEmailPoolEntry: getCustomEmailPoolEntryForRun,
  getCustomEmailPoolEmail: getCustomEmailPoolEmailForRun,
  getRegistrationEmailBaseline,
  getState,
  ensureMail2925AccountForFlow,
  joinCloudflareTempEmailUrl,
  normalizeCloudflareDomain,
  normalizeCloudflareTempEmailAddress,
  normalizeEmailGenerator,
  isGeneratedAliasProvider,
  persistRegistrationEmailState,
  reuseOrCreateTab,
  sendToContentScript,
  setEmailState,
  setState,
  throwIfStopped,
});

function generateCloudflareAliasLocalPart() {
  return generatedEmailHelpers.generateCloudflareAliasLocalPart();
}

async function fetchCloudflareEmail(state, options = {}) {
  return generatedEmailHelpers.fetchCloudflareEmail(state, options);
}

function ensureCloudflareTempEmailConfig(state, options = {}) {
  return generatedEmailHelpers.ensureCloudflareTempEmailConfig(state, options);
}

async function requestCloudflareTempEmailJson(config, path, options = {}) {
  return generatedEmailHelpers.requestCloudflareTempEmailJson(config, path, options);
}

async function fetchCloudflareTempEmailAddress(state, options = {}) {
  return generatedEmailHelpers.fetchCloudflareTempEmailAddress(state, options);
}

async function fetchDuckEmail(options = {}) {
  return generatedEmailHelpers.fetchDuckEmail(options);
}

async function fetchGeneratedEmail(state, options = {}) {
  const currentState = state || await getState();
  const generator = normalizeEmailGenerator(options.generator ?? currentState.emailGenerator);
  if (generator === CLOUD_MAIL_GENERATOR) {
    return fetchCloudMailAddress(currentState, options);
  }
  return generatedEmailHelpers.fetchGeneratedEmail(state, options);
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;
let autoRunAttemptRun = 0;
let autoRunSessionId = 0;
let autoRunSessionSeed = 0;
let runScopedCheckoutConversionProxySnapshot = null;
let ipProxyAutoSyncRunning = false;
const EMAIL_FETCH_MAX_ATTEMPTS = 5;
const VERIFICATION_POLL_MAX_ROUNDS = 5;
const STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS = 25000;
const MAIL_2925_VERIFICATION_MAX_ATTEMPTS = 15;
const MAIL_2925_VERIFICATION_INTERVAL_MS = 15000;
const AUTO_RUN_NODE_DELAYS = Object.freeze({
  'open-chatgpt': 2000,
  'submit-signup-email': 2000,
  'fill-password': 3000,
  'fetch-signup-code': 2000,
  'fill-profile': 0,
  'wait-registration-success': 3000,
  'plus-checkout-create': 3000,
  'oauth-login': 2000,
  'fetch-login-code': 2000,
  'confirm-oauth': 1000,
  'platform-verify': 0,
});

function getAutoRunNodeDelayMs(nodeId) {
  return AUTO_RUN_NODE_DELAYS[String(nodeId || '').trim()] ?? 0;
}
const accountRunHistoryHelpers = self.MultiPageBackgroundAccountRunHistory?.createAccountRunHistoryHelpers({
  ACCOUNT_RUN_HISTORY_STORAGE_KEY,
  addLog,
  buildLocalHelperEndpoint: (baseUrl, path) => buildHotmailLocalEndpoint(baseUrl, path),
  chrome,
  getErrorMessage,
  getNodeIdByStepForState,
  getNodeTitleForState,
  getState,
  normalizeAccountRunHistoryHelperBaseUrl,
});
const contributionOAuthManager = self.MultiPageBackgroundContributionOAuth?.createContributionOAuthManager({
  addLog,
  broadcastDataUpdate,
  chrome,
  closeLocalhostCallbackTabs,
  createAutomationTab,
  getState,
  queryTabsInAutomationWindow,
  setState,
});
contributionOAuthManager?.ensureCallbackListeners?.();

async function broadcastAccountRunHistoryUpdate() {
  if (!accountRunHistoryHelpers?.getPersistedAccountRunHistory) {
    return [];
  }

  const history = await accountRunHistoryHelpers.getPersistedAccountRunHistory();
  broadcastDataUpdate({ accountRunHistory: history });
  return history;
}

async function appendAndBroadcastAccountRunRecord(status, stateOverride = null, reason = '') {
  if (!accountRunHistoryHelpers?.appendAccountRunRecord) {
    return null;
  }

  const state = stateOverride || await getState();
  const resolvedStatus = resolveAccountRunRecordStatusForStop(status, state);
  const resolvedReason = resolveAccountRunRecordReasonForStop(resolvedStatus, reason);
  const record = await accountRunHistoryHelpers.appendAccountRunRecord(resolvedStatus, state, resolvedReason);
  if (!record) {
    return null;
  }

  await broadcastAccountRunHistoryUpdate();
  if (typeof syncFeishuAccountResult === 'function') {
    await syncFeishuAccountResult({
      accountRecord: record,
      finalStatus: record.finalStatus,
      failureReason: record.failureDetail || reason,
    }, {
      state,
      silent: true,
    });
  }
  return record;
}

async function clearAndBroadcastAccountRunHistory(stateOverride = null) {
  if (!accountRunHistoryHelpers?.clearAccountRunHistory) {
    return { clearedCount: 0 };
  }

  const result = await accountRunHistoryHelpers.clearAccountRunHistory(stateOverride);
  await broadcastAccountRunHistoryUpdate();
  return result;
}

async function deleteAndBroadcastAccountRunHistoryRecords(recordIds = [], stateOverride = null) {
  if (!accountRunHistoryHelpers?.deleteAccountRunHistoryRecords) {
    return { deletedCount: 0, remainingCount: 0 };
  }

  const result = await accountRunHistoryHelpers.deleteAccountRunHistoryRecords(recordIds, stateOverride);
  await broadcastAccountRunHistoryUpdate();
  return result;
}

function resolveIpProxyCandidateCountForAutoSwitch(state = {}, mode = 'account', provider = DEFAULT_IP_PROXY_SERVICE) {
  const normalizedMode = typeof normalizeIpProxyMode === 'function'
    ? normalizeIpProxyMode(mode)
    : String(mode || 'account').trim().toLowerCase();
  const normalizedProvider = typeof normalizeIpProxyProviderValue === 'function'
    ? normalizeIpProxyProviderValue(provider)
    : String(provider || DEFAULT_IP_PROXY_SERVICE).trim().toLowerCase();
  if (normalizedMode === 'account' && typeof getAccountModeProxyPoolFromState === 'function') {
    const pool = getAccountModeProxyPoolFromState(state, normalizedProvider);
    return Array.isArray(pool) ? pool.length : 0;
  }
  if (typeof getIpProxyRuntimeSnapshot === 'function') {
    const runtime = getIpProxyRuntimeSnapshot(state, normalizedMode, normalizedProvider);
    return Array.isArray(runtime?.pool) ? runtime.pool.length : 0;
  }
  return 0;
}

function resolveIpProxyAutoSyncIntervalMinutes(value, fallback = IP_PROXY_AUTO_SYNC_DEFAULT_INTERVAL_MINUTES) {
  return normalizeIpProxyAutoSyncIntervalMinutes(value, fallback);
}

async function clearIpProxyAutoSyncAlarm() {
  await chrome.alarms.clear(IP_PROXY_AUTO_SYNC_ALARM_NAME);
}

async function ensureIpProxyAutoSyncAlarm(stateOverride = null) {
  if (!LEGACY_IP_PROXY_FEATURE_ENABLED) {
    await clearIpProxyAutoSyncAlarm();
    return false;
  }
  const state = stateOverride || await getState();
  const enabled = Boolean(state?.ipProxyAutoSyncEnabled);
  if (!enabled) {
    await clearIpProxyAutoSyncAlarm();
    return false;
  }
  const intervalMinutes = resolveIpProxyAutoSyncIntervalMinutes(
    state?.ipProxyAutoSyncIntervalMinutes,
    PERSISTED_SETTING_DEFAULTS.ipProxyAutoSyncIntervalMinutes
  );
  const existingAlarm = await chrome.alarms.get(IP_PROXY_AUTO_SYNC_ALARM_NAME);
  const existingPeriod = Number(existingAlarm?.periodInMinutes) || 0;
  if (!existingAlarm || Math.abs(existingPeriod - intervalMinutes) > 0.0001) {
    await chrome.alarms.clear(IP_PROXY_AUTO_SYNC_ALARM_NAME);
    await chrome.alarms.create(IP_PROXY_AUTO_SYNC_ALARM_NAME, {
      periodInMinutes: intervalMinutes,
      delayInMinutes: intervalMinutes,
    });
  }
  return true;
}

async function runIpProxyAutoSync(trigger = 'alarm') {
  if (!LEGACY_IP_PROXY_FEATURE_ENABLED) {
    await clearIpProxyAutoSyncAlarm();
    return { skipped: true, reason: 'feature_disabled' };
  }
  if (ipProxyAutoSyncRunning) {
    return { skipped: true, reason: 'running' };
  }
  ipProxyAutoSyncRunning = true;
  try {
    const state = await getState();
    if (!state?.ipProxyAutoSyncEnabled) {
      await clearIpProxyAutoSyncAlarm();
      return { skipped: true, reason: 'disabled' };
    }
    if (!state?.ipProxyEnabled) {
      return { skipped: true, reason: 'proxy_disabled' };
    }
    const mode = typeof normalizeIpProxyMode === 'function'
      ? normalizeIpProxyMode(state?.ipProxyMode)
      : String(state?.ipProxyMode || 'account').trim().toLowerCase();
    const result = await refreshIpProxyPool({
      state,
      mode,
      skipExitProbe: true,
    });
    if (typeof addLog === 'function') {
      const display = String(result?.display || '').trim();
      await addLog(
        display
          ? `IP 代理自动同步完成（${trigger}）：${display}`
          : `IP 代理自动同步完成（${trigger}）。`,
        'info'
      ).catch(() => {});
    }
    return { skipped: false, result };
  } catch (error) {
    if (typeof addLog === 'function') {
      await addLog(
        `IP 代理自动同步失败：${error?.message || String(error || '未知错误')}`,
        'warn'
      ).catch(() => {});
    }
    return { skipped: true, reason: 'error', error: error?.message || String(error || '未知错误') };
  } finally {
    ipProxyAutoSyncRunning = false;
  }
}

async function disableLegacyIpProxyFeatureRuntime() {
  if (typeof clearIpProxyAutoSyncAlarm === 'function') {
    await clearIpProxyAutoSyncAlarm().catch(() => {});
  }
  if (typeof clearIpProxySettings === 'function') {
    await clearIpProxySettings({ resetLastAppliedAuthSnapshot: true }).catch(() => {});
  }
  if (typeof setIpProxyLeakGuardEnabled === 'function') {
    await setIpProxyLeakGuardEnabled(false).catch(() => {});
  }

  const state = await getState().catch(() => ({}));
  const patch = {
    ipProxyEnabled: false,
    ipProxyAutoSyncEnabled: false,
    ipProxyApplied: false,
    ipProxyAppliedReason: 'feature_removed',
    ipProxyAppliedAt: 0,
    ipProxyAppliedHost: '',
    ipProxyAppliedPort: 0,
    ipProxyAppliedRegion: '',
    ipProxyAppliedHasAuth: false,
    ipProxyAppliedProvider: '',
    ipProxyAppliedError: '',
    ipProxyAppliedWarning: '',
    ipProxyAppliedExitIp: '',
    ipProxyAppliedExitRegion: '',
    ipProxyAppliedExitDetecting: false,
    ipProxyAppliedExitError: '',
    ipProxyAppliedExitSource: '',
    ipProxyAppliedExitEndpoint: '',
    ipProxyPool: [],
    ipProxyCurrentIndex: 0,
    ipProxyCurrent: null,
    ipProxyApiPool: [],
    ipProxyApiCurrentIndex: 0,
    ipProxyApiCurrent: null,
    ipProxyAccountPool: [],
    ipProxyAccountCurrentIndex: 0,
    ipProxyAccountCurrent: null,
    ipProxyExitRegion: '',
  };
  const shouldUpdateRuntime = Object.keys(patch).some((key) => {
    const nextValue = patch[key];
    const currentValue = state?.[key];
    return JSON.stringify(currentValue) !== JSON.stringify(nextValue);
  });
  if (shouldUpdateRuntime) {
    await setState(patch).catch(() => {});
    broadcastDataUpdate(patch);
  }
  await setPersistentSettings({
    ipProxyEnabled: false,
    ipProxyAutoSyncEnabled: false,
  }).catch(() => {});
}

async function maybeSwitchIpProxyAfterAutoRunRoundSuccess(payload = {}) {
  if (!LEGACY_IP_PROXY_FEATURE_ENABLED) {
    return null;
  }
  if (typeof switchIpProxy !== 'function') {
    return null;
  }
  const successfulRuns = Number(payload?.successfulRuns) || 0;
  if (successfulRuns <= 0) {
    return null;
  }

  const state = await getState();
  if (!state?.ipProxyEnabled) {
    return null;
  }

  const mode = typeof normalizeIpProxyMode === 'function'
    ? normalizeIpProxyMode(state?.ipProxyMode)
    : String(state?.ipProxyMode || 'account').trim().toLowerCase();
  const provider = typeof normalizeIpProxyProviderValue === 'function'
    ? normalizeIpProxyProviderValue(state?.ipProxyService)
    : String(state?.ipProxyService || DEFAULT_IP_PROXY_SERVICE).trim().toLowerCase();
  const threshold = typeof resolveIpProxyAutoSwitchThreshold === 'function'
    ? resolveIpProxyAutoSwitchThreshold(state)
    : Math.max(1, Math.min(500, Number(state?.ipProxyPoolTargetCount) || 20));
  if (successfulRuns % threshold !== 0) {
    return null;
  }

  const candidateCount = resolveIpProxyCandidateCountForAutoSwitch(state, mode, provider);
  if (candidateCount <= 1) {
    await addLog(
      `任务切换阈值命中（成功 ${successfulRuns} 轮 / 阈值 ${threshold}），但当前仅 ${candidateCount} 条可切换代理，已跳过自动切换。`,
      'info'
    );
    return {
      skipped: true,
      reason: 'insufficient_candidates',
      candidateCount,
      threshold,
      successfulRuns,
    };
  }

  const switchResult = await switchIpProxy('next', {
    mode,
    state,
    forceRefresh: mode === 'api',
    maxItems: typeof resolveIpProxyPoolTargetCountForMode === 'function'
      ? resolveIpProxyPoolTargetCountForMode(state, mode)
      : undefined,
  });
  const display = String(switchResult?.display || '').trim();
  const routingApplied = Boolean(switchResult?.proxyRouting?.applied);
  await addLog(
    routingApplied
      ? `任务切换阈值命中（成功 ${successfulRuns} 轮 / 阈值 ${threshold}），已自动切换代理：${display || '已切换到下一条'}。`
      : `任务切换阈值命中（成功 ${successfulRuns} 轮 / 阈值 ${threshold}），已尝试自动切换代理，但连通性仍异常。`,
    routingApplied ? 'ok' : 'warn'
  );
  return switchResult;
}

const autoRunController = self.MultiPageBackgroundAutoRunController?.createAutoRunController({
  addLog,
  appendAccountRunRecord: (...args) => appendAndBroadcastAccountRunRecord(...args),
  AUTO_RUN_MAX_RETRIES_PER_ROUND,
  AUTO_RUN_RETRY_DELAY_MS,
  AUTO_RUN_TIMER_KIND_BEFORE_RETRY,
  AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS,
  broadcastAutoRunStatus,
  broadcastStopToContentScripts,
  cancelPendingCommands,
  clearStopRequest: () => clearStopRequest(),
  createAutoRunSessionId: () => createAutoRunSessionId(),
  ensureHotmailMailboxReadyForAutoRunRound: (...args) => ensureHotmailMailboxReadyForAutoRunRound(...args),
  getAutoRunStatusPayload,
  getExternalRedeemQualifiedFailureMessage,
  getErrorMessage,
  getFirstUnfinishedNodeId,
  getPendingAutoRunTimerPlan,
  getRunningNodeIds,
  getState,
  getStopRequested: () => stopRequested,
  hasUnusedCustomEmailPoolEntry,
  hasSavedNodeProgress,
  isAddPhoneAuthFailure,
  isExternalRedeemQualifiedFailureError,
  isPhoneSmsPlatformRateLimitFailure,
  isPlusCheckoutNonFreeTrialFailure,
  isRestartCurrentAttemptError,
  isStep4Route405RecoveryLimitFailure,
  isSignupUserAlreadyExistsFailure,
  isIcloudApiAuthFailureError,
  isVerificationMailPollingError,
  isStopError,
  launchAutoRunTimerPlan,
  markCustomEmailPoolEntryUsedByEmail,
  normalizeAutoRunFallbackThreadIntervalMinutes,
  onAutoRunRoundSuccess: async (payload = {}) => {
    if (LEGACY_IP_PROXY_FEATURE_ENABLED) {
      return maybeSwitchIpProxyAfterAutoRunRoundSuccess(payload);
    }
    return null;
  },
  persistAutoRunTimerPlan,
  resetState,
  runAutoSequenceFromNode: (...args) => runAutoSequenceFromNode(...args),
  runtime: {
    get: () => ({
      autoRunActive,
      autoRunCurrentRun,
      autoRunTotalRuns,
      autoRunAttemptRun,
      autoRunSessionId,
    }),
    set: (updates = {}) => {
      if (updates.autoRunActive !== undefined) autoRunActive = Boolean(updates.autoRunActive);
      if (updates.autoRunCurrentRun !== undefined) autoRunCurrentRun = Number(updates.autoRunCurrentRun) || 0;
      if (updates.autoRunTotalRuns !== undefined) autoRunTotalRuns = Number(updates.autoRunTotalRuns) || 0;
      if (updates.autoRunAttemptRun !== undefined) autoRunAttemptRun = Number(updates.autoRunAttemptRun) || 0;
      if (updates.autoRunSessionId !== undefined) autoRunSessionId = normalizeAutoRunSessionId(updates.autoRunSessionId);
    },
  },
  setState,
  sleepWithStop,
  throwIfAutoRunSessionStopped: (sessionId) => throwIfAutoRunSessionStopped(sessionId),
  waitForRunningNodesToFinish,
  throwIfStopped: () => throwIfStopped(),
  chrome,
});

async function resumeAutoRunIfWaitingForEmail(options = {}) {
  const { silent = false } = options;
  const state = await getState();
  if (!state.email || !isAutoRunPausedState(state)) {
    return false;
  }

  if (resumeWaiter) {
    if (!silent) {
      await addLog('邮箱已就绪，自动继续后续步骤...', 'info');
    }
    resumeWaiter.resolve();
    resumeWaiter = null;
    return true;
  }

  return false;
}

function shouldStopIcloudAutoFetchRetries(error) {
  if (!error) {
    return false;
  }

  if (error.code === 'ICLOUD_TRANSIENT_CONTEXT') {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  if (message.includes('请先在新打开的 icloud 页面中完成登录')) {
    return true;
  }
  return message.includes('网络/上下文波动')
    || message.includes('could not validate icloud session')
    || message.includes('status 421')
    || message.includes('failed to fetch')
    || message.includes('network request failed')
    || message.includes('networkerror')
    || message.includes('cors')
    || message.includes('address space')
    || message.includes('timed out')
    || message.includes('timeout');
}

function shouldStopEmailAutoFetchRetries(generator, error) {
  if (generator === 'icloud' && shouldStopIcloudAutoFetchRetries(error)) {
    return true;
  }
  const message = String(error?.message || '');
  if (generator === 'cloudflare' && /域名/.test(message)) {
    return true;
  }
  return generator === CLOUDFLARE_TEMP_EMAIL_GENERATOR && /(服务地址|Admin Auth|域名)/.test(message);
}

async function ensureAutoEmailReady(targetRun, totalRuns, attemptRuns) {
  const currentState = await getState();
  if (isHotmailProvider(currentState)) {
    const account = await ensureHotmailAccountForFlow({
      allowAllocate: true,
      markUsed: true,
      preferredAccountId: null,
    });
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：已分配 Hotmail 账号 ${account.email}（第 ${attemptRuns} 次尝试）===`, 'ok');
    return account.registrationAliasEmail || (await getState()).email || account.email;
  }

  if (isLuckmailProvider(currentState)) {
    const purchase = await ensureLuckmailPurchaseForFlow({ allowReuse: true });
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：LuckMail 邮箱已就绪：${purchase.email_address}（第 ${attemptRuns} 次尝试）===`, 'ok');
    return purchase.email_address;
  }

  if (isGeneratedAliasProvider(currentState)) {
    if (currentState.mailProvider === GMAIL_PROVIDER) {
      if (!currentState.emailPrefix) {
        throw new Error('Gmail 原邮箱未设置，请先在侧边栏填写。');
      }
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：Gmail +tag 模式已启用，将在步骤 3 自动生成邮箱（第 ${attemptRuns} 次尝试）===`, 'info');
      return null;
    }
    if (!currentState.emailPrefix) {
      throw new Error('2925 邮箱前缀未设置，请先在侧边栏填写。');
    }
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：2925 模式已启用，将在步骤 3 自动生成邮箱（第 ${attemptRuns} 次尝试）===`, 'info');
    return null;
  }

  if (currentState.email) {
    return currentState.email;
  }

  if (isCustomMailProvider(currentState)) {
    const poolSize = getCustomMailProviderPool(currentState).length;
    if (poolSize > 0) {
      const queuedEmail = getCustomMailProviderPoolEmailForRun(currentState, targetRun);
      if (!queuedEmail) {
        throw new Error(`自定义邮箱号池第 ${targetRun} 个邮箱不存在，请检查号池数量是否与自动轮数一致。`);
      }
      await setEmailState(queuedEmail);
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：自定义邮箱号池已就绪：${queuedEmail}（第 ${attemptRuns} 次尝试；第 4/8 步仍需手动输入验证码）===`, 'ok');
      return queuedEmail;
    }
  }

  if (isCustomEmailPoolGenerator(currentState)) {
    const poolSelection = getCustomEmailPoolSelectionForRun(currentState, targetRun);
    const queuedEmail = String(poolSelection.entry?.email || '').trim();
    if (!queuedEmail) {
      const poolSize = Number(poolSelection.total) || getCustomEmailPoolEntries(currentState).length;
      throw new Error(
        poolSize > 0
          ? `自定义邮箱池未用邮箱已耗尽（总数 ${poolSize}，已用 ${Number(poolSelection.used) || 0}），请补充邮箱或清空已用后重试。`
          : '自定义邮箱池为空，请先至少填写 1 个邮箱。'
      );
    }
    await setEmailState(queuedEmail);
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：自定义邮箱池已就绪：${queuedEmail}（第 ${attemptRuns} 次尝试；剩余未用 ${Math.max(0, Number(poolSelection.unused) || 0)} / 总数 ${Number(poolSelection.total) || 0}）===`, 'ok');
    return queuedEmail;
  }

  if (shouldUseCustomRegistrationEmail(currentState)) {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮已暂停：请先填写自定义注册邮箱，然后继续 ===`, 'warn');
    await broadcastAutoRunStatus('waiting_email', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });

    await waitForResume();

    const resumedState = await getState();
    if (!resumedState.email) {
      throw new Error('无法继续：当前没有注册邮箱。');
    }
    return resumedState.email;
  }

  const generator = normalizeEmailGenerator(currentState.emailGenerator);
  const generatorLabel = getEmailGeneratorLabel(generator);
  let lastError = null;
  let attemptedFetches = 0;
  for (let attempt = 1; attempt <= EMAIL_FETCH_MAX_ATTEMPTS; attempt++) {
    attemptedFetches = attempt;
    try {
      if (attempt > 1) {
        await addLog(`${generatorLabel}：正在进行第 ${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS} 次自动获取重试...`, 'warn');
      }
      const generatedEmail = await fetchGeneratedEmail(currentState, {
        generateNew: generator !== 'icloud' || normalizeIcloudFetchMode(currentState.icloudFetchMode) === 'always_new',
        generator,
      });
      await addLog(
        `=== 目标 ${targetRun}/${totalRuns} 轮：${generatorLabel}已就绪：${generatedEmail}（第 ${attemptRuns} 次尝试，第 ${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS} 次获取）===`,
        'ok'
      );
      return generatedEmail;
    } catch (err) {
      lastError = err;
      await addLog(`${generatorLabel}自动获取失败（${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS}）：${err.message}`, 'warn');
      if (generator === 'icloud' && shouldStopIcloudAutoFetchRetries(err)) {
        await addLog('iCloud：检测到会话/网络异常，本轮将停止重复重试。请先确认 iCloud 页面已登录，再点击“我已登录”或手动粘贴邮箱继续。', 'warn');
      }
      if (shouldStopEmailAutoFetchRetries(generator, err)) {
        break;
      }
    }
  }

  const totalAttempts = Math.max(1, attemptedFetches);
  await addLog(`${generatorLabel}自动获取已连续失败 ${totalAttempts} 次：${lastError?.message || '未知错误'}`, 'error');
  await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮已暂停：请先自动获取邮箱或手动粘贴邮箱，然后继续 ===`, 'warn');
  await broadcastAutoRunStatus('waiting_email', {
    currentRun: targetRun,
    totalRuns,
    attemptRun: attemptRuns,
  });

  await waitForResume();

  const resumedState = await getState();
  if (!resumedState.email) {
    throw new Error('无法继续：当前没有邮箱地址。');
  }
  return resumedState.email;
}

async function ensureAutoEmailReady(targetRun, totalRuns, attemptRuns) {
  const currentState = await getState();
  if (isHotmailProvider(currentState)) {
    const account = await ensureHotmailAccountForFlow({
      allowAllocate: true,
      markUsed: true,
      preferredAccountId: null,
    });
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：已分配 Hotmail 账号 ${account.email}（第 ${attemptRuns} 次尝试）===`, 'ok');
    return account.registrationAliasEmail || (await getState()).email || account.email;
  }

  if (isLuckmailProvider(currentState)) {
    const purchase = await ensureLuckmailPurchaseForFlow({ allowReuse: true });
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：LuckMail 邮箱已就绪：${purchase.email_address}（第 ${attemptRuns} 次尝试）===`, 'ok');
    return purchase.email_address;
  }

  if (isGeneratedAliasProvider(currentState)) {
    if (isReusableGeneratedAliasEmail(currentState)) {
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：当前已复用 ${currentState.email}，将直接继续执行（第 ${attemptRuns} 次尝试）===`, 'info');
      return currentState.email;
    }

    let managedAliasState = currentState;
    if (
      String(currentState.mailProvider || '').trim().toLowerCase() === '2925'
      && Boolean(currentState.mail2925UseAccountPool)
    ) {
      const account = await ensureMail2925AccountForFlow({
        allowAllocate: true,
        preferredAccountId: currentState.currentMail2925AccountId || null,
        markUsed: true,
      });
      managedAliasState = {
        ...(await getState()),
        currentMail2925AccountId: account.id,
      };
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：已分配 2925 账号 ${account.email}（第 ${attemptRuns} 次尝试）===`, 'ok');
    }

    const baseEmail = getManagedAliasBaseEmail(managedAliasState);
    if (!baseEmail && !managedAliasState.email) {
      const baseLabel = currentState.mailProvider === GMAIL_PROVIDER ? 'Gmail 原邮箱' : '2925 基邮箱';
      throw new Error(`${baseLabel}未设置，请先填写，或直接在“注册邮箱”中手动填写完整邮箱。`);
    }

    await addLog(
      `=== 目标 ${targetRun}/${totalRuns} 轮：${currentState.mailProvider === GMAIL_PROVIDER ? 'Gmail +tag' : '2925'} 模式已启用，将在步骤 3 自动生成邮箱（第 ${attemptRuns} 次尝试）===`,
      'info'
    );
    return null;
  }

  if (currentState.email) {
    return currentState.email;
  }

  if (isCustomMailProvider(currentState)) {
    const poolSize = getCustomMailProviderPool(currentState).length;
    if (poolSize > 0) {
      const queuedEmail = getCustomMailProviderPoolEmailForRun(currentState, targetRun);
      if (!queuedEmail) {
        throw new Error(`自定义邮箱号池第 ${targetRun} 个邮箱不存在，请检查号池数量是否与自动轮数一致。`);
      }
      await setEmailState(queuedEmail);
      await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：自定义邮箱号池已就绪：${queuedEmail}（第 ${attemptRuns} 次尝试；第 4/8 步仍需手动输入验证码）===`, 'ok');
      return queuedEmail;
    }
  }

  if (isCustomEmailPoolGenerator(currentState)) {
    const poolSelection = getCustomEmailPoolSelectionForRun(currentState, targetRun);
    const queuedEmail = String(poolSelection.entry?.email || '').trim();
    if (!queuedEmail) {
      const poolSize = Number(poolSelection.total) || getCustomEmailPoolEntries(currentState).length;
      throw new Error(
        poolSize > 0
          ? `自定义邮箱池未用邮箱已耗尽（总数 ${poolSize}，已用 ${Number(poolSelection.used) || 0}），请补充邮箱或清空已用后重试。`
          : '自定义邮箱池为空，请先至少填写 1 个邮箱。'
      );
    }
    await setEmailState(queuedEmail);
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：自定义邮箱池已就绪：${queuedEmail}（第 ${attemptRuns} 次尝试；剩余未用 ${Math.max(0, Number(poolSelection.unused) || 0)} / 总数 ${Number(poolSelection.total) || 0}）===`, 'ok');
    return queuedEmail;
  }

  if (shouldUseCustomRegistrationEmail(currentState)) {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮已暂停：请先填写自定义注册邮箱，然后继续 ===`, 'warn');
    await broadcastAutoRunStatus('waiting_email', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });

    await waitForResume();

    const resumedState = await getState();
    if (!resumedState.email) {
      throw new Error('无法继续：当前没有注册邮箱。');
    }
    return resumedState.email;
  }

  const generator = normalizeEmailGenerator(currentState.emailGenerator);
  const generatorLabel = getEmailGeneratorLabel(generator);
  let lastError = null;
  let attemptedFetches = 0;
  for (let attempt = 1; attempt <= EMAIL_FETCH_MAX_ATTEMPTS; attempt++) {
    attemptedFetches = attempt;
    try {
      if (attempt > 1) {
        await addLog(`${generatorLabel}：正在进行第 ${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS} 次自动获取重试...`, 'warn');
      }
      const generatedEmail = await fetchGeneratedEmail(currentState, {
        generateNew: generator !== 'icloud' || normalizeIcloudFetchMode(currentState.icloudFetchMode) === 'always_new',
        generator,
      });
      await addLog(
        `=== 目标 ${targetRun}/${totalRuns} 轮：${generatorLabel}已就绪：${generatedEmail}（第 ${attemptRuns} 次尝试，第 ${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS} 次获取）===`,
        'ok'
      );
      return generatedEmail;
    } catch (err) {
      lastError = err;
      await addLog(`${generatorLabel}自动获取失败（${attempt}/${EMAIL_FETCH_MAX_ATTEMPTS}）：${err.message}`, 'warn');
      if (generator === 'icloud' && shouldStopIcloudAutoFetchRetries(err)) {
        await addLog('iCloud：检测到会话/网络异常，本轮将停止重复重试。请先确认 iCloud 页面已登录，再点击“我已登录”或手动粘贴邮箱继续。', 'warn');
      }
      if (shouldStopEmailAutoFetchRetries(generator, err)) {
        break;
      }
    }
  }

  const totalAttempts = Math.max(1, attemptedFetches);
  await addLog(`${generatorLabel}自动获取已连续失败 ${totalAttempts} 次：${lastError?.message || '未知错误'}`, 'error');
  await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮已暂停：请先自动获取邮箱或手动粘贴邮箱，然后继续 ===`, 'warn');
  await broadcastAutoRunStatus('waiting_email', {
    currentRun: targetRun,
    totalRuns,
    attemptRun: attemptRuns,
  });

  await waitForResume();

  const resumedState = await getState();
  if (!resumedState.email) {
    throw new Error('无法继续：当前没有邮箱地址。');
  }
  return resumedState.email;
}

async function runAutoSequenceFromNode(startNodeId, context = {}) {
  const state = await getState();
  const normalizedStartNodeId = String(startNodeId || '').trim();
  if (!normalizedStartNodeId || !getAutoRunWorkflowNodeIds(state).includes(normalizedStartNodeId)) {
    throw new Error(`自动运行无法从未知节点继续：${startNodeId}`);
  }
  const runner = () => runAutoSequenceFromNodeGraph(normalizedStartNodeId, context);
  if (context?.skipCheckoutConversionProxy || context?.k12Workspace) {
    return runner();
  }
  if (!context?.continued) {
    await selectNextCheckoutConversionProxyForAutoRun(context);
  }
  return runWithCheckoutConversionProxyDuringPluginUse(
    runner,
    {
      startLog: '全流程代理已启用：本轮插件执行期间，浏览器网络都会走该代理。',
      finishReason: '本轮自动运行结束',
    }
  );
}

function getAutoRunWorkflowNodeIds(state = {}) {
  if (typeof getNodeIdsForState === 'function') {
    const nodeIds = getNodeIdsForState(state);
    if (Array.isArray(nodeIds) && nodeIds.length) {
      return nodeIds.map((nodeId) => String(nodeId || '').trim()).filter(Boolean);
    }
  }

  if (typeof getStepIdsForState === 'function' && typeof getNodeIdByStepForState === 'function') {
    return getStepIdsForState(state)
      .map((step) => getNodeIdByStepForState(step, state))
      .map((nodeId) => String(nodeId || '').trim())
      .filter(Boolean);
  }

  return [];
}

async function runAutoSequenceFromNodeGraph(startNodeId, context = {}) {
  const { targetRun, totalRuns, attemptRuns, continued = false } = context;
  let postStep7RestartCount = 0;
  let plusCheckoutRestartCount = 0;
  let step4RestartCount = 0;
  const nodeIdleRestartCounts = new Map();
  let currentStartNodeId = String(startNodeId || '').trim();
  let continueCurrentAttempt = continued;
  const resolvedSignupMethod = await ensureResolvedSignupMethodForRun();
  const getNodeStatusForNode = (state, nodeId) => (
    String(state?.nodeStatuses?.[nodeId] || 'pending').trim() || 'pending'
  );
  const getDisplayStepForNode = (nodeId, state = {}) => {
    const displayStep = typeof getStepIdByNodeIdForState === 'function'
      ? Number(getStepIdByNodeIdForState(nodeId, state))
      : 0;
    return Number.isInteger(displayStep) && displayStep > 0 ? displayStep : null;
  };
  const getNodeExecutionKey = (nodeId, state = {}) => {
    const nodeDefinition = typeof getNodeDefinitionForState === 'function'
      ? getNodeDefinitionForState(nodeId, state)
      : null;
    return String(nodeDefinition?.executeKey || nodeDefinition?.command || nodeId || '').trim();
  };
  const getNodeLabel = (nodeId, state = {}) => {
    const title = typeof getNodeTitleForState === 'function'
      ? getNodeTitleForState(nodeId, state)
      : '';
    return title && title !== nodeId ? `${nodeId}（${title}）` : nodeId;
  };
  const getNodeIndex = (state, nodeId) => getAutoRunWorkflowNodeIds(state).indexOf(nodeId);
  const shouldRunNamedNode = async (nodeId) => {
    const state = await getState();
    const nodeIds = getAutoRunWorkflowNodeIds(state);
    const targetIndex = nodeIds.indexOf(nodeId);
    if (targetIndex < 0) {
      return false;
    }
    const startIndex = nodeIds.indexOf(currentStartNodeId);
    return startIndex < 0 || startIndex <= targetIndex;
  };
  const getPreviousNodeId = (nodeId, state = {}) => {
    const nodeIds = getAutoRunWorkflowNodeIds(state);
    const index = nodeIds.indexOf(nodeId);
    return index > 0 ? nodeIds[index - 1] : '';
  };
  const setRestartNode = (nodeId) => {
    currentStartNodeId = String(nodeId || '').trim();
    continueCurrentAttempt = true;
  };
  const attachFailedNode = (error, nodeId, state = {}) => {
    const failedNodeId = String(nodeId || '').trim();
    if (!error || typeof error !== 'object' || !failedNodeId) {
      return error;
    }

    if (!String(error.failedNodeId || '').trim()) {
      try {
        error.failedNodeId = failedNodeId;
      } catch (_err) {
        // Some host errors may be non-extensible; state-based inference still covers normal paths.
      }
    }

    const failedStep = getDisplayStepForNode(failedNodeId, state);
    if (!Number.isInteger(Number(error.failedStep)) || Number(error.failedStep) <= 0) {
      try {
        error.failedStep = failedStep;
      } catch (_err) {
        // Some host errors may be non-extensible; state-based inference still covers normal paths.
      }
    }

    return error;
  };
  const invalidateDownstreamAfterAutoRunNodeRestart = async (nodeId, options = {}) => {
    if (typeof invalidateDownstreamAfterNodeRestart === 'function') {
      return invalidateDownstreamAfterNodeRestart(nodeId, options);
    }
    const state = await getState();
    const step = getDisplayStepForNode(nodeId, state);
    if (Number.isInteger(step) && step > 0 && typeof invalidateDownstreamAfterStepRestart === 'function') {
      return invalidateDownstreamAfterStepRestart(step, options);
    }
    return undefined;
  };
  const restartCurrentNodeAfterIdle = async (nodeId, error) => {
    if (!isAutoRunStepIdleRestartError(error)) {
      return false;
    }

    const idleRestartCount = (nodeIdleRestartCounts.get(nodeId) || 0) + 1;
    nodeIdleRestartCounts.set(nodeId, idleRestartCount);
    if (idleRestartCount > AUTO_RUN_STEP_IDLE_RESTART_MAX_ATTEMPTS) {
      await addLog(
        `节点 ${nodeId}：已连续 ${AUTO_RUN_STEP_IDLE_RESTART_MAX_ATTEMPTS} 次因 5 分钟无新日志而重开，停止自动重试。原因：${getErrorMessage(error)}`,
        'error'
      );
      throw error;
    }

    const reason = getErrorMessage(error);
    if (typeof cancelPendingCommands === 'function') {
      cancelPendingCommands(`节点 ${nodeId} 5 分钟没有新日志，准备重开当前节点。`);
    }
    if (typeof broadcastStopToContentScripts === 'function') {
      await broadcastStopToContentScripts();
    }
    await addLog(
      `节点 ${nodeId}：5 分钟没有新日志，准备重新开始当前节点（第 ${idleRestartCount}/${AUTO_RUN_STEP_IDLE_RESTART_MAX_ATTEMPTS} 次）。原因：${reason}`,
      'warn'
    );
    const latestState = await getState();
    const resetAnchorNodeId = getPreviousNodeId(nodeId, latestState) || nodeId;
    await invalidateDownstreamAfterAutoRunNodeRestart(resetAnchorNodeId, {
      logLabel: `节点 ${nodeId} 因 5 分钟无新日志准备重开（第 ${idleRestartCount}/${AUTO_RUN_STEP_IDLE_RESTART_MAX_ATTEMPTS} 次）`,
    });
    setRestartNode(nodeId);
    return true;
  };

  while (true) {

  if (continueCurrentAttempt) {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：继续当前进度，从节点 ${currentStartNodeId} 开始（第 ${attemptRuns} 次尝试）===`, 'info');
  } else {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：第 ${attemptRuns} 次尝试，阶段 1，打开官网并进入密码页 ===`, 'info');
  }

  if (await shouldRunNamedNode('open-chatgpt')) {
    try {
      await executeNodeAndWaitWithAutoRunIdleLogWatchdog('open-chatgpt', getAutoRunNodeDelayMs('open-chatgpt'));
    } catch (err) {
      attachFailedNode(err, 'open-chatgpt', await getState());
      if (isStopError(err)) {
        throw err;
      }
      if (await restartCurrentNodeAfterIdle('open-chatgpt', err)) {
        continue;
      }
      throw err;
    }
  }

  if (await shouldRunNamedNode('submit-signup-email')) {
    try {
      await runAutoNodeActionWithIdleLogWatchdog('submit-signup-email', async () => {
        if (resolvedSignupMethod === SIGNUP_METHOD_PHONE) {
          await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：本轮注册方式为手机号注册，将跳过邮箱预获取 ===`, 'info');
        } else {
          await ensureAutoEmailReady(targetRun, totalRuns, attemptRuns);
        }
        await executeNodeAndWait('submit-signup-email', getAutoRunNodeDelayMs('submit-signup-email'));
      });
    } catch (err) {
      attachFailedNode(err, 'submit-signup-email', await getState());
      if (isStopError(err)) {
        throw err;
      }
      if (await restartCurrentNodeAfterIdle('submit-signup-email', err)) {
        continue;
      }
      throw err;
    }
  }

  let restartFromStep1WithCurrentEmail = false;

  if (await shouldRunNamedNode('fill-password')) {
    const latestState = await getState();
    const fillPasswordStatus = getNodeStatusForNode(latestState, 'fill-password');
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：阶段 2，填写密码、验证、登录并完成授权（第 ${attemptRuns} 次尝试）===`, 'info');
    await broadcastAutoRunStatus('running', {
      currentRun: targetRun,
      totalRuns,
      attemptRun: attemptRuns,
    });
    if (isStepDoneStatus(fillPasswordStatus)) {
      await addLog(`自动运行：节点 fill-password 当前状态为 ${fillPasswordStatus}，将直接继续后续流程。`, 'info');
    } else {
      try {
        await executeNodeAndWaitWithAutoRunIdleLogWatchdog('fill-password', getAutoRunNodeDelayMs('fill-password'));
      } catch (err) {
        attachFailedNode(err, 'fill-password', latestState);
        if (isStopError(err)) {
          throw err;
        }
        if (await restartCurrentNodeAfterIdle('fill-password', err)) {
          continue;
        }
        if (isSignupPhonePasswordMismatchFailure(err)) {
          step4RestartCount += 1;
          await restartSignupPhonePasswordMismatchAttemptFromNode('fill-password', step4RestartCount, err);
          setRestartNode('open-chatgpt');
          restartFromStep1WithCurrentEmail = true;
          continue;
        }
        throw err;
      }
    }
  } else {
    await addLog(`=== 目标 ${targetRun}/${totalRuns} 轮：继续执行剩余流程（第 ${attemptRuns} 次尝试）===`, 'info');
  }

  if (restartFromStep1WithCurrentEmail) {
    continue;
  }

  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }

  let loopState = await getState();
  let nodeIds = getAutoRunWorkflowNodeIds(loopState);
  const firstVerificationIndex = nodeIds.indexOf('fetch-signup-code');
  const startIndex = nodeIds.indexOf(currentStartNodeId);
  let nodeIndex = Math.max(
    startIndex >= 0 ? startIndex : 0,
    firstVerificationIndex >= 0 ? firstVerificationIndex : 0
  );
  while (nodeIndex < nodeIds.length) {
    const latestState = await getState();
    nodeIds = getAutoRunWorkflowNodeIds(latestState);
    const nodeId = nodeIds[nodeIndex];
    if (!nodeId) {
      nodeIndex += 1;
      continue;
    }
    const currentStatus = getNodeStatusForNode(latestState, nodeId);
    if (isStepDoneStatus(currentStatus)) {
      await addLog(`自动运行：节点 ${nodeId} 当前状态为 ${currentStatus}，将直接继续后续流程。`, 'info');
      nodeIndex += 1;
      continue;
    }
    try {
      await executeNodeAndWaitWithAutoRunIdleLogWatchdog(nodeId, getAutoRunNodeDelayMs(nodeId));
      nodeIndex += 1;
    } catch (err) {
      attachFailedNode(err, nodeId, latestState);
      if (isStopError(err)) {
        throw err;
      }

      if (await restartCurrentNodeAfterIdle(nodeId, err)) {
        continue;
      }

      const step = getDisplayStepForNode(nodeId, latestState);
      const nodeExecutionKey = getNodeExecutionKey(nodeId, latestState);
      if (isPlusCheckoutRestartStep(step, nodeExecutionKey, latestState)
        && isPlusCheckoutRestartRequiredFailure(err)) {
        plusCheckoutRestartCount += 1;
        await addLog(
          `节点 ${getNodeLabel(nodeId, latestState)}：检测到 Plus Checkout 失败/卡住，准备回到节点 plus-checkout-create 重新创建 Plus Checkout（第 ${plusCheckoutRestartCount} 次）。原因：${getErrorMessage(err)}`,
          'warn'
        );
        const checkoutResetAnchorNodeId = getPreviousNodeId('plus-checkout-create', latestState) || 'fill-profile';
        await invalidateDownstreamAfterAutoRunNodeRestart(checkoutResetAnchorNodeId, {
          logLabel: `节点 ${nodeId} Plus Checkout 失败后准备回到 plus-checkout-create 重试（第 ${plusCheckoutRestartCount} 次）`,
        });
        nodeIndex = Math.max(0, getNodeIndex(await getState(), 'plus-checkout-create'));
        continue;
      }

      if (nodeId === 'fetch-signup-code') {
        if (isSignupUserAlreadyExistsFailure(err)) {
          throw err;
        }
        if (isMail2925ThreadTerminatedError(err)) {
          await addLog(`节点 fetch-signup-code：2925 已切换账号并要求结束当前尝试：${getErrorMessage(err)}`, 'warn');
          throw err;
        }
        if (isIcloudApiAuthFailureError(err)) {
          await addLog(`节点 fetch-signup-code：当前邮箱取码接口鉴权失败，交给自动运行切换下一个未用邮箱。原因：${getErrorMessage(err)}`, 'warn');
          throw err;
        }
        if (isVerificationMailPollingError(err)) {
          await addLog(
            `节点 fetch-signup-code：验证码暂未获取到，保持当前验证码页，不回到 open-chatgpt 重开。原因：${getErrorMessage(err)}`,
            'warn'
          );
          throw err;
        }
        step4RestartCount += 1;
        const isPhoneResendBanned = typeof phoneVerificationHelpers !== 'undefined'
          && typeof phoneVerificationHelpers?.isPhoneResendBannedNumberError === 'function'
          && phoneVerificationHelpers.isPhoneResendBannedNumberError(err);
        if (isSignupPhonePasswordMismatchFailure(err) || isPhoneResendBanned) {
          await restartSignupPhonePasswordMismatchAttemptFromNode('fetch-signup-code', step4RestartCount, err);
        } else {
          const preservedState = await getState();
          const preservedEmail = String(preservedState.email || '').trim();
          const preservedPassword = String(preservedState.password || '').trim();
          const emailSuffix = preservedEmail ? `当前邮箱：${preservedEmail}；` : '';
          await addLog(
            `节点 fetch-signup-code：执行失败，准备沿用当前邮箱回到节点 open-chatgpt 重新开始（第 ${step4RestartCount} 次重开）。${emailSuffix}原因：${getErrorMessage(err)}`,
            'warn'
          );
          await invalidateDownstreamAfterAutoRunNodeRestart('open-chatgpt', {
            logLabel: `节点 fetch-signup-code 报错后准备回到 open-chatgpt 沿用当前邮箱重试（第 ${step4RestartCount} 次重开）`,
          });
          const restorePayload = {};
          if (preservedEmail) restorePayload.email = preservedEmail;
          if (preservedPassword) restorePayload.password = preservedPassword;
          restorePayload.skipOpenChatgptCookieCleanupOnce = true;
          if (Object.keys(restorePayload).length) {
            await setState(restorePayload);
          }
        }
        setRestartNode('open-chatgpt');
        restartFromStep1WithCurrentEmail = true;
        break;
      }

      if (isExternalRedeemQualifiedFailureError(err)) {
        await addLog(
          `节点 ${getNodeLabel(nodeId, latestState)}：检测到当前邮箱已因 AC/外部兑换失败标记不可再用，交给自动运行切换下一个未用邮箱。原因：${getExternalRedeemQualifiedFailureMessage(err)}`,
          'warn'
        );
        throw err;
      }

      const restartDecision = await getPostStep6AutoRestartDecision(step, err);
      if (restartDecision.shouldRestart) {
        postStep7RestartCount += 1;
        const restartStep = restartDecision.restartStep;
        const restartNodeId = String(getNodeIdByStepForState(restartStep, await getState()) || 'oauth-login').trim();
        const resetAfterNodeId = getPreviousNodeId(restartNodeId, await getState()) || restartNodeId;
        const authState = restartDecision.authState;
        const authStateLabel = authState?.state ? getLoginAuthStateLabel(authState.state) : '未知页面';
        const authStateSuffix = authState?.url
          ? `当前认证页：${authStateLabel}（${authState.url}）`
          : authState?.state
            ? `当前认证页：${authStateLabel}`
            : '未获取到认证页状态';
        await addLog(
          `节点 ${getNodeLabel(nodeId, latestState)}：检测到报错且当前未进入 add-phone，正在回到节点 ${restartNodeId} 重新开始授权流程（第 ${postStep7RestartCount} 次重开）。${authStateSuffix}；原因：${restartDecision.errorMessage || '未知错误'}`,
          'warn'
        );
        await invalidateDownstreamAfterAutoRunNodeRestart(resetAfterNodeId, {
          logLabel: `节点 ${nodeId} 报错后准备回到 ${restartNodeId} 重试（第 ${postStep7RestartCount} 次重开）`,
        });
        nodeIndex = Math.max(0, getNodeIndex(await getState(), restartNodeId));
        continue;
      }

      if (restartDecision.blockedByAddPhone) {
        const addPhoneUrl = restartDecision.authState?.url || 'https://auth.openai.com/add-phone';
        const authChainStartNodeId = String(getNodeIdByStepForState(restartDecision.restartStep, await getState()) || 'oauth-login').trim();
        await addLog(`节点 ${getNodeLabel(nodeId, latestState)}：检测到认证流程进入 add-phone（${addPhoneUrl}），停止自动回到节点 ${authChainStartNodeId} 重开。`, 'warn');
      }
      throw err;
    }
  }

  if (restartFromStep1WithCurrentEmail) {
    continue;
  }

  break;
}
}

async function waitForResume() {
  throwIfStopped();
  const state = await getState();
  if (state.email) {
    await addLog('邮箱已就绪，自动继续后续步骤...', 'info');
    return;
  }

  return new Promise((resolve, reject) => {
    resumeWaiter = { resolve, reject };
  });
}

function createAutoRunRoundSummary(round) {
  return autoRunController.createAutoRunRoundSummary(round);
}

function normalizeAutoRunRoundSummary(summary, round) {
  return autoRunController.normalizeAutoRunRoundSummary(summary, round);
}

function buildAutoRunRoundSummaries(totalRuns, rawSummaries = []) {
  return autoRunController.buildAutoRunRoundSummaries(totalRuns, rawSummaries);
}

function serializeAutoRunRoundSummaries(totalRuns, roundSummaries = []) {
  return autoRunController.serializeAutoRunRoundSummaries(totalRuns, roundSummaries);
}

function getAutoRunRoundRetryCount(summary) {
  return autoRunController.getAutoRunRoundRetryCount(summary);
}

function formatAutoRunFailureReasons(reasons = []) {
  return autoRunController.formatAutoRunFailureReasons(reasons);
}

async function logAutoRunFinalSummary(totalRuns, roundSummaries = []) {
  return autoRunController.logAutoRunFinalSummary(totalRuns, roundSummaries);
}

async function skipAutoRunCountdown() {
  return autoRunController.skipAutoRunCountdown();
}

async function waitBetweenAutoRunRounds(targetRun, totalRuns, roundSummary, options = {}) {
  return autoRunController.waitBetweenAutoRunRounds(targetRun, totalRuns, roundSummary, options);
}

async function waitBeforeAutoRunRetry(targetRun, totalRuns, nextAttemptRun, options = {}) {
  return autoRunController.waitBeforeAutoRunRetry(targetRun, totalRuns, nextAttemptRun, options);
}

async function handleAutoRunLoopUnhandledError(error) {
  try {
    return await autoRunController.handleAutoRunLoopUnhandledError(error);
  } finally {
    await restoreRunScopedCheckoutConversionProxy('自动运行异常终止');
  }
}

function startAutoRunLoop(totalRuns, options = {}) {
  autoRunController.autoRunLoop(totalRuns, options).catch((error) => {
    handleAutoRunLoopUnhandledError(error).catch(() => {});
  });
}

async function autoRunLoop(totalRuns, options = {}) {
  return autoRunController.autoRunLoop(totalRuns, options);
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('无法继续：当前没有邮箱地址，请先在侧边栏填写邮箱。', 'error');
    return false;
  }

  const resumedInMemory = await resumeAutoRunIfWaitingForEmail({ silent: true });
  if (resumedInMemory) {
    return true;
  }

  if (!isAutoRunPausedState(state)) {
    return false;
  }

  if (autoRunActive) {
    return false;
  }

  const totalRuns = state.autoRunTotalRuns || 1;
  const currentRun = state.autoRunCurrentRun || 1;
  const attemptRun = state.autoRunAttemptRun || 1;

  await addLog('检测到自动流程暂停上下文已丢失，正在从当前进度恢复自动运行...', 'warn');
  startAutoRunLoop(totalRuns, {
    autoRunSessionId: normalizeAutoRunSessionId(state.autoRunSessionId),
    autoRunSkipFailures: Boolean(state.autoRunSkipFailures),
    mode: 'continue',
    resumeCurrentRun: currentRun,
    resumeAttemptRun: attemptRun,
    resumeRoundSummaries: state.autoRunRoundSummaries,
  });
  return true;
}

// ============================================================
// Signup / OAuth Helpers
// ============================================================

const SIGNUP_ENTRY_URL = 'https://chatgpt.com/auth/login';
const SIGNUP_PAGE_INJECT_FILES = ['content/utils.js', 'content/operation-delay.js', 'content/auth-page-recovery.js', 'content/signup-page.js'];
const panelBridge = self.MultiPageBackgroundPanelBridge?.createPanelBridge({
  chrome,
  addLog,
  createLocalCliProxyApi: self.MultiPageBackgroundLocalCliProxyApi?.createLocalCliProxyApi,
  closeConflictingTabsForSource,
  createAutomationTab,
  ensureContentScriptReadyOnTab,
  getPanelMode,
  normalizeCodex2ApiUrl,
  normalizeSub2ApiUrl,
  rememberSourceLastUrl,
  sendToContentScript,
  sendToContentScriptResilient,
  waitForTabUrlFamily,
  DEFAULT_SUB2API_GROUP_NAME,
  SUB2API_STEP1_RESPONSE_TIMEOUT_MS,
});
const signupFlowHelpers = self.MultiPageSignupFlowHelpers?.createSignupFlowHelpers({
  addLog,
  buildGeneratedAliasEmail,
  chrome,
  ensureContentScriptReadyOnTab,
  ensureHotmailAccountForFlow,
  ensureMail2925AccountForFlow,
  ensureLuckmailPurchaseForFlow,
  fetchGeneratedEmail,
  getTabId,
  isGeneratedAliasProvider,
  isReusableGeneratedAliasEmail,
  isSignupEmailVerificationPageUrl,
  isSignupPhoneVerificationPageUrl: (rawUrl) => {
    const parsed = parseUrlSafely(rawUrl);
    return Boolean(parsed && isSignupPageHost(parsed.hostname) && /\/phone-verification(?:[/?#]|$)/i.test(parsed.pathname || ''));
  },
  isSignupProfilePageUrl: (rawUrl) => {
    const parsed = parseUrlSafely(rawUrl);
    return Boolean(parsed && isSignupPageHost(parsed.hostname) && /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i.test(parsed.pathname || ''));
  },
  isRetryableContentScriptTransportError,
  isHotmailProvider,
  isLuckmailProvider,
  isSignupPasswordPageUrl,
  isTabAlive,
  persistRegistrationEmailState,
  reuseOrCreateTab,
  sendToContentScriptResilient,
  setEmailState,
  setState,
  SIGNUP_ENTRY_URL,
  SIGNUP_PAGE_INJECT_FILES,
  waitForTabStableComplete,
  waitForTabUrlMatch,
});
const openAiMailRules = self.MultiPageOpenAiMailRules?.createOpenAiMailRules({
  getHotmailVerificationRequestTimestamp,
  MAIL_2925_VERIFICATION_INTERVAL_MS,
  MAIL_2925_VERIFICATION_MAX_ATTEMPTS,
});
const mailRuleRegistry = self.MultiPageBackgroundMailRuleRegistry?.createMailRuleRegistry({
  defaultFlowId: DEFAULT_ACTIVE_FLOW_ID,
  flowBuilders: {
    openai: openAiMailRules,
  },
});
const verificationFlowHelpers = self.MultiPageBackgroundVerificationFlow?.createVerificationFlowHelpers({
  addLog,
  buildVerificationPollPayload: mailRuleRegistry?.buildVerificationPollPayload,
  chrome,
  closeConflictingTabsForSource,
  CLOUDFLARE_TEMP_EMAIL_PROVIDER,
  CLOUD_MAIL_PROVIDER,
  completeNodeFromBackground,
  confirmCustomVerificationStepBypassRequest: (step) => chrome.runtime.sendMessage({
    type: 'REQUEST_CUSTOM_VERIFICATION_BYPASS_CONFIRMATION',
    payload: { step },
  }),
  getNodeIdByStepForState,
  getHotmailVerificationPollConfig,
  getHotmailVerificationRequestTimestamp,
  handleMail2925LimitReachedError,
  getState,
  getTabId,
  HOTMAIL_PROVIDER,
  ICLOUD_API_PROVIDER,
  isMail2925LimitReachedError,
  isRetryableContentScriptTransportError,
  isStopError,
  LUCKMAIL_PROVIDER,
  MAIL_2925_VERIFICATION_INTERVAL_MS,
  MAIL_2925_VERIFICATION_MAX_ATTEMPTS,
  pollCloudflareTempEmailVerificationCode,
  pollCloudMailVerificationCode,
  pollIcloudApiVerificationCode,
  pollHotmailVerificationCode,
  pollLuckmailVerificationCode,
  recoverAuthOpenAiHttp500Page,
  sendToContentScript,
  sendToContentScriptResilient,
  sendToMailContentScriptResilient,
  setNodeStatus,
  setState,
  sleepWithStop,
  throwIfStopped,
  VERIFICATION_POLL_MAX_ROUNDS,
});
const phoneVerificationHelpers = self.MultiPageBackgroundPhoneVerification?.createPhoneVerificationHelpers({
  addLog,
  broadcastDataUpdate,
  DEFAULT_FIVE_SIM_BASE_URL,
  DEFAULT_FIVE_SIM_COUNTRY_ORDER,
  DEFAULT_FIVE_SIM_OPERATOR,
  DEFAULT_FIVE_SIM_PRODUCT,
  DEFAULT_NEX_SMS_BASE_URL,
  DEFAULT_NEX_SMS_COUNTRY_ORDER,
  DEFAULT_NEX_SMS_SERVICE_CODE,
  DEFAULT_HERO_SMS_BASE_URL,
  DEFAULT_HERO_SMS_REUSE_ENABLED,
  DEFAULT_PHONE_CODE_WAIT_SECONDS,
  DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS,
  DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS,
  DEFAULT_PHONE_CODE_POLL_ROUNDS,
  readAuthTabSnapshot,
  ensureStep8SignupPageReady,
  navigateAuthTabToAddPhone: async (tabId, options = {}) => {
    const visibleStep = Math.floor(Number(options.visibleStep || options.step) || 0) || 9;
    const requestedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : await getOAuthFlowStepTimeoutMs(30000, {
        step: visibleStep,
        actionLabel: 'direct add-phone navigation',
      });
    await chrome.tabs.update(tabId, { url: 'https://auth.openai.com/add-phone', active: true });
    await ensureStep8SignupPageReady(tabId, {
      timeoutMs,
      visibleStep,
      logStepKey: options.logStepKey || 'phone-verification',
      logMessage: options.logMessage || '步骤 9：认证页已失联，直接打开添加手机号页面后等待脚本恢复。',
    });
    return {
      addPhonePage: true,
      phoneVerificationPage: false,
      url: 'https://auth.openai.com/add-phone',
    };
  },
  generateRandomBirthday,
  generateRandomName,
  getOAuthFlowRemainingMs,
  getOAuthFlowStepTimeoutMs,
  getState,
  HERO_SMS_COUNTRY_ID,
  HERO_SMS_COUNTRY_LABEL,
  HERO_SMS_SERVICE_CODE,
  HERO_SMS_SERVICE_LABEL,
  sendToContentScript,
  sendToContentScriptResilient,
  setState,
  sleepWithStop,
  throwIfStopped,
  createFiveSimProvider: self.PhoneSmsFiveSimProvider?.createProvider,
});
const step1Executor = self.MultiPageBackgroundStep1?.createStep1Executor({
  addLog,
  completeNodeFromBackground,
  setState,
  openSignupEntryTab,
});
const step2Executor = self.MultiPageBackgroundStep2?.createStep2Executor({
  addLog,
  chrome,
  completeNodeFromBackground,
  ensureContentScriptReadyOnTab,
  ensureSignupAuthEntryPageReady,
  ensureSignupEntryPageReady,
  ensureSignupPostEmailPageReadyInTab,
  ensureSignupPostIdentityPageReadyInTab: signupFlowHelpers.ensureSignupPostIdentityPageReadyInTab,
  getTabId,
  isTabAlive,
  phoneVerificationHelpers,
  resolveSignupMethod,
  resolveSignupEmailForFlow,
  sendToContentScriptResilient,
  SIGNUP_PAGE_INJECT_FILES,
  waitForTabStableComplete,
});
const step3Executor = self.MultiPageBackgroundStep3?.createStep3Executor({
  addLog,
  appendAccountRunRecord: (...args) => appendAndBroadcastAccountRunRecord(...args),
  chrome,
  ensureContentScriptReadyOnTab,
  generatePassword,
  getTabId,
  isTabAlive,
  resolveSignupMethod,
  sendToContentScript,
  setPasswordState,
  setState,
  SIGNUP_PAGE_INJECT_FILES,
});

async function ensureIcloudMailSessionForVerification(options = {}) {
  const flowState = options?.state || await getState().catch(() => ({}));
  const hostPreference = getConfiguredIcloudHostPreference(flowState)
    || normalizeIcloudHost(flowState?.preferredIcloudHost);
  return checkIcloudSession({
    ...(hostPreference ? { hostPreference } : {}),
    actionLabel: options?.actionLabel || '检查 iCloud 会话',
  });
}

const step4Executor = self.MultiPageBackgroundStep4?.createStep4Executor({
  addLog,
  chrome,
  completeNodeFromBackground,
  confirmCustomVerificationStepBypass: verificationFlowHelpers.confirmCustomVerificationStepBypass,
  generateRandomBirthday,
  generateRandomName,
  ensureMail2925MailboxSession,
  ensureIcloudMailSession: ensureIcloudMailSessionForVerification,
  getMailConfig,
  getTabId,
  HOTMAIL_PROVIDER,
  ICLOUD_API_PROVIDER,
  isTabAlive,
  LUCKMAIL_PROVIDER,
  CLOUDFLARE_TEMP_EMAIL_PROVIDER,
  CLOUD_MAIL_PROVIDER,
  resolveVerificationStep: verificationFlowHelpers.resolveVerificationStep,
  resolveMfaChallenge: resolveChatGptTotpMfaChallenge,
  reuseOrCreateTab,
  sendToContentScript,
  sendToContentScriptResilient,
  isRetryableContentScriptTransportError,
  shouldUseCustomRegistrationEmail,
  STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS,
  throwIfStopped,
  waitForTabStableComplete,
  recoverAuthOpenAiHttp500Page,
  phoneVerificationHelpers,
  resolveSignupMethod,
  ensureContentScriptReadyOnTab,
  SIGNUP_PAGE_INJECT_FILES,
});
const step5Executor = self.MultiPageBackgroundStep5?.createStep5Executor({
  addLog,
  generateRandomBirthday,
  generateRandomName,
  sendToContentScript,
  sendToContentScriptResilient,
  SIGNUP_PAGE_INJECT_FILES,
});
const step6Executor = self.MultiPageBackgroundStep6?.createStep6Executor({
  addLog,
  buildLocalHelperEndpoint: (baseUrl, path) => buildHotmailLocalEndpoint(baseUrl, path),
  chrome,
  completeNodeFromBackground,
  createLocalCliProxyApi: self.MultiPageBackgroundLocalCliProxyApi?.createLocalCliProxyApi,
  ensureContentScriptReadyOnTab,
  getErrorMessage,
  getPanelMode,
  getTabId,
  normalizeHotmailLocalBaseUrl,
  registrationSuccessWaitMs: STEP6_REGISTRATION_SUCCESS_WAIT_MS,
  sendToContentScriptResilient,
  sleepWithStop,
});
const step7Executor = self.MultiPageBackgroundStep7?.createStep7Executor({
  addLog,
  completeNodeFromBackground,
  getErrorMessage,
  getLoginAuthStateLabel,
  getOAuthFlowStepTimeoutMs,
  getState,
  getTabId,
  isAddPhoneAuthFailure,
  isStep6RecoverableResult,
  isStep6SuccessResult,
  phoneVerificationHelpers,
  refreshOAuthUrlBeforeStep6,
  reuseOrCreateTab,
  sendToContentScriptResilient,
  startOAuthFlowTimeoutWindow,
  STEP6_MAX_ATTEMPTS,
  throwIfStopped,
});
const step8Executor = self.MultiPageBackgroundStep8?.createStep8Executor({
  addLog,
  chrome,
  CLOUDFLARE_TEMP_EMAIL_PROVIDER,
  CLOUD_MAIL_PROVIDER,
  completeNodeFromBackground,
  confirmCustomVerificationStepBypass: verificationFlowHelpers.confirmCustomVerificationStepBypass,
  ensureMail2925MailboxSession,
  ensureIcloudMailSession: ensureIcloudMailSessionForVerification,
  ensureStep8VerificationPageReady,
  getOAuthFlowRemainingMs,
  getOAuthFlowStepTimeoutMs,
  getPanelMode,
  getMailConfig,
  getState,
  getTabId,
  HOTMAIL_PROVIDER,
  ICLOUD_API_PROVIDER,
  isTabAlive,
  isVerificationMailPollingError,
  LUCKMAIL_PROVIDER,
  resolveVerificationStep: verificationFlowHelpers.resolveVerificationStep,
  resolveSignupEmailForFlow,
  persistRegistrationEmailState,
  phoneVerificationHelpers,
  rerunStep7ForStep8Recovery: (...args) => rerunStep7ForStep8Recovery(...args),
  resolveMfaChallenge: resolveChatGptTotpMfaChallenge,
  resolveSignupMethod,
  reuseOrCreateTab,
  sendToContentScriptResilient,
  setState,
  shouldUseCustomRegistrationEmail,
  sleepWithStop,
  STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS,
  STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS,
  throwIfStopped,
});
const plusCheckoutCreateExecutor = self.MultiPageBackgroundPlusCheckoutCreate?.createPlusCheckoutCreateExecutor({
  addLog,
  broadcastDataUpdate,
  chrome,
  clickWithDebugger,
  completeNodeFromBackground,
  createAutomationTab,
  ensureContentScriptReadyOnTabUntilStopped,
  failNodeFromBackground,
  fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  getState,
  isCheckoutConversionProxyActive: () => isRunScopedCheckoutConversionProxyActive(),
  requestStop,
  getLastNodeIdForState,
  markCurrentRegistrationAccountUsed,
  registerTab,
  sendTabMessageUntilStopped,
  setState,
  skipNodeFromBackground,
  sleepWithStop,
  throwIfStopped,
  waitForTabCompleteUntilStopped,
  waitForTabUrlMatchUntilStopped,
});
const plusSuccessSessionUploadManager = self.MultiPageBackgroundPlusSuccessSessionUpload?.createPlusSuccessSessionUploadManager({
  addLog,
  completeNodeFromBackground,
  failNodeFromBackground,
  getState,
  setState,
});
const step10Executor = self.MultiPageBackgroundStep10?.createStep10Executor({
  addLog,
  buildLocalHelperEndpoint: (baseUrl, path) => buildHotmailLocalEndpoint(baseUrl, path),
  chrome,
  closeConflictingTabsForSource,
  completeNodeFromBackground,
  createLocalCliProxyApi: self.MultiPageBackgroundLocalCliProxyApi?.createLocalCliProxyApi,
  ensureContentScriptReadyOnTab,
  getPanelMode,
  getTabId,
  isLocalhostOAuthCallbackUrl,
  isTabAlive,
  normalizeHotmailLocalBaseUrl,
  normalizeCodex2ApiUrl,
  normalizeSub2ApiUrl,
  rememberSourceLastUrl,
  reuseOrCreateTab,
  sendToContentScript,
  sendToContentScriptResilient,
  shouldBypassStep9ForLocalCpa,
  DEFAULT_SUB2API_GROUP_NAME,
  SUB2API_STEP9_RESPONSE_TIMEOUT_MS,
});

function resolveBoundEmailForReloginState(state = {}) {
  return String(
    state?.step8VerificationTargetEmail
    || state?.email
    || state?.registrationEmailState?.current
    || ''
  ).trim();
}

function getK12WorkspaceDefaultId() {
  return self.GuJumpgateK12Workspace?.DEFAULT_WORKSPACE_ID || '631e1603-06cf-4f0b-b79b-d09fbfcfe98d';
}

function buildK12WorkflowNodeStatuses() {
  return Object.fromEntries(
    K12_WORKSPACE_STEP_DEFINITIONS
      .map((definition) => String(definition?.key || '').trim())
      .filter(Boolean)
      .map((nodeId) => [nodeId, 'pending'])
  );
}

function buildK12EmailPoolFromInput(options = {}, state = {}) {
  const k12Module = self.GuJumpgateK12Workspace;
  const mode = normalizeIcloudApiModeValue(options?.apiMode || state?.k12IcloudApiMode || ICLOUD_API_MODE_NORMAL);
  const entriesFromPayload = k12Module?.normalizeK12EmailPoolEntries?.(options?.emailPoolEntries || [], { mode }) || [];
  if (entriesFromPayload.length) {
    return {
      mode,
      entries: entriesFromPayload,
      text: k12Module?.serializeK12EmailPoolEntries?.(entriesFromPayload) || '',
    };
  }
  const rawText = String(options?.emailPoolText ?? state?.k12EmailPoolText ?? '').trim();
  const entries = k12Module?.parseK12EmailPoolText?.(rawText, {
    mode,
    existingEntries: state?.k12EmailPoolEntries || [],
  }) || [];
  return {
    mode,
    entries,
    text: k12Module?.serializeK12EmailPoolEntries?.(entries) || rawText,
  };
}

function buildK12RuntimePoolForSingleEmail(entry = null) {
  if (!entry?.email) {
    return [];
  }
  return normalizeCustomEmailPoolEntryObjects([{
    id: entry.id || `k12-runtime-${entry.email}`,
    email: entry.email,
    enabled: true,
    used: false,
    note: entry.note || 'K12 自动注册',
    apiMode: entry.apiMode || ICLOUD_API_MODE_NORMAL,
    queryCode: entry.queryCode || '',
    password: entry.password || '',
    clientId: entry.clientId || '',
    refreshToken: entry.refreshToken || '',
    verificationUrl: entry.verificationUrl || '',
  }]);
}

function buildK12MainStateSnapshot(state = {}) {
  const keys = [
    'activeFlowId',
    'panelMode',
    'plusModeEnabled',
    'plusPaymentMethod',
    'plusAccountAccessStrategy',
    'externalRedeemEnabled',
    'mailProvider',
    'emailGenerator',
    'icloudApiMode',
    'customEmailPool',
    'customEmailPoolEntries',
    'customMailProviderPool',
    'email',
    'password',
    'registrationEmailState',
    'accountIdentifierType',
    'accountIdentifier',
    'signupMethod',
    'resolvedSignupMethod',
    'phoneVerificationEnabled',
    'phoneSignupReloginAfterBindEmailEnabled',
    'nodeStatuses',
    'currentNodeId',
    'skipOpenChatgptCookieCleanupOnce',
    'preserveOpenChatgptCookiesOnce',
  ];
  const snapshot = {};
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      snapshot[key] = state[key];
    }
  });
  return snapshot;
}

async function runK12WorkspaceAutoRegister(options = {}) {
  const k12Module = self.GuJumpgateK12Workspace;
  if (!k12Module?.runK12WorkspaceRedeem) {
    throw new Error('K12 Workspace 自动注册能力未接入。');
  }
  const initialState = await getState();
  if (autoRunActive || initialState.autoRunning || initialState.k12WorkspaceAutoRunning) {
    throw new Error('当前已有自动任务在运行，请先停止或等待完成。');
  }

  const pool = buildK12EmailPoolFromInput(options, initialState);
  const selectedEntry = k12Module.pickUnusedK12EmailPoolEntry?.(pool.entries) || null;
  if (!selectedEntry?.email) {
    throw new Error('K12 邮箱池没有未用邮箱，请先补充 K12 邮箱池或清空已用。');
  }

  const workspaceId = String(options?.workspaceId || initialState.k12WorkspaceId || getK12WorkspaceDefaultId()).trim() || getK12WorkspaceDefaultId();
  const sessionId = createAutoRunSessionId();
  const snapshot = buildK12MainStateSnapshot(initialState);
  const runtimeEntries = buildK12RuntimePoolForSingleEmail(selectedEntry);
  const k12NodeStatuses = buildK12WorkflowNodeStatuses();
  let finalStatus = 'failed';
  let successPayload = null;

  clearStopRequest();
  autoRunActive = true;
  autoRunCurrentRun = 1;
  autoRunTotalRuns = 1;
  autoRunAttemptRun = 1;
  autoRunSessionId = sessionId;

  await setPersistentSettings({
    k12WorkspaceId: workspaceId,
    k12IcloudApiMode: pool.mode,
    k12EmailPoolText: pool.text,
    k12EmailPoolEntries: pool.entries,
  });
  await setState({
    ...getAutoRunStatusPayload('running', { currentRun: 1, totalRuns: 1, attemptRun: 1, sessionId }),
    k12WorkspaceId: workspaceId,
    k12IcloudApiMode: pool.mode,
    k12EmailPoolText: pool.text,
    k12EmailPoolEntries: pool.entries,
    k12WorkspaceAutoRunning: true,
    k12WorkspaceAutoStatus: 'running',
    k12WorkspaceRunActive: true,
    k12WorkspaceAutoLastEmail: selectedEntry.email,
    k12WorkspaceAutoLastError: '',
    activeFlowId: DEFAULT_ACTIVE_FLOW_ID,
    panelMode: DEFAULT_PANEL_MODE,
    plusModeEnabled: false,
    externalRedeemEnabled: false,
    phoneVerificationEnabled: false,
    phoneSignupReloginAfterBindEmailEnabled: false,
    signupMethod: 'email',
    resolvedSignupMethod: 'email',
    mailProvider: ICLOUD_API_PROVIDER,
    icloudApiMode: selectedEntry.apiMode || pool.mode || ICLOUD_API_MODE_NORMAL,
    emailGenerator: CUSTOM_EMAIL_POOL_GENERATOR,
    customEmailPool: [selectedEntry.email],
    customEmailPoolEntries: runtimeEntries,
    customMailProviderPool: [],
    email: null,
    password: null,
    registrationEmailState: { ...DEFAULT_REGISTRATION_EMAIL_STATE },
    accountIdentifierType: null,
    accountIdentifier: '',
    currentNodeId: 'open-chatgpt',
    nodeStatuses: k12NodeStatuses,
    skipOpenChatgptCookieCleanupOnce: true,
    preserveOpenChatgptCookiesOnce: true,
  });
  broadcastDataUpdate({
    k12WorkspaceAutoRunning: true,
    k12WorkspaceAutoStatus: 'running',
    k12WorkspaceAutoLastEmail: selectedEntry.email,
    k12EmailPoolEntries: pool.entries,
    k12EmailPoolText: pool.text,
  });

  await addLog(`K12 自动注册：已选择 ${selectedEntry.email}，开始注册并准备回填 AC。`, 'info');
  await addK12WorkspaceLog(`已选择 ${selectedEntry.email}，模式 ${pool.mode || ICLOUD_API_MODE_NORMAL}，准备注册并执行 Workspace ${workspaceId}。`, 'info', {
    phase: 'auto-register',
    email: selectedEntry.email,
  });

  try {
    await addK12WorkspaceLog('开始打开 ChatGPT 并执行注册流程。', 'info', {
      phase: 'auto-register',
      email: selectedEntry.email,
    });
    await runAutoSequenceFromNode('open-chatgpt', {
      targetRun: 1,
      totalRuns: 1,
      attemptRuns: 1,
      k12Workspace: true,
      skipCheckoutConversionProxy: true,
    });

    await addK12WorkspaceLog('注册流程返回，正在读取当前 ChatGPT AC。', 'info', {
      phase: 'read-ac',
      email: selectedEntry.email,
    });
    const sessionState = await readCurrentChatGptSessionForExport({}).catch((error) => {
      throw new Error(`K12 自动注册已完成但读取 AC 失败：${error?.message || error}`);
    });
    const accessToken = k12Module.extractAccessToken(sessionState?.accessToken || '');
    if (!accessToken) {
      throw new Error('K12 自动注册已完成但未读取到有效 AC。');
    }
    await setState({
      k12WorkspaceAccessTokenDraft: accessToken,
      k12WorkspaceAccessTokenUpdatedAt: Date.now(),
    });
    await addLog(`K12 自动注册：已读取 ${selectedEntry.email} 的 AC，并写入 K12 access_token 输入框。`, 'ok');
    await addK12WorkspaceLog('已读取 AC 并写入 K12 access_token 输入框，开始调用 Workspace invite。', 'ok', {
      phase: 'read-ac',
      email: selectedEntry.email,
    });

    const redeemResult = await k12Module.runK12WorkspaceRedeem({
      getState,
      setState,
      broadcastDataUpdate,
      readChatGptAccessTokenInfo,
      readCurrentChatGptSessionForExport,
      addK12WorkspaceLog,
    }, {
      workspaceId,
      accessToken,
      useCurrent: false,
    });
    if (!redeemResult?.ok) {
      throw new Error('K12 Workspace invite 接口返回失败。');
    }
    const updatedPoolEntries = k12Module.markK12EmailPoolEntryUsed(pool.entries, selectedEntry.email, {
      lastError: '',
      accessTokenCheck: sessionState?.accessTokenCheck || null,
    });
    const updatedPoolText = k12Module.serializeK12EmailPoolEntries(updatedPoolEntries);
    await setPersistentSettings({
      k12EmailPoolEntries: updatedPoolEntries,
      k12EmailPoolText: updatedPoolText,
    });
    await setState({
      k12EmailPoolEntries: updatedPoolEntries,
      k12EmailPoolText: updatedPoolText,
      k12WorkspaceAutoStatus: 'completed',
      k12WorkspaceAutoLastError: '',
    });
    await addLog(`K12 自动注册：${selectedEntry.email} 已完成注册并执行 K12，邮箱已标记为已用。`, 'ok');
    await addK12WorkspaceLog(`${selectedEntry.email} 已完成 K12 invite，邮箱已标记为已用。`, 'ok', {
      phase: 'completed',
      email: selectedEntry.email,
    });
    finalStatus = 'completed';
    successPayload = {
      ok: true,
      email: selectedEntry.email,
      workspaceId,
    };
  } catch (error) {
    const message = error?.message || String(error || '未知错误');
    const updatedPoolEntries = k12Module.markK12EmailPoolEntryUsed(pool.entries, selectedEntry.email, {
      used: false,
      lastError: message,
    });
    const updatedPoolText = k12Module.serializeK12EmailPoolEntries(updatedPoolEntries);
    await setPersistentSettings({
      k12EmailPoolEntries: updatedPoolEntries,
      k12EmailPoolText: updatedPoolText,
    });
    await setState({
      k12EmailPoolEntries: updatedPoolEntries,
      k12EmailPoolText: updatedPoolText,
      k12WorkspaceAutoStatus: 'failed',
      k12WorkspaceAutoLastError: message,
    });
    await addLog(`K12 自动注册失败：${message}`, 'error');
    await addK12WorkspaceLog(`自动注册失败：${message}`, 'error', {
      phase: 'failed',
      email: selectedEntry.email,
    });
    throw error;
  } finally {
    autoRunActive = false;
    autoRunCurrentRun = 0;
    autoRunTotalRuns = 1;
    autoRunAttemptRun = 0;
    clearCurrentAutoRunSessionId(sessionId);
    const latest = await getState();
    const restorePatch = {
      ...snapshot,
      ...getAutoRunStatusPayload('idle', { currentRun: 0, totalRuns: 1, attemptRun: 0, sessionId: 0 }),
      k12WorkspaceRunActive: false,
      k12WorkspaceAutoRunning: false,
      k12WorkspaceAutoStatus: finalStatus,
      k12WorkspaceLastResult: latest.k12WorkspaceLastResult || null,
      k12WorkspaceHistory: Array.isArray(latest.k12WorkspaceHistory) ? latest.k12WorkspaceHistory : [],
      k12WorkspaceLogs: Array.isArray(latest.k12WorkspaceLogs) ? latest.k12WorkspaceLogs : [],
      k12WorkspaceAccessTokenDraft: latest.k12WorkspaceAccessTokenDraft || '',
      k12WorkspaceAccessTokenUpdatedAt: Number(latest.k12WorkspaceAccessTokenUpdatedAt) || 0,
      k12WorkspaceAutoLastEmail: latest.k12WorkspaceAutoLastEmail || selectedEntry.email,
      k12WorkspaceAutoLastError: latest.k12WorkspaceAutoLastError || '',
      k12EmailPoolEntries: latest.k12EmailPoolEntries || pool.entries,
      k12EmailPoolText: latest.k12EmailPoolText || pool.text,
      k12IcloudApiMode: latest.k12IcloudApiMode || pool.mode,
      k12WorkspaceId: latest.k12WorkspaceId || workspaceId,
    };
    await setState(restorePatch);
    const restored = await getState();
    broadcastDataUpdate({
      k12WorkspaceRunActive: false,
      k12WorkspaceAutoRunning: false,
      k12WorkspaceAutoStatus: finalStatus,
      k12WorkspaceLastResult: restored.k12WorkspaceLastResult || null,
      k12WorkspaceHistory: restored.k12WorkspaceHistory || [],
      k12WorkspaceLogs: restored.k12WorkspaceLogs || [],
      k12WorkspaceAccessTokenDraft: restored.k12WorkspaceAccessTokenDraft || '',
      k12WorkspaceAccessTokenUpdatedAt: restored.k12WorkspaceAccessTokenUpdatedAt || 0,
      k12WorkspaceAutoLastEmail: restored.k12WorkspaceAutoLastEmail || '',
      k12WorkspaceAutoLastError: restored.k12WorkspaceAutoLastError || '',
      k12EmailPoolEntries: restored.k12EmailPoolEntries || [],
      k12EmailPoolText: restored.k12EmailPoolText || '',
      k12IcloudApiMode: restored.k12IcloudApiMode || ICLOUD_API_MODE_NORMAL,
      k12WorkspaceId: restored.k12WorkspaceId || workspaceId,
      autoRunning: false,
      autoRunPhase: 'idle',
    });
  }
  return {
    ...(successPayload || { ok: finalStatus === 'completed', email: selectedEntry.email, workspaceId }),
    state: await getState(),
  };
}

async function executeReloginBoundEmail(state = {}) {
  const visibleStep = Math.floor(Number(state?.visibleStep) || 0) || 10;
  const boundEmail = resolveBoundEmailForReloginState(state);
  if (!boundEmail) {
    throw new Error(`步骤 ${visibleStep}：缺少绑定邮箱，无法在绑定邮箱后切入邮箱模式 OAuth 登录。`);
  }
  await addLog(`步骤 ${visibleStep}：绑定邮箱已提交，正在刷新 OAuth 并使用绑定邮箱 ${boundEmail} 登录...`, 'info', {
    step: visibleStep,
    stepKey: 'relogin-bound-email',
  });
  return step7Executor.executeStep7({
    ...state,
    forceLoginIdentifierType: 'email',
    forceEmailLogin: true,
    signupMethod: 'email',
    resolvedSignupMethod: 'email',
    accountIdentifierType: 'email',
    accountIdentifier: boundEmail,
    email: boundEmail,
    step8VerificationTargetEmail: boundEmail,
  });
}

const stepExecutorsByKey = {
  'open-chatgpt': (state) => step1Executor.executeStep1(state),
  'submit-signup-email': (state) => step2Executor.executeStep2(state),
  'fill-password': (state) => step3Executor.executeStep3(state),
  'fetch-signup-code': (state) => step4Executor.executeStep4(state),
  'fill-profile': (state) => step5Executor.executeStep5(state),
  'wait-registration-success': (state) => step6Executor.executeStep6({
    ...state,
    step6CookieCleanupEnabled: false,
  }),
  'chatgpt-ac-external-redeem': (state) => executeChatGptAcExternalRedeemNode(state),
  'plus-checkout-create': (state) => plusCheckoutCreateExecutor.executePlusCheckoutCreate(state),
};
const messageRouter = self.MultiPageBackgroundMessageRouter?.createMessageRouter({
  addLog,
  appendAccountRunRecord: (...args) => appendAndBroadcastAccountRunRecord(...args),
  batchUpdateLuckmailPurchases,
  buildLocalhostCleanupPrefix,
  buildLuckmailSessionSettingsPayload,
  buildPersistentSettingsPayload,
  broadcastDataUpdate,
  applyIpProxySettingsFromState: null,
  cancelScheduledAutoRun,
  checkIcloudSession,
  clearAccountRunHistory: (...args) => clearAndBroadcastAccountRunHistory(...args),
  deleteAccountRunHistoryRecords: (...args) => deleteAndBroadcastAccountRunHistoryRecords(...args),
  clearAutoRunTimerAlarm,
  clearFreeReusablePhoneActivation,
  clearLuckmailRuntimeState,
  clearStopRequest,
  closeLocalhostCallbackTabs,
  closeTabsByUrlPrefix,
  completeNodeFromBackground,
  deleteHotmailAccount,
  deleteHotmailAccounts,
  deleteIcloudAlias,
  deleteUsedIcloudAliases,
  disableUsedLuckmailPurchases,
  doesNodeUseCompletionSignal,
  ensureMail2925MailboxSession,
  ensureManualInteractionAllowed,
  executeNode,
  executeNodeViaCompletionSignal,
  executeWithCheckoutConversionProxy: (callback, options) => runWithCheckoutConversionProxyDuringPluginUse(callback, options),
  applyPluginProxy: (...args) => applyPluginProxyForManualUse(...args),
  clearPluginProxy: (...args) => clearPluginProxyForManualUse(...args),
  exportCurrentSessionJson: null,
  readChatGptAccessTokenInfo,
  runK12WorkspaceRedeem: (options) => self.GuJumpgateK12Workspace?.runK12WorkspaceRedeem?.({
    getState,
    setState,
    broadcastDataUpdate,
    readChatGptAccessTokenInfo,
    readCurrentChatGptSessionForExport,
    addK12WorkspaceLog,
  }, options),
  runK12WorkspaceAutoRegister: (options) => runK12WorkspaceAutoRegister(options),
  clearK12WorkspaceHistory: () => self.GuJumpgateK12Workspace?.clearK12WorkspaceHistory?.({
    getState,
    setState,
    broadcastDataUpdate,
  }),
  pollExternalRedeemQueue,
  retryExternalRedeemQueueItem,
  deleteExternalRedeemQueueItem,
  readExternalRedeemRecordsFromSqlite,
  clearExternalRedeemRecordsFromSqlite,
  ensureExternalRedeemMonitorAlarm,
  exportSettingsBundle,
  testFeishuSyncConnection,
  syncCurrentFeishuAccountResult,
  testCheckoutConversionProxy: (...args) => plusCheckoutCreateExecutor.testCheckoutConversionProxy(...args),
  fetchGeneratedEmail,
  finalizePhoneActivationAfterSuccessfulFlow,
  finalizeStep3Completion: async () => {
    const currentState = await getState();
    const signupTabId = await getTabId('signup-page');
    return signupFlowHelpers.finalizeSignupPasswordSubmitInTab(
      signupTabId,
      currentState.password || currentState.customPassword || '',
      3
    );
  },
  finalizeIcloudAliasAfterSuccessfulFlow,
  findHotmailAccount,
  flushCommand,
  getCurrentLuckmailPurchase,
  getPendingAutoRunTimerPlan,
  getSourceLabel,
  getState,
  getNodeDefinitionForState,
  getNodeIdsForState,
  getStepIdByNodeIdForState,
  getStepDefinitionForState,
  getStepIdsForState,
  getLastStepIdForState,
  normalizeCheckoutConversionProxyInput,
  normalizeSignupMethod,
  canUsePhoneSignup,
  resolveSignupMethod,
  validateAutoRunStart: validateAutoRunStartState,
  getTabId,
  getStopRequested: () => stopRequested,
  handleCloudflareSecurityBlocked,
  handleAutoRunLoopUnhandledError,
  importSettingsBundle,
  invalidateDownstreamAfterStepRestart,
  isCloudflareSecurityBlockedError: isTerminalSecurityBlockedError,
  isAutoRunLockedState,
  isHotmailProvider,
  isLocalhostOAuthCallbackUrl,
  isLuckmailProvider,
  isStopError,
  isTabAlive,
  launchAutoRunTimerPlan,
  ensureIpProxyAutoSyncAlarm: null,
  clearIpProxyAutoSyncAlarm: null,
  runIpProxyAutoSync: null,
  listIcloudAliases,
  listLuckmailPurchasesForManagement,
  markCurrentCustomEmailPoolEntryUsed,
  markCurrentRegistrationAccountUsed,
  getCurrentMail2925Account,
  normalizeHotmailAccounts,
  normalizeMail2925Accounts,
  normalizeRunCount,
  ensureMultiThreadLocalServices: (...args) => multiThreadWorkbench?.ensureLocalServicesForWorkbench?.(...args),
  prepareMultiThreadWorkbench: (...args) => multiThreadWorkbench?.prepareMultiThreadWorkbench?.(...args),
  syncMultiThreadRunnerLogs: (...args) => multiThreadWorkbench?.syncMultiThreadRunnerLogs?.(...args),
  startMultiThreadAutoRun: (...args) => multiThreadWorkbench?.startMultiThreadAutoRun?.(...args),
  stopMultiThreadAutoRun: (...args) => multiThreadWorkbench?.stopMultiThreadAutoRun?.(...args),
  clearMultiThreadWorkbench: (...args) => multiThreadWorkbench?.clearMultiThreadWorkbench?.(...args),
  AUTO_RUN_TIMER_KIND_SCHEDULED_START,
  notifyNodeComplete,
  notifyNodeError,
  patchHotmailAccount,
  patchMail2925Account,
  registerTab,
  requestStop,
  probeIpProxyExit: null,
  resetState,
  resumeAutoRun,
  scheduleAutoRun,
  selectLuckmailPurchase,
  switchIpProxy: null,
  changeIpProxyExit: null,
  setCurrentHotmailAccount,
  setCurrentMail2925Account,
  setContributionMode,
  setEmailState,
  setEmailStateSilently,
  persistRegistrationEmailState,
  setFreeReusablePhoneActivation,
  setSignupPhoneState,
  setSignupPhoneStateSilently,
  setIcloudAliasPreservedState,
  setIcloudAliasUsedState,
  setLuckmailPurchaseDisabledState,
  setLuckmailPurchasePreservedState,
  setLuckmailPurchaseUsedState,
  setPersistentSettings,
  setState,
  setNodeStatus,
  skipAutoRunCountdown,
  skipNode,
  startContributionFlow: (...args) => contributionOAuthManager?.startContributionFlow?.(...args),
  startAutoRunLoop,
  pollContributionStatus: (...args) => contributionOAuthManager?.pollContributionStatus?.(...args),
  syncHotmailAccounts,
  deleteMail2925Account,
  deleteMail2925Accounts,
  testHotmailAccountMailAccess,
  upsertMail2925Account,
  upsertHotmailAccount,
  verifyHotmailAccount,
});

function buildNodeRegistry(definitions = []) {
  return self.MultiPageBackgroundStepRegistry?.createNodeRegistry(
    definitions.map((definition) => ({
      ...definition,
      nodeId: definition.nodeId || definition.key,
      displayOrder: definition.displayOrder || definition.order,
      executeKey: definition.executeKey || definition.key,
      execute: stepExecutorsByKey[definition.executeKey || definition.key || definition.nodeId],
    }))
  );
}

function buildStepRegistry(definitions = []) {
  const nodeRegistry = buildNodeRegistry(definitions);
  return {
    executeNode: (nodeId, state) => nodeRegistry.executeNode(nodeId, state),
    getNodeDefinition: (nodeId) => nodeRegistry.getNodeDefinition(nodeId),
    getOrderedNodes: () => nodeRegistry.getOrderedNodes(),
    executeStep: (step, state) => {
      const nodeId = String(getStepDefinitionForState(step, state)?.key || '').trim();
      if (!nodeId) {
        throw new Error(`未知节点：${step}`);
      }
      return nodeRegistry.executeNode(nodeId, state);
    },
    getStepDefinition: (step) => {
      const nodeId = String(getStepDefinitionForState(step, {})?.key || '').trim();
      return nodeId ? nodeRegistry.getNodeDefinition(nodeId) : null;
    },
    getOrderedSteps: () => nodeRegistry.getOrderedNodes(),
  };
}

async function acquireTopLevelAuthChainExecution(step, state = {}) {
  return acquireTopLevelAuthChainExecutionForNode(getNodeIdByStepForState(step, state), state);
}

const slimStepRegistry = buildStepRegistry(SLIM_STEP_DEFINITIONS);

function getStepRegistryForState(state = {}) {
  const activeFlowId = String(state?.activeFlowId || DEFAULT_ACTIVE_FLOW_ID).trim().toLowerCase() || DEFAULT_ACTIVE_FLOW_ID;
  if (activeFlowId !== DEFAULT_ACTIVE_FLOW_ID) {
    throw new Error(`当前尚未注册 flow=${activeFlowId} 的步骤执行器。`);
  }
  return slimStepRegistry;
}

async function requestOAuthUrlFromPanel(state, options = {}) {
  return panelBridge.requestOAuthUrlFromPanel(state, options);
}

async function requestCpaOAuthUrl(state, options = {}) {
  return panelBridge.requestCpaOAuthUrl(state, options);
}

async function requestSub2ApiOAuthUrl(state, options = {}) {
  return panelBridge.requestSub2ApiOAuthUrl(state, options);
}

async function openSignupEntryTab(step = 1) {
  return signupFlowHelpers.openSignupEntryTab(step);
}

async function ensureSignupEntryPageReady(step = 1) {
  return signupFlowHelpers.ensureSignupEntryPageReady(step);
}

async function ensureSignupAuthEntryPageReady(step = 1) {
  return signupFlowHelpers.ensureSignupEntryPageReady(step);
}

async function ensureSignupPasswordPageReadyInTab(tabId, step = 2, options = {}) {
  return signupFlowHelpers.ensureSignupPasswordPageReadyInTab(tabId, step, options);
}

async function ensureSignupPostEmailPageReadyInTab(tabId, step = 2, options = {}) {
  return signupFlowHelpers.ensureSignupPostEmailPageReadyInTab(tabId, step, options);
}

async function resolveSignupEmailForFlow(state) {
  return signupFlowHelpers.resolveSignupEmailForFlow(state);
}

// ============================================================
// Step 1: Open ChatGPT homepage
// ============================================================

async function executeStep1() {
  return step1Executor.executeStep1(await getState());
}

// ============================================================
// Step 2: Click signup, fill email, continue to password page
// ============================================================

async function executeStep2(state) {
  return step2Executor.executeStep2(state);
}

// ============================================================
// Step 3: Fill Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  return step3Executor.executeStep3(state);
}

// ============================================================
// Step 4: Get Signup Verification Code (iCloud API polls, then fills in signup-page.js)
// ============================================================

function getMailConfig() {
  return { provider: ICLOUD_API_PROVIDER, label: 'iCloud API 邮箱' };
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

function getVerificationCodeStateKey(step) {
  return verificationFlowHelpers.getVerificationCodeStateKey(step);
}

function getVerificationCodeLabel(step) {
  return verificationFlowHelpers.getVerificationCodeLabel(step);
}

async function confirmCustomVerificationStepBypass(step) {
  return verificationFlowHelpers.confirmCustomVerificationStepBypass(step);
}

function getVerificationPollPayload(step, state, overrides = {}) {
  return verificationFlowHelpers.getVerificationPollPayload(step, state, overrides);
}

async function requestVerificationCodeResend(step) {
  return verificationFlowHelpers.requestVerificationCodeResend(step);
}

async function pollFreshVerificationCode(step, state, mail, pollOverrides = {}) {
  return verificationFlowHelpers.pollFreshVerificationCode(step, state, mail, pollOverrides);
}

async function pollFreshVerificationCodeWithResendInterval(step, state, mail, pollOverrides = {}) {
  return verificationFlowHelpers.pollFreshVerificationCodeWithResendInterval(step, state, mail, pollOverrides);
}

async function submitVerificationCode(step, code) {
  return verificationFlowHelpers.submitVerificationCode(step, code);
}

async function resolveVerificationStep(step, state, mail, options = {}) {
  return verificationFlowHelpers.resolveVerificationStep(step, state, mail, options);
}

async function executeStep4(state) {
  return step4Executor.executeStep4(state);
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  return step5Executor.executeStep5(state);
}

// ============================================================
// Step 7: Login and ensure the auth page reaches the login verification page
// ============================================================

async function refreshOAuthUrlBeforeStep6(state, options = {}) {
  const visibleStep = Number(options.visibleStep) || Number(state?.visibleStep) || 7;
  if (state?.contributionModeExpected && !state?.contributionMode) {
    throw new Error(`步骤 ${visibleStep}：当前自动流程预期使用贡献模式，但运行态 contributionMode 已丢失，已阻止回退到普通 CPA / SUB2API / Codex2API 链路。请重新进入贡献模式后再点击自动。`);
  }
  if (state?.contributionMode && contributionOAuthManager?.startContributionFlow) {
    await addLog('contributionMode=true，走公开贡献接口，正在申请 OAuth 登录地址...', 'info', {
      step: visibleStep,
      stepKey: 'oauth-login',
    });
    const contributionState = await contributionOAuthManager.startContributionFlow({
      nickname: state.contributionNickname || '',
      openAuthTab: false,
      stateOverride: state,
    });
    const oauthUrl = String(contributionState?.contributionAuthUrl || '').trim();
    if (!oauthUrl) {
      throw new Error('贡献模式未返回可用的登录地址，请稍后重试。');
    }
    await handleStepData(1, { oauthUrl });
    return oauthUrl;
  }
  await addLog(`contributionMode=false，走普通 CPA / SUB2API / Codex2API 链路（当前面板：${getPanelModeLabel(state)}），正在刷新 OAuth 登录地址...`, 'info', {
    step: visibleStep,
    stepKey: 'oauth-login',
  });
  console.log(LOG_PREFIX, '[refreshOAuthUrlBeforeStep6] requesting fresh OAuth directly from panel');
  const refreshResult = await requestOAuthUrlFromPanel(state, { logLabel: `步骤 ${visibleStep}` });
  await handleStepData(1, refreshResult);

  if (!refreshResult?.oauthUrl) {
    throw new Error('刷新 OAuth 链接后仍未拿到可用链接。');
  }

  return refreshResult.oauthUrl;
}

function buildOAuthFlowTimeoutError(step, actionLabel = '后续授权流程', state = {}) {
  const restartStep = typeof getAuthChainStartStepId === 'function'
    ? getAuthChainStartStepId(state)
    : FINAL_OAUTH_CHAIN_START_STEP;
  return new Error(
    `步骤 ${step}：从拿到 OAuth 登录地址开始，${Math.round(OAUTH_FLOW_TIMEOUT_MS / 60000)} 分钟内未完成${actionLabel}，结束当前链路，准备从步骤 ${restartStep} 重新开始。`
  );
}

function normalizeOAuthFlowDeadlineAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function normalizeOAuthFlowSourceUrl(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

async function startOAuthFlowTimeoutWindow(options = {}) {
  const step = Number(options.step) || 7;
  const state = options.state || await getState();
  if (state?.oauthFlowTimeoutEnabled === false) {
    await setState({
      oauthFlowDeadlineAt: null,
      oauthFlowDeadlineSourceUrl: null,
    });
    await addLog(`步骤 ${step}：已拿到新的 OAuth 登录地址，授权后链总超时已关闭，仅保留各步骤本地等待超时。`, 'info');
    return null;
  }

  const deadlineAt = Date.now() + OAUTH_FLOW_TIMEOUT_MS;
  await setState({
    oauthFlowDeadlineAt: deadlineAt,
    oauthFlowDeadlineSourceUrl: normalizeOAuthFlowSourceUrl(options.oauthUrl),
  });
  await addLog(`步骤 ${step}：已拿到新的 OAuth 登录地址，开始 ${Math.round(OAUTH_FLOW_TIMEOUT_MS / 60000)} 分钟倒计时。`, 'info');
  return deadlineAt;
}

async function getOAuthFlowRemainingMs(options = {}) {
  const step = Number(options.step) || 7;
  const actionLabel = String(options.actionLabel || '后续授权流程').trim() || '后续授权流程';
  const state = options.state || await getState();
  if (state?.oauthFlowTimeoutEnabled === false) {
    return null;
  }

  const deadlineAt = normalizeOAuthFlowDeadlineAt(state?.oauthFlowDeadlineAt);
  const deadlineSourceUrl = normalizeOAuthFlowSourceUrl(state?.oauthFlowDeadlineSourceUrl);
  const currentOauthUrl = normalizeOAuthFlowSourceUrl(options.oauthUrl !== undefined ? options.oauthUrl : state?.oauthUrl);
  if (!deadlineAt) {
    return null;
  }

  if (deadlineSourceUrl && currentOauthUrl && deadlineSourceUrl !== currentOauthUrl) {
    console.warn(LOG_PREFIX, '[oauth-flow] ignoring stale deadline due to oauth url mismatch', {
      step,
      actionLabel,
      deadlineSourceUrl,
      currentOauthUrl,
    });
    return null;
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw buildOAuthFlowTimeoutError(step, actionLabel, state);
  }

  return remainingMs;
}

async function getOAuthFlowStepTimeoutMs(defaultTimeoutMs, options = {}) {
  const normalizedDefault = Math.max(1000, Number(defaultTimeoutMs) || 1000);
  const reserveMs = Math.max(0, Number(options.reserveMs) || 0);
  const remainingMs = await getOAuthFlowRemainingMs(options);
  if (remainingMs === null) {
    return normalizedDefault;
  }

  const budgetMs = remainingMs - reserveMs;
  if (budgetMs <= 0) {
    const stateForError = options.state || await getState();
    throw buildOAuthFlowTimeoutError(
      Number(options.step) || 7,
      String(options.actionLabel || '后续授权流程').trim() || '后续授权流程',
      stateForError
    );
  }

  return Math.max(1000, Math.min(normalizedDefault, budgetMs));
}

function isStep6SuccessResult(result) {
  return result?.step6Outcome === 'success';
}

function isStep6RecoverableResult(result) {
  return result?.step6Outcome === 'recoverable';
}

function isAddPhoneAuthUrl(url) {
  return /https:\/\/auth\.openai\.com\/(?:add-phone|phone-verification)(?:[/?#]|$)/i.test(String(url || '').trim());
}

function isAddPhoneAuthState(authState = {}) {
  return authState?.state === 'add_phone_page'
    || authState?.state === 'phone_verification_page'
    || Boolean(authState?.addPhonePage)
    || Boolean(authState?.phoneVerificationPage)
    || isAddPhoneAuthUrl(authState?.url);
}

async function getPostStep6AutoRestartDecision(step, error) {
  const resolveStepKey = (stepId, state) => {
    if (typeof getStepExecutionKeyForState === 'function') {
      return getStepExecutionKeyForState(stepId, state);
    }
    return String(
      typeof getStepDefinitionForState === 'function'
        ? (getStepDefinitionForState(stepId, state)?.key || '')
        : ''
    ).trim();
  };
  const findStepIdByKeyForState = (targetKey, state = {}) => {
    const normalizedKey = String(targetKey || '').trim();
    if (!normalizedKey) {
      return null;
    }
    const stepIds = typeof getStepIdsForState === 'function'
      ? getStepIdsForState(state)
      : [];
    for (const stepId of stepIds) {
      if (resolveStepKey(stepId, state) === normalizedKey) {
        return Number(stepId);
      }
    }
    return null;
  };
  const isPlatformVerifyTransientRetryError = (errorMessage = '') => {
    const normalizedMessage = String(errorMessage || '');
    const mentionsTokenExchange = /auth\.openai\.com\/oauth\/token|token\s*exchange|token_exchange_user_error/i.test(normalizedMessage);
    const hasTransientNetworkSignal = /connect:\s*connection refused|failed to fetch|i\/o timeout|context deadline exceeded|eof|connection reset by peer/i.test(normalizedMessage);
    const hasTransientTokenExchangeSignal = /token_exchange_user_error|invalid request\.?\s*please try again later/i.test(normalizedMessage);
    return mentionsTokenExchange && (hasTransientNetworkSignal || hasTransientTokenExchangeSignal);
  };
  const isPhoneVerificationLocalFailure = (errorMessage = '') => {
    const normalizedMessage = String(errorMessage || '');
    if (isPhoneSmsPlatformRateLimitFailure(normalizedMessage)) {
      return false;
    }
    return /HeroSMS|phone verification did not succeed|number replacements|sms_timeout_after(?:_[a-z0-9_]+)?|phone number is already linked|add-phone keeps rejecting current number|手机验证码|短信验证码|接码|步骤\s*9[：:][\s\S]*(?:手机号验证|手机验证码|接码|没有可用手机号|无可用手机号)|(?:手机号验证|手机号码验证|手机号接码|手机号码接码)[\s\S]*(?:失败|超时|未成功|不可用|拒绝)|(?:手机号|手机号码)[\s\S]*(?:已绑定|被占用|不可用|拒绝|失败|超时|没有可用|无可用)|Step\s*9.*phone verification/i.test(normalizedMessage);
  };

  const normalizedStep = Number(step);
  const errorMessage = getErrorMessage(error);
  if (isExternalRedeemQualifiedFailureError(error)) {
    return {
      shouldRestart: false,
      blockedByAddPhone: false,
      forcedByPhoneVerificationTimeout: false,
      restartStep: FINAL_OAUTH_CHAIN_START_STEP,
      errorMessage,
      authState: null,
    };
  }
  const shouldForceRestartFromStep7 = /restart step 7 with a new number/i.test(errorMessage);
  const latestState = await getState();
  const authChainStartStep = typeof getAuthChainStartStepId === 'function'
    ? getAuthChainStartStepId(latestState)
    : FINAL_OAUTH_CHAIN_START_STEP;
  const lastStepId = typeof getLastStepIdForState === 'function'
    ? getLastStepIdForState(latestState)
    : (typeof LAST_STEP_ID === 'number' ? LAST_STEP_ID : 10);
  const currentNodeKey = resolveStepKey(normalizedStep, latestState);
  const confirmOauthStep = findStepIdByKeyForState('confirm-oauth', latestState);
  const boundEmailReloginStep = findStepIdByKeyForState('relogin-bound-email', latestState);
  const isBoundEmailReloginTailStep = [
    'relogin-bound-email',
    'fetch-bound-email-login-code',
    'post-bound-email-phone-verification',
  ].includes(currentNodeKey);
  const shouldRetryFromConfirmStep = currentNodeKey === 'platform-verify'
    && Number.isFinite(confirmOauthStep)
    && confirmOauthStep > 0
    && confirmOauthStep < normalizedStep
    && isPlatformVerifyTransientRetryError(errorMessage);
  const restartAnchorStep = shouldRetryFromConfirmStep
    ? confirmOauthStep
    : (isBoundEmailReloginTailStep && Number.isFinite(boundEmailReloginStep) && boundEmailReloginStep > 0
      ? boundEmailReloginStep
      : authChainStartStep);
  if (isPhoneSmsPlatformRateLimitFailure(errorMessage)) {
    return {
      shouldRestart: false,
      blockedByAddPhone: false,
      forcedByPhoneVerificationTimeout: false,
      restartStep: authChainStartStep,
      errorMessage,
      authState: null,
    };
  }

  if (!Number.isFinite(normalizedStep) || normalizedStep < authChainStartStep || normalizedStep > lastStepId) {
    return {
      shouldRestart: false,
      blockedByAddPhone: false,
      forcedByPhoneVerificationTimeout: false,
      restartStep: authChainStartStep,
      errorMessage,
      authState: null,
    };
  }

  if (isPhoneVerificationLocalFailure(errorMessage)) {
    return {
      shouldRestart: false,
      blockedByAddPhone: true,
      forcedByPhoneVerificationTimeout: false,
      restartStep: authChainStartStep,
      errorMessage,
      authState: null,
    };
  }

  if (shouldForceRestartFromStep7) {
    return {
      shouldRestart: true,
      blockedByAddPhone: false,
      forcedByPhoneVerificationTimeout: true,
      restartStep: authChainStartStep,
      errorMessage,
      authState: null,
    };
  }

  if (isAddPhoneAuthFailure(error) || isAddPhoneAuthUrl(errorMessage)) {
    return {
      shouldRestart: false,
      blockedByAddPhone: true,
      forcedByPhoneVerificationTimeout: false,
      restartStep: authChainStartStep,
      errorMessage,
      authState: null,
    };
  }

  let authState = null;
  try {
    authState = await getLoginAuthStateFromContent({
      logMessage: `步骤 ${normalizedStep}：正在确认当前认证页状态，以决定是否回到步骤 ${restartAnchorStep} 重开...`,
    });
  } catch (inspectError) {
    console.warn(LOG_PREFIX, '[AutoRun] failed to inspect login auth state after post-step6 error', {
      step: normalizedStep,
      sourceError: errorMessage,
      inspectError: inspectError?.message || inspectError,
    });
  }

  if (isAddPhoneAuthState(authState) && !isPhoneSmsPlatformRateLimitFailure(errorMessage)) {
    return {
      shouldRestart: false,
      blockedByAddPhone: true,
      forcedByPhoneVerificationTimeout: false,
      restartStep: authChainStartStep,
      errorMessage,
      authState,
    };
  }

  return {
    shouldRestart: true,
    blockedByAddPhone: false,
    forcedByPhoneVerificationTimeout: false,
    restartStep: restartAnchorStep,
    errorMessage,
    authState,
  };
}

async function getLoginAuthStateFromContent(options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep || options.logStep || options.step) || 0);
  const logStep = visibleStep > 0 ? visibleStep : null;
  const { logMessage = '认证页正在切换，等待页面重新就绪后继续确认验证码页状态...' } = options;
  const result = await sendToContentScriptResilient(
    'signup-page',
    {
      type: 'GET_LOGIN_AUTH_STATE',
      source: 'background',
      payload: {},
    },
    {
      timeoutMs: options.timeoutMs ?? 15000,
      retryDelayMs: options.retryDelayMs ?? 600,
      responseTimeoutMs: options.responseTimeoutMs ?? (options.timeoutMs ?? 15000),
      logMessage,
      logStep,
      logStepKey: options.logStepKey || '',
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  return result || {};
}

async function getStep5SubmitStateFromContent(options = {}) {
  const result = await sendToContentScriptResilient(
    'signup-page',
    {
      type: 'GET_STEP5_SUBMIT_STATE',
      source: 'background',
      payload: {},
    },
    {
      timeoutMs: options.timeoutMs ?? 15000,
      retryDelayMs: options.retryDelayMs ?? 600,
      responseTimeoutMs: options.responseTimeoutMs ?? (options.timeoutMs ?? 15000),
      logMessage: options.logMessage || '步骤 5：资料页正在切换，等待页面恢复后确认提交结果...',
      logStep: 5,
      logStepKey: options.logStepKey || 'fill-profile',
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  return result || {};
}

async function recoverStep5SubmitRetryPageOnTab(options = {}) {
  const result = await sendToContentScriptResilient(
    'signup-page',
    {
      type: 'RECOVER_STEP5_SUBMIT_RETRY_PAGE',
      source: 'background',
      payload: {
        timeoutMs: options.timeoutMs ?? 12000,
        maxClickAttempts: options.maxClickAttempts ?? 2,
      },
    },
    {
      timeoutMs: options.timeoutMs ?? 15000,
      retryDelayMs: options.retryDelayMs ?? 600,
      responseTimeoutMs: options.responseTimeoutMs ?? (options.timeoutMs ?? 15000),
      logMessage: options.logMessage || '步骤 5：资料提交后正在尝试恢复认证重试页...',
      logStep: 5,
      logStepKey: options.logStepKey || 'fill-profile',
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  return result || {};
}

async function waitForStep5DelayedOnboardingOnTab(options = {}) {
  const payloadTimeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const responseTimeoutMs = Math.max(
    payloadTimeoutMs + 5000,
    Number(options.responseTimeoutMs) || 0,
    35000
  );
  const result = await sendToContentScriptResilient(
    'signup-page',
    {
      type: 'WAIT_STEP5_DELAYED_ONBOARDING',
      source: 'background',
      payload: {
        context: options.context || '后台提交后校验',
        timeoutMs: payloadTimeoutMs,
        pollIntervalMs: options.pollIntervalMs ?? 300,
        logEveryMs: options.logEveryMs ?? 5000,
        logCompletion: options.logCompletion !== false,
      },
    },
    {
      inject: SIGNUP_PAGE_INJECT_FILES,
      injectSource: 'signup-page',
      timeoutMs: responseTimeoutMs + 5000,
      retryDelayMs: options.retryDelayMs ?? 600,
      responseTimeoutMs,
      logMessage: options.logMessage || '步骤 5：ChatGPT 首页可能正在弹出创建后引导页，等待内容脚本恢复后继续处理...',
      logStep: 5,
      logStepKey: options.logStepKey || 'fill-profile',
    }
  );

  if (result?.error) {
    throw new Error(result.error);
  }

  return result || {};
}

async function validateStep5PostCompletion(tabId, completionPayload = {}) {
  if (!Number.isInteger(tabId)) {
    throw new Error('步骤 5：缺少有效的资料页标签页，无法确认提交后的最终状态。');
  }

  const maxAuthRetryRecoveries = Math.max(1, Number(completionPayload?.maxAuthRetryRecoveries) || 2);
  let authRetryRecoveryCount = 0;

  while (true) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = String(tab?.url || completionPayload?.url || '').trim();
    if (currentUrl && isLikelyLoggedInChatgptHomeUrl(currentUrl)) {
      await addLog('步骤 5：已进入 ChatGPT 首页，继续等待最多 30 秒处理可能延迟弹出的创建后引导页...', 'info', {
        step: 5,
        stepKey: 'fill-profile',
      });
      await waitForStep5DelayedOnboardingOnTab({
        context: '后台在 ChatGPT 首页确认 Step 5 完成前',
        timeoutMs: 30000,
        responseTimeoutMs: 40000,
        retryDelayMs: 600,
      });
      return {
        successState: 'logged_in_home',
        url: String((await chrome.tabs.get(tabId).catch(() => null))?.url || currentUrl),
      };
    }

    const pageState = await getStep5SubmitStateFromContent({
      timeoutMs: 15000,
      responseTimeoutMs: 15000,
      retryDelayMs: 500,
      logMessage: '步骤 5：资料提交已触发页面跳转，正在确认最终页面状态...',
    });

    if (pageState.userAlreadyExistsBlocked) {
      throw new Error('SIGNUP_USER_ALREADY_EXISTS::步骤 5：检测到 user_already_exists，当前轮将直接停止。');
    }
    if (pageState.maxCheckAttemptsBlocked) {
      throw new Error('AUTH_MAX_CHECK_ATTEMPTS::max_check_attempts on step 5 auth retry page; restart the current auth step without clicking Retry.');
    }

    if (pageState.retryPage) {
      if (authRetryRecoveryCount >= maxAuthRetryRecoveries) {
        throw new Error(`步骤 5：资料提交后连续进入认证重试页 ${maxAuthRetryRecoveries} 次，页面仍未恢复。URL: ${pageState.url || currentUrl || 'unknown'}`);
      }
      authRetryRecoveryCount += 1;
      await addLog(`步骤 5：提交完成信号后检测到认证重试页，正在自动恢复（${authRetryRecoveryCount}/${maxAuthRetryRecoveries}）...`, 'warn', {
        step: 5,
        stepKey: 'fill-profile',
      });
      await recoverStep5SubmitRetryPageOnTab({
        timeoutMs: 15000,
        retryDelayMs: 600,
        logMessage: '步骤 5：资料提交后的认证重试页正在恢复，等待“重试”按钮重新就绪...',
      });
      await waitForTabStableComplete(tabId, {
        timeoutMs: 30000,
        retryDelayMs: 300,
        stableMs: 1000,
        initialDelayMs: 300,
      }).catch(() => null);
      continue;
    }

    if (pageState.successState === 'logged_in_home' || pageState.successState === 'oauth_consent' || pageState.successState === 'add_phone') {
      return pageState;
    }

    if (pageState.errorText) {
      throw new Error(`步骤 5：资料提交后页面返回错误：${pageState.errorText}。URL: ${pageState.url || currentUrl || 'unknown'}`);
    }

    if (pageState.profileVisible) {
      throw new Error(`步骤 5：资料提交完成信号已收到，但页面仍停留在资料页，当前流程将直接报错。URL: ${pageState.url || currentUrl || 'unknown'}`);
    }

    if (pageState.unknownAuthPage) {
      throw new Error(`步骤 5：资料提交后进入未识别的认证页，无法确认成功。URL: ${pageState.url || currentUrl || 'unknown'}`);
    }

    throw new Error(`步骤 5：资料提交后未能确认最终状态。URL: ${pageState.url || currentUrl || 'unknown'}`);
  }
}

async function ensureStep8VerificationPageReady(options = {}) {
  const visibleStep = Number(options.visibleStep) || 8;
  const authLoginStep = Number(options.authLoginStep) || (visibleStep >= 11 ? 10 : 7);
  const inspectState = async (overrides = {}) => getLoginAuthStateFromContent({
    ...options,
    ...overrides,
  });
  let pageState = await inspectState();
  if (
    pageState.state === 'verification_page'
    || pageState.state === 'oauth_consent_page'
    || (options.allowPhoneVerificationPage && pageState.state === 'phone_verification_page')
    || (options.allowAddEmailPage && pageState.state === 'add_email_page')
  ) {
    return pageState;
  }

  if (pageState.maxCheckAttemptsBlocked) {
    throw new Error(`${CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX}${CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE}`);
  }

  if (pageState.state === 'login_timeout_error_page') {
    let recovered = false;
    try {
      const recoverPayload = {
        flow: 'login',
        logLabel: `步骤 ${visibleStep}：检测到登录超时报错，正在点击“重试”恢复当前页面`,
        step: visibleStep,
        timeoutMs: 12000,
      };
      const recoverMessage = {
        type: 'RECOVER_AUTH_RETRY_PAGE',
        source: 'background',
        payload: recoverPayload,
      };
      let recoverResult = null;
      const recoverTimeoutMs = 15000;
      if (typeof sendToContentScriptResilient === 'function') {
        recoverResult = await sendToContentScriptResilient(
          'signup-page',
          recoverMessage,
          {
            timeoutMs: recoverTimeoutMs,
            responseTimeoutMs: recoverTimeoutMs,
            retryDelayMs: 700,
            logMessage: '认证页进入重试/超时报错状态，正在尝试点击“重试”恢复...',
            logStep: visibleStep,
            logStepKey: 'fetch-login-code',
          }
        );
      } else if (typeof sendToContentScript === 'function') {
        recoverResult = await sendToContentScript('signup-page', recoverMessage, {
          responseTimeoutMs: recoverTimeoutMs,
        });
      }

      if (recoverResult?.error) {
        throw new Error(recoverResult.error);
      }
      recovered = Boolean(recoverResult?.recovered || Number(recoverResult?.clickCount) > 0);
      if (recovered && typeof addLog === 'function') {
        await addLog('认证页已点击“重试”，正在重新确认验证码页状态...', 'warn', {
          step: visibleStep,
          stepKey: 'fetch-login-code',
        });
      }
    } catch (recoverError) {
      const recoverMessage = getErrorMessage(recoverError);
      if (/^CF_SECURITY_BLOCKED::/i.test(recoverMessage)) {
        throw recoverError;
      }
      if (typeof addLog === 'function') {
        await addLog(`认证页“重试”恢复失败：${recoverMessage}`, 'warn', {
          step: visibleStep,
          stepKey: 'fetch-login-code',
        });
      }
    }

    if (recovered) {
      pageState = await inspectState({
        timeoutMs: 10000,
        responseTimeoutMs: 10000,
        retryDelayMs: 500,
        logMessage: '认证页恢复后，正在确认验证码页是否可继续...',
        logStepKey: 'fetch-login-code',
      });
      if (
        pageState.state === 'verification_page'
        || pageState.state === 'oauth_consent_page'
        || (options.allowPhoneVerificationPage && pageState.state === 'phone_verification_page')
        || (options.allowAddEmailPage && pageState.state === 'add_email_page')
      ) {
        return pageState;
      }
      if (pageState.maxCheckAttemptsBlocked) {
        throw new Error(`${CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX}${CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE}`);
      }
      if (pageState.state === 'add_phone_page' || pageState.state === 'phone_verification_page') {
        const urlPart = pageState.url ? ` URL: ${pageState.url}` : '';
        throw new Error(`步骤 ${visibleStep}：当前认证页进入手机号页面，当前流程无法继续自动授权。${urlPart}`.trim());
      }
    }

    const urlPart = pageState.url ? ` URL: ${pageState.url}` : '';
    throw new Error(`STEP8_RESTART_STEP7::步骤 ${visibleStep}：当前认证页进入登录超时报错页，请回到步骤 ${authLoginStep} 重新开始。${urlPart}`.trim());
  }

  if (pageState.state === 'add_phone_page' || pageState.state === 'phone_verification_page') {
    const urlPart = pageState.url ? ` URL: ${pageState.url}` : '';
    throw new Error(`步骤 ${visibleStep}：当前认证页进入手机号页面，当前流程无法继续自动授权。${urlPart}`.trim());
  }

  const stateLabel = getLoginAuthStateLabel(pageState.state);
  const urlPart = pageState.url ? ` URL: ${pageState.url}` : '';
  throw new Error(`当前未进入登录验证码页面，请先重新完成步骤 ${authLoginStep}。当前状态：${stateLabel}.${urlPart}`.trim());
}

async function rerunStep7ForStep8Recovery(options = {}) {
  const {
    logMessage = '正在回到授权登录步骤，重新发起登录验证码流程...',
    logStep = null,
    logStepKey = 'fetch-login-code',
    postStepDelayMs = 3000,
  } = options;

  throwIfStopped();
  const initialState = await getState();
  const authLoginStep = typeof getAuthChainStartStepId === 'function'
    ? getAuthChainStartStepId(initialState)
    : FINAL_OAUTH_CHAIN_START_STEP;
  const authLoginNodeId = getNodeIdByStepForState(authLoginStep, initialState) || 'oauth-login';
  await addLog(logMessage, 'warn', {
    step: logStep,
    stepKey: logStepKey,
  });
  await setNodeStatus(authLoginNodeId, 'running');
  await addLog('开始执行', 'info', { nodeId: authLoginNodeId });

  try {
    await step7Executor.executeStep7({
      ...initialState,
      visibleStep: authLoginStep,
    });
  } catch (err) {
    const latestState = await getState();
    if (isStopError(err)) {
      await setNodeStatus(authLoginNodeId, 'stopped');
      await addLog('已被用户停止', 'warn', { nodeId: authLoginNodeId });
      await appendManualAccountRunRecordIfNeeded(`node:${authLoginNodeId}:stopped`, latestState, getErrorMessage(err));
      throw err;
    }
    if (isTerminalSecurityBlockedError(err)) {
      await handleCloudflareSecurityBlocked(err);
      throw new Error(STOP_ERROR_MESSAGE);
    }
    await setNodeStatus(authLoginNodeId, 'failed');
    await addLog(`失败：${getErrorMessage(err)}`, 'error', { nodeId: authLoginNodeId });
    await appendManualAccountRunRecordIfNeeded(`node:${authLoginNodeId}:failed`, latestState, getErrorMessage(err));
    throw err;
  }

  if (postStepDelayMs > 0) {
    await sleepWithStop(postStepDelayMs);
  }
}

async function executeStep6(state = null) {
  return step6Executor.executeStep6({
    ...(state || await getState()),
    step6CookieCleanupEnabled: false,
  });
}

// ============================================================
// Step 7: Refresh OAuth and log in
// ============================================================

async function executeStep7(state) {
  return step7Executor.executeStep7(state);
}

// ============================================================
// Step 8: Poll login verification mail and submit the login code
// ============================================================

async function executeStep8(state) {
  return step8Executor.executeStep8(state);
}

// ============================================================
// Step 9: 完成 OAuth（自动点击 + localhost 回调监听）
// ============================================================

let webNavListener = null;
let webNavCommittedListener = null;
let step8TabUpdatedListener = null;
let step8PendingReject = null;
const STEP8_CLICK_EFFECT_TIMEOUT_MS = 15000;
const STEP8_CLICK_RETRY_DELAY_MS = 500;
const STEP8_READY_WAIT_TIMEOUT_MS = 180000;
const STEP8_MAX_ROUNDS = 5;
const STEP8_STRATEGIES = [
  { mode: 'content', strategy: 'requestSubmit', label: 'form.requestSubmit' },
  { mode: 'debugger', label: 'debugger click' },
  { mode: 'content', strategy: 'nativeClick', label: 'element.click' },
  { mode: 'content', strategy: 'dispatchClick', label: 'dispatch click' },
  { mode: 'debugger', label: 'debugger click retry' },
];

function setWebNavListener(listener) {
  webNavListener = listener;
}

function getWebNavListener() {
  return webNavListener;
}

function setWebNavCommittedListener(listener) {
  webNavCommittedListener = listener;
}

function getWebNavCommittedListener() {
  return webNavCommittedListener;
}

function setStep8TabUpdatedListener(listener) {
  step8TabUpdatedListener = listener;
}

function getStep8TabUpdatedListener() {
  return step8TabUpdatedListener;
}

function setStep8PendingReject(handler) {
  step8PendingReject = handler;
}

function cleanupStep8NavigationListeners() {
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }
  if (webNavCommittedListener) {
    chrome.webNavigation.onCommitted.removeListener(webNavCommittedListener);
    webNavCommittedListener = null;
  }
  if (step8TabUpdatedListener) {
    chrome.tabs.onUpdated.removeListener(step8TabUpdatedListener);
    step8TabUpdatedListener = null;
  }
}

function rejectPendingStep8(error) {
  if (!step8PendingReject) return;
  const reject = step8PendingReject;
  step8PendingReject = null;
  reject(error);
}

function throwIfStep8SettledOrStopped(isSettled = false) {
  if (isSettled || stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
}

function isStep9AuthCallbackWaitPageUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!['auth.openai.com', 'auth0.openai.com', 'accounts.openai.com'].includes(hostname)) {
      return false;
    }
    const pathname = String(parsed.pathname || '');
    return /\/api\/oauth\/oauth2\/auth(?:[/?#]|$)/i.test(pathname)
      || /\/oauth\/oauth2\/auth(?:[/?#]|$)/i.test(pathname);
  } catch {
    return false;
  }
}

async function shouldDeferStep9CallbackTimeout(details = {}) {
  const tabId = details?.tabId;
  if (!Number.isInteger(tabId)) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return isStep9AuthCallbackWaitPageUrl(tab?.url || '');
}

async function ensureStep8SignupPageReady(tabId, options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep || options.logStep || options.step) || 0);
  await ensureContentScriptReadyOnTab('signup-page', tabId, {
    inject: SIGNUP_PAGE_INJECT_FILES,
    injectSource: 'signup-page',
    timeoutMs: options.timeoutMs ?? 15000,
    retryDelayMs: options.retryDelayMs ?? 600,
    logMessage: options.logMessage || '',
    logStep: visibleStep > 0 ? visibleStep : null,
    logStepKey: options.logStepKey || '',
  });
}

async function readAuthTabSnapshot(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  let tabSnapshot = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabSnapshot = {
      url: String(tab?.url || ''),
      title: String(tab?.title || ''),
      text: '',
    };
  } catch {
    tabSnapshot = null;
  }
  try {
    const executionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => ({
        url: String(location.href || ''),
        title: String(document.title || ''),
        text: String(document.body?.innerText || document.documentElement?.innerText || '').trim(),
      }),
    });
    return executionResults?.[0]?.result || tabSnapshot;
  } catch {
    return tabSnapshot;
  }
}

async function getStep8PageState(tabId, responseTimeoutMs = 1500, visibleStep = 9) {
  try {
    const result = await sendTabMessageWithTimeout(tabId, 'signup-page', {
      type: 'STEP8_GET_STATE',
      source: 'background',
      payload: { visibleStep },
    }, responseTimeoutMs);
    if (result?.error) {
      throw new Error(result.error);
    }
    return result;
  } catch (err) {
    if (isRetryableContentScriptTransportError(err)) {
      return null;
    }
    throw err;
  }
}

async function waitForStep8Ready(tabId, timeoutMs = STEP8_READY_WAIT_TIMEOUT_MS, options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  const start = Date.now();
  let recovered = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const pageState = await getStep8PageState(tabId, 1500, visibleStep);
    if (pageState?.maxCheckAttemptsBlocked) {
      throw new Error(`${CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX}${CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE}`);
    }
    if (pageState?.addPhonePage || pageState?.phoneVerificationPage) {
      const urlPart = pageState?.url ? ` URL: ${pageState.url}` : '';
      throw new Error(
        pageState?.phoneVerificationPage
          ? `步骤 ${visibleStep}：自动确认 OAuth 只处理 OAuth 授权页，当前仍在手机验证码页。${urlPart}`.trim()
          : `步骤 ${visibleStep}：自动确认 OAuth 只处理 OAuth 授权页，当前仍在添加手机号页。${urlPart}`.trim()
      );
    }
    if (pageState?.retryPage) {
      const retryUrl = String(pageState?.url || '').trim();
      const consentLikeRetry = Boolean(
        pageState?.consentReady
        || pageState?.consentPage
        || /\/sign-in-with-chatgpt\/[^/?#]+\/consent(?:[/?#]|$)/i.test(retryUrl)
      );
      if (!consentLikeRetry) {
        throw new Error(`步骤 ${visibleStep}：当前认证页已进入重试页，当前流程将直接报错。URL: ${pageState.url || 'unknown'}`);
      }
    }
    if (pageState?.consentReady) {
      return pageState;
    }
    if (pageState === null && !recovered) {
      recovered = true;
      await ensureStep8SignupPageReady(tabId, {
        timeoutMs: Math.min(10000, timeoutMs),
        visibleStep,
        logStepKey: 'confirm-oauth',
        logMessage: '认证页内容脚本已失联，正在等待页面重新就绪...',
      });
      continue;
    }
    recovered = false;
    await sleepWithStop(250);
  }

  throw new Error(`步骤 ${visibleStep}：长时间未进入 OAuth 同意页，无法定位“继续”按钮。`);
}

async function prepareStep8DebuggerClick(tabId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const responseTimeoutMs = options.responseTimeoutMs ?? timeoutMs;
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  await ensureStep8SignupPageReady(tabId, {
    timeoutMs,
    visibleStep,
    logStepKey: 'confirm-oauth',
    logMessage: '认证页内容脚本已失联，正在恢复后继续定位按钮...',
  });
  const result = await sendToContentScriptResilient('signup-page', {
    type: 'STEP8_FIND_AND_CLICK',
    source: 'background',
    payload: { visibleStep },
  }, {
    timeoutMs,
    responseTimeoutMs,
    retryDelayMs: 600,
    logMessage: '认证页正在切换，等待 OAuth 同意页按钮重新就绪...',
    logStep: visibleStep,
    logStepKey: 'confirm-oauth',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function triggerStep8ContentStrategy(tabId, strategy, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const responseTimeoutMs = options.responseTimeoutMs ?? timeoutMs;
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  await ensureStep8SignupPageReady(tabId, {
    timeoutMs,
    visibleStep,
    logStepKey: 'confirm-oauth',
    logMessage: '认证页内容脚本已失联，正在恢复后继续点击“继续”按钮...',
  });
  const result = await sendToContentScriptResilient('signup-page', {
    type: 'STEP8_TRIGGER_CONTINUE',
    source: 'background',
    payload: {
      visibleStep,
      strategy,
      findTimeoutMs: 4000,
      enabledTimeoutMs: 3000,
    },
  }, {
    timeoutMs,
    responseTimeoutMs,
    retryDelayMs: 600,
    logMessage: '认证页正在切换，等待“继续”按钮重新就绪...',
    logStep: visibleStep,
    logStepKey: 'confirm-oauth',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function recoverAuthRetryPageOnTab(tabId, payload = {}, options = {}) {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const responseTimeoutMs = options.responseTimeoutMs ?? timeoutMs;
  const visibleStep = Math.floor(Number(options.visibleStep || payload?.visibleStep || payload?.step) || 0) || 9;
  await ensureStep8SignupPageReady(tabId, {
    timeoutMs: readyTimeoutMs,
    retryDelayMs: options.retryDelayMs ?? 600,
    visibleStep,
    logStepKey: 'confirm-oauth',
    logMessage: options.readyLogMessage || '认证页内容脚本已失联，正在恢复后继续处理重试页...',
  });
  const result = await sendToContentScriptResilient('signup-page', {
    type: 'RECOVER_AUTH_RETRY_PAGE',
    source: 'background',
    payload,
  }, {
    timeoutMs,
    responseTimeoutMs,
    retryDelayMs: options.retryDelayMs ?? 600,
    logMessage: options.logMessage || '认证页正在切换，等待“重试”按钮重新就绪...',
    logStep: visibleStep,
    logStepKey: 'confirm-oauth',
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function reloadStep8ConsentPage(tabId, timeoutMs = 30000, options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  if (!Number.isInteger(tabId)) {
    throw new Error(`步骤 ${visibleStep}：缺少有效的认证页标签页，无法刷新后重试。`);
  }

  await chrome.tabs.update(tabId, { active: true }).catch(() => { });

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`步骤 ${visibleStep}：刷新认证页后等待页面完成加载超时。`));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status !== 'complete') return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId, { bypassCache: false }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });

  await ensureStep8SignupPageReady(tabId, {
    timeoutMs: Math.min(15000, timeoutMs),
    visibleStep,
    logStepKey: 'confirm-oauth',
    logMessage: '认证页刷新后内容脚本尚未就绪，正在等待页面恢复...',
  });
}

async function waitForStep8ClickEffect(tabId, baselineUrl, timeoutMs = STEP8_CLICK_EFFECT_TIMEOUT_MS, options = {}) {
  const visibleStep = Math.floor(Number(options.visibleStep) || 0) || 9;
  const start = Date.now();
  let recovered = false;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error(`步骤 ${visibleStep}：认证页面标签页已关闭，无法继续自动授权。`);
    }

    if (baselineUrl && typeof tab.url === 'string' && tab.url !== baselineUrl) {
      return { progressed: true, reason: 'url_changed', url: tab.url };
    }

    const pageState = await getStep8PageState(tabId, 1500, visibleStep);
    if (pageState?.maxCheckAttemptsBlocked) {
      throw new Error(`${CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX}${CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE}`);
    }
    if (pageState?.addPhonePage) {
      throw new Error(`步骤 ${visibleStep}：点击“继续”后页面跳到了手机号页面，当前流程无法继续自动授权。`);
    }
    if (pageState?.retryPage) {
      const retryUrl = String(pageState?.url || baselineUrl || '').trim();
      const consentLikeRetry = Boolean(
        pageState?.consentReady
        || pageState?.consentPage
        || /\/sign-in-with-chatgpt\/[^/?#]+\/consent(?:[/?#]|$)/i.test(retryUrl)
      );
      if (!consentLikeRetry) {
        throw new Error(`步骤 ${visibleStep}：点击“继续”后页面进入认证页重试页，当前流程将直接报错。URL: ${pageState.url || baselineUrl || 'unknown'}`);
      }
    }
    if (pageState === null) {
      if (!recovered) {
        recovered = true;
        await ensureStep8SignupPageReady(tabId, {
          timeoutMs: Math.max(1000, Math.min(8000, timeoutMs)),
          visibleStep,
          logStepKey: 'confirm-oauth',
          logMessage: '点击后认证页正在重载，正在等待内容脚本重新就绪...',
        }).catch(() => null);
        continue;
      }
      await sleepWithStop(200);
      continue;
    }
    recovered = false;

    if (pageState?.consentPage === false && !pageState?.verificationPage) {
      return {
        progressed: true,
        reason: 'left_consent_page',
        url: pageState.url || baselineUrl || '',
      };
    }

    await sleepWithStop(200);
  }

  return { progressed: false, reason: 'no_effect' };
}

function getStep8EffectLabel(effect) {
  switch (effect?.reason) {
    case 'url_changed':
      return `URL 已变化：${effect.url}`;
    case 'page_reloading':
      return '页面正在跳转或重载';
    case 'left_consent_page':
      return `页面已离开 OAuth 同意页：${effect.url || 'unknown'}`;
    default:
      return '页面仍停留在 OAuth 同意页';
  }
}

function isStep9OAuthLocalhostTimeoutError(error, visibleStep = 9) {
  const message = getErrorMessage(error);
  if (!message) {
    return false;
  }
  if (!/从拿到 OAuth 登录地址开始/.test(message)) {
    return false;
  }
  if (!/localhost 回调|OAuth localhost 回调/i.test(message)) {
    return false;
  }
  const normalizedStep = Number(visibleStep);
  if (Number.isFinite(normalizedStep) && normalizedStep > 0) {
    const stepPrefix = new RegExp(`步骤\\s*${normalizedStep}\\s*：`);
    if (!stepPrefix.test(message)) {
      return false;
    }
  }
  return true;
}

async function recoverOAuthLocalhostTimeout(details = {}) {
  const {
    error,
    state,
    visibleStep = 9,
  } = details;

  if (!isStep9OAuthLocalhostTimeoutError(error, visibleStep)) {
    return null;
  }

  const authLoginStep = typeof getAuthChainStartStepId === 'function'
    ? getAuthChainStartStepId(state || {})
    : FINAL_OAUTH_CHAIN_START_STEP;
  const authLoginNodeId = String(getNodeIdByStepForState(authLoginStep, state || {}) || 'oauth-login').trim();
  const confirmNodeId = String(getNodeIdByStepForState(visibleStep, state || {}) || 'confirm-oauth').trim();

  await addLog(
    `检测到 OAuth localhost 回调等待窗口已过期，正在复核认证页并回到步骤 ${authLoginStep} 重拉授权链路。`,
    'warn',
    { step: visibleStep, stepKey: 'confirm-oauth' }
  );

  let authState = null;
  try {
    authState = await getLoginAuthStateFromContent({
      timeoutMs: 10000,
      responseTimeoutMs: 10000,
      visibleStep,
      logMessage: '正在复核认证页状态，确认是否可自动恢复 localhost 回调链路...',
      logStepKey: 'confirm-oauth',
    });
  } catch (inspectError) {
    await addLog(
      `复核认证页状态失败（${getErrorMessage(inspectError)}），将按当前 OAuth 流程图重新执行授权前置节点。`,
      'warn',
      { step: visibleStep, stepKey: 'confirm-oauth' }
    );
  }

  if (isAddPhoneAuthState(authState)) {
    const stateLabel = getLoginAuthStateLabel(authState.state);
    await addLog(
      `当前认证页为 ${stateLabel}，将直接回到步骤 ${authLoginStep} 重新拉起授权链路，避免验证码/OAuth 恢复冲突。`,
      'warn',
      { step: visibleStep, stepKey: 'confirm-oauth' }
    );
  } else if (authState && authState.state && !['verification_page', 'oauth_consent_page'].includes(authState.state)) {
    const stateLabel = getLoginAuthStateLabel(authState.state);
    await addLog(
      `当前认证页为 ${stateLabel}，不满足快速恢复条件，将回到步骤 ${authLoginStep} 重开授权链路。`,
      'warn',
      { step: visibleStep, stepKey: 'confirm-oauth' }
    );
  }

  const latestState = await getState();
  if (!step7Executor?.executeStep7 || !step8Executor?.executeStep8) {
    return null;
  }
  const workflowNodeIds = getAutoRunWorkflowNodeIds(latestState);
  const authStartIndex = workflowNodeIds.indexOf(authLoginNodeId);
  const confirmIndex = workflowNodeIds.indexOf(confirmNodeId);
  if (authStartIndex < 0 || confirmIndex < 0 || authStartIndex >= confirmIndex) {
    return null;
  }
  const recoveryNodeIds = workflowNodeIds.slice(authStartIndex, confirmIndex);
  const runRecoveryNode = async (nodeId) => {
    const recoveryState = await getState();
    const recoveryStep = getStepIdByNodeIdForState(nodeId, recoveryState);
    const payload = {
      ...recoveryState,
      visibleStep: recoveryStep,
      nodeId,
    };
    switch (nodeId) {
      case 'oauth-login':
        return step7Executor.executeStep7(payload);
      case 'fetch-login-code':
        return step8Executor.executeStep8(payload);
      case 'post-login-phone-verification':
        return step8Executor.executePostLoginPhoneVerification(payload);
      case 'bind-email':
        return step8Executor.executeBindEmail(payload);
      case 'fetch-bind-email-code':
        return step8Executor.executeFetchBindEmailCode(payload);
      default:
        throw new Error(`OAuth localhost 恢复不支持节点 ${nodeId}。`);
    }
  };

  await addLog(
    `正在自动重开 OAuth 前置节点：${recoveryNodeIds.join(' -> ')}。`,
    'warn',
    { step: visibleStep, stepKey: 'confirm-oauth' }
  );
  for (const nodeId of recoveryNodeIds) {
    await runRecoveryNode(nodeId);
  }

  const recoveredState = await getState();
  const oauthUrl = String(recoveredState?.oauthUrl || state?.oauthUrl || '').trim();
  if (oauthUrl && typeof startOAuthFlowTimeoutWindow === 'function') {
    await startOAuthFlowTimeoutWindow({
      step: Number(visibleStep) || 9,
      oauthUrl,
    });
  }

  await setState({
    localhostUrl: null,
  });

  await addLog(
    `已恢复到自动确认 OAuth 前置状态，并刷新 OAuth localhost 回调等待窗口，准备重试当前步骤。`,
    'warn',
    { step: visibleStep, stepKey: 'confirm-oauth' }
  );
  return await getState();
}

const step9Executor = self.MultiPageBackgroundStep9?.createStep9Executor({
  addLog,
  chrome,
  cleanupStep8NavigationListeners,
  clickWithDebugger,
  completeNodeFromBackground,
  ensureStep8SignupPageReady,
  getOAuthFlowStepTimeoutMs,
  getStep8CallbackUrlFromNavigation,
  getStep8CallbackUrlFromTabUpdate,
  getStep8EffectLabel,
  getTabId,
  getWebNavCommittedListener,
  getWebNavListener,
  getStep8TabUpdatedListener,
  isTabAlive,
  prepareStep8DebuggerClick,
  recoverOAuthLocalhostTimeout,
  reloadStep8ConsentPage,
  reuseOrCreateTab,
  setStep8PendingReject,
  setStep8TabUpdatedListener,
  setWebNavCommittedListener,
  setWebNavListener,
  shouldDeferStep9CallbackTimeout,
  sleepWithStop,
  STEP8_CLICK_RETRY_DELAY_MS,
  STEP8_MAX_ROUNDS,
  STEP8_READY_WAIT_TIMEOUT_MS,
  STEP8_STRATEGIES,
  throwIfStep8SettledOrStopped,
  triggerStep8ContentStrategy,
  waitForStep8ClickEffect,
  waitForStep8Ready,
});

async function executeStep9(state) {
  return step9Executor.executeStep9(state);
}

// ============================================================
// Step 10: 平台回调验证
// ============================================================

async function executeContributionStep10(state) {
  const platformVerifyStep = typeof getStepIdByKeyForState === 'function'
    ? (getStepIdByKeyForState('platform-verify', state) || 10)
    : 10;
  const confirmOauthStep = typeof getStepIdByKeyForState === 'function'
    ? (getStepIdByKeyForState('confirm-oauth', state) || 9)
    : 9;
  const authLoginStep = typeof getStepIdByKeyForState === 'function'
    ? (getStepIdByKeyForState('oauth-login', state) || 7)
    : 7;
  if (state.localhostUrl && !isLocalhostOAuthCallbackUrl(state.localhostUrl)) {
    throw new Error(`步骤 ${confirmOauthStep} 捕获到的 localhost OAuth 回调地址无效，请重新执行步骤 ${confirmOauthStep}。`);
  }
  if (!state.localhostUrl) {
    throw new Error(`缺少 localhost 回调地址，请先完成步骤 ${confirmOauthStep}。`);
  }
  if (!state.contributionSessionId) {
    throw new Error(`缺少贡献会话信息，请重新从步骤 ${authLoginStep} 开始。`);
  }
  if (!contributionOAuthManager?.pollContributionStatus) {
    throw new Error(`贡献 OAuth 流程尚未接入，无法完成贡献模式的步骤 ${platformVerifyStep}。`);
  }

  await addLog('贡献模式正在提交回调并等待最终结果...', 'info', {
    step: platformVerifyStep,
    stepKey: 'platform-verify',
  });

  let latestState = await getState();
  const callbackUrl = latestState.localhostUrl || state.localhostUrl;

  if (!latestState.contributionCallbackUrl && contributionOAuthManager?.handleCapturedCallback) {
    latestState = await contributionOAuthManager.handleCapturedCallback(callbackUrl, {
      source: 'step10',
    });
  } else {
    latestState = await contributionOAuthManager.pollContributionStatus({
      reason: 'step10_initial',
      stateOverride: latestState,
    });
  }

  const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
    ? await getOAuthFlowStepTimeoutMs(120000, {
      step: platformVerifyStep,
      actionLabel: '贡献流程最终结果',
    })
    : 120000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = String(latestState.contributionStatus || '').trim().toLowerCase();
    if (contributionOAuthManager?.isContributionFinalStatus?.(status)) {
      if (status === 'auto_approved') {
        await addLog(`贡献流程已结束，最终状态：${latestState.contributionStatusMessage || status}`, 'ok', {
          step: platformVerifyStep,
          stepKey: 'platform-verify',
        });
        await completeNodeFromBackground(state?.nodeId || 'platform-verify', {
          contributionStatus: status,
          contributionStatusMessage: latestState.contributionStatusMessage || '',
          localhostUrl: callbackUrl,
        });
        return;
      }
      throw new Error(latestState.contributionStatusMessage || '贡献流程失败。');
    }

    await sleepWithStop(2500);
    latestState = await contributionOAuthManager.pollContributionStatus({
      reason: 'step10_wait_final',
      stateOverride: latestState,
    });
  }

  throw new Error(`步骤 ${platformVerifyStep}：等待贡献流程最终结果超时。`);
}

async function executeStep10(state) {
  const platformVerifyStep = typeof getStepIdByKeyForState === 'function'
    ? (getStepIdByKeyForState('platform-verify', state || {}) || 10)
    : 10;
  if (state?.contributionModeExpected && !state?.contributionMode) {
    throw new Error(`步骤 ${platformVerifyStep}：当前自动流程预期使用贡献模式，但运行态 contributionMode 已丢失，已阻止回退到普通 CPA / SUB2API / Codex2API 提交。请重新进入贡献模式后再点击自动。`);
  }
  if (state?.contributionMode) {
    return executeContributionStep10(state);
  }
  return step10Executor.executeStep10(state);
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_RUN_TIMER_ALARM_NAME) {
    launchAutoRunTimerPlan('alarm').catch((err) => {
      console.error(LOG_PREFIX, 'Failed to resume auto run from timer alarm:', err);
    });
    return;
  }
  if (LEGACY_IP_PROXY_FEATURE_ENABLED && alarm.name === IP_PROXY_AUTO_SYNC_ALARM_NAME) {
    runIpProxyAutoSync('alarm').catch((err) => {
      console.error(LOG_PREFIX, 'Failed to run IP proxy auto sync alarm:', err);
    });
    return;
  }
  if (alarm.name === EXTERNAL_REDEEM_MONITOR_ALARM_NAME) {
    pollExternalRedeemQueue('alarm').catch((err) => {
      console.error(LOG_PREFIX, 'Failed to poll external redeem queue:', err);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  plusSuccessSessionUploadManager?.handleTabUpdated(tabId, changeInfo, tab).catch((err) => {
    console.error(LOG_PREFIX, 'Failed to process ChatGPT payments success continuation:', err);
  });
});

chrome.runtime.onStartup.addListener(() => {
  restoreAutoRunTimerIfNeeded().catch((err) => {
    console.error(LOG_PREFIX, 'Failed to restore auto run timer on startup:', err);
  });
  disableLegacyIpProxyFeatureRuntime().catch((err) => {
    console.error(LOG_PREFIX, 'Failed to disable legacy IP proxy feature on startup:', err);
  });
  getState().then((state) => ensureExternalRedeemMonitorAlarm(state)).catch((err) => {
    console.error(LOG_PREFIX, 'Failed to restore external redeem monitor on startup:', err);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  restoreAutoRunTimerIfNeeded().catch((err) => {
    console.error(LOG_PREFIX, 'Failed to restore auto run timer on install/update:', err);
  });
  disableLegacyIpProxyFeatureRuntime().catch((err) => {
    console.error(LOG_PREFIX, 'Failed to disable legacy IP proxy feature on install/update:', err);
  });
  getState().then((state) => ensureExternalRedeemMonitorAlarm(state)).catch((err) => {
    console.error(LOG_PREFIX, 'Failed to restore external redeem monitor on install/update:', err);
  });
});

restoreAutoRunTimerIfNeeded().catch((err) => {
  console.error(LOG_PREFIX, 'Failed to restore auto run timer:', err);
});
disableLegacyIpProxyFeatureRuntime().catch((err) => {
  console.error(LOG_PREFIX, 'Failed to disable legacy IP proxy feature:', err);
});
getState().then((state) => ensureExternalRedeemMonitorAlarm(state)).catch((err) => {
  console.error(LOG_PREFIX, 'Failed to restore external redeem monitor:', err);
});
