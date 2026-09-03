(function startBilibiliShadowingSidePanel() {
  const biliCore = globalThis.ShadowingBilibiliCore;
  const playbackCore = globalThis.ShadowingBilibiliPlaybackCore;
  const exportCore = globalThis.ShadowingBilibiliSubtitleExportCore;
  const EDITABLE_SHORTCUT_SELECTOR = 'input, select, textarea, [contenteditable="true"]';
  const BUTTON_LIKE_SHORTCUT_SELECTOR = 'button, a, [role="button"]';
  let pointerFocusedControl = null;
  const state = {
    tabId: null,
    bvid: '',
    cid: '',
    videoKey: '',
    page: 1,
    pageCount: 1,
    title: '',
    tracks: [],
    selectedTrackKey: '',
    trackSelections: {},
    rawCues: [],
    sentences: [],
    practiceUnits: [],
    currentIndex: -1,
    currentChunkIndex: -1,
    currentUnitIndex: -1,
    player: null,
    loading: false,
    playbackMode: 'continuous',
    practiceGranularity: 'sentence',
    playbackRate: 1,
    workspaceView: 'practice',
    settingsOpen: false,
    contextExpanded: false,
    contextForcedExpanded: false,
    loadGeneration: 0
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    topbar: $('.topbar'),
    empty: $('#emptyState'),
    practice: $('#practiceView'),
    contextToggle: $('#videoContextToggle'),
    contextDetails: $('#videoContextDetails'),
    contextSummaryMeta: $('#contextSummaryMeta'),
    contextSummaryTitle: $('#contextSummaryTitle'),
    title: $('#videoTitle'),
    status: $('#videoStatus'),
    language: $('#languageBadge'),
    trackControl: $('#subtitleTrackControl'),
    trackSelect: $('#subtitleTrackSelect'),
    downloadControl: $('#subtitleDownloadControl'),
    downloadLayer: $('#subtitleDownloadLayer'),
    downloadFormat: $('#subtitleDownloadFormat'),
    downloadButton: $('#subtitleDownloadButton'),
    downloadStatus: $('#subtitleDownloadStatus'),
    loading: $('#loadingCard'),
    card: $('#practiceCard'),
    practicePane: $('#practicePane'),
    captionsPane: $('#captionsPane'),
    workspaceTabs: [...document.querySelectorAll('[data-workspace-view]')],
    captionSection: $('#captionSection'),
    captionList: $('#captionList'),
    captionCount: $('#captionCount'),
    locateCaption: $('#locateCurrentCaption'),
    currentSentence: $('#currentSentence'),
    sentenceScroll: document.querySelector('.sentence-scroll'),
    counter: $('#sentenceCounter'),
    chunkPosition: $('#chunkPosition'),
    time: $('#sentenceTime'),
    progress: $('#sentenceProgress'),
    play: $('#playButton'),
    previous: $('#previousButton'),
    next: $('#nextButton'),
    playbackModes: [...document.querySelectorAll('[data-playback-mode]')],
    practiceGranularities: [...document.querySelectorAll('[data-practice-granularity]')],
    speed: $('#speedSelect'),
    settingsToggle: $('#practiceSettingsToggle'),
    settingsPanel: $('#practiceSettingsPanel'),
    settingsSummary: $('#practiceSettingsSummary'),
    retry: $('#retryButton'),
    reload: $('#reloadButton'),
    footer: $('#footerStatus'),
    dot: $('#connectionDot')
  };

  function parseBilibiliVideoUrl(url) {
    try {
      const parsed = new URL(url || '');
      const bvid = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/u)?.[1] || '';
      const requestedPage = Number(parsed.searchParams.get('p') || 1);
      return parsed.protocol === 'https:' && parsed.hostname === 'www.bilibili.com' && bvid
        ? { bvid, page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 }
        : null;
    } catch {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
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

  function setConnection(message, kind = '') {
    elements.footer.textContent = message;
    elements.dot.className = kind;
  }

  function showEmpty(message = '打开一个哔哩哔哩 BV 视频后再试。') {
    elements.topbar.hidden = false;
    elements.empty.hidden = false;
    elements.practice.hidden = true;
    elements.empty.querySelector('p').textContent = message;
    state.tracks = [];
    state.selectedTrackKey = '';
    state.rawCues = [];
    state.sentences = [];
    renderDownloadState();
    setWorkspaceView('practice', false);
    renderSubtitleTracks();
    setConnection('等待哔哩哔哩页面');
  }

  function showPractice() {
    elements.topbar.hidden = true;
    elements.empty.hidden = true;
    elements.practice.hidden = false;
    renderDownloadState();
  }

  function renderContextSummary() {
    elements.contextSummaryMeta.textContent = elements.language.textContent || `P${state.page}/${state.pageCount}`;
    elements.contextSummaryTitle.textContent = state.title || '正在连接哔哩哔哩…';
    const expanded = state.contextForcedExpanded || state.contextExpanded;
    elements.contextToggle.setAttribute('aria-expanded', String(expanded));
    elements.contextDetails.hidden = !expanded;
  }

  function setContextForcedExpanded(forced) {
    state.contextForcedExpanded = Boolean(forced);
    renderContextSummary();
  }

  async function setContextExpanded(expanded, persist = true) {
    state.contextExpanded = Boolean(expanded);
    renderContextSummary();
    if (persist) await chrome.storage.local.set({ bilibiliContextExpanded: state.contextExpanded });
  }

  function renderSettingsSummary() {
    const granularity = state.practiceGranularity === 'chunk' ? '分段' : '整句';
    const mode = { continuous: '连播', single: '单句', loop: '循环' }[state.playbackMode] || '连播';
    const rate = Number(state.playbackRate || 1).toFixed(2).replace(/\.00$/u, '').replace(/0$/u, '');
    elements.settingsSummary.textContent = `${granularity} · ${mode} · ${rate}×`;
  }

  function setSettingsOpen(open) {
    state.settingsOpen = Boolean(open);
    elements.settingsToggle.setAttribute('aria-expanded', String(state.settingsOpen));
    elements.settingsPanel.hidden = !state.settingsOpen;
  }

  function locateCurrentCaption(behavior = 'auto') {
    if (state.currentIndex < 0 || elements.captionsPane.hidden) return;
    const item = elements.captionList.querySelector(`.caption-item[data-index="${state.currentIndex}"]`);
    if (!item) return;
    const listRect = elements.captionList.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const target = Math.max(0, elements.captionList.scrollTop
      + itemRect.top - listRect.top
      - (elements.captionList.clientHeight - itemRect.height) / 2);
    elements.captionList.scrollTo({ top: target, behavior });
  }

  function setWorkspaceView(view, locate = true) {
    const requested = view === 'captions' && state.sentences.length ? 'captions' : 'practice';
    state.workspaceView = requested;
    elements.practicePane.hidden = requested !== 'practice';
    elements.captionsPane.hidden = requested !== 'captions';
    for (const tab of elements.workspaceTabs) {
      const active = tab.dataset.workspaceView === requested;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    if (requested === 'captions' && locate) requestAnimationFrame(() => locateCurrentCaption('auto'));
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] || null;
  }

  async function sendToContent(type, data = {}) {
    if (!Number.isInteger(state.tabId)) throw new Error('没有可用的哔哩哔哩标签页。');
    try {
      const response = await chrome.tabs.sendMessage(state.tabId, {
        source: 'bilibili-shadowing-sidepanel',
        type,
        ...data
      });
      if (!response?.ok) throw new Error(response?.error || '哔哩哔哩页面没有响应。');
      return response.data;
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/iu.test(error?.message || '')) {
        throw new Error('插件还没有连接到这个页面，请刷新哔哩哔哩视频后重试。');
      }
      throw error;
    }
  }

  function renderCurrentSentence() {
    const sentence = state.sentences[state.currentIndex];
    const unit = state.practiceUnits[state.currentUnitIndex];
    if (!sentence) {
      elements.currentSentence.textContent = '选择一句开始练习';
      delete elements.currentSentence.dataset.sentenceIndex;
      elements.counter.textContent = `0 / ${state.sentences.length}`;
      elements.chunkPosition.hidden = true;
      elements.time.textContent = '00:00 — 00:00';
      elements.previous.disabled = true;
      elements.next.disabled = true;
      elements.play.disabled = true;
      return;
    }
    const chunks = Array.isArray(sentence.practiceChunks) ? sentence.practiceChunks : [];
    const textSegments = playbackCore.buildPracticeTextSegments(
      sentence,
      state.practiceGranularity,
      state.currentChunkIndex
    );
    if (state.practiceGranularity === 'chunk' && textSegments[0]?.chunkIndex >= 0) {
      elements.currentSentence.innerHTML = textSegments.map((segment) => `<span class="practice-chunk${segment.active ? ' active' : ''}" data-chunk-index="${segment.chunkIndex}" role="button" tabindex="0">${escapeHtml(segment.text)}</span>`).join('');
    } else {
      elements.currentSentence.textContent = sentence.text;
    }
    elements.currentSentence.dataset.sentenceIndex = String(state.currentIndex);
    elements.counter.textContent = `${state.currentIndex + 1} / ${state.sentences.length}`;
    elements.chunkPosition.hidden = state.practiceGranularity !== 'chunk';
    elements.chunkPosition.textContent = state.practiceGranularity === 'chunk'
      ? `片段 ${Math.max(1, state.currentChunkIndex + 1)} / ${Math.max(1, chunks.length)}`
      : '';
    elements.time.textContent = `${formatTime(unit?.start ?? sentence.start)} — ${formatTime(unit?.end ?? sentence.end)}`;
    elements.previous.disabled = state.currentUnitIndex <= 0;
    elements.next.disabled = state.currentUnitIndex >= state.practiceUnits.length - 1;
    elements.play.disabled = false;
    elements.captionList.querySelectorAll('.caption-item').forEach((button, index) => {
      button.classList.toggle('active', index === state.currentIndex);
    });
    updateProgress();
  }

  function renderCaptionList() {
    elements.captionCount.textContent = `${state.sentences.length} 句`;
    elements.captionList.innerHTML = state.sentences.map((sentence, index) => `
      <button class="caption-item${index === state.currentIndex ? ' active' : ''}" data-index="${index}" type="button">
        <time>${formatTime(sentence.start)}</time>
        <span class="caption-copy">${escapeHtml(sentence.text)}</span>
        ${sentence.practiceChunks?.length > 1 ? `<small>${sentence.practiceChunks.length} 段</small>` : ''}
      </button>
    `).join('');
  }

  function updateProgress() {
    const sentence = state.practiceUnits[state.currentUnitIndex];
    const currentTime = Number(state.player?.currentTime) || 0;
    if (!sentence) {
      elements.progress.style.width = '0';
      return;
    }
    const ratio = Math.max(0, Math.min(1, (currentTime - sentence.start) / (sentence.end - sentence.start)));
    elements.progress.style.width = `${ratio * 100}%`;
  }

  function renderPlayerState() {
    const playing = Boolean(state.player?.playing);
    const modeLabel = { continuous: '连播', single: '单句', loop: '循环' }[state.playbackMode] || '连播';
    const granularityLabel = state.practiceGranularity === 'chunk' ? '分段' : '整句';
    elements.play.textContent = playing ? 'Ⅱ' : '▶';
    elements.play.title = playing ? '暂停' : '播放';
    elements.status.textContent = state.player?.ready
      ? `${playing ? '正在播放' : '已暂停'} · ${granularityLabel} / ${modeLabel} · ${Number(state.player.playbackRate || 1).toFixed(2).replace(/\.00$/u, '')}×`
      : '等待哔哩哔哩播放器准备';
    renderContextSummary();
    updateProgress();
  }

  function renderPlaybackMode() {
    for (const button of elements.playbackModes) {
      const active = button.dataset.playbackMode === state.playbackMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderSettingsSummary();
  }

  function renderPracticeGranularity() {
    for (const button of elements.practiceGranularities) {
      const active = button.dataset.practiceGranularity === state.practiceGranularity;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderSettingsSummary();
  }

  function renderSubtitleTracks() {
    elements.trackControl.hidden = !state.tracks.length;
    elements.trackSelect.replaceChildren();
    if (!state.selectedTrackKey) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '请选择字幕轨道';
      placeholder.selected = true;
      elements.trackSelect.append(placeholder);
    }
    for (const track of state.tracks) {
      const option = document.createElement('option');
      option.value = track.trackKey;
      const kind = track.detectionSource === 'content'
        ? '英文内容识别'
        : track.isAi ? 'AI' : '人工';
      option.textContent = `${track.name || track.languageCode || '字幕'} · ${kind}`;
      option.selected = track.trackKey === state.selectedTrackKey;
      elements.trackSelect.append(option);
    }
    elements.trackSelect.value = state.selectedTrackKey || '';
    renderContextSummary();
  }

  function selectedSubtitleTrack() {
    return state.tracks.find((track) => track.trackKey === state.selectedTrackKey) || null;
  }

  function setDownloadStatus(message = '', error = false) {
    elements.downloadStatus.textContent = message;
    elements.downloadStatus.classList.toggle('error', Boolean(error));
  }

  function exportItemsForLayer(layer = elements.downloadLayer.value) {
    return layer === 'cue' ? state.rawCues : state.sentences;
  }

  function renderDownloadState(resetStatus = false) {
    const hasVideo = Boolean(state.bvid);
    const items = exportItemsForLayer();
    const ready = !state.loading && Boolean(state.selectedTrackKey) && items.length > 0;
    elements.downloadControl.hidden = !hasVideo;
    elements.downloadLayer.disabled = state.loading || !state.selectedTrackKey;
    elements.downloadFormat.disabled = state.loading || !state.selectedTrackKey;
    elements.downloadButton.disabled = !ready;
    if (state.loading) setDownloadStatus('正在读取字幕');
    else if (!ready) setDownloadStatus('暂无可下载字幕');
    else if (resetStatus) setDownloadStatus('');
  }

  function downloadCurrentSubtitles() {
    try {
      const layer = exportCore.normalizeExportLayer(elements.downloadLayer.value);
      const format = exportCore.normalizeExportFormat(elements.downloadFormat.value);
      const track = selectedSubtitleTrack();
      const artifact = exportCore.createSubtitleExport({
        layer,
        format,
        items: exportItemsForLayer(layer),
        metadata: {
          bvid: state.bvid,
          cid: state.cid,
          page: state.page,
          pageCount: state.pageCount,
          title: state.title,
          url: `https://www.bilibili.com/video/${state.bvid}/?p=${state.page}`,
          track
        }
      });
      const objectUrl = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = artifact.filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setDownloadStatus(`已下载：${artifact.filename}`);
    } catch (error) {
      setDownloadStatus(error?.message || '字幕下载失败。', true);
    }
  }

  function savedTrackKey() {
    return String(state.trackSelections?.[state.videoKey]?.trackKey || '');
  }

  async function persistTrackSelections() {
    state.trackSelections = biliCore.normalizeTrackSelectionStore(state.trackSelections, 50);
    await chrome.storage.local.set({ bilibiliSubtitleTrackSelections: state.trackSelections });
  }

  async function forgetSavedTrackSelection() {
    if (!state.videoKey || !state.trackSelections[state.videoKey]) return;
    const next = { ...state.trackSelections };
    delete next[state.videoKey];
    state.trackSelections = next;
    await persistTrackSelections();
  }

  async function rememberSelectedTrack(track) {
    state.trackSelections = biliCore.rememberTrackSelection(
      state.trackSelections,
      state.videoKey,
      track,
      Date.now()
    );
    await persistTrackSelections();
  }

  function rebuildPracticeUnits() {
    state.practiceUnits = playbackCore.buildPracticeUnits(state.sentences, state.practiceGranularity);
    return state.practiceUnits;
  }

  function syncSelectionFromUnitIndex(index) {
    if (!state.practiceUnits.length) {
      state.currentUnitIndex = -1;
      state.currentIndex = state.sentences.length ? 0 : -1;
      state.currentChunkIndex = -1;
      return;
    }
    state.currentUnitIndex = Math.max(0, Math.min(Number(index) || 0, state.practiceUnits.length - 1));
    const unit = state.practiceUnits[state.currentUnitIndex];
    state.currentIndex = unit.sentenceIndex;
    state.currentChunkIndex = unit.chunkIndex;
  }

  function setLoadError(message) {
    state.loading = false;
    elements.loading.hidden = true;
    elements.card.hidden = true;
    elements.captionSection.hidden = true;
    elements.workspaceTabs.find((tab) => tab.dataset.workspaceView === 'captions').disabled = true;
    setWorkspaceView('practice', false);
    elements.retry.hidden = false;
    elements.status.textContent = message;
    elements.language.textContent = '读取失败';
    renderDownloadState();
    setContextForcedExpanded(true);
    renderSubtitleTracks();
    setConnection(message, 'error');
  }

  function setSelectionError(message) {
    state.loading = false;
    elements.loading.hidden = true;
    elements.card.hidden = true;
    elements.captionSection.hidden = true;
    elements.workspaceTabs.find((tab) => tab.dataset.workspaceView === 'captions').disabled = true;
    setWorkspaceView('practice', false);
    elements.retry.hidden = false;
    elements.status.textContent = message;
    elements.language.textContent = '未找到英文字幕';
    renderDownloadState();
    setContextForcedExpanded(true);
    renderSubtitleTracks();
    setConnection(message, 'error');
  }

  async function loadCaptions({ trackKey = '', explicitSelection = false } = {}) {
    if (!state.bvid || state.loading) return;
    const requestedTrackKey = String(trackKey || savedTrackKey()).slice(0, 300);
    const generation = ++state.loadGeneration;
    state.loading = true;
    state.rawCues = [];
    state.sentences = [];
    state.practiceUnits = [];
    state.currentIndex = -1;
    state.currentChunkIndex = -1;
    state.currentUnitIndex = -1;
    elements.loading.hidden = false;
    elements.card.hidden = true;
    elements.captionSection.hidden = true;
    elements.workspaceTabs.find((tab) => tab.dataset.workspaceView === 'captions').disabled = true;
    setWorkspaceView('practice', false);
    elements.retry.hidden = true;
    elements.trackSelect.disabled = true;
    elements.language.textContent = '正在读取';
    elements.status.textContent = '正在读取当前分P的字幕和时间轴';
    renderDownloadState();
    setContextForcedExpanded(true);
    setConnection('正在读取当前分P', 'connected');

    try {
      const data = await sendToContent('LOAD_CAPTIONS', {
        bvid: state.bvid,
        trackKey: requestedTrackKey
      });
      if (generation !== state.loadGeneration || data.bvid !== state.bvid || Number(data.page) !== state.page) return;
      state.cid = data.cid;
      state.videoKey = data.videoKey;
      state.pageCount = data.pageCount || 1;
      state.title = data.title || state.title;
      const resolvedSavedTrackKey = !requestedTrackKey ? savedTrackKey() : '';
      if (resolvedSavedTrackKey && resolvedSavedTrackKey !== data.selectedTrackKey) {
        state.loading = false;
        return loadCaptions({ trackKey: resolvedSavedTrackKey });
      }
      state.tracks = (Array.isArray(data.tracks) ? data.tracks : []).filter((track) => track?.isEnglish);
      state.selectedTrackKey = String(data.selectedTrackKey || '');
      if (data.requestedTrackMissing && requestedTrackKey === savedTrackKey()) {
        await forgetSavedTrackSelection();
      }
      renderSubtitleTracks();
      elements.title.textContent = state.title;
      elements.language.textContent = data.selectionError
        ? `P${state.page}/${state.pageCount} · 未找到英文字幕`
        : `P${state.page}/${state.pageCount} · ${data.language || '字幕'}${data.track?.detectionSource === 'content'
          ? ' · 英文内容识别'
          : data.track?.isAi ? ' · AI' : ' · 人工'}`;
      renderContextSummary();
      if (data.selectionError) {
        setSelectionError(data.selectionError);
        return false;
      }
      state.rawCues = Array.isArray(data.cues) ? data.cues : [];
      state.sentences = data.sentences || [];
      if (!state.sentences.length) throw new Error('所选字幕轨道没有可练习的字幕内容。');
      rebuildPracticeUnits();
      if (state.sentences.length) {
        state.player = await sendToContent('SET_TIMELINE', {
          videoKey: state.videoKey,
          practiceUnits: state.practiceUnits,
          practiceGranularity: state.practiceGranularity,
          playbackMode: state.playbackMode
        });
        if (state.player?.ready) {
          state.player = await sendToContent('PLAYER_COMMAND', { command: { action: 'set-rate', rate: state.playbackRate } });
        }
      }
      const activeIndex = Number(state.player?.activeUnitIndex ?? state.player?.activeIndex);
      syncSelectionFromUnitIndex(Number.isInteger(activeIndex) ? activeIndex : 0);
      if (explicitSelection && data.track && !data.requestedTrackMissing) {
        await rememberSelectedTrack(data.track);
      }
      elements.loading.hidden = true;
      elements.card.hidden = false;
      elements.captionSection.hidden = false;
      elements.workspaceTabs.find((tab) => tab.dataset.workspaceView === 'captions').disabled = false;
      renderCaptionList();
      renderCurrentSentence();
      elements.status.textContent = `${state.sentences.length} 句 · ${state.practiceUnits.length} 个练习单元`;
      renderDownloadState(true);
      setContextForcedExpanded(false);
      setConnection('已连接当前哔哩哔哩分P', 'connected');
      return true;
    } catch (error) {
      if (generation === state.loadGeneration) setLoadError(error?.message || '字幕读取失败。');
    } finally {
      if (generation === state.loadGeneration) {
        state.loading = false;
        elements.trackSelect.disabled = false;
        renderDownloadState(true);
      }
    }
  }

  async function selectPracticeUnit(index, autoplay = true, seek = true) {
    const nextIndex = Math.max(0, Math.min(Number(index), state.practiceUnits.length - 1));
    const unit = state.practiceUnits[nextIndex];
    if (!unit) return;
    syncSelectionFromUnitIndex(nextIndex);
    renderCurrentSentence();
    try {
      state.player = await sendToContent('SELECT_PRACTICE_UNIT', {
        unit,
        index: nextIndex,
        autoplay,
        seek
      });
      renderPlayerState();
    } catch (error) {
      setConnection(error?.message || '无法控制播放器。', 'error');
    }
  }

  function navigatePracticeUnit(direction) {
    const targetIndex = playbackCore.resolvePracticeNavigationIndex(
      state.practiceUnits,
      state.currentUnitIndex,
      direction
    );
    if (targetIndex < 0 || targetIndex === state.currentUnitIndex) return;
    selectPracticeUnit(targetIndex, true, true);
  }

  function selectSentence(index, autoplay = true) {
    const sentenceIndex = Math.max(0, Math.min(Number(index), state.sentences.length - 1));
    const unitIndex = playbackCore.findPracticeUnitIndex(
      state.practiceUnits,
      sentenceIndex,
      state.practiceGranularity === 'chunk' ? 0 : -1
    );
    return selectPracticeUnit(unitIndex, autoplay, true);
  }

  async function playerCommand(action, extra = {}) {
    try {
      state.player = await sendToContent('PLAYER_COMMAND', { command: { action, ...extra } });
      renderPlayerState();
      setConnection('已连接当前哔哩哔哩分P', 'connected');
    } catch (error) {
      setConnection(error?.message || '播放器操作失败。', 'error');
    }
  }

  async function connectToTab(forceReload = false) {
    const tab = await activeTab();
    const urlInfo = parseBilibiliVideoUrl(tab?.url);
    if (!tab || !urlInfo) {
      state.tabId = null;
      state.bvid = '';
      state.cid = '';
      state.videoKey = '';
      state.rawCues = [];
      state.sentences = [];
      state.practiceUnits = [];
      state.currentIndex = -1;
      state.currentUnitIndex = -1;
      state.currentChunkIndex = -1;
      showEmpty();
      return;
    }
    const tabChanged = tab.id !== state.tabId;
    state.tabId = tab.id;
    showPractice();
    setConnection('正在连接哔哩哔哩页面');
    try {
      const context = await sendToContent('GET_VIDEO_CONTEXT');
      if (!context?.supported || !context.bvid) return showEmpty('当前页面不是支持的哔哩哔哩 BV 视频。');
      const videoChanged = tabChanged
        || context.bvid !== state.bvid
        || Number(context.page) !== state.page
        || Boolean(context.cid && state.cid && context.cid !== state.cid);
      state.bvid = context.bvid;
      state.cid = context.cid || '';
      state.videoKey = context.videoKey || '';
      state.page = Number(context.page) || 1;
      state.title = context.title || tab.title || '哔哩哔哩视频';
      state.player = context.player;
      elements.title.textContent = state.title;
      renderContextSummary();
      renderPlayerState();
      if (videoChanged || forceReload || !state.sentences.length) {
        if (videoChanged) {
          state.tracks = [];
          state.selectedTrackKey = '';
          state.rawCues = [];
          renderSubtitleTracks();
          renderDownloadState();
        }
        state.loading = false;
        state.loadGeneration += 1;
        await loadCaptions();
      }
    } catch (error) {
      showPractice();
      setLoadError(error?.message || '无法连接当前哔哩哔哩页面。');
    }
  }

  async function restoreSettings() {
    const settings = await chrome.storage.local.get([
      'bilibiliPlaybackMode',
      'bilibiliPlaybackRate',
      'bilibiliPracticeGranularity',
      'bilibiliSubtitleTrackSelections',
      'bilibiliContextExpanded'
    ]);
    state.playbackMode = playbackCore.normalizePlaybackMode(settings.bilibiliPlaybackMode, 'continuous');
    state.practiceGranularity = playbackCore.normalizePracticeGranularity(
      settings.bilibiliPracticeGranularity,
      'sentence'
    );
    state.playbackRate = [0.5, 0.75, 1, 1.25, 1.5, 2].includes(Number(settings.bilibiliPlaybackRate))
      ? Number(settings.bilibiliPlaybackRate)
      : 1;
    state.trackSelections = biliCore.normalizeTrackSelectionStore(
      settings.bilibiliSubtitleTrackSelections,
      50
    );
    state.contextExpanded = settings.bilibiliContextExpanded === true;
    renderPlaybackMode();
    renderPracticeGranularity();
    elements.speed.value = String(state.playbackRate);
    setSettingsOpen(false);
    setContextForcedExpanded(false);
    renderSettingsSummary();
  }

  async function setPlaybackMode(mode) {
    state.playbackMode = playbackCore.normalizePlaybackMode(mode, state.playbackMode);
    renderPlaybackMode();
    await chrome.storage.local.set({ bilibiliPlaybackMode: state.playbackMode });
    try {
      state.player = await sendToContent('SET_PLAYBACK_MODE', { mode: state.playbackMode });
      renderPlayerState();
      setConnection('播放方式已更新', 'connected');
    } catch (error) {
      setConnection(error?.message || '无法更新播放方式。', 'error');
    }
  }

  async function setPracticeGranularity(granularity) {
    const sentenceIndex = Math.max(0, state.currentIndex);
    const currentTime = Number(state.player?.currentTime);
    state.practiceGranularity = playbackCore.normalizePracticeGranularity(
      granularity,
      state.practiceGranularity
    );
    rebuildPracticeUnits();
    const containingIndex = playbackCore.findContainingPracticeUnitIndex(
      state.practiceUnits,
      currentTime,
      sentenceIndex
    );
    const fallbackIndex = playbackCore.findPracticeUnitIndex(
      state.practiceUnits,
      sentenceIndex,
      state.practiceGranularity === 'chunk' ? 0 : -1
    );
    syncSelectionFromUnitIndex(containingIndex >= 0 ? containingIndex : fallbackIndex);
    renderPracticeGranularity();
    renderCurrentSentence();
    renderPlayerState();
    await chrome.storage.local.set({ bilibiliPracticeGranularity: state.practiceGranularity });
    if (!state.practiceUnits.length || !state.videoKey) return;
    try {
      state.player = await sendToContent('SET_TIMELINE', {
        videoKey: state.videoKey,
        practiceUnits: state.practiceUnits,
        practiceGranularity: state.practiceGranularity,
        playbackMode: state.playbackMode
      });
      state.player = await sendToContent('SELECT_PRACTICE_UNIT', {
        unit: state.practiceUnits[state.currentUnitIndex],
        index: state.currentUnitIndex,
        autoplay: false,
        seek: false
      });
      renderPlayerState();
      setConnection('练习粒度已更新', 'connected');
    } catch (error) {
      setConnection(error?.message || '无法更新练习粒度。', 'error');
    }
  }

  elements.captionList.addEventListener('click', (event) => {
    const button = event.target.closest('.caption-item');
    if (button) {
      setWorkspaceView('practice', false);
      selectSentence(Number(button.dataset.index), true);
    }
  });
  elements.workspaceTabs.forEach((tab) => {
    tab.addEventListener('click', () => setWorkspaceView(tab.dataset.workspaceView));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const nextView = tab.dataset.workspaceView === 'practice' ? 'captions' : 'practice';
      const nextTab = elements.workspaceTabs.find((candidate) => candidate.dataset.workspaceView === nextView);
      if (!nextTab?.disabled) {
        setWorkspaceView(nextView);
        nextTab.focus();
      }
    });
  });
  elements.locateCaption.addEventListener('click', () => locateCurrentCaption('smooth'));
  elements.settingsToggle.addEventListener('click', () => setSettingsOpen(!state.settingsOpen));
  elements.contextToggle.addEventListener('click', () => {
    if (state.contextForcedExpanded) return;
    setContextExpanded(!state.contextExpanded).catch(() => {});
  });
  elements.currentSentence.addEventListener('click', (event) => {
    const chunk = event.target.closest('.practice-chunk');
    if (!chunk || state.practiceGranularity !== 'chunk') return;
    const unitIndex = playbackCore.findPracticeUnitIndex(
      state.practiceUnits,
      state.currentIndex,
      Number(chunk.dataset.chunkIndex)
    );
    selectPracticeUnit(unitIndex, true, true);
  });
  elements.currentSentence.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const chunk = event.target.closest('.practice-chunk');
    if (!chunk || state.practiceGranularity !== 'chunk') return;
    event.preventDefault();
    const unitIndex = playbackCore.findPracticeUnitIndex(
      state.practiceUnits,
      state.currentIndex,
      Number(chunk.dataset.chunkIndex)
    );
    selectPracticeUnit(unitIndex, true, true);
  });
  elements.previous.addEventListener('click', () => navigatePracticeUnit('previous'));
  elements.next.addEventListener('click', () => navigatePracticeUnit('next'));
  elements.play.addEventListener('click', () => playerCommand('toggle'));
  elements.retry.addEventListener('click', () => loadCaptions({ trackKey: state.selectedTrackKey || savedTrackKey() }));
  elements.reload.addEventListener('click', () => connectToTab(true));

  elements.trackSelect.addEventListener('change', async () => {
    const trackKey = String(elements.trackSelect.value || '');
    if (!trackKey || trackKey === state.selectedTrackKey) return;
    await playerCommand('pause');
    await loadCaptions({ trackKey, explicitSelection: true });
  });

  elements.downloadLayer.addEventListener('change', () => renderDownloadState(true));
  elements.downloadFormat.addEventListener('change', () => renderDownloadState(true));
  elements.downloadButton.addEventListener('click', downloadCurrentSubtitles);

  elements.playbackModes.forEach((button) => {
    button.addEventListener('click', () => setPlaybackMode(button.dataset.playbackMode));
  });

  elements.practiceGranularities.forEach((button) => {
    button.addEventListener('click', () => setPracticeGranularity(button.dataset.practiceGranularity));
  });

  elements.speed.addEventListener('change', async () => {
    state.playbackRate = Number(elements.speed.value);
    renderSettingsSummary();
    await chrome.storage.local.set({ bilibiliPlaybackRate: state.playbackRate });
    await playerCommand('set-rate', { rate: state.playbackRate });
  });

  document.addEventListener('pointerdown', (event) => {
    pointerFocusedControl = closestShortcutTarget(event.target, BUTTON_LIKE_SHORTCUT_SELECTOR);
  }, true);

  document.addEventListener('focusin', (event) => {
    const focusedControl = closestShortcutTarget(event.target, BUTTON_LIKE_SHORTCUT_SELECTOR);
    if (!focusedControl || focusedControl !== pointerFocusedControl) pointerFocusedControl = null;
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') pointerFocusedControl = null;
    if (event.defaultPrevented) return;
    const command = playbackCore.practiceCommandForKey(event);
    const targetContext = shortcutTargetContext(event.target);
    if (playbackCore.shouldHandlePracticeShortcut(command, {
      timelineReady: Boolean(state.practiceUnits.length),
      ...targetContext
    })) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (command === 'previous-practice-unit') {
        navigatePracticeUnit('previous');
      } else if (command === 'next-practice-unit') {
        navigatePracticeUnit('next');
      } else if (command === 'toggle-practice-playback') {
        playerCommand('toggle');
      }
      return;
    }
    if (targetContext.editable || targetContext.buttonLike) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigatePracticeUnit('previous');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigatePracticeUnit('next');
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.source !== 'bilibili-shadowing-content' || sender.tab?.id !== state.tabId) return;
    if (message.type === 'BILIBILI_SHADOWING_PLAYER_STATE_CHANGED') {
      if (state.videoKey && message.payload?.videoKey && message.payload.videoKey !== state.videoKey) return;
      const previousUnitIndex = state.currentUnitIndex;
      state.player = message.payload;
      const activeIndex = Number(message.payload.activeUnitIndex ?? message.payload.activeIndex);
      if (Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < state.practiceUnits.length) {
        syncSelectionFromUnitIndex(activeIndex);
      }
      if (state.currentUnitIndex !== previousUnitIndex) renderCurrentSentence();
      renderPlayerState();
    }
    if (message.type === 'BILIBILI_SHADOWING_VIDEO_CONTEXT_CHANGED') {
      const context = message.payload;
      if (!context?.bvid) return;
      const cidChanged = Boolean(context.cid && state.cid && context.cid !== state.cid);
      if (context.bvid === state.bvid && Number(context.page) === state.page && !cidChanged) {
        state.cid = context.cid || state.cid;
        state.videoKey = context.videoKey || state.videoKey;
        state.player = context.player || state.player;
        return;
      }
      connectToTab(true);
    }
  });

  chrome.tabs.onActivated.addListener(() => connectToTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.tabId && (changeInfo.url || changeInfo.status === 'complete')) connectToTab();
  });

  restoreSettings()
    .then(() => connectToTab())
    .catch((error) => showEmpty(error?.message || '插件初始化失败。'));
}());
