import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type { Course, ExamSession, Lesson, LessonExamSettings, PersistedState, PracticeAttempt } from './types';
import { questionVersionOf } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

type StoredState = PersistedState | (Omit<PersistedState, 'schemaVersion'> & { schemaVersion: 1 });

/** v1 草稿迁移到 v2：补齐场次集合与限时设置 */
function migrate(parsed: StoredState): PersistedState {
  if (parsed.schemaVersion === 2) return parsed;
  const attempts = (parsed.attempts ?? []).map((attempt) => ({
    ...attempt,
    sessionId: attempt.id,
    sessionStatus: 'submitted' as const,
    startedAt: attempt.submittedAt,
    durationSec: 0,
    questionVersion: '',
    frozenSentences: attempt.sentenceAttempts.map((item) => ({
      sentenceId: item.sentenceId,
      text: item.source,
      translation: '',
      note: ''
    })),
    mappings: attempt.sentenceAttempts.map((item) => ({ frozenId: item.sentenceId, status: 'matched' as const, currentSentenceId: item.sentenceId })),
    sentenceAttempts: attempt.sentenceAttempts.map((item) => ({ ...item, scored: true, mappingStatus: 'matched' as const }))
  }));
  return {
    schemaVersion: 2,
    courses: parsed.courses ?? [],
    attempts,
    progress: parsed.progress ?? {},
    sessions: [],
    lessonExamSettings: {},
    activeSessionId: '',
    activeLessonId: parsed.activeLessonId ?? '',
    activeSentenceId: parsed.activeSentenceId ?? '',
    theme: parsed.theme ?? 'light',
    fontScale: parsed.fontScale ?? 1,
    role: parsed.role ?? 'learner'
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw) as StoredState);
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

/**
 * 课程包更新对账：新版课节内容进入本地，同时保留本机的下载标记。
 * 未收卷场次随后会按新版本重新确认词位。
 */
function reconcileCourses(stored: PersistedState, latest: Course[]): PersistedState {
  const storedCourseById = new Map(stored.courses.map((course) => [course.id, course]));
  stored.courses = latest.map((course) => {
    const previous = storedCourseById.get(course.id);
    if (!previous) return course;
    const previousLessonById = new Map(previous.lessons.map((lesson) => [lesson.id, lesson]));
    const lessons = course.lessons.map((lesson) => {
      const old = previousLessonById.get(lesson.id);
      return old ? { ...lesson, downloaded: old.downloaded } : lesson;
    });
    return { ...course, lessons };
  });
  return stored;
}

export const state = reactive(reconcileCourses(loadState(), createInitialState().courses));

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
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
export const sessionById = (id: string) => state.sessions.find((session) => session.id === id);
export const inProgressSessionForLesson = (lessonId: string) => state.sessions.find((session) => session.lessonId === lessonId && session.status === 'in_progress');
export const inProgressSession = () => state.sessions.find((session) => session.status === 'in_progress');

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

/** 课节限时（秒）：教师设置优先，否则按预计时长给默认值 */
export function lessonDurationSec(lesson: Lesson): number {
  return state.lessonExamSettings[lesson.id] ?? Math.max(3, lesson.estimatedMinutes) * 60;
}

export function setLessonDuration(lessonId: string, durationSec: number) {
  const settings: LessonExamSettings = { ...state.lessonExamSettings };
  if (durationSec > 0) settings[lessonId] = durationSec;
  else delete settings[lessonId];
  state.lessonExamSettings = settings;
}

/** 当前课程句子版本（与场次冻结版本比较，判断句子是否变更） */
export function currentQuestionVersion(lessonId: string): string {
  const lesson = lessonById(lessonId);
  return lesson ? questionVersionOf(lesson.sentences) : '';
}

export function saveSession(session: ExamSession) {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) state.sessions[index] = session;
  else state.sessions.unshift(session);
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    attempts: state.attempts.map((attempt) => ({
      ...attempt,
      // 导出同时带场次状态和原始题目版本
      session: {
        sessionId: attempt.sessionId,
        status: attempt.sessionStatus,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        durationSec: attempt.durationSec,
        questionVersion: attempt.questionVersion,
        pendingSentenceIds: attempt.sentenceAttempts.filter((item) => !item.scored).map((item) => item.sentenceId),
        frozenSentences: attempt.frozenSentences,
        mappings: attempt.mappings
      }
    })),
    sessions: state.sessions.map((session) => ({
      id: session.id,
      lessonId: session.lessonId,
      status: session.status,
      startedAt: session.startedAt,
      submittedAt: session.submittedAt,
      durationSec: session.durationSec,
      questionVersion: session.questionVersion,
      answers: session.answers,
      frozenSentences: session.frozenSentences,
      mappings: session.mappings
    })),
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = reconcileCourses(createInitialState(), createInitialState().courses);
  Object.assign(state, fresh);
}
