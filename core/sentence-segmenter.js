(function installSentenceSegmenter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ShadowingBilibiliCore = Object.assign(root.ShadowingBilibiliCore || {}, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSentenceSegmenter() {
  const DEFAULT_OPTIONS = Object.freeze({
    sentenceMinDuration: 1.5,
    sentencePause: 1.2,
    chunkThreshold: 7,
    chunkTarget: 4,
    chunkMin: 2,
    chunkIdealMin: 3,
    chunkIdealMax: 5,
    chunkMax: 6,
    chunkPause: 0.35,
    chunkStrongPause: 0.75,
    splitCost: 45
  });

  const ALWAYS_PROTECTED = new Set([
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.'
  ]);
  const CONTEXTUAL_ABBREVIATIONS = new Set([
    'e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'dept.', 'inc.'
  ]);
  const CLAUSE_WORDS = new Set([
    'because', 'although', 'though', 'while', 'when', 'if', 'unless', 'since',
    'whereas', 'which', 'who', 'where'
  ]);
  const COORDINATING_WORDS = new Set(['and', 'but', 'or', 'so', 'yet', 'nor']);
  const CJK_CLAUSE_WORDS = ['但是', '不过', '因此', '所以', '因为', '虽然', '如果', '同时'];
  const CJK_COORDINATING_WORDS = ['而且', '并且', '或者'];
  const UNSAFE_AFTER_WORDS = new Set([
    'a', 'an', 'the', 'this', 'these', 'those',
    'my', 'your', 'his', 'her', 'our', 'their',
    'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did',
    'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
    'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'about', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under'
  ]);
  const UNSAFE_BEFORE_WORDS = new Set([
    'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'about', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under'
  ]);
  const CHUNK_REASONS = new Set([
    'sentence', 'pause', 'punctuation', 'clause', 'coordination', 'cue', 'sentence-end'
  ]);
  const EPSILON = 0.001;

  function cleanCaptionText(text = '') {
    return String(text)
      .replace(/^\s*>>\s*/u, '')
      .replace(/\[(?:music|applause|laughter)\]/giu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function textWeight(text) {
    return Math.max(1, [...String(text || '')].filter((character) => !/\s/u.test(character)).length);
  }

  function cueToAtoms(cue = {}) {
    const start = Number(cue.start);
    const end = Number(cue.end);
    const text = cleanCaptionText(cue.text);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

    let parts = text.match(/\S+\s*/gu) || [text];
    const splitIntoCharacters = parts.length === 1 && [...text].length > 30;
    if (splitIntoCharacters) parts = [...text];
    if (parts.length === 1) {
      return [{
        text,
        start,
        end,
        estimated: false,
        attachToPrevious: false,
        cueBoundaryAfter: false
      }];
    }

    const duration = end - start;
    const totalWeight = parts.reduce((sum, part) => sum + textWeight(part), 0);
    let consumedWeight = 0;
    return parts.map((part, index) => {
      const startRatio = consumedWeight / totalWeight;
      consumedWeight += textWeight(part);
      const endRatio = consumedWeight / totalWeight;
      return {
        text: part.trim(),
        start: start + duration * startRatio,
        end: index === parts.length - 1 ? end : start + duration * endRatio,
        estimated: true,
        attachToPrevious: splitIntoCharacters,
        cueBoundaryAfter: index === parts.length - 1
      };
    });
  }

  function normalizeToken(token) {
    const text = String(token?.text || '').trim();
    const start = Number(token?.start);
    const end = Number(token?.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return {
      text,
      start,
      end,
      estimated: Boolean(token?.estimated),
      attachToPrevious: Boolean(token?.attachToPrevious),
      cueBoundaryAfter: Boolean(token?.cueBoundaryAfter)
    };
  }

  function needsSpaceBetween(output, atom) {
    const text = String(atom?.text || '').trim();
    const cjkAdjacent = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(output)
      && /^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text);
    return Boolean(output)
      && !atom?.attachToPrevious
      && !cjkAdjacent
      && !/[\s([{“‘]$/u.test(output)
      && !/^[,.;:!?，。；：！？、…'’”）)\]}]/u.test(text);
  }

  function joinAtomsWithOffsets(atoms) {
    let text = '';
    const offsets = [];
    for (const atom of atoms) {
      const atomText = String(atom?.text || '').trim();
      if (!atomText) continue;
      if (needsSpaceBetween(text, atom)) text += ' ';
      const startOffset = text.length;
      text += atomText;
      offsets.push({ startOffset, endOffset: text.length });
    }
    return { text, offsets };
  }

  function joinAtoms(atoms) {
    return joinAtomsWithOffsets(atoms).text;
  }

  function stableSentenceUid(start, end, text) {
    const source = JSON.stringify([Number(start), Number(end), String(text || '')]);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (const character of source) {
      const code = character.codePointAt(0);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    return `sentence-${first.toString(36)}${second.toString(36)}`;
  }

  function finalWord(text) {
    return String(text || '').toLowerCase().match(/((?:[a-z]\.){2,}|[a-z]+\.|[a-z]\.)$/iu)?.[0] || '';
  }

  function isTerminalBoundary(text, nextText = '') {
    const trimmed = String(text || '').trim();
    if (!/[.!?。！？](?:["'’”）)\]]*)$/u.test(trimmed)) return false;
    if (!/\.(?:["'’”）)\]]*)$/u.test(trimmed)) return true;

    const word = finalWord(trimmed);
    if (ALWAYS_PROTECTED.has(word)) return false;
    const nextFirst = String(nextText || '').trim().match(/[A-Za-z]/u)?.[0];
    if (CONTEXTUAL_ABBREVIATIONS.has(word) && nextFirst && nextFirst === nextFirst.toLowerCase()) return false;
    return !(/^[a-z]\.$/iu.test(word) && nextFirst);
  }

  function isSoftBoundary(text) {
    return /[,;:，；：、…](?:["'’”）)\]]*)?$/u.test(String(text || '').trim());
  }

  function normalizedWord(text) {
    return String(text || '').toLowerCase().replace(/^[^a-z]+|[^a-z]+$/giu, '');
  }

  function boundaryCandidate(atoms, index, options) {
    const atom = atoms[index];
    const next = atoms[index + 1];
    if (!atom || !next || /^[,.;:!?，。；：！？、…'’”）)\]}]/u.test(String(next.text || '').trim())) return null;

    const pause = Math.max(0, next.start - atom.end);
    const softPunctuation = isSoftBoundary(atom.text);
    const nextWord = normalizedWord(next.text);
    const currentWord = normalizedWord(atom.text);
    const cjkLookahead = atoms.slice(index + 1, index + 5)
      .map((item) => String(item.text || '').trim())
      .join('');
    const clauseBoundary = CLAUSE_WORDS.has(nextWord)
      || CJK_CLAUSE_WORDS.some((word) => cjkLookahead.startsWith(word));
    const coordinatingBoundary = COORDINATING_WORDS.has(nextWord)
      || CJK_COORDINATING_WORDS.some((word) => cjkLookahead.startsWith(word));
    const strongPause = pause >= options.chunkStrongPause;

    if ((UNSAFE_AFTER_WORDS.has(currentWord) || UNSAFE_BEFORE_WORDS.has(nextWord))
      && !strongPause && !softPunctuation) return null;
    if (strongPause) return { index, score: 140, reason: 'pause' };
    if (pause >= options.chunkPause) return { index, score: 110, reason: 'pause' };
    if (softPunctuation) return { index, score: 90, reason: 'punctuation' };
    if (clauseBoundary) return { index, score: 65, reason: 'clause' };
    if (coordinatingBoundary) return { index, score: 50, reason: 'coordination' };
    if (atom.cueBoundaryAfter) return { index, score: 30, reason: 'cue' };
    return null;
  }

  function chunkDurationScore(duration, options) {
    const distance = Math.abs(duration - options.chunkTarget);
    if (duration >= options.chunkIdealMin && duration <= options.chunkIdealMax) return 30 - distance * 4;
    if (duration >= options.chunkMin && duration <= options.chunkMax) return 10 - distance * 6;
    const distanceToRange = duration < options.chunkMin
      ? options.chunkMin - duration
      : duration - options.chunkMax;
    return -20 - distanceToRange * 5;
  }

  function wholeSentenceChunk(sentence, sentenceId = Math.max(1, Math.floor(Number(sentence?.id) || 1))) {
    const text = String(sentence?.text || '');
    return [{
      sentenceId,
      order: 1,
      text,
      start: Number(sentence?.start),
      end: Number(sentence?.end),
      startOffset: 0,
      endOffset: text.length,
      splitReason: 'sentence'
    }];
  }

  function normalizeStoredChunk(chunk, sentenceId) {
    return {
      sentenceId: Number.isFinite(Number(chunk?.sentenceId)) ? Number(chunk.sentenceId) : sentenceId,
      order: Number(chunk?.order),
      text: String(chunk?.text || ''),
      start: Number(chunk?.start),
      end: Number(chunk?.end),
      startOffset: Number(chunk?.startOffset),
      endOffset: Number(chunk?.endOffset),
      splitReason: String(chunk?.splitReason || '')
    };
  }

  function nearlyEqual(left, right) {
    return Math.abs(Number(left) - Number(right)) <= EPSILON;
  }

  function validatePracticeChunks(chunks, sentence, { requireTokenBoundaries = true } = {}) {
    if (!Array.isArray(chunks) || !chunks.length || !sentence) return false;
    const sentenceId = Math.max(1, Math.floor(Number(sentence.id) || 1));
    const sentenceStart = Number(sentence.start);
    const sentenceEnd = Number(sentence.end);
    const sentenceText = String(sentence.text || '');
    if (!Number.isFinite(sentenceStart) || !Number.isFinite(sentenceEnd) || sentenceEnd <= sentenceStart || !sentenceText) return false;

    const tokens = Array.isArray(sentence.tokens) ? sentence.tokens.map(normalizeToken).filter(Boolean) : [];
    const joined = joinAtomsWithOffsets(tokens);
    const startOffsets = new Set([0, ...joined.offsets.map((offset) => offset.startOffset)]);
    const endOffsets = new Set([...joined.offsets.slice(1).map((offset) => offset.startOffset), sentenceText.length]);
    let offsetCursor = 0;
    let previousEnd = sentenceStart;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = normalizeStoredChunk(chunks[index], sentenceId);
      if (chunk.sentenceId !== sentenceId || chunk.order !== index + 1 || !CHUNK_REASONS.has(chunk.splitReason)) return false;
      if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end) || chunk.end <= chunk.start) return false;
      if (chunk.start < sentenceStart - EPSILON || chunk.end > sentenceEnd + EPSILON || chunk.start < previousEnd - EPSILON) return false;
      if (!Number.isInteger(chunk.startOffset) || !Number.isInteger(chunk.endOffset)
        || chunk.startOffset !== offsetCursor || chunk.endOffset <= chunk.startOffset
        || chunk.endOffset > sentenceText.length) return false;
      if (sentenceText.slice(chunk.startOffset, chunk.endOffset) !== chunk.text) return false;
      if (requireTokenBoundaries) {
        if (!tokens.length || joined.text !== sentenceText
          || !startOffsets.has(chunk.startOffset) || !endOffsets.has(chunk.endOffset)
          || !tokens.some((token) => nearlyEqual(token.start, chunk.start))
          || !tokens.some((token) => nearlyEqual(token.end, chunk.end))) return false;
      }
      offsetCursor = chunk.endOffset;
      previousEnd = chunk.end;
    }

    return nearlyEqual(chunks[0].start, sentenceStart)
      && nearlyEqual(chunks.at(-1).end, sentenceEnd)
      && offsetCursor === sentenceText.length
      && chunks.map((chunk) => String(chunk.text || '')).join('') === sentenceText;
  }

  function buildPracticeChunks(sentence, customOptions = {}) {
    const options = { ...DEFAULT_OPTIONS, ...customOptions };
    const sentenceId = Math.max(1, Math.floor(Number(sentence?.id) || 1));
    const duration = Number(sentence?.end) - Number(sentence?.start);
    const atoms = Array.isArray(sentence?.tokens)
      ? sentence.tokens.map(normalizeToken).filter(Boolean)
      : [];
    const joined = joinAtomsWithOffsets(atoms);
    if (!Number.isFinite(duration) || duration <= options.chunkThreshold || atoms.length < 2
      || joined.text !== String(sentence?.text || '')) {
      return wholeSentenceChunk(sentence, sentenceId);
    }

    const candidates = new Map();
    for (let index = 0; index < atoms.length - 1; index += 1) {
      const candidate = boundaryCandidate(atoms, index, options);
      if (candidate) candidates.set(index + 1, candidate);
    }
    if (!candidates.size) return wholeSentenceChunk(sentence, sentenceId);

    const positions = [0, ...candidates.keys(), atoms.length];
    const best = new Map([[0, { score: 0, previous: null }]]);
    for (let leftIndex = 0; leftIndex < positions.length - 1; leftIndex += 1) {
      const from = positions[leftIndex];
      const current = best.get(from);
      if (!current) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < positions.length; rightIndex += 1) {
        const to = positions[rightIndex];
        const chunkDuration = atoms[to - 1].end - atoms[from].start;
        if (chunkDuration < options.chunkMin) continue;
        const internalBoundary = candidates.get(to);
        const score = current.score
          + chunkDurationScore(chunkDuration, options)
          + (internalBoundary ? internalBoundary.score - options.splitCost : 0);
        if (!best.has(to) || score > best.get(to).score) best.set(to, { score, previous: from });
      }
    }

    const result = best.get(atoms.length);
    if (!result || result.score <= 0) return wholeSentenceChunk(sentence, sentenceId);
    const boundaries = [];
    let cursor = atoms.length;
    while (cursor > 0) {
      boundaries.push(cursor);
      cursor = best.get(cursor)?.previous;
      if (!Number.isInteger(cursor)) return wholeSentenceChunk(sentence, sentenceId);
    }
    boundaries.reverse();
    if (boundaries.length < 2) return wholeSentenceChunk(sentence, sentenceId);

    const chunks = [];
    let startIndex = 0;
    for (const endIndex of boundaries) {
      const startOffset = startIndex === 0 ? 0 : joined.offsets[startIndex].startOffset;
      const endOffset = endIndex < atoms.length ? joined.offsets[endIndex].startOffset : joined.text.length;
      chunks.push({
        sentenceId,
        order: chunks.length + 1,
        text: joined.text.slice(startOffset, endOffset),
        start: atoms[startIndex].start,
        end: atoms[endIndex - 1].end,
        startOffset,
        endOffset,
        splitReason: candidates.get(endIndex)?.reason || 'sentence-end'
      });
      startIndex = endIndex;
    }
    return validatePracticeChunks(chunks, { ...sentence, id: sentenceId, tokens: atoms })
      ? chunks
      : wholeSentenceChunk(sentence, sentenceId);
  }

  function normalizeSentence(sentence, fallbackId = 1) {
    const id = Math.max(1, Math.floor(Number(sentence?.id) || fallbackId));
    const start = Number(sentence?.start);
    const end = Number(sentence?.end);
    const text = cleanCaptionText(sentence?.text);
    const tokens = Array.isArray(sentence?.tokens) ? sentence.tokens.map(normalizeToken).filter(Boolean) : [];
    const normalized = {
      id,
      uid: stableSentenceUid(start, end, text),
      start,
      end,
      text,
      splitReason: String(sentence?.splitReason || 'remainder'),
      tokens
    };
    if (tokens.length) {
      normalized.practiceChunks = buildPracticeChunks(normalized);
    } else {
      const stored = Array.isArray(sentence?.practiceChunks)
        ? sentence.practiceChunks.map((chunk) => normalizeStoredChunk(chunk, id))
        : [];
      normalized.practiceChunks = validatePracticeChunks(stored, normalized, { requireTokenBoundaries: false })
        ? stored
        : wholeSentenceChunk(normalized, id);
    }
    return normalized;
  }

  function makeSentence(atoms, id, splitReason, options) {
    const text = joinAtoms(atoms);
    const sentence = {
      id,
      uid: stableSentenceUid(atoms[0].start, atoms.at(-1).end, text),
      start: atoms[0].start,
      end: atoms.at(-1).end,
      text,
      splitReason,
      tokens: atoms.map((atom) => ({ ...atom }))
    };
    sentence.practiceChunks = buildPracticeChunks(sentence, options);
    return sentence;
  }

  function smartSegmentCues(cues, customOptions = {}) {
    const options = { ...DEFAULT_OPTIONS, ...customOptions };
    const atoms = (Array.isArray(cues) ? cues : [])
      .flatMap(cueToAtoms)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!atoms.length) return [];

    const sentences = [];
    let startIndex = 0;
    function emit(endIndex, splitReason) {
      if (endIndex < startIndex) return;
      sentences.push(makeSentence(atoms.slice(startIndex, endIndex + 1), sentences.length + 1, splitReason, options));
      startIndex = endIndex + 1;
    }

    for (let index = 0; index < atoms.length; index += 1) {
      const next = atoms[index + 1];
      const currentText = joinAtoms(atoms.slice(startIndex, index + 1));
      const duration = atoms[index].end - atoms[startIndex].start;
      const pauseAfter = next ? Math.max(0, next.start - atoms[index].end) : 0;
      if (isTerminalBoundary(currentText, next?.text || '')) emit(index, 'punctuation');
      else if (pauseAfter >= options.sentencePause && duration >= options.sentenceMinDuration) emit(index, 'strong-pause');
    }
    if (startIndex < atoms.length) emit(atoms.length - 1, 'remainder');
    return sentences;
  }

  return {
    DEFAULT_SEGMENTATION_OPTIONS: DEFAULT_OPTIONS,
    buildPracticeChunks,
    cleanCaptionText,
    cueToAtoms,
    normalizeSentence,
    smartSegmentCues,
    stableSentenceUid,
    validatePracticeChunks
  };
}));
