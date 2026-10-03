export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'exam' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';
export type ExamSessionStatus = 'active' | 'submitted' | 'expired';

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

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
  examSessionId?: string;
}

export interface ExamPendingAnswer {
  sentenceId: string;
  sourceText: string;
  answer: string;
  reason: string;
}

export interface ExamSession {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  status: ExamSessionStatus;
  startedAt: string;
  deadlineAt: string;
  durationMinutes: number;
  submittedAt: string | null;
  questionVersion: string;
  frozenSentences: Sentence[];
  answers: Record<string, string>;
  activeSentenceId: string;
  pendingAnswers: ExamPendingAnswer[];
  attemptId: string | null;
  updatedAt: string;
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
  examSessions: ExamSession[];
  activeExamId: string;
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
