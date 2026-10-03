import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type { Course, ExamSession, Lesson, PersistedState, PracticeAttempt } from './types';
import { compareSentence, deepClone, normalizeToken, scoreAttempt, segmentText, sentenceSetVersion } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

function migrateState(parsed: { schemaVersion?: number } & Record<string, unknown>): PersistedState | null {
  if (parsed.schemaVersion === 2) return parsed as unknown as PersistedState;
  if (parsed.schemaVersion === 1) {
    // v1 → v2：补充限时听写场次字段，原有练习数据保持不变。
    const legacy = parsed as unknown as PersistedState;
    return { ...legacy, schemaVersion: 2, examSessions: [], activeExamId: '' };
  }
  return null;
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { schemaVersion?: number } & Record<string, unknown>;
      const migrated = migrateState(parsed);
      if (migrated) return migrated;
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string): Course | undefined => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

// ---------- 限时听写场次 ----------

export const examSessionById = (id: string): ExamSession | undefined => state.examSessions.find((session) => session.id === id);
export const activeExamForLesson = (lessonId: string): ExamSession | undefined =>
  state.examSessions.find((session) => session.lessonId === lessonId && session.status === 'active');

/** 开始一场限时听写：冻结当前题目版本，按真实时间设定截止点。 */
export function startExamSession(lesson: Lesson, durationMinutes: number): ExamSession {
  const existing = activeExamForLesson(lesson.id);
  if (existing) return existing;
  const course = courseForLesson(lesson.id);
  const startedAt = new Date();
  const frozenSentences = deepClone(lesson.sentences);
  const session: ExamSession = {
    id: `exam-${startedAt.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course?.title ?? '',
    status: 'active',
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + durationMinutes * 60_000).toISOString(),
    durationMinutes,
    submittedAt: null,
    questionVersion: sentenceSetVersion(frozenSentences),
    frozenSentences,
    answers: {},
    activeSentenceId: frozenSentences[0]?.id ?? '',
    pendingAnswers: [],
    attemptId: null,
    updatedAt: startedAt.toISOString()
  };
  state.examSessions.unshift(session);
  state.activeExamId = session.id;
  return session;
}

export function saveExamAnswer(sessionId: string, sentenceId: string, value: string) {
  const session = examSessionById(sessionId);
  if (!session || session.status !== 'active') return;
  session.answers[sentenceId] = value;
  session.activeSentenceId = sentenceId;
  session.updatedAt = new Date().toISOString();
}

export function setExamActiveSentence(sessionId: string, sentenceId: string) {
  const session = examSessionById(sessionId);
  if (!session || session.status !== 'active') return;
  session.activeSentenceId = sentenceId;
  session.updatedAt = new Date().toISOString();
}

const normalizedText = (text: string): string => segmentText(text).map((token) => normalizeToken(token.display)).filter(Boolean).join(' ');

/**
 * 课程句子变化后，为未收卷场次重新确认词位：
 * 答案按「同 id 且原文一致」或「全文唯一匹配」保留，其余列入待确认且不计分。
 * 已收卷场次保存快照，一律不动。
 */
export function reconcileExamSession(session: ExamSession): boolean {
  if (session.status !== 'active') return false;
  const lesson = lessonById(session.lessonId);
  if (!lesson) return false;
  const nextVersion = sentenceSetVersion(lesson.sentences);
  if (nextVersion === session.questionVersion) return false;

  const nextSentences = lesson.sentences;
  const nextAnswers: Record<string, string> = {};
  for (const frozen of session.frozenSentences) {
    const answer = session.answers[frozen.id];
    if (!answer || !answer.trim()) continue;
    const sameSlot = nextSentences.find((sentence) => sentence.id === frozen.id && sentence.text === frozen.text);
    if (sameSlot) {
      nextAnswers[sameSlot.id] = answer;
      continue;
    }
    const signature = normalizedText(frozen.text);
    const textMatches = nextSentences.filter((sentence) => normalizedText(sentence.text) === signature);
    if (textMatches.length === 1) {
      nextAnswers[textMatches[0].id] = answer;
    } else {
      session.pendingAnswers.push({
        sentenceId: frozen.id,
        sourceText: frozen.text,
        answer,
        reason: textMatches.length > 1 ? '课程更新后存在多个相同句子，无法唯一匹配' : '课程更新后找不到对应原句'
      });
    }
  }

  session.answers = nextAnswers;
  session.frozenSentences = deepClone(nextSentences);
  session.questionVersion = nextVersion;
  if (!nextSentences.some((sentence) => sentence.id === session.activeSentenceId)) {
    session.activeSentenceId = nextSentences[0]?.id ?? '';
  }
  session.updatedAt = new Date().toISOString();
  return true;
}

/** 扫描全部未收卷场次，课程版本有变化就重新确认词位。返回发生变化的场次数。 */
export function reconcileActiveExamSessions(lessonId?: string): number {
  let changed = 0;
  for (const session of state.examSessions) {
    if (lessonId && session.lessonId !== lessonId) continue;
    if (reconcileExamSession(session)) changed += 1;
  }
  return changed;
}

/** 收卷：按冻结题目与已确认答案评分，生成结果快照，场次锁定后不能续写。 */
export function finalizeExamSession(session: ExamSession, status: 'submitted' | 'expired'): PracticeAttempt | null {
  if (session.status !== 'active') {
    return state.attempts.find((attempt) => attempt.id === session.attemptId) ?? null;
  }
  reconcileExamSession(session);
  const submittedAt = new Date().toISOString();
  const sentenceAttempts = session.frozenSentences.map((sentence) => {
    const answer = session.answers[sentence.id] ?? '';
    const tokens = compareSentence(sentence.text, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return {
      sentenceId: sentence.id,
      source: sentence.text,
      answer,
      tokens,
      score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0
    };
  });
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    lessonId: session.lessonId,
    lessonTitle: session.lessonTitle,
    courseTitle: session.courseTitle,
    submittedAt,
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: '',
    examSessionId: session.id
  };
  session.status = status;
  session.submittedAt = submittedAt;
  session.attemptId = attempt.id;
  session.updatedAt = submittedAt;
  if (state.activeExamId === session.id) state.activeExamId = '';
  saveAttempt(attempt);
  return attempt;
}

/** 超时立即收卷：按真实经过时间判断，返回本次被收卷的场次。 */
export function sweepExpiredExamSessions(now: number = Date.now()): ExamSession[] {
  const expired: ExamSession[] = [];
  for (const session of state.examSessions) {
    if (session.status === 'active' && now >= new Date(session.deadlineAt).getTime()) {
      finalizeExamSession(session, 'expired');
      expired.push(session);
    }
  }
  return expired;
}

export function updateLessonSentences(lessonId: string, sentences: Lesson['sentences']): number {
  const lesson = lessonById(lessonId);
  if (!lesson) return 0;
  lesson.sentences = deepClone(sentences);
  return reconcileActiveExamSessions(lessonId);
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    examSessions: state.examSessions.map((session) => ({
      id: session.id,
      lessonId: session.lessonId,
      lessonTitle: session.lessonTitle,
      courseTitle: session.courseTitle,
      status: session.status,
      startedAt: session.startedAt,
      deadlineAt: session.deadlineAt,
      durationMinutes: session.durationMinutes,
      submittedAt: session.submittedAt,
      questionVersion: session.questionVersion,
      frozenSentences: session.frozenSentences,
      answers: session.answers,
      pendingAnswers: session.pendingAnswers,
      attemptId: session.attemptId
    })),
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
