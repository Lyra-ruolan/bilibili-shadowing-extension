const BILIBILI_VIDEO_URL = /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{10}(?:[/?#]|$)/u;

async function configureAction() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  configureAction().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureAction().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  const url = changeInfo.url || tab.url || '';
  chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel/index.html',
    enabled: BILIBILI_VIDEO_URL.test(url)
  }).catch(() => {});
});

async function injectPageBridge(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['core/bilibili.js', 'content/page-bridge.js']
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'BILIBILI_SHADOWING_ENSURE_PAGE_BRIDGE') return false;
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false, error: '无法确定当前哔哩哔哩标签页。' });
    return false;
  }

  injectPageBridge(tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({
      ok: false,
      error: error?.message || '无法连接哔哩哔哩页面。'
    }));
  return true;
});

const PRACTICE_COMMANDS = new Set([
  'previous-practice-unit',
  'toggle-practice-playback',
  'next-practice-unit'
]);

chrome.commands.onCommand.addListener(async (command) => {
  if (!PRACTICE_COMMANDS.has(command)) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!Number.isInteger(tab?.id) || !BILIBILI_VIDEO_URL.test(String(tab.url || ''))) return;
    await chrome.tabs.sendMessage(tab.id, {
      source: 'bilibili-shadowing-service-worker',
      type: 'BILIBILI_SHADOWING_SHORTCUT',
      command
    });
  } catch {
    // Ignore shortcuts when the active page or content script is unavailable.
  }
});
