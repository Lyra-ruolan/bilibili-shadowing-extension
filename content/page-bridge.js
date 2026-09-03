(function installBilibiliShadowingPageBridge() {
  const CHANNEL = 'SHADOWING_STUDIO_BILIBILI_V1';
  const core = globalThis.ShadowingBilibiliCore;
  if (!core || globalThis.__bilibiliShadowingPageBridgeInstalled) return;
  globalThis.__bilibiliShadowingPageBridgeInstalled = true;

  function activeCidFromPage() {
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

    const stateCandidates = [
      globalThis.__INITIAL_STATE__?.cid,
      globalThis.__INITIAL_STATE__?.videoData?.cid,
      globalThis.__playinfo__?.data?.cid
    ];
    for (const candidate of stateCandidates) {
      const cid = core.normalizeCid(candidate);
      if (cid) return cid;
    }
    return '';
  }

  function embeddedPages() {
    const candidates = [
      globalThis.__INITIAL_STATE__?.videoData?.pages,
      globalThis.__INITIAL_STATE__?.pages
    ];
    return candidates.find((value) => Array.isArray(value) && value.length) || [];
  }

  function cleanDocumentTitle() {
    const heading = document.querySelector('h1')?.textContent;
    const meta = document.querySelector('meta[property="og:title"]')?.content;
    return String(heading || meta || document.title || '哔哩哔哩视频')
      .replace(/_哔哩哔哩_bilibili\s*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 500);
  }

  async function fetchApi(path, parameters) {
    const url = new URL(path, 'https://api.bilibili.com');
    for (const [key, value] of Object.entries(parameters || {})) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
      referrer: location.href,
      referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!response.ok) throw new Error(`哔哩哔哩接口返回 ${response.status}。`);
    const data = await response.json().catch(() => null);
    if (!data || Number(data.code) !== 0) {
      throw new Error(String(data?.message || data?.msg || '哔哩哔哩接口没有返回可用数据。'));
    }
    return data;
  }

  async function fetchPageList(bvid) {
    const embedded = core.normalizePageList(embeddedPages());
    if (embedded.length) return embedded;
    const response = await fetchApi('/x/player/pagelist', { bvid, jsonp: 'jsonp' });
    return core.normalizePageList(response);
  }

  async function resolveVideoContext(expected = {}) {
    const locationInfo = core.parseBilibiliVideoUrl(location.href);
    if (!locationInfo) throw new Error('当前页面不是支持的哔哩哔哩 BV 视频。');
    if (expected.bvid && expected.bvid !== locationInfo.bvid) throw new Error('页面已经切换到另一个视频。');
    const pages = await fetchPageList(locationInfo.bvid);
    const selectedPage = core.chooseCurrentPage(pages, locationInfo.page, activeCidFromPage() || expected.cid);
    if (!selectedPage) throw new Error('无法确定当前视频分P。');
    return {
      bvid: locationInfo.bvid,
      cid: selectedPage.cid,
      videoKey: core.contextKey(locationInfo.bvid, selectedPage.cid),
      page: selectedPage.page,
      pageCount: pages.length,
      partTitle: selectedPage.part,
      duration: selectedPage.duration,
      title: cleanDocumentTitle()
    };
  }

  function subtitleTracks(playerData) {
    const tracks = playerData?.subtitle?.subtitles;
    return Array.isArray(tracks) ? tracks : [];
  }

  function discoveredSubtitleTracks() {
    const urls = new Set();
    const resourceEntries = globalThis.performance?.getEntriesByType?.('resource') || [];
    for (const entry of resourceEntries) {
      const value = String(entry?.name || '');
      try {
        const url = safeSubtitleUrl(value);
        const path = url.pathname.toLowerCase();
        if (path.includes('subtitle') && (path.endsWith('.json') || path.includes('/bfs/'))) {
          urls.add(url.href);
        }
      } catch {
        // Ignore unrelated or untrusted page resources.
      }
    }
    for (const element of document.querySelectorAll('track[src]')) {
      try { urls.add(safeSubtitleUrl(element.src).href); }
      catch { /* Ignore unsupported track hosts. */ }
    }
    return [...urls].map((subtitleUrl) => ({
      lan: '',
      lan_doc: '播放器字幕资源',
      subtitle_url: subtitleUrl,
      ai_type: subtitleUrl.includes('ai_subtitle') ? 1 : 0,
      type: 0,
      detectionSource: 'resource'
    }));
  }

  function mergeSubtitleTracks(...groups) {
    const merged = new Map();
    for (const item of groups.flat()) {
      const track = core.normalizeSubtitleTrack(item);
      if (!track.subtitleUrl || merged.has(track.subtitleUrl)) continue;
      track.detectionSource = String(item?.detectionSource || (track.isEnglish ? 'metadata' : ''));
      merged.set(track.subtitleUrl, track);
    }
    return [...merged.values()];
  }

  async function fetchPlayerData(context) {
    const parameters = { bvid: context.bvid, cid: context.cid };
    const standard = await fetchApi('/x/player/v2', parameters);
    let playerData = standard.data || {};
    const standardTracks = subtitleTracks(playerData);
    const hasMetadataEnglish = core.normalizeEnglishSubtitleTracks(standardTracks).length > 0;
    if (!hasMetadataEnglish && playerData.need_login_subtitle !== true) {
      try {
        const wbi = await fetchApi('/x/player/wbi/v2', parameters);
        const wbiData = wbi.data || {};
        const mergedTracks = mergeSubtitleTracks(standardTracks, subtitleTracks(wbiData));
        if (mergedTracks.length) {
          playerData = {
            ...playerData,
            ...wbiData,
            subtitle: {
              ...(playerData.subtitle || {}),
              ...(wbiData.subtitle || {}),
              subtitles: mergedTracks
            }
          };
        }
      } catch {
        // The unsigned WBI endpoint is only a compatibility fallback.
      }
    }
    return playerData;
  }

  function safeSubtitleUrl(value) {
    const raw = String(value || '').trim();
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, location.origin);
    const allowedHost = url.hostname === 'bilibili.com'
      || url.hostname.endsWith('.bilibili.com')
      || url.hostname === 'hdslb.com'
      || url.hostname.endsWith('.hdslb.com');
    if (url.protocol !== 'https:' || !allowedHost) throw new Error('字幕地址不属于受支持的哔哩哔哩域名。');
    return url;
  }

  async function fetchSubtitle(track) {
    const response = await fetch(safeSubtitleUrl(track.subtitleUrl), {
      credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, */*' },
      referrer: location.href,
      referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!response.ok) throw new Error(`字幕文件返回 ${response.status}。`);
    const body = await response.text();
    const cues = core.parseBilibiliSubtitleBody(body);
    if (!cues.length) throw new Error('字幕文件没有可解析的时间轴。');
    return cues;
  }

  async function detectEnglishTrackByContent(tracks, preferredTrackKey = '', checkedUrls = new Map()) {
    const requestedKey = String(preferredTrackKey || '');
    const candidates = [...tracks].map((track, index) => ({ track, index }))
      .sort((left, right) => Number(right.track.trackKey === requestedKey) - Number(left.track.trackKey === requestedKey)
        || Number(left.track.isAi) - Number(right.track.isAi)
        || left.index - right.index)
      .map(({ track }) => track)
      .slice(0, 12);
    for (const candidate of candidates) {
      const cached = checkedUrls.get(candidate.subtitleUrl);
      if (cached === false) continue;
      if (Array.isArray(cached) && cached.length) {
        return {
          track: {
            ...candidate,
            isEnglish: true,
            detectionSource: 'content'
          },
          cues: cached
        };
      }
      try {
        const cues = await fetchSubtitle(candidate);
        const language = core.analyzeSubtitleLanguage(cues);
        if (!language.isEnglish) {
          checkedUrls.set(candidate.subtitleUrl, false);
          continue;
        }
        checkedUrls.set(candidate.subtitleUrl, cues);
        return {
          track: {
            ...candidate,
            isEnglish: true,
            detectionSource: 'content'
          },
          cues
        };
      } catch {
        // A temporarily unavailable candidate may become readable while the player finishes loading.
        // It must not hide other subtitle resources in the same pass.
      }
    }
    return null;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function detectFallbackEnglishTrack(officialCandidates, preferredTrackKey = '') {
    const checkedUrls = new Map();
    const deadline = Date.now() + 2500;
    do {
      const candidates = mergeSubtitleTracks(officialCandidates, discoveredSubtitleTracks());
      const detected = await detectEnglishTrackByContent(candidates, preferredTrackKey, checkedUrls);
      if (detected) return detected;
      if (Date.now() >= deadline) return null;
      await delay(250);
    } while (true);
  }

  function publicTrack(track) {
    return {
      trackKey: track.trackKey,
      id: track.id,
      languageCode: track.lan,
      name: track.detectionSource === 'content'
        ? '英文（正文检测）'
        : track.lanDoc,
      aiType: track.aiType,
      type: track.type,
      isEnglish: track.isEnglish,
      isAi: track.isAi,
      detectionSource: track.detectionSource || (track.isEnglish ? 'metadata' : '')
    };
  }

  async function loadCaptions(expected) {
    const context = await resolveVideoContext(expected);
    if (expected?.cid && !core.sameVideoContext(context, expected)) throw new Error('当前分P已经切换，请重新读取字幕。');
    const playerData = await fetchPlayerData(context);
    const requestedTrackKey = String(expected?.trackKey || '').trim();
    const officialCandidates = mergeSubtitleTracks(subtitleTracks(playerData));
    let tracks = core.normalizeEnglishSubtitleTracks(
      officialCandidates
    ).map((track) => ({ ...track, detectionSource: 'metadata' }));
    let detectedCues = null;
    if (!tracks.length) {
      const detected = await detectFallbackEnglishTrack(officialCandidates, requestedTrackKey);
      if (detected) {
        tracks = [detected.track];
        detectedCues = detected.cues;
      }
    }
    // `tracks` is already a private allow-list: metadata-confirmed English tracks or
    // a content-verified fallback. Re-normalizing it would discard the verification
    // result when the original Bilibili language metadata is empty or incorrect.
    const requestedTrack = requestedTrackKey
      ? tracks.find((candidate) => candidate.trackKey === requestedTrackKey) || null
      : null;
    const requestedTrackMissing = Boolean(requestedTrackKey && !requestedTrack);
    let track = requestedTrack || tracks[0] || null;
    if (!track) {
      return {
        ...context,
        track: null,
        tracks: [],
        selectedTrackKey: '',
        requestedTrackMissing,
        selectionError: '该分P没有可提取的英文字幕。',
        source: 'bilibili-subtitle',
        cues: []
      };
    }
    const cues = detectedCues && detectedCues.length && tracks.length === 1
      && tracks[0].trackKey === track.trackKey
      ? detectedCues
      : await fetchSubtitle(track);

    const currentLocation = core.parseBilibiliVideoUrl(location.href);
    const currentCid = activeCidFromPage();
    if (!currentLocation || currentLocation.bvid !== context.bvid
      || (currentCid && currentCid !== context.cid)) {
      throw new Error('读取字幕期间页面已经切换到另一个分P。');
    }

    return {
      ...context,
      track: publicTrack(track),
      tracks: tracks.map(publicTrack),
      selectedTrackKey: track.trackKey,
      requestedTrackMissing,
      selectionError: '',
      source: 'bilibili-subtitle',
      cues
    };
  }

  function post(type, requestId, payload) {
    window.postMessage({
      channel: CHANNEL,
      direction: 'page-to-content',
      type,
      requestId,
      payload
    }, location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message?.direction !== 'content-to-page') return;
    if (message.type !== 'LOAD_CAPTIONS') return;
    const requestId = String(message.requestId || '');
    if (!/^[\w-]{8,100}$/u.test(requestId)) return;
    const expected = {
      bvid: String(message.payload?.bvid || ''),
      cid: core.normalizeCid(message.payload?.cid),
      page: Number(message.payload?.page) || 1,
      trackKey: String(message.payload?.trackKey || '').slice(0, 300)
    };
    if (!core.BVID_PATTERN.test(expected.bvid)) return;

    loadCaptions(expected)
      .then((data) => post('CAPTIONS_RESULT', requestId, { ok: true, data }))
      .catch((error) => post('CAPTIONS_RESULT', requestId, {
        ok: false,
        error: String(error?.message || '字幕读取失败。').slice(0, 600)
      }));
  });
}());
