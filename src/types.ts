export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
export type SessionStatus = 'in_progress' | 'submitted' | 'timed_out';
/** 冻结句与当前课程句子的词位匹配状态：唯一匹配 / 无法唯一匹配待确认 */
export type MappingStatus = 'matched' | 'pending';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

/** 场次开始时冻结的句子（原始题目版本） */
export interface FrozenSentence {
  sentenceId: string;
  text: string;
  translation: string;
  note: string;
}

/** 冻结句到当前课程句子的词位映射 */
export interface SentenceMapping {
  frozenId: string;
  status: MappingStatus;
  currentSentenceId: string;
}

/** 可恢复的限时听写场次 */
export interface ExamSession {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  courseTitle: string;
  status: SessionStatus;
  /** 开始时刻（ISO），倒计时按真实经过时间计算 */
  startedAt: string;
  /** 时长（秒），开始后冻结 */
  durationSec: number;
  submittedAt: string;
  /** 题目版本快照 */
  questionVersion: string;
  frozenSentences: FrozenSentence[];
  /** 以冻结句 id 为键的答案 */
  answers: Record<string, string>;
  activeFrozenId: string;
  mappings: SentenceMapping[];
}

/** 教师为课节设置的开考限时（秒） */
export type LessonExamSettings = Record<string, number>;

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
  /** 场次收卷时该句能否唯一匹配当前词位；待确认句不计分 */
  scored: boolean;
  mappingStatus: MappingStatus;
}

export interface PracticeAttempt {
  id: string;
  sessionId: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
  /** 收卷场次状态：手动交卷 / 超时收卷 */
  sessionStatus: SessionStatus;
  /** 开始时刻与时长，用于还原场次真实经过 */
  startedAt: string;
  durationSec: number;
  /** 原始题目版本快照，不受课程新版本影响 */
  questionVersion: string;
  frozenSentences: FrozenSentence[];
  mappings: SentenceMapping[];
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  sessions: ExamSession[];
  lessonExamSettings: LessonExamSettings;
  activeSessionId: string;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
