(function installSubtitleExportCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShadowingBilibiliSubtitleExportCore = Object.assign(
    root.ShadowingBilibiliSubtitleExportCore || {},
    api
  );
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSubtitleExportCore() {
  const EXPORT_FORMATS = Object.freeze({ SRT: 'srt', TXT: 'txt', MARKDOWN: 'markdown', JSON: 'json' });
  const EXPORT_LAYERS = Object.freeze({ SENTENCE: 'sentence', CUE: 'cue' });
  const FORMAT_DETAILS = Object.freeze({
    srt: { extension: 'srt', mimeType: 'application/x-subrip;charset=utf-8', bom: true },
    txt: { extension: 'txt', mimeType: 'text/plain;charset=utf-8', bom: true },
    markdown: { extension: 'md', mimeType: 'text/markdown;charset=utf-8', bom: true },
    json: { extension: 'json', mimeType: 'application/json;charset=utf-8', bom: false }
  });

  function normalizeExportFormat(value, fallback = EXPORT_FORMATS.SRT) {
    const normalized = String(value || '').toLowerCase();
    return Object.hasOwn(FORMAT_DETAILS, normalized) ? normalized : fallback;
  }

  function normalizeExportLayer(value, fallback = EXPORT_LAYERS.SENTENCE) {
    const normalized = String(value || '').toLowerCase();
    return Object.values(EXPORT_LAYERS).includes(normalized) ? normalized : fallback;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\r\n?/gu, '\n').trim();
  }

  function normalizeExportItems(items) {
    return (Array.isArray(items) ? items : []).map((item, sourceIndex) => ({
      source: item,
      sourceIndex,
      start: Number(item?.start),
      end: Number(item?.end),
      text: normalizeText(item?.text)
    })).filter((item) => Number.isFinite(item.start)
      && Number.isFinite(item.end)
      && item.end > item.start
      && item.text)
      .sort((left, right) => left.start - right.start || left.end - right.end || left.sourceIndex - right.sourceIndex);
  }

  function timestampParts(seconds) {
    const totalMilliseconds = Math.max(0, Math.round(Number(seconds) * 1000) || 0);
    const milliseconds = totalMilliseconds % 1000;
    const totalSeconds = Math.floor(totalMilliseconds / 1000);
    const secs = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return { hours, minutes, seconds: secs, milliseconds };
  }

  function formatSrtTimestamp(seconds) {
    const parts = timestampParts(seconds);
    return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}:${String(parts.seconds).padStart(2, '0')},${String(parts.milliseconds).padStart(3, '0')}`;
  }

  function formatReadableTimestamp(seconds) {
    return formatSrtTimestamp(seconds).replace(',', '.');
  }

  function sanitizeFilePart(value, fallback) {
    let cleaned = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001F]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/[. ]+$/gu, '')
      .trim();
    if (!cleaned) cleaned = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(cleaned)) cleaned = `_${cleaned}`;
    return cleaned;
  }

  function buildSubtitleFilename({ title, page, language, layer, format }) {
    const normalizedFormat = normalizeExportFormat(format);
    const normalizedLayer = normalizeExportLayer(layer);
    const safeLanguage = sanitizeFilePart(language, 'Subtitle').slice(0, 48);
    const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
    const layerLabel = normalizedLayer === EXPORT_LAYERS.CUE ? 'Cue' : 'Sentence';
    const suffix = `-P${pageNumber}-${safeLanguage}-${layerLabel}.${FORMAT_DETAILS[normalizedFormat].extension}`;
    const maxTitleLength = Math.max(20, 180 - suffix.length);
    const safeTitle = sanitizeFilePart(title, 'Bilibili-Subtitle').slice(0, maxTitleLength)
      .replace(/[. ]+$/gu, '') || 'Bilibili-Subtitle';
    return `${safeTitle}${suffix}`;
  }

  function cleanMetadata(metadata, layer) {
    const page = Math.max(1, Math.floor(Number(metadata?.page) || 1));
    const pageCount = Math.max(page, Math.floor(Number(metadata?.pageCount) || page));
    return {
      exportedAt: String(metadata?.exportedAt || new Date().toISOString()),
      video: {
        bvid: String(metadata?.bvid || ''),
        cid: String(metadata?.cid || ''),
        page,
        pageCount,
        title: String(metadata?.title || '哔哩哔哩字幕'),
        url: String(metadata?.url || '')
      },
      track: metadata?.track && typeof metadata.track === 'object' ? {
        trackKey: String(metadata.track.trackKey || ''),
        id: String(metadata.track.id || ''),
        languageCode: String(metadata.track.languageCode || ''),
        name: String(metadata.track.name || ''),
        aiType: Number(metadata.track.aiType) || 0,
        type: String(metadata.track.type || ''),
        isEnglish: Boolean(metadata.track.isEnglish),
        isAi: Boolean(metadata.track.isAi)
      } : null,
      layer
    };
  }

  function serializeSrt(items) {
    return `${items.map((item, index) => `${index + 1}\r\n${formatSrtTimestamp(item.start)} --> ${formatSrtTimestamp(item.end)}\r\n${item.text.replace(/\n/gu, '\r\n')}`).join('\r\n\r\n')}\r\n`;
  }

  function serializeTxt(items) {
    return `${items.map((item) => item.text.replace(/\n+/gu, ' ')).join('\r\n')}\r\n`;
  }

  function serializeMarkdown(items, metadata) {
    const layerLabel = metadata.layer === EXPORT_LAYERS.CUE ? '原始字幕 cue' : '整理后完整 Sentence';
    const trackName = metadata.track?.name || metadata.track?.languageCode || '字幕';
    const lines = [
      `# ${metadata.video.title.replace(/\s+/gu, ' ').trim()}`,
      '',
      `- 分P：P${metadata.video.page}/${metadata.video.pageCount}`,
      `- 字幕轨道：${trackName}`,
      `- 内容层级：${layerLabel}`,
      `- 导出时间：${metadata.exportedAt}`
    ];
    if (metadata.video.url) lines.push(`- 来源：[哔哩哔哩视频](${metadata.video.url})`);
    for (const [index, item] of items.entries()) {
      lines.push('', `## ${index + 1}. ${formatReadableTimestamp(item.start)} — ${formatReadableTimestamp(item.end)}`, '', item.text);
    }
    return `${lines.join('\n')}\n`;
  }

  function serializeJson(items, metadata) {
    const exportedItems = items.map((item) => metadata.layer === EXPORT_LAYERS.CUE
      ? { start: item.start, end: item.end, text: item.text }
      : { ...item.source, start: item.start, end: item.end, text: item.text });
    return `${JSON.stringify({
      exportVersion: 1,
      platform: 'bilibili',
      exportedAt: metadata.exportedAt,
      video: metadata.video,
      track: metadata.track,
      layer: metadata.layer,
      items: exportedItems
    }, null, 2)}\n`;
  }

  function createSubtitleExport({ format, layer, items, metadata = {} }) {
    const normalizedFormat = normalizeExportFormat(format);
    const normalizedLayer = normalizeExportLayer(layer);
    const normalizedItems = normalizeExportItems(items);
    if (!normalizedItems.length) throw new Error('没有可下载的有效字幕内容。');
    const clean = cleanMetadata(metadata, normalizedLayer);
    const details = FORMAT_DETAILS[normalizedFormat];
    let content = normalizedFormat === EXPORT_FORMATS.SRT
      ? serializeSrt(normalizedItems)
      : normalizedFormat === EXPORT_FORMATS.TXT
        ? serializeTxt(normalizedItems)
        : normalizedFormat === EXPORT_FORMATS.MARKDOWN
          ? serializeMarkdown(normalizedItems, clean)
          : serializeJson(normalizedItems, clean);
    if (details.bom) content = `\uFEFF${content}`;
    const language = clean.track?.name || clean.track?.languageCode || 'Subtitle';
    return {
      content,
      mimeType: details.mimeType,
      extension: details.extension,
      itemCount: normalizedItems.length,
      filename: buildSubtitleFilename({
        title: clean.video.title,
        page: clean.video.page,
        language,
        layer: normalizedLayer,
        format: normalizedFormat
      })
    };
  }

  return {
    EXPORT_FORMATS,
    EXPORT_LAYERS,
    buildSubtitleFilename,
    createSubtitleExport,
    formatSrtTimestamp,
    normalizeExportFormat,
    normalizeExportItems,
    normalizeExportLayer
  };
}));
