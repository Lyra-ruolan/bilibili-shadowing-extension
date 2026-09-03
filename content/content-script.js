(function startBilibiliShadowingContentScript() {
  if (globalThis.__bilibiliShadowingContentInstalled) return;
  globalThis.__bilibiliShadowingContentInstalled = true;

  const CHANNEL = 'SHADOWING_STUDIO_BILIBILI_V1';
  const core = globalThis.ShadowingBilibiliCore;
  const playbackCore = globalThis.ShadowingBilibiliPlaybackCore;
  const EDITABLE_SHORTCUT_SELECTOR = 'input, select, textarea, [contenteditable="true"]';
  const BUTTON_LIKE_SHORTCUT_SELECTOR = 'button, a, [role="button"]';
  const pendingBridgeRequests = new Map();
  const ALLOWED_RATES = new Set([0.5, 0.75, 1, 1.25, 1.5, 2]);
  let videoElement = null;
  let videoListeners = null;
  let timeline = [];
  let selectedPracticeUnit = null;
  let selectedIndex = -1;
  let playbackMode = 'continuous';
  let practiceGranularity = 'sentence';
  let currentBvid = '';
  let currentCid = '';
  let currentPage = 1;
  let currentPartTitle = '';
  let navigationGeneration = 0;
  let lastContextSignature = '';
  let monitorToken = 0;
  let monitorInterval = null;
  let boundaryLock = false;
  let lastStateSentAt = 0;
  let pointerFocusedControl = null;

  function locationInfo() {
    return core?.parseBilibiliVideoUrl?.(location.href) || null;
  }

  function activeCidFromDocument() {
    const selectors = [
      '.bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item[data-cid]',
      '.video-pod__item.active[data-cid]',
      '.video-pod__item.playing[data-cid]',
      '[data-cid][class*="active"]'
    ];
    for (const selector of selectors) {
      const cid = core.normalizeCid(document.querySelector(selector)?.getAttribute('data-cid'));
      if (cid) return cid;
    }
    return '';
  }

  function cleanTitle() {
    const heading = document.querySelector('h1')?.textContent;
    const metaTitle = document.querySelector('meta[property="og:title"]')?.content;
    return String(currentPartTitle || heading || metaTitle || document.title || '哔哩哔哩视频')
      .replace(/_哔哩哔哩_bilibili\s*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 500);
  }

  function chooseVideoElement() {
    const candidates = [...document.querySelectorAll('video')].filter((video) => video.isConnected);
    if (!candidates.length) return null;
    return candidates.sort((left, right) => {
      function score(video) {
        const rect = video.getBoundingClientRect();
        const visibleArea = Math.max(0, rect.width) * Math.max(0, rect.height);
        return visibleArea + (video.readyState > 0 ? 1_000_000 : 0) + (!video.paused ? 2_000_000 : 0);
      }
      return score(right) - score(left);
    })[0];
  }

  function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function currentVideoKey() {
    return core.contextKey(currentBvid, currentCid);
  }

  function playerState() {
    return {
      bvid: currentBvid,
      cid: currentCid,
      videoKey: currentVideoKey(),
      page: currentPage,
      ready: Boolean(videoElement),
      playing: Boolean(videoElement && !videoElement.paused && !videoElement.ended),
      currentTime: finiteNumber(videoElement?.currentTime),
      duration: finiteNumber(videoElement?.duration),
      playbackRate: finiteNumber(videoElement?.playbackRate, 1),
      playbackMode,
      practiceGranularity,
      activeUnitIndex: selectedIndex,
      activeIndex: selectedIndex,
      sentenceIndex: Number(selectedPracticeUnit?.sentenceIndex) || 0,
      chunkIndex: Number.isInteger(Number(selectedPracticeUnit?.chunkIndex))
        ? Number(selectedPracticeUnit.chunkIndex)
        : -1,
      selectedPracticeUnit,
      selectedSentence: selectedPracticeUnit
    };
  }

  function videoContext() {
    const info = locationInfo();
    return {
      bvid: currentBvid || info?.bvid || '',
      cid: currentCid,
      videoKey: currentVideoKey(),
      page: currentPage || info?.page || 1,
      partTitle: currentPartTitle,
      url: location.href,
      title: cleanTitle(),
      player: playerState(),
      supported: Boolean(info?.bvid)
    };
  }

  function sendExtensionEvent(type, payload) {
    try {
      chrome.runtime.sendMessage({ source: 'bilibili-shadowing-content', type, payload }).catch(() => {});
    } catch {
      // The extension may have been reloaded while the page remained open.
    }
  }

  function emitPlayerState(force = false) {
    const now = performance.now();
    if (!force && now - lastStateSentAt < 120) return;
    lastStateSentAt = now;
    sendExtensionEvent('BILIBILI_SHADOWING_PLAYER_STATE_CHANGED', playerState());
  }

  function stopMonitor() {
    monitorToken += 1;
    if (monitorInterval) clearInterval(monitorInterval);
    monitorInterval = null;
  }

  function setActiveIndex(index) {
    const nextIndex = Number(index);
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= timeline.length) return false;
    if (selectedIndex === nextIndex && selectedPracticeUnit === timeline[nextIndex]) return false;
    selectedIndex = nextIndex;
    selectedPracticeUnit = timeline[nextIndex];
    return true;
  }

  function syncActivePracticeUnit(mediaTime = videoElement?.currentTime) {
    const index = playbackCore?.resolveActivePracticeUnitIndex?.(
      timeline,
      finiteNumber(mediaTime, NaN),
      selectedIndex
    ) ?? -1;
    return index >= 0 ? setActiveIndex(index) : false;
  }

  function finishPracticeUnit(action, index = selectedIndex) {
    if (!videoElement || !timeline.length || boundaryLock) return;
    setActiveIndex(index);
    const unit = timeline[selectedIndex];
    if (!unit) return;
    boundaryLock = true;
    if (action === 'loop') {
      videoElement.currentTime = unit.start;
      videoElement.play().catch(() => {});
      setTimeout(() => { boundaryLock = false; }, 140);
    } else if (action === 'pause') {
      videoElement.pause();
      if (videoElement.currentTime > unit.end) videoElement.currentTime = unit.end;
      boundaryLock = false;
    } else {
      boundaryLock = false;
    }
    emitPlayerState(true);
  }

  function checkPlaybackPosition(mediaTime = videoElement?.currentTime) {
    if (!videoElement || boundaryLock || !timeline.length) return;
    const time = finiteNumber(mediaTime, -1);
    if (videoElement.paused) return;
    const decision = playbackCore?.decidePlaybackTick?.({
      mode: playbackMode,
      units: timeline,
      currentIndex: selectedIndex,
      currentTime: time,
      boundaryTolerance: 0.05
    }) || { action: 'none', index: selectedIndex };
    if (decision.action === 'sync') {
      if (setActiveIndex(decision.index)) emitPlayerState(true);
    } else if (decision.action === 'loop' || decision.action === 'pause') {
      finishPracticeUnit(decision.action, decision.index);
    }
  }

  function startMonitor() {
    stopMonitor();
    const token = monitorToken;
    monitorInterval = setInterval(() => {
      checkPlaybackPosition();
      emitPlayerState();
    }, 50);

    if (typeof videoElement?.requestVideoFrameCallback === 'function') {
      const onFrame = (_now, metadata) => {
        if (token !== monitorToken || !videoElement) return;
        checkPlaybackPosition(metadata?.mediaTime);
        emitPlayerState();
        videoElement.requestVideoFrameCallback(onFrame);
      };
      videoElement.requestVideoFrameCallback(onFrame);
    }
  }

  function preparePracticeResume() {
    if (!videoElement || !selectedPracticeUnit) return false;
    if (!playbackCore.shouldRestartPracticeUnit(
      playbackMode,
      videoElement.currentTime,
      selectedPracticeUnit,
      0.05
    )) return false;
    boundaryLock = false;
    videoElement.currentTime = selectedPracticeUnit.start;
    return true;
  }

  function attachVideo(nextVideo) {
    if (videoElement === nextVideo) return;
    if (videoListeners) videoListeners.abort();
    stopMonitor();
    videoElement = nextVideo;
    videoListeners = new AbortController();
    if (!videoElement) {
      emitPlayerState(true);
      return;
    }
    const signal = videoListeners.signal;
    videoElement.addEventListener('play', () => {
      preparePracticeResume();
      syncActivePracticeUnit();
      startMonitor();
      emitPlayerState(true);
    }, { signal });
    videoElement.addEventListener('pause', () => { stopMonitor(); emitPlayerState(true); }, { signal });
    videoElement.addEventListener('ratechange', () => emitPlayerState(true), { signal });
    videoElement.addEventListener('loadedmetadata', () => emitPlayerState(true), { signal });
    videoElement.addEventListener('timeupdate', () => { checkPlaybackPosition(); emitPlayerState(); }, { signal });
    videoElement.addEventListener('seeking', () => { syncActivePracticeUnit(); emitPlayerState(true); }, { signal });
    videoElement.addEventListener('seeked', () => { syncActivePracticeUnit(); emitPlayerState(true); }, { signal });
    videoElement.addEventListener('ended', () => { stopMonitor(); emitPlayerState(true); }, { signal });
    if (!videoElement.paused) startMonitor();
    emitPlayerState(true);
  }

  function resetTimeline() {
    timeline = [];
    selectedPracticeUnit = null;
    selectedIndex = -1;
    currentPartTitle = '';
    boundaryLock = false;
  }

  function emitContextIfChanged(force = false) {
    const context = videoContext();
    const signature = `${context.bvid}|${context.cid}|${context.page}|${context.title}|${Boolean(videoElement)}`;
    if (!force && signature === lastContextSignature) return;
    lastContextSignature = signature;
    sendExtensionEvent('BILIBILI_SHADOWING_VIDEO_CONTEXT_CHANGED', context);
  }

  function inspectPage(force = false) {
    const info = locationInfo();
    const nextBvid = info?.bvid || '';
    const nextPage = info?.page || 1;
    const observedCid = nextBvid ? activeCidFromDocument() : '';
    const keepKnownCid = nextBvid === currentBvid && nextPage === currentPage;
    const nextCid = observedCid || (keepKnownCid ? currentCid : '');
    const identityChanged = nextBvid !== currentBvid
      || nextPage !== currentPage
      || Boolean(observedCid && observedCid !== currentCid);
    if (identityChanged) {
      currentBvid = nextBvid;
      currentCid = nextCid;
      currentPage = nextPage;
      navigationGeneration += 1;
      timeline = [];
      selectedPracticeUnit = null;
      selectedIndex = -1;
      boundaryLock = false;
      lastContextSignature = '';
      force = true;
    } else {
      currentBvid = nextBvid;
      currentCid = nextCid;
      currentPage = nextPage;
    }
    attachVideo(chooseVideoElement());
    emitContextIfChanged(force);
  }

  async function ensurePageBridge() {
    const result = await chrome.runtime.sendMessage({ type: 'BILIBILI_SHADOWING_ENSURE_PAGE_BRIDGE' });
    if (!result?.ok) throw new Error(result?.error || '无法连接哔哩哔哩页面。');
  }

  function requestBridge(type, payload, timeoutMs = 30000) {
    const requestId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        reject(new Error('读取字幕超时，请重试。'));
      }, timeoutMs);
      pendingBridgeRequests.set(requestId, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      window.postMessage({
        channel: CHANNEL,
        direction: 'content-to-page',
        type,
        requestId,
        payload
      }, location.origin);
    });
  }

  async function loadCaptions(requestedBvid, requestedTrackKey = '') {
    if (!core?.smartSegmentCues) throw new Error('插件分句模块没有正确加载。');
    inspectPage();
    const info = locationInfo();
    if (!info || requestedBvid !== info.bvid) throw new Error('当前页面已经切换到另一个视频。');
    const generation = navigationGeneration;
    const expected = {
      bvid: currentBvid,
      cid: currentCid,
      page: currentPage,
      trackKey: String(requestedTrackKey || '').slice(0, 300)
    };
    await ensurePageBridge();
    const response = await requestBridge('LOAD_CAPTIONS', expected, 45000);
    if (generation !== navigationGeneration) throw new Error('分P已切换，旧字幕结果已丢弃。');
    if (!response?.ok) throw new Error(response?.error || '字幕读取失败。');
    const data = response.data;
    if (data?.bvid !== currentBvid || Number(data?.page) !== currentPage) {
      throw new Error('字幕返回数据与当前分P不匹配。');
    }
    const observedCid = activeCidFromDocument();
    if (observedCid && observedCid !== String(data.cid)) throw new Error('分P已切换，旧字幕结果已丢弃。');
    currentCid = core.normalizeCid(data.cid);
    currentPartTitle = String(data.partTitle || '').slice(0, 500);
    const commonResult = {
      bvid: currentBvid,
      cid: currentCid,
      videoKey: currentVideoKey(),
      page: currentPage,
      pageCount: Number(data.pageCount) || 1,
      title: currentPartTitle || String(data.title || cleanTitle()).slice(0, 500),
      rootTitle: String(data.title || '').slice(0, 500),
      track: data.track || null,
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      selectedTrackKey: String(data.selectedTrackKey || ''),
      requestedTrackMissing: Boolean(data.requestedTrackMissing),
      selectionError: String(data.selectionError || ''),
      source: String(data.source || 'bilibili-subtitle')
    };
    if (commonResult.selectionError || !commonResult.track) {
      timeline = [];
      selectedPracticeUnit = null;
      selectedIndex = -1;
      boundaryLock = false;
      emitContextIfChanged(true);
      return {
        ...commonResult,
        language: '未找到英文字幕',
        cues: [],
        sentenceCount: 0,
        sentences: []
      };
    }
    const cues = (Array.isArray(data.cues) ? data.cues : []).slice(0, 50000).map((cue) => ({
      start: Number(cue?.start),
      end: Number(cue?.end),
      text: String(cue?.text || '').replace(/\s+/gu, ' ').trim().slice(0, 10000)
    })).filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.text);
    if (!cues.length) throw new Error('字幕轨道没有可解析的时间轴。');
    const sentences = core.smartSegmentCues(cues);
    if (!sentences.length) throw new Error('字幕无法切分为有效句子。');
    emitContextIfChanged(true);
    return {
      ...commonResult,
      language: String(data.track?.name || data.track?.languageCode || '字幕').slice(0, 100),
      cues,
      sentenceCount: sentences.length,
      sentences
    };
  }

  async function playVideo() {
    if (!videoElement) throw new Error('哔哩哔哩播放器还没有准备好。');
    const materialEnd = Number(timeline.at(-1)?.end);
    if (!preparePracticeResume() && playbackMode === 'continuous'
      && (videoElement.ended || (Number.isFinite(materialEnd) && videoElement.currentTime >= materialEnd - 0.05))) {
      videoElement.currentTime = selectedPracticeUnit?.start || 0;
    }
    await videoElement.play();
  }

  async function executePlayerCommand(command) {
    inspectPage();
    if (!videoElement) throw new Error('哔哩哔哩播放器还没有准备好。');
    const action = String(command?.action || '');
    if (action === 'play') await playVideo();
    else if (action === 'pause') videoElement.pause();
    else if (action === 'toggle') {
      if (videoElement.paused) await playVideo();
      else videoElement.pause();
    } else if (action === 'seek') {
      const seconds = finiteNumber(command.seconds, NaN);
      if (!Number.isFinite(seconds)) throw new Error('无效的跳转时间。');
      videoElement.currentTime = Math.max(0, Math.min(seconds, finiteNumber(videoElement.duration, seconds)));
      syncActivePracticeUnit(seconds);
    } else if (action === 'set-rate') {
      const rate = finiteNumber(command.rate, NaN);
      if (!ALLOWED_RATES.has(rate)) throw new Error('不支持这个播放速度。');
      videoElement.playbackRate = rate;
    } else throw new Error('未知的播放器操作。');
    emitPlayerState(true);
    return playerState();
  }

  function normalizeTimeline(sentences) {
    return playbackCore.normalizePracticeTimeline(sentences);
  }

  function setTimeline(message) {
    if (!core.sameVideoContext(String(message?.videoKey || ''), currentVideoKey())) {
      throw new Error('时间轴与当前分P不匹配。');
    }
    const sourceUnits = Array.isArray(message?.practiceUnits) && message.practiceUnits.length
      ? message.practiceUnits
      : (Array.isArray(message?.sentences) ? message.sentences.map((sentence, sentenceIndex) => ({
        ...sentence,
        sentenceId: Number(sentence?.id) || sentenceIndex + 1,
        sentenceIndex,
        chunkIndex: -1,
        order: 1
      })) : []);
    const nextTimeline = normalizeTimeline(sourceUnits);
    if (!nextTimeline.length) throw new Error('没有可用的练习时间轴。');
    timeline = nextTimeline;
    playbackMode = playbackCore.normalizePlaybackMode(message?.playbackMode, playbackMode);
    practiceGranularity = playbackCore.normalizePracticeGranularity(
      message?.practiceGranularity,
      practiceGranularity
    );
    boundaryLock = false;
    const activeIndex = playbackCore.resolveActivePracticeUnitIndex(timeline, videoElement?.currentTime, 0);
    setActiveIndex(activeIndex >= 0 ? activeIndex : 0);
    emitPlayerState(true);
    return playerState();
  }

  function setPlaybackMode(mode) {
    playbackMode = playbackCore.normalizePlaybackMode(mode, playbackMode);
    boundaryLock = false;
    syncActivePracticeUnit();
    emitPlayerState(true);
    return playerState();
  }

  async function selectPracticeUnit(unit, requestedIndex, autoplay, seek = true) {
    inspectPage();
    const start = finiteNumber(unit?.start, NaN);
    const end = finiteNumber(unit?.end, NaN);
    const text = String(unit?.text || '').trim().slice(0, 10000);
    if (!videoElement) throw new Error('哔哩哔哩播放器还没有准备好。');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) throw new Error('练习单元时间轴无效。');
    const exactIndex = Number(requestedIndex);
    const timelineIndex = Number.isInteger(exactIndex) && exactIndex >= 0 && exactIndex < timeline.length
      ? exactIndex
      : timeline.findIndex((item) => Math.abs(item.start - start) < 0.001 && (!item.text || item.text === text));
    if (timelineIndex >= 0) setActiveIndex(timelineIndex);
    else {
      selectedIndex = -1;
      selectedPracticeUnit = {
        sentenceId: Number(unit?.sentenceId || unit?.id) || 0,
        sentenceIndex: Math.max(0, Number(unit?.sentenceIndex) || 0),
        chunkIndex: Number.isInteger(Number(unit?.chunkIndex)) ? Number(unit.chunkIndex) : -1,
        start,
        end,
        text
      };
    }
    boundaryLock = false;
    if (seek) videoElement.currentTime = start;
    if (autoplay) await videoElement.play();
    emitPlayerState(true);
    return playerState();
  }

  async function selectSentence(sentence, requestedIndex, autoplay) {
    return selectPracticeUnit({
      ...sentence,
      sentenceId: Number(sentence?.id) || Number(requestedIndex) + 1,
      sentenceIndex: Math.max(0, Number(requestedIndex) || 0),
      chunkIndex: -1,
      order: 1
    }, requestedIndex, autoplay, true);
  }

  async function executeGlobalShortcut(command) {
    inspectPage();
    if (!videoElement) return { ...playerState(), shortcutHandled: false, shortcutReason: 'player-unavailable' };
    if (!timeline.length || selectedIndex < 0) {
      return { ...playerState(), shortcutHandled: false, shortcutReason: 'timeline-unavailable' };
    }
    if (command === 'toggle-practice-playback') {
      const result = await executePlayerCommand({ action: 'toggle' });
      return { ...result, shortcutHandled: true };
    }
    const direction = command === 'previous-practice-unit'
      ? 'previous'
      : command === 'next-practice-unit' ? 'next' : '';
    if (!direction) return { ...playerState(), shortcutHandled: false, shortcutReason: 'unknown-command' };
    const targetIndex = playbackCore.resolvePracticeNavigationIndex(timeline, selectedIndex, direction);
    if (targetIndex < 0 || targetIndex === selectedIndex) {
      return { ...playerState(), shortcutHandled: false, shortcutReason: 'timeline-boundary' };
    }
    const result = await selectPracticeUnit(timeline[targetIndex], targetIndex, true, true);
    return { ...result, shortcutHandled: true };
  }

  function respondAsync(sendResponse, operation) {
    Promise.resolve()
      .then(operation)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '操作失败。' }));
  }

  function closestShortcutTarget(target, selector) {
    return target instanceof Element ? target.closest(selector) : null;
  }

  function shortcutTargetContext(target) {
    const buttonLike = closestShortcutTarget(target, BUTTON_LIKE_SHORTCUT_SELECTOR);
    return {
      editable: Boolean(closestShortcutTarget(target, EDITABLE_SHORTCUT_SELECTOR)),
      buttonLike: Boolean(buttonLike),
      pointerFocused: Boolean(buttonLike && pointerFocusedControl === buttonLike)
    };
  }

  document.addEventListener('pointerdown', (event) => {
    pointerFocusedControl = closestShortcutTarget(event.target, BUTTON_LIKE_SHORTCUT_SELECTOR);
  }, true);

  document.addEventListener('focusin', (event) => {
    const focusedControl = closestShortcutTarget(event.target, BUTTON_LIKE_SHORTCUT_SELECTOR);
    if (!focusedControl || focusedControl !== pointerFocusedControl) pointerFocusedControl = null;
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') pointerFocusedControl = null;
    const command = playbackCore.practiceCommandForKey(event);
    if (!playbackCore.shouldHandlePracticeShortcut(command, {
      timelineReady: Boolean(timeline.length && selectedIndex >= 0 && videoElement),
      ...shortcutTargetContext(event.target)
    })) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    executeGlobalShortcut(command).catch(() => {});
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source === 'bilibili-shadowing-service-worker'
      && message.type === 'BILIBILI_SHADOWING_SHORTCUT') {
      respondAsync(sendResponse, () => executeGlobalShortcut(String(message.command || '')));
      return true;
    }
    if (message?.source !== 'bilibili-shadowing-sidepanel') return false;
    if (message.type === 'GET_VIDEO_CONTEXT') {
      inspectPage();
      sendResponse({ ok: true, data: videoContext() });
      return false;
    }
    if (message.type === 'LOAD_CAPTIONS') {
      respondAsync(sendResponse, () => loadCaptions(
        String(message.bvid || ''),
        String(message.trackKey || '')
      ));
      return true;
    }
    if (message.type === 'PLAYER_COMMAND') {
      respondAsync(sendResponse, () => executePlayerCommand(message.command));
      return true;
    }
    if (message.type === 'SELECT_SENTENCE') {
      respondAsync(sendResponse, () => selectSentence(message.sentence, Number(message.index), Boolean(message.autoplay)));
      return true;
    }
    if (message.type === 'SELECT_PRACTICE_UNIT') {
      respondAsync(sendResponse, () => selectPracticeUnit(
        message.unit,
        Number(message.index),
        Boolean(message.autoplay),
        message.seek !== false
      ));
      return true;
    }
    if (message.type === 'SET_TIMELINE') {
      try { sendResponse({ ok: true, data: setTimeline(message) }); }
      catch (error) { sendResponse({ ok: false, error: error?.message || '时间轴设置失败。' }); }
      return false;
    }
    if (message.type === 'SET_PLAYBACK_MODE') {
      sendResponse({ ok: true, data: setPlaybackMode(message.mode) });
      return false;
    }
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message?.direction !== 'page-to-content') return;
    if (message.type !== 'CAPTIONS_RESULT') return;
    const pending = pendingBridgeRequests.get(String(message.requestId || ''));
    if (!pending) return;
    pendingBridgeRequests.delete(message.requestId);
    pending.resolve(message.payload);
  });

  window.addEventListener('popstate', () => setTimeout(() => inspectPage(true), 0));
  window.addEventListener('hashchange', () => setTimeout(() => inspectPage(true), 0));
  document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(() => {
      const info = locationInfo();
      const observedCid = activeCidFromDocument();
      if (!videoElement?.isConnected || info?.bvid !== currentBvid || info?.page !== currentPage
        || (observedCid && observedCid !== currentCid)) inspectPage();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    inspectPage(true);
  }, { once: true });

  setInterval(() => inspectPage(), 700);
  ensurePageBridge().catch(() => {});
  inspectPage(true);
}());
