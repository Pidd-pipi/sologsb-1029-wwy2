import { courseForLesson, currentQuestionVersion, lessonById, lessonDurationSec, saveAttempt, saveSession } from './store';
import type { ExamSession, Lesson, PracticeAttempt, SentenceMapping, SessionStatus } from './types';
import { bindPendingMapping, compareSentence, freezeSentences, remapSentences, remainingMs, scoreAttempt } from './utils';

/** 开始即冻结题目版本：此后课程句子变化不影响本场 */
export function startSession(lesson: Lesson): ExamSession {
  const course = courseForLesson(lesson.id);
  const frozen = freezeSentences(lesson.sentences);
  const now = new Date().toISOString();
  const session: ExamSession = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseId: course?.id ?? '',
    courseTitle: course?.title ?? '',
    status: 'in_progress',
    startedAt: now,
    durationSec: lessonDurationSec(lesson),
    submittedAt: '',
    questionVersion: currentQuestionVersion(lesson.id),
    frozenSentences: frozen,
    answers: {},
    activeFrozenId: frozen[0]?.sentenceId ?? '',
    mappings: frozen.map((sentence) => ({ frozenId: sentence.sentenceId, status: 'matched', currentSentenceId: sentence.sentenceId }))
  };
  saveSession(session);
  return session;
}

/**
 * 恢复同一场次：按最新课程句子重新确认词位。
 * 版本一致时全部唯一匹配；句子一变，无法按 id / 规范化文本唯一命中的列入待确认。
 */
export function restoreSession(session: ExamSession): ExamSession {
  if (session.status !== 'in_progress') return session;
  // 课节在课程包中被移除时，按空的当前句集合处理：全部转为待确认
  const lesson = lessonById(session.lessonId);
  const mappings = remapSentences(session.frozenSentences, lesson?.sentences ?? [], session.mappings);
  const changed = mappings.some((mapping, index) => mapping.status !== session.mappings[index]?.status || mapping.currentSentenceId !== session.mappings[index]?.currentSentenceId);
  if (changed || !lesson || currentQuestionVersion(session.lessonId) !== session.questionVersion) {
    const updated = { ...session, mappings };
    saveSession(updated);
    return updated;
  }
  return session;
}

export function isExpired(session: ExamSession, now: number = Date.now()): boolean {
  return session.status === 'in_progress' && remainingMs(session.startedAt, session.durationSec, now) <= 0;
}

export function bindPending(session: ExamSession, frozenId: string, currentSentenceId: string): ExamSession {
  const mappings = bindPendingMapping(session.mappings, frozenId, currentSentenceId);
  const updated = { ...session, mappings };
  saveSession(updated);
  return updated;
}

export function setSessionAnswer(session: ExamSession, frozenId: string, answer: string): ExamSession {
  if (session.status !== 'in_progress') return session;
  session.answers[frozenId] = answer;
  session.activeFrozenId = frozenId;
  saveSession(session);
  return session;
}

export function setActiveSentence(session: ExamSession, frozenId: string): ExamSession {
  if (session.status !== 'in_progress') return session;
  session.activeFrozenId = frozenId;
  saveSession(session);
  return session;
}

/** 超时立即收卷（断网恢复、切回前台、刷新重开都走这里），状态不可逆 */
export function autoSubmitIfExpired(session: ExamSession, now: number = Date.now()): { session: ExamSession; attempt?: PracticeAttempt } {
  if (!isExpired(session, now)) return { session };
  return finalizeSession(session, 'timed_out', now);
}

/**
 * 收卷：判分始终使用冻结的原始题目；待确认句保留在结果中但不计分。
 * 收卷后保存快照，课程后续更新不再影响本次结果，也不能续写。
 */
export function finalizeSession(session: ExamSession, status: SessionStatus, now: number = Date.now()): { session: ExamSession; attempt: PracticeAttempt } {
  const mappingsById = new Map<SentenceMapping['frozenId'], SentenceMapping>(session.mappings.map((mapping) => [mapping.frozenId, mapping]));
  const submittedAt = new Date(now).toISOString();

  const sentenceAttempts = session.frozenSentences.map((frozen) => {
    const mapping = mappingsById.get(frozen.sentenceId);
    const matched = mapping?.status === 'matched';
    const answer = session.answers[frozen.sentenceId] ?? '';
    const tokens = compareSentence(frozen.text, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return {
      sentenceId: frozen.sentenceId,
      source: frozen.text,
      answer,
      tokens,
      score: tokens.length && matched ? Math.round((correct / tokens.length) * 100) : 0,
      scored: matched,
      mappingStatus: matched ? 'matched' as const : 'pending' as const
    };
  });

  const attempt: PracticeAttempt = {
    id: `attempt-${now}`,
    sessionId: session.id,
    lessonId: session.lessonId,
    lessonTitle: session.lessonTitle,
    courseTitle: session.courseTitle,
    submittedAt,
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: '',
    sessionStatus: status,
    startedAt: session.startedAt,
    durationSec: session.durationSec,
    questionVersion: session.questionVersion,
    frozenSentences: session.frozenSentences,
    mappings: session.mappings
  };

  const finalized: ExamSession = {
    ...session,
    status,
    submittedAt,
    activeFrozenId: session.frozenSentences[0]?.sentenceId ?? ''
  };
  saveSession(finalized);
  saveAttempt(attempt);
  return { session: finalized, attempt };
}
