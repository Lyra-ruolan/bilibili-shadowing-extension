(function installPlaybackModeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShadowingBilibiliPlaybackCore = Object.assign(root.ShadowingBilibiliPlaybackCore || {}, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPlaybackModeCore() {
  const PLAYBACK_MODES = Object.freeze({
    SINGLE: 'single',
    CONTINUOUS: 'continuous',
    LOOP: 'loop'
  });
  const PRACTICE_GRANULARITIES = Object.freeze({
    SENTENCE: 'sentence',
    CHUNK: 'chunk'
  });
  const VALID_PLAYBACK_MODES = new Set(Object.values(PLAYBACK_MODES));
  const VALID_GRANULARITIES = new Set(Object.values(PRACTICE_GRANULARITIES));

  function normalizePlaybackMode(value, fallback = PLAYBACK_MODES.CONTINUOUS) {
    const normalized = String(value || '');
    if (VALID_PLAYBACK_MODES.has(normalized)) return normalized;
    return VALID_PLAYBACK_MODES.has(fallback) ? fallback : PLAYBACK_MODES.CONTINUOUS;
  }

  function normalizePracticeGranularity(value, fallback = PRACTICE_GRANULARITIES.SENTENCE) {
    const normalized = String(value || '');
    if (VALID_GRANULARITIES.has(normalized)) return normalized;
    return VALID_GRANULARITIES.has(fallback) ? fallback : PRACTICE_GRANULARITIES.SENTENCE;
  }

  function wholeSentenceUnit(sentence, sentenceIndex) {
    return {
      sentenceId: Number(sentence?.id) || sentenceIndex + 1,
      order: 1,
      start: Number(sentence?.start),
      end: Number(sentence?.end),
      text: String(sentence?.text || ''),
      sentenceIndex,
      chunkIndex: -1
    };
  }

  function buildPracticeUnits(sentences, granularity) {
    if (!Array.isArray(sentences)) return [];
    const chunkMode = normalizePracticeGranularity(granularity) === PRACTICE_GRANULARITIES.CHUNK;
    return sentences.flatMap((sentence, sentenceIndex) => {
      const fallback = wholeSentenceUnit(sentence, sentenceIndex);
      const chunks = chunkMode && Array.isArray(sentence?.practiceChunks) && sentence.practiceChunks.length
        ? sentence.practiceChunks
        : [fallback];
      return chunks.map((chunk, chunkIndex) => ({
        sentenceId: Number(sentence?.id) || sentenceIndex + 1,
        order: chunkMode ? Number(chunk?.order) || chunkIndex + 1 : 1,
        start: Number(chunk?.start),
        end: Number(chunk?.end),
        text: String(chunk?.text || ''),
        sentenceIndex,
        chunkIndex: chunkMode ? chunkIndex : -1
      })).filter((unit) => Number.isFinite(unit.start)
        && Number.isFinite(unit.end)
        && unit.end > unit.start
        && unit.text);
    });
  }

  function buildPracticeTextSegments(sentence, granularity, currentChunkIndex = 0) {
    const text = String(sentence?.text || '');
    const chunks = Array.isArray(sentence?.practiceChunks) ? sentence.practiceChunks : [];
    const chunkMode = normalizePracticeGranularity(granularity) === PRACTICE_GRANULARITIES.CHUNK;
    if (!chunkMode || !chunks.length || chunks.map((chunk) => String(chunk?.text || '')).join('') !== text) {
      return [{ text, chunkIndex: -1, active: false }];
    }
    const activeIndex = Math.max(0, Math.min(Math.floor(Number(currentChunkIndex) || 0), chunks.length - 1));
    return chunks.map((chunk, chunkIndex) => ({
      text: String(chunk.text || ''),
      chunkIndex,
      active: chunkIndex === activeIndex
    }));
  }

  function normalizePracticeTimeline(units) {
    return (Array.isArray(units) ? units : []).slice(0, 100000).map((unit, index) => ({
      sentenceId: Math.max(1, Math.floor(Number(unit?.sentenceId) || Number(unit?.id) || index + 1)),
      order: Math.max(1, Math.floor(Number(unit?.order) || 1)),
      start: Number(unit?.start),
      end: Number(unit?.end),
      text: String(unit?.text || '').trim().slice(0, 10000),
      sentenceIndex: Math.max(0, Math.floor(Number(unit?.sentenceIndex) || 0)),
      chunkIndex: Number.isInteger(Number(unit?.chunkIndex)) ? Number(unit.chunkIndex) : -1
    })).filter((unit) => Number.isFinite(unit.start)
      && Number.isFinite(unit.end)
      && unit.end > unit.start
      && unit.text)
      .sort((left, right) => left.start - right.start
        || left.end - right.end
        || left.sentenceIndex - right.sentenceIndex
        || left.chunkIndex - right.chunkIndex)
      .map((unit, index) => ({ ...unit, index }));
  }

  function findPracticeUnitIndex(units, sentenceIndex, chunkIndex = -1) {
    if (!Array.isArray(units) || !units.length) return -1;
    const exact = units.findIndex((unit) => unit.sentenceIndex === sentenceIndex && unit.chunkIndex === chunkIndex);
    if (exact >= 0) return exact;
    const sentenceMatch = units.findIndex((unit) => unit.sentenceIndex === sentenceIndex);
    return sentenceMatch >= 0 ? sentenceMatch : 0;
  }

  function findContainingPracticeUnitIndex(units, currentTime, sentenceIndex = null) {
    if (!Array.isArray(units) || !units.length) return -1;
    const time = Number(currentTime);
    if (!Number.isFinite(time)) return -1;
    return units.findIndex((unit, index) => {
      if (Number.isInteger(sentenceIndex) && unit.sentenceIndex !== sentenceIndex) return false;
      const isLast = index === units.length - 1;
      return time >= Number(unit.start) && (time < Number(unit.end) || (isLast && time <= Number(unit.end)));
    });
  }

  function resolvePracticeNavigationIndex(units, currentIndex, direction) {
    if (!Array.isArray(units) || !units.length) return -1;
    const index = Math.max(0, Math.min(Math.floor(Number(currentIndex) || 0), units.length - 1));
    const delta = direction === 'previous' ? -1 : direction === 'next' ? 1 : 0;
    if (!delta) return index;
    return Math.max(0, Math.min(index + delta, units.length - 1));
  }

  function practiceCommandForKey(input) {
    if (!input || input.defaultPrevented || input.repeat || input.isComposing
      || input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) return '';
    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    if (key === 'j') return 'previous-practice-unit';
    if (key === 'l') return 'next-practice-unit';
    if (key === ' ' || key === 'spacebar' || code === 'Space') return 'toggle-practice-playback';
    return '';
  }

  function shouldHandlePracticeShortcut(command, context = {}) {
    const normalizedCommand = String(command || '');
    if (!normalizedCommand || !context.timelineReady || context.editable) return false;
    if (normalizedCommand === 'toggle-practice-playback'
      && context.buttonLike
      && !context.pointerFocused) return false;
    return normalizedCommand === 'previous-practice-unit'
      || normalizedCommand === 'toggle-practice-playback'
      || normalizedCommand === 'next-practice-unit';
  }

  function shouldRestartPracticeUnit(mode, currentTime, unit, tolerance = 0.05) {
    if (normalizePlaybackMode(mode) === PLAYBACK_MODES.CONTINUOUS) return false;
    const time = Number(currentTime);
    const start = Number(unit?.start);
    const end = Number(unit?.end);
    if (!Number.isFinite(time) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
    const boundaryTolerance = Math.max(0, Number(tolerance) || 0);
    return time >= end - boundaryTolerance || time < start - 0.25;
  }

  function resolveActivePracticeUnitIndex(units, currentTime, fallbackIndex = 0) {
    if (!Array.isArray(units) || !units.length) return -1;
    const boundedFallback = Math.max(0, Math.min(Math.floor(Number(fallbackIndex) || 0), units.length - 1));
    const time = Number(currentTime);
    if (!Number.isFinite(time)) return boundedFallback;
    if (time < Number(units[0]?.start)) return -1;

    let low = 0;
    let high = units.length - 1;
    let resolved = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const start = Number(units[middle]?.start);
      if (!Number.isFinite(start)) return boundedFallback;
      if (start <= time) {
        resolved = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return resolved;
  }

  function decidePlaybackTick({
    mode,
    units,
    currentIndex,
    currentTime,
    boundaryTolerance = 0.05
  }) {
    if (!Array.isArray(units) || !units.length || !Number.isFinite(Number(currentTime))) {
      return { action: 'none', index: -1 };
    }
    const playbackMode = normalizePlaybackMode(mode);
    const index = Math.max(0, Math.min(Math.floor(Number(currentIndex) || 0), units.length - 1));
    const time = Number(currentTime);
    const tolerance = Math.max(0, Number(boundaryTolerance) || 0);

    if (playbackMode === PLAYBACK_MODES.CONTINUOUS) {
      const lastIndex = units.length - 1;
      const materialEnd = Number(units[lastIndex]?.end);
      if (Number.isFinite(materialEnd) && time >= materialEnd - tolerance) {
        return { action: 'pause', index: lastIndex };
      }
      const resolvedIndex = resolveActivePracticeUnitIndex(units, time, index);
      return resolvedIndex >= 0 && resolvedIndex !== index
        ? { action: 'sync', index: resolvedIndex }
        : { action: 'none', index };
    }

    const unitEnd = Number(units[index]?.end);
    if (!Number.isFinite(unitEnd) || time < unitEnd - tolerance) return { action: 'none', index };
    return playbackMode === PLAYBACK_MODES.LOOP
      ? { action: 'loop', index }
      : { action: 'pause', index };
  }

  function playbackBoundaryAction(mode, currentTime, unit, tolerance = 0.05) {
    if (normalizePlaybackMode(mode) === PLAYBACK_MODES.CONTINUOUS) {
      const end = Number(unit?.end);
      const time = Number(currentTime);
      return Number.isFinite(end) && Number.isFinite(time) && time >= end - Math.max(0, Number(tolerance) || 0)
        ? 'continue'
        : 'none';
    }
    const decision = decidePlaybackTick({ mode, units: [unit], currentIndex: 0, currentTime, boundaryTolerance: tolerance });
    if (decision.action === 'loop') return 'loop';
    if (decision.action === 'pause') return 'pause';
    return 'none';
  }

  function findActiveSentenceIndex(timeline, currentTime) {
    return resolveActivePracticeUnitIndex(timeline, currentTime, 0);
  }

  return {
    PLAYBACK_MODES,
    PRACTICE_GRANULARITIES,
    buildPracticeTextSegments,
    buildPracticeUnits,
    decidePlaybackTick,
    findActiveSentenceIndex,
    findContainingPracticeUnitIndex,
    findPracticeUnitIndex,
    normalizePlaybackMode,
    normalizePracticeGranularity,
    normalizePracticeTimeline,
    playbackBoundaryAction,
    practiceCommandForKey,
    resolveActivePracticeUnitIndex,
    resolvePracticeNavigationIndex,
    shouldHandlePracticeShortcut,
    shouldRestartPracticeUnit
  };
}));
