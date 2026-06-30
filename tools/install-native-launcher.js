#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const HOST_NAME = 'com.gujumpgate.icloud_api_launcher';
const HOST_SCRIPT = path.join(__dirname, 'native-launcher-host.js');
const CHROME_NATIVE_HOST_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts'
);
const HOST_MANIFEST_PATH = path.join(CHROME_NATIVE_HOST_DIR, `${HOST_NAME}.json`);
const HOST_WRAPPER_PATH = path.join(CHROME_NATIVE_HOST_DIR, `${HOST_NAME}.sh`);
const CHROME_USER_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function collectPreferenceFiles() {
  if (!fs.existsSync(CHROME_USER_DATA_DIR)) {
    return [];
  }
  return fs.readdirSync(CHROME_USER_DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CHROME_USER_DATA_DIR, entry.name, 'Preferences'))
    .filter((filePath) => fs.existsSync(filePath));
}

function findExtensionIds() {
  const explicitIds = [
    process.env.GUJUMPGATE_EXTENSION_ID || '',
    process.env.GUJUMPGATE_EXTENSION_IDS || '',
    ...process.argv.slice(2),
  ]
    .join(',')
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => /^[a-p]{32}$/.test(value));
  if (explicitIds.length) {
    return [...new Set(explicitIds)];
  }

  const normalizedProjectDir = fs.realpathSync(PROJECT_DIR);
  const ids = new Set();
  for (const prefPath of collectPreferenceFiles()) {
    const prefs = readJson(prefPath);
    const settings = prefs?.extensions?.settings || {};
    for (const [extensionId, meta] of Object.entries(settings)) {
      const rawPath = meta?.path || meta?.manifest?.key || '';
      if (!rawPath || typeof rawPath !== 'string') {
        continue;
      }
      let resolved = rawPath;
      if (!path.isAbsolute(resolved)) {
        resolved = path.resolve(path.dirname(prefPath), rawPath);
      }
      try {
        if (fs.existsSync(resolved) && fs.realpathSync(resolved) === normalizedProjectDir) {
          ids.add(extensionId);
        }
      } catch {}
    }
  }
  return [...ids];
}

function findExtensionIdsFromLocalStorageMarkers() {
  const ids = new Set();
  const profiles = fs.existsSync(CHROME_USER_DATA_DIR)
    ? fs.readdirSync(CHROME_USER_DATA_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  for (const profile of profiles) {
    const settingsDir = path.join(CHROME_USER_DATA_DIR, profile.name, 'Local Extension Settings');
    if (!fs.existsSync(settingsDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(settingsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-p]{32}$/.test(entry.name)) {
        continue;
      }
      const extensionDataDir = path.join(settingsDir, entry.name);
      let matched = false;
      for (const file of fs.readdirSync(extensionDataDir).slice(0, 24)) {
        const filePath = path.join(extensionDataDir, file);
        if (!fs.statSync(filePath).isFile()) {
          continue;
        }
        const buffer = fs.readFileSync(filePath);
        const text = buffer.toString('utf8');
        if (
          text.includes('chatgpt-ac-external-redeem')
          || text.includes('plusCheckoutConversionProxyUrl')
          || text.includes('multiThreadProfileRunnerUrl')
        ) {
          matched = true;
          break;
        }
      }
      if (matched) {
        ids.add(entry.name);
      }
    }
  }
  return [...ids];
}

function writeHostWrapper() {
  const escapedNode = process.execPath.replace(/"/g, '\\"');
  const escapedScript = HOST_SCRIPT.replace(/"/g, '\\"');
  fs.writeFileSync(HOST_WRAPPER_PATH, `#!/bin/sh\nexec "${escapedNode}" "${escapedScript}"\n`);
  fs.chmodSync(HOST_WRAPPER_PATH, 0o755);
}

function installNativeHost() {
  const preferenceIds = findExtensionIds();
  const extensionIds = preferenceIds.length ? preferenceIds : findExtensionIdsFromLocalStorageMarkers();
  if (!extensionIds.length) {
    throw new Error('未找到当前扩展 ID。请在 chrome://extensions 复制插件 ID 后运行：GUJUMPGATE_EXTENSION_ID=你的插件ID npm run install-native-launcher');
  }
  fs.mkdirSync(CHROME_NATIVE_HOST_DIR, { recursive: true });
  writeHostWrapper();
  const manifest = {
    name: HOST_NAME,
    description: 'GuJumpgate iCloud API local service launcher',
    path: HOST_WRAPPER_PATH,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  fs.writeFileSync(HOST_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.chmodSync(HOST_SCRIPT, 0o755);
  return { hostName: HOST_NAME, manifestPath: HOST_MANIFEST_PATH, wrapperPath: HOST_WRAPPER_PATH, extensionIds };
}

try {
  const result = installNativeHost();
  console.log(`已安装 Native Launcher: ${result.hostName}`);
  console.log(`配置文件: ${result.manifestPath}`);
  console.log(`启动脚本: ${result.wrapperPath}`);
  console.log(`已授权扩展 ID: ${result.extensionIds.join(', ')}`);
  console.log('请在 chrome://extensions 重新加载插件，然后再点击多线程启动。');
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
