import type { FrozenSentence, Sentence, SentenceAttempt, SentenceMapping, TextSegment, TokenResult } from './types';

export const segmentText = (text: string): TextSegment[] => {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]+/gu) ?? [];
  return matches.map((display, index) => ({
    index,
    display,
    normalized: normalizeToken(display)
  }));
};

export const normalizeToken = (token: string): string => token
  .toLocaleLowerCase('en')
  .replaceAll('’', "'")
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** 句子的规范化全文，用于课程更新后按内容重新确认词位 */
export function sentenceKey(text: string): string {
  return segmentText(text)
    .map((token) => token.normalized)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .join(' ');
}

/** 简单稳定的字符串哈希（djb2），用来生成可比较的题目版本号 */
export function hashContent(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 课节题目版本：句子 id 与文本的组合哈希，句子一变版本即变 */
export function questionVersionOf(sentences: Array<Pick<Sentence, 'id' | 'text'>>): string {
  return hashContent(sentences.map((sentence) => `${sentence.id}:${sentenceKey(sentence.text)}`).join('|'));
}

export function freezeSentences(sentences: Sentence[]): FrozenSentence[] {
  return sentences.map(({ id, text, translation, note }) => ({ sentenceId: id, text, translation, note }));
}

/**
 * 课程句子更新后，为冻结句重新确认词位。
 * 先按句子 id 唯一命中，再按规范化文本唯一命中；否则列入待确认且不计分。
 */
export function remapSentences(frozen: FrozenSentence[], current: Sentence[], previous: SentenceMapping[] = []): SentenceMapping[] {
  const previousById = new Map(previous.map((mapping) => [mapping.frozenId, mapping]));
  const currentById = new Map(current.map((sentence) => [sentence.id, sentence]));
  const keyToIds = new Map<string, string[]>();
  current.forEach((sentence) => {
    const key = sentenceKey(sentence.text);
    const ids = keyToIds.get(key) ?? [];
    ids.push(sentence.id);
    keyToIds.set(key, ids);
  });

  return frozen.map((item) => {
    // 沿用已人工确认过的映射（仅当目标句仍存在）
    const prior = previousById.get(item.sentenceId);
    if (prior?.status === 'matched' && currentById.has(prior.currentSentenceId)) {
      return { frozenId: item.sentenceId, status: 'matched' as const, currentSentenceId: prior.currentSentenceId };
    }
    if (currentById.has(item.sentenceId)) {
      return { frozenId: item.sentenceId, status: 'matched' as const, currentSentenceId: item.sentenceId };
    }
    const ids = keyToIds.get(sentenceKey(item.text)) ?? [];
    if (ids.length === 1) {
      return { frozenId: item.sentenceId, status: 'matched' as const, currentSentenceId: ids[0] };
    }
    return { frozenId: item.sentenceId, status: 'pending' as const, currentSentenceId: '' };
  });
}

/** 人工确认某条待确认词位的唯一匹配目标 */
export function bindPendingMapping(mappings: SentenceMapping[], frozenId: string, currentSentenceId: string): SentenceMapping[] {
  if (!currentSentenceId) return mappings;
  // 目标词位必须唯一：不能被另一条冻结句占用
  const occupied = mappings.some((mapping) => mapping.status === 'matched' && mapping.currentSentenceId === currentSentenceId && mapping.frozenId !== frozenId);
  if (occupied) return mappings;
  return mappings.map((mapping) => mapping.frozenId === frozenId ? { ...mapping, status: 'matched', currentSentenceId } : mapping);
}

export function compareSentence(expected: string, answer: string): TokenResult[] {
  const expectedTokens = segmentText(expected);
  const actualTokens = segmentText(answer);
  const rows = expectedTokens.length + actualTokens.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(rows + 1).fill(0));
  const move = Array.from({ length: rows + 1 }, () => Array<string>(rows + 1).fill(''));

  for (let i = 0; i <= expectedTokens.length; i += 1) {
    table[i][0] = i;
    move[i][0] = 'delete';
  }
  for (let j = 0; j <= actualTokens.length; j += 1) {
    table[0][j] = j;
    move[0][j] = 'insert';
  }

  for (let i = 1; i <= expectedTokens.length; i += 1) {
    for (let j = 1; j <= actualTokens.length; j += 1) {
      const substitution = table[i - 1][j - 1] + (expectedTokens[i - 1].normalized === actualTokens[j - 1].normalized ? 0 : 1);
      const deletion = table[i - 1][j] + 1;
      const insertion = table[i][j - 1] + 1;
      table[i][j] = Math.min(substitution, deletion, insertion);
      move[i][j] = substitution <= deletion && substitution <= insertion
        ? 'match'
        : deletion <= insertion ? 'delete' : 'insert';
    }
  }

  const reversed: TokenResult[] = [];
  let i = expectedTokens.length;
  let j = actualTokens.length;
  while (i > 0 || j > 0) {
    const direction = move[i][j];
    if (direction === 'match' && i > 0 && j > 0) {
      const expectedToken = expectedTokens[i - 1];
      const actualToken = actualTokens[j - 1];
      const correct = expectedToken.normalized === actualToken.normalized;
      reversed.push({
        index: i - 1,
        expected: expectedToken.display,
        actual: actualToken.display,
        correct,
        category: correct ? 'unclassified' : 'spelling',
        reason: ''
      });
      i -= 1;
      j -= 1;
    } else if (direction === 'delete' && i > 0) {
      reversed.push({ index: i - 1, expected: expectedTokens[i - 1].display, actual: '', correct: false, category: 'omitted', reason: '' });
      i -= 1;
    } else if (j > 0) {
      reversed.push({ index: Math.max(0, i - 1), expected: '', actual: actualTokens[j - 1].display, correct: false, category: 'extra', reason: '' });
      j -= 1;
    } else {
      break;
    }
  }

  const result = reversed.reverse();
  return result.map((token, index) => ({ ...token, index }));
}

/** 整课得分只统计已唯一匹配词位（可计分）的句子 */
export function scoreAttempt(sentenceAttempts: SentenceAttempt[]): number {
  const totals = sentenceAttempts.filter((attempt) => attempt.scored).flatMap((attempt) => attempt.tokens);
  if (!totals.length) return 0;
  const correct = totals.filter((token) => token.correct).length;
  return Math.max(0, Math.round((correct / totals.length) * 100));
}

export function remainingMs(startedAt: string, durationSec: number, now: number = Date.now()): number {
  return Math.max(0, new Date(startedAt).getTime() + durationSec * 1000 - now);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const minutes = Math.round(sec / 60);
  return `${minutes} 分钟`;
}
