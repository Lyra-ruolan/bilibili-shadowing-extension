(function installBilibiliCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShadowingBilibiliCore = Object.assign(root.ShadowingBilibiliCore || {}, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createBilibiliCore() {
  const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/u;

  function parseBilibiliVideoUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.hostname !== 'www.bilibili.com') return null;
      const bvid = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/u)?.[1] || '';
      if (!BVID_PATTERN.test(bvid)) return null;
      const requestedPage = Number(url.searchParams.get('p') || 1);
      const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
      return { bvid, page };
    } catch {
      return null;
    }
  }

  function normalizeCid(value) {
    const text = String(value ?? '').trim();
    return /^\d+$/u.test(text) && Number(text) > 0 ? text : '';
  }

  function contextKey(bvid, cid) {
    const normalizedBvid = BVID_PATTERN.test(String(bvid || '')) ? String(bvid) : '';
    const normalizedCid = normalizeCid(cid);
    return normalizedBvid && normalizedCid ? `${normalizedBvid}:${normalizedCid}` : '';
  }

  function sameVideoContext(left, right) {
    const leftKey = typeof left === 'string' ? left : contextKey(left?.bvid, left?.cid);
    const rightKey = typeof right === 'string' ? right : contextKey(right?.bvid, right?.cid);
    return Boolean(leftKey && rightKey && leftKey === rightKey);
  }

  function normalizePageList(value) {
    const pages = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : [];
    return pages.map((page, index) => ({
      page: Number.isInteger(Number(page?.page)) && Number(page.page) > 0 ? Number(page.page) : index + 1,
      cid: normalizeCid(page?.cid),
      part: String(page?.part || '').replace(/\s+/gu, ' ').trim().slice(0, 500),
      duration: Number.isFinite(Number(page?.duration)) ? Math.max(0, Number(page.duration)) : 0
    })).filter((page) => page.cid);
  }

  function chooseCurrentPage(pages, requestedPage = 1, activeCid = '') {
    const normalizedPages = normalizePageList(pages);
    const normalizedCid = normalizeCid(activeCid);
    return normalizedPages.find((page) => page.cid === normalizedCid)
      || normalizedPages.find((page) => page.page === Number(requestedPage))
      || normalizedPages[0]
      || null;
  }

  function stableTrackKey(id, lan, lanDoc, subtitleUrl) {
    if (id) return `id:${id}`;
    const source = `${lan}|${lanDoc}|${subtitleUrl}`;
    let hash = 0x811c9dc5;
    for (const character of source) hash = Math.imul(hash ^ character.codePointAt(0), 0x01000193) >>> 0;
    return `track:${hash.toString(36)}`;
  }

  function isEnglishSubtitleTrack(track) {
    const lan = String(track?.lan || track?.languageCode || '').trim().toLowerCase().replace(/_/gu, '-');
    const lanTokens = lan.split('-').filter(Boolean);
    const label = String(track?.lanDoc || track?.lan_doc || track?.name || '').trim();
    return lan === 'en'
      || lanTokens.includes('en')
      || /\benglish\b/iu.test(label)
      || /英文|英语|英語/u.test(label);
  }

  function normalizeSubtitleTrack(track) {
    const lan = String(track?.lan || track?.languageCode || '').trim();
    const lanDoc = String(track?.lan_doc || track?.lanDoc || track?.name || lan || '字幕')
      .replace(/\s+/gu, ' ').trim().slice(0, 100);
    const subtitleUrl = String(track?.subtitle_url || track?.subtitleUrl || track?.url || '').trim();
    const id = String(track?.id_str || track?.id || '');
    const aiType = Number.isFinite(Number(track?.ai_type ?? track?.aiType))
      ? Number(track?.ai_type ?? track?.aiType)
      : 0;
    const type = Number.isFinite(Number(track?.type)) ? Number(track.type) : 0;
    const normalized = {
      id,
      lan,
      lanDoc,
      subtitleUrl,
      aiType,
      type,
      isAi: aiType !== 0,
      detectionSource: String(track?.detectionSource || '')
    };
    normalized.trackKey = String(track?.trackKey || stableTrackKey(id, lan, lanDoc, subtitleUrl));
    normalized.isEnglish = isEnglishSubtitleTrack(normalized);
    return normalized;
  }

  function normalizeEnglishSubtitleTracks(tracks) {
    const uniqueUrls = new Set();
    return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
      track: normalizeSubtitleTrack(track),
      index
    })).filter(({ track }) => {
      if (!track.subtitleUrl || !track.isEnglish || uniqueUrls.has(track.subtitleUrl)) return false;
      uniqueUrls.add(track.subtitleUrl);
      return true;
    }).sort((left, right) => Number(left.track.isAi) - Number(right.track.isAi) || left.index - right.index)
      .map(({ track }) => track);
  }

  function selectPreferredSubtitleTrack(tracks) {
    return normalizeEnglishSubtitleTracks(tracks)[0] || null;
  }

  function selectSubtitleTrack(tracks, trackKey) {
    const requestedKey = String(trackKey || '').trim();
    if (!requestedKey) return selectPreferredSubtitleTrack(tracks);
    return normalizeEnglishSubtitleTracks(tracks)
      .find((track) => track.trackKey === requestedKey)
      || null;
  }

  function normalizeTrackSelectionStore(value, limit = 50) {
    const entries = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value)
      : [];
    return Object.fromEntries(entries.map(([videoKey, selection]) => ({
      videoKey: String(videoKey || ''),
      trackKey: String(selection?.trackKey || ''),
      languageCode: String(selection?.languageCode || ''),
      updatedAt: Number(selection?.updatedAt) || 0
    })).filter((entry) => /^[A-Za-z0-9]{12}:\d+$/u.test(entry.videoKey) && entry.trackKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.floor(Number(limit) || 50)))
      .map((entry) => [entry.videoKey, {
        trackKey: entry.trackKey,
        languageCode: entry.languageCode,
        updatedAt: entry.updatedAt
      }]));
  }

  function rememberTrackSelection(store, videoKey, track, updatedAt = Date.now()) {
    const normalizedStore = normalizeTrackSelectionStore(store, 50);
    const key = String(videoKey || '');
    const trackKey = String(track?.trackKey || '');
    if (!/^[A-Za-z0-9]{12}:\d+$/u.test(key) || !trackKey) return normalizedStore;
    return normalizeTrackSelectionStore({
      ...normalizedStore,
      [key]: {
        trackKey,
        languageCode: String(track?.languageCode || track?.lan || ''),
        updatedAt: Number(updatedAt) || Date.now()
      }
    }, 50);
  }

  function cleanSubtitleText(value) {
    return String(value || '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
  }

  function parseBilibiliSubtitleBody(value) {
    let data = value;
    if (typeof value === 'string') {
      try { data = JSON.parse(value); }
      catch { return []; }
    }
    const rawBody = Array.isArray(data?.body) ? data.body : [];
    const unique = new Map();
    for (const item of rawBody) {
      const start = Number(item?.from);
      const end = Number(item?.to);
      const text = cleanSubtitleText(item?.content);
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || !text) continue;
      const key = `${start.toFixed(3)}|${end.toFixed(3)}|${text}`;
      if (!unique.has(key)) unique.set(key, { start, end, text });
    }
    return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
  }

  function analyzeSubtitleLanguage(cues) {
    const text = (Array.isArray(cues) ? cues : [])
      .map((cue) => cleanSubtitleText(cue?.text || cue?.content))
      .filter(Boolean)
      .join(' ')
      .slice(0, 50000);
    const latinCharacters = (text.match(/[A-Za-z]/gu) || []).length;
    const cjkCharacters = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
    const words = text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/gu) || [];
    const englishHints = new Set([
      'the', 'and', 'of', 'to', 'is', 'are', 'was', 'were', 'that', 'this', 'it',
      'for', 'with', 'as', 'on', 'at', 'from', 'by', 'you', 'we', 'they', 'can',
      'have', 'has', 'not', 'but', 'or', 'if', 'because', 'what', 'when', 'where'
    ]);
    const englishHintHits = words.reduce((total, word) => total + Number(englishHints.has(word)), 0);
    const alphabeticCharacters = latinCharacters + cjkCharacters;
    const latinRatio = alphabeticCharacters ? latinCharacters / alphabeticCharacters : 0;
    const requiredHints = Math.max(4, Math.ceil(words.length * 0.03));
    return {
      isEnglish: latinCharacters >= 40
        && words.length >= 12
        && latinRatio >= 0.7
        && englishHintHits >= requiredHints,
      latinCharacters,
      cjkCharacters,
      latinRatio,
      wordCount: words.length,
      englishHintHits
    };
  }

  function subtitleAvailabilityError(playerData) {
    const subtitle = playerData?.subtitle || {};
    const tracks = Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
    if (tracks.some((track) => String(track?.subtitle_url || '').trim())) return '';
    if (playerData?.need_login_subtitle === true || subtitle?.need_login === true) {
      return '当前视频的字幕需要登录哔哩哔哩后才能读取，请登录并刷新视频页面。';
    }
    return '这个分P没有可读取的播放器字幕。';
  }

  return {
    BVID_PATTERN,
    chooseCurrentPage,
    contextKey,
    analyzeSubtitleLanguage,
    normalizeCid,
    normalizeEnglishSubtitleTracks,
    normalizePageList,
    normalizeSubtitleTrack,
    normalizeTrackSelectionStore,
    parseBilibiliSubtitleBody,
    parseBilibiliVideoUrl,
    sameVideoContext,
    selectSubtitleTrack,
    selectPreferredSubtitleTrack,
    rememberTrackSelection,
    isEnglishSubtitleTrack,
    subtitleAvailabilityError
  };
}));
