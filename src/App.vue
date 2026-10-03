<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  currentQuestionVersion, exportRecords, inProgressSessionForLesson, lessonById,
  lessonDurationSec, persist, sessionById, setDownloaded, setLessonDuration, state, updateTokenClassification
} from './store';
import { autoSubmitIfExpired, bindPending, finalizeSession, restoreSession, setActiveSentence, setSessionAnswer, startSession } from './exam';
import type { ErrorCategory, ExamSession, Lesson, PracticeAttempt, PracticeView } from './types';
import { formatClock, formatDuration, remainingMs, segmentText } from './utils';

/** 启动时恢复未收卷场次：重新确认词位，已超时立即收卷 */
function resolveInitial(): { session?: ExamSession; attempt?: PracticeAttempt } {
  let session = sessionById(state.activeSessionId);
  if (!session || session.status !== 'in_progress') session = state.sessions.find((item) => item.status === 'in_progress');
  if (!session) return {};
  const restored = restoreSession(session);
  const checked = autoSubmitIfExpired(restored);
  return { session: checked.session, attempt: checked.attempt };
}
const initial = resolveInitial();
const view = ref<PracticeView>(initial.attempt ? 'result' : initial.session ? 'practice' : 'library');
const activeSessionId = ref(initial.session?.status === 'in_progress' ? initial.session.id : '');
state.activeSessionId = activeSessionId.value;

const online = ref(navigator.onLine);
const toast = ref('');
const nowTick = ref(Date.now());
const resultAttemptId = ref(initial.attempt?.id ?? state.attempts[0]?.id ?? '');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(0);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
const currentAnswer = ref('');
let toastTimer = 0;
let tickTimer = 0;

const activeSession = computed(() => sessionById(activeSessionId.value));
const activeLesson = computed(() => activeSession.value ? lessonById(activeSession.value.lessonId) : undefined);
const frozenSentences = computed(() => activeSession.value?.frozenSentences ?? []);
const currentFrozen = computed(() => {
  const session = activeSession.value;
  if (!session) return undefined;
  return frozenSentences.value.find((item) => item.sentenceId === session.activeFrozenId) ?? frozenSentences.value[0];
});
const currentIndex = computed(() => frozenSentences.value.findIndex((item) => item.sentenceId === currentFrozen.value?.sentenceId));
const mappingByFrozen = computed(() => new Map((activeSession.value?.mappings ?? []).map((mapping) => [mapping.frozenId, mapping])));
const pendingFrozen = computed(() => frozenSentences.value.filter((item) => mappingByFrozen.value.get(item.sentenceId)?.status === 'pending'));
const answeredCount = computed(() => Object.values(activeSession.value?.answers ?? {}).filter((value) => value.trim()).length);
const remaining = computed(() => {
  const session = activeSession.value;
  return session ? remainingMs(session.startedAt, session.durationSec, nowTick.value) : 0;
});
const versionStale = computed(() => {
  const session = activeSession.value;
  return !!session && currentQuestionVersion(session.lessonId) !== session.questionVersion;
});

const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const resultLesson = computed(() => resultAttempt.value ? lessonById(resultAttempt.value.lessonId) : undefined);
const resultPendingCount = computed(() => resultAttempt.value?.sentenceAttempts.filter((item) => !item.scored).length ?? 0);
const resultScoredCount = computed(() => resultAttempt.value?.sentenceAttempts.filter((item) => item.scored).length ?? 0);

const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const allLessons = computed(() => state.courses.flatMap((course) => course.lessons.map((lesson) => ({ courseTitle: course.title, lesson }))));
const durationOptions = [3, 5, 7, 10, 15, 20];
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

watch(currentFrozen, (frozen) => {
  const session = activeSession.value;
  currentAnswer.value = frozen && session ? session.answers[frozen.sentenceId] ?? '' : '';
  window.scrollTo({ top: 0 });
}, { immediate: true });

watch(currentAnswer, (value) => {
  const session = activeSession.value;
  const frozen = currentFrozen.value;
  if (!session || !frozen || session.status !== 'in_progress') return;
  if ((session.answers[frozen.sentenceId] ?? '') === value) return;
  setSessionAnswer(session, frozen.sentenceId, value);
});

watch(resultSentence, () => syncSegment(), { immediate: true });

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2600);
}

/** 有待收场次则恢复同一场；否则确认后开新场并冻结题目版本 */
function startLesson(lesson: Lesson) {
  const existing = inProgressSessionForLesson(lesson.id);
  if (existing) {
    openSession(restoreSession(existing));
    return;
  }
  if (!window.confirm(
    `本场为限时听写，时长 ${formatDuration(lessonDurationSec(lesson))}。\n\n`
    + '· 开始后题目版本冻结，刷新、切后台或课程更新都使用同一份题目；\n'
    + '· 倒计时按真实经过时间计算，切到后台只暂停语音、不暂停答题；\n'
    + '· 断网可继续作答，超时立即自动收卷，收卷后不能续写。\n\n'
    + '确认现在开始？'
  )) return;
  openSession(startSession(lesson));
}

function openSession(session: ExamSession) {
  const checked = autoSubmitIfExpired(session);
  if (checked.session.status === 'in_progress') {
    activeSessionId.value = checked.session.id;
    state.activeSessionId = checked.session.id;
    view.value = 'practice';
    persist();
  } else if (checked.attempt) {
    activeSessionId.value = '';
    state.activeSessionId = '';
    showResult(checked.attempt, '时间到，已自动收卷');
  }
}

function showResult(attempt: PracticeAttempt, message?: string) {
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
  persist();
  if (message) notify(message);
}

function leaveToLibrary() {
  view.value = 'library';
}

function goToFrozen(index: number) {
  const session = activeSession.value;
  const frozen = frozenSentences.value[index];
  if (!session || !frozen) return;
  setActiveSentence(session, frozen.sentenceId);
}

/** 待确认句可选的新词位（排除已被其他冻结句唯一占用的句子） */
function targetsFor(frozenId: string) {
  const lesson = activeLesson.value;
  const session = activeSession.value;
  if (!lesson || !session) return [];
  return lesson.sentences.filter((sentence) => !session.mappings.some(
    (mapping) => mapping.status === 'matched' && mapping.currentSentenceId === sentence.id && mapping.frozenId !== frozenId
  ));
}

function onPendingTarget(frozenId: string, event: Event) {
  const session = activeSession.value;
  const targetId = (event.target as HTMLSelectElement).value;
  if (!session || !targetId) return;
  const updated = bindPending(session, frozenId, targetId);
  if (updated.mappings.some((mapping) => mapping.frozenId === frozenId && mapping.status === 'matched')) {
    notify('词位已唯一确认，该句恢复计分');
    persist();
  }
}

function submitLesson() {
  const session = activeSession.value;
  if (!session || session.status !== 'in_progress') return;
  if (!answeredCount.value) {
    notify('请至少输入一句话再交卷');
    return;
  }
  const unanswered = frozenSentences.value.length - answeredCount.value;
  const pending = pendingFrozen.value.length;
  const warnings: string[] = [];
  if (unanswered > 0) warnings.push(`还有 ${unanswered} 句未作答`);
  if (pending > 0) warnings.push(`${pending} 句无法唯一匹配词位，收卷后不计分`);
  if (warnings.length && !window.confirm(`${warnings.join('；')}。仍然交卷吗？`)) return;
  const { attempt } = finalizeSession(session, 'submitted');
  activeSessionId.value = '';
  state.activeSessionId = '';
  showResult(attempt, '已交卷，结果快照已保存');
}

function tick() {
  nowTick.value = Date.now();
  const session = activeSession.value;
  if (view.value !== 'practice' || !session || session.status !== 'in_progress') return;
  if (remainingMs(session.startedAt, session.durationSec, nowTick.value) <= 0) {
    const { attempt } = autoSubmitIfExpired(session, nowTick.value);
    if (attempt) {
      activeSessionId.value = '';
      state.activeSessionId = '';
      showResult(attempt, '时间到，已自动收卷');
    }
  }
}

/** 切回前台或断网恢复：只重新对账词位与超时，不补偿时间 */
function resumeAfterForeground() {
  online.value = navigator.onLine;
  const session = activeSession.value;
  if (view.value !== 'practice' || !session || session.status !== 'in_progress') return;
  const restored = restoreSession(session);
  const checked = autoSubmitIfExpired(restored);
  if (checked.attempt) {
    activeSessionId.value = '';
    state.activeSessionId = '';
    showResult(checked.attempt, '时间到，已自动收卷');
  }
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  attempt.teacherFeedback = teacherDraft.value.trim();
  persist();
  notify('教师反馈已保存');
}

function onDurationChange(lessonId: string, event: Event) {
  setLessonDuration(lessonId, Number((event.target as HTMLSelectElement).value));
  persist();
  notify('课节限时已更新，新开场次生效');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('练习记录已导出');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function onConnectionChange() {
  online.value = navigator.onLine;
  persist();
  if (navigator.onLine) resumeAfterForeground();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // 后台只暂停语音，倒计时与答题不暂停
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    persist();
  } else {
    resumeAfterForeground();
  }
}

onMounted(() => {
  tickTimer = window.setInterval(tick, 500);
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', persist);
});

onBeforeUnmount(() => {
  window.clearInterval(tickTimer);
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', persist);
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>限时听写 · 可离线恢复</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>下载课节后可离线开考。题目开考即冻结，切后台只停语音，刷新或超时都能恢复同一场次。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 数据已保存到本机' : '● 离线模式 · 可继续已下载课节的场次' }}</span>
          <span>{{ online ? '本地优先存储' : '场次与倒计时照常运行' }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div>
              <h4>{{ lesson.title }}</h4>
              <p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 限时约 {{ Math.round(lessonDurationSec(lesson) / 60) }} 分钟</p>
              <p v-if="inProgressSessionForLesson(lesson.id)" class="exam-meta">
                <span class="status-chip warning">未收卷场次 · 剩余 {{ formatClock(remainingMs(inProgressSessionForLesson(lesson.id)!.startedAt, inProgressSessionForLesson(lesson.id)!.durationSec, nowTick)) }}</span>
              </p>
            </div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ inProgressSessionForLesson(lesson.id) ? '继续考试' : '开始限时听写' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top">
              <strong>{{ attempt.lessonTitle }}</strong>
              <span class="history-score">{{ attempt.score }} 分</span>
            </div>
            <p>
              {{ formatDate(attempt.submittedAt) }} ·
              <span :class="attempt.sessionStatus === 'timed_out' ? 'tag-timed' : 'tag-submitted'">{{ attempt.sessionStatus === 'timed_out' ? '超时收卷' : '手动交卷' }}</span>
              <template v-if="attempt.sentenceAttempts.some((item) => !item.scored)"> · {{ attempt.sentenceAttempts.filter((item) => !item.scored).length }} 句待确认未计分</template>
              <template v-else> · {{ attempt.teacherFeedback || '暂无教师反馈' }}</template>
            </p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次限时听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeSession" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库（计时继续）" @click="leaveToLibrary">‹</button>
            <div><h2>{{ activeSession.lessonTitle }}</h2></div>
            <span class="timer-chip" :class="{ danger: remaining <= 60000 }" aria-label="剩余时间">⏱ {{ formatClock(remaining) }}</span>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count">
              <span>第 {{ currentIndex + 1 }} / {{ frozenSentences.length }} 句</span>
              <span>{{ answeredCount }} / {{ frozenSentences.length }} 句已填写</span>
            </div>
          </div>
          <div class="version-line">
            <span class="status-chip">题目版本 {{ activeSession.questionVersion.slice(0, 8) }}</span>
            <span v-if="versionStale" class="status-chip warning">课程已更新 · 已重新确认词位</span>
          </div>
        </header>

        <div v-if="versionStale" class="warn-banner">
          <template v-if="!activeLesson">本场课节已不在当前课程包中，全部句子进入待确认；仍可完成作答并交卷，但不计分。</template>
          <template v-else>
            本场题目已冻结；检测到课程句子更新，已按新版本重新确认词位。
            <template v-if="pendingFrozen.length">{{ pendingFrozen.length }} 句无法唯一匹配，在下方确认对应句子前不计分。</template>
            <template v-else>全部句子已唯一匹配，计分不受影响。</template>
          </template>
        </div>

        <section v-if="pendingFrozen.length" class="panel pending-panel">
          <div class="dictation-label"><strong>待确认词位（不计分）</strong><span>选择课程中对应的新句子</span></div>
          <div v-for="frozen in pendingFrozen" :key="frozen.sentenceId" class="feedback-card warning-card">
            <strong>原句：{{ frozen.text }}</strong>
            <select aria-label="确认对应的新句子" @change="onPendingTarget(frozen.sentenceId, $event)">
              <option value="">选择课程里对应的新句子…</option>
              <option v-for="candidate in targetsFor(frozen.sentenceId)" :key="candidate.id" :value="candidate.id">{{ candidate.text }}</option>
            </select>
          </div>
        </section>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentFrozen?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。切到后台时语音暂停，倒计时不会暂停。</p></div>
          </div>
        </section>

        <div class="dictation-label">
          <strong>输入听到的内容</strong>
          <span v-if="currentFrozen && mappingByFrozen.get(currentFrozen.sentenceId)?.status === 'pending'" class="tag-pending">待确认 · 不计分</span>
          <span v-else>答案在本机自动保存</span>
        </div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentFrozen?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" @click="submitLesson">交卷</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(frozen, index) in frozenSentences" :key="frozen.sentenceId" class="sentence-dot"
            :class="{
              active: frozen.sentenceId === currentFrozen?.sentenceId,
              done: !!(activeSession.answers[frozen.sentenceId] ?? '').trim(),
              pending: mappingByFrozen.get(frozen.sentenceId)?.status === 'pending'
            }"
            :aria-label="`跳到第 ${index + 1} 句`" @click="goToFrozen(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentFrozen" class="panel">
          <div class="detail-head">
            <div><h3>场景提示</h3><p>{{ currentFrozen.translation }}</p></div>
            <span v-if="mappingByFrozen.get(currentFrozen.sentenceId)?.status === 'pending'" class="status-chip warning">待确认</span>
          </div>
          <div class="feedback-card">{{ currentFrozen.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="leaveToLibrary">‹</button>
          <span class="status-chip" :class="{ warning: resultAttempt.sessionStatus === 'timed_out' }">{{ resultAttempt.sessionStatus === 'timed_out' ? '超时收卷' : '手动交卷' }} · {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 得分按 {{ resultScoredCount }} 句已匹配词位计算。</p>
          <p v-if="resultPendingCount" class="pending-note">另有 {{ resultPendingCount }} 句收卷时无法唯一匹配词位，未计入得分，可在下方查看。</p>
        </section>

        <section class="panel snapshot-panel">
          <div class="dictation-label"><strong>场次快照</strong><span>不受课程新版本影响</span></div>
          <dl class="snapshot-list">
            <div><dt>场次状态</dt><dd>{{ resultAttempt.sessionStatus === 'timed_out' ? '超时收卷（不可续写）' : '已交卷（不可续写）' }}</dd></div>
            <div><dt>开始时间</dt><dd>{{ formatDate(resultAttempt.startedAt) }}</dd></div>
            <div><dt>收卷时间</dt><dd>{{ formatDate(resultAttempt.submittedAt) }}</dd></div>
            <div><dt>限时时长</dt><dd>{{ formatDuration(resultAttempt.durationSec) }}</dd></div>
            <div><dt>原始题目版本</dt><dd><code>{{ resultAttempt.questionVersion.slice(0, 12) || '历史记录' }}</code></dd></div>
            <div><dt>词位匹配</dt><dd>{{ resultScoredCount }} 句计分 · {{ resultPendingCount }} 句待确认</dd></div>
          </dl>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot"
            :class="{ active: index === selectedResultSentence, pending: !attempt.scored }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score" :class="{ 'score-muted': !resultSentence.scored }">{{ resultSentence.scored ? `${resultSentence.score}%` : '不计分' }}</span>
          </div>
          <div v-if="!resultSentence.scored" class="warn-banner tight">本句收卷时无法唯一匹配课程新词位，按待确认处理，未计入整课得分。</div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="resultLesson && startLesson(resultLesson)">用同一课节再开一场</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="leaveToLibrary">返回课程库</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="leaveToLibrary">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>设置限时、查看作答并写入反馈</p></div></div>
        </header>

        <section class="panel">
          <div class="dictation-label"><strong>课节限时设置</strong><span>对新开场次生效</span></div>
          <div v-for="{ courseTitle, lesson } in allLessons" :key="lesson.id" class="duration-row">
            <div><strong>{{ lesson.title }}</strong><p>{{ courseTitle }} · 默认按预计 {{ lesson.estimatedMinutes }} 分钟</p></div>
            <select aria-label="课节限时" :value="state.lessonExamSettings[lesson.id] ?? -1" @change="onDurationChange(lesson.id, $event)">
              <option :value="-1">按预计时长（{{ lesson.estimatedMinutes }} 分钟）</option>
              <option v-for="minutes in durationOptions" :key="minutes" :value="minutes * 60">{{ minutes }} 分钟</option>
            </select>
          </div>
        </section>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${attempt.sessionStatus === 'timed_out' ? '超时收卷' : '手动交卷'} · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card">
              <strong>{{ teacherAttempt.courseTitle }}</strong>
              <p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，{{ teacherAttempt.sentenceAttempts.filter((item) => item.scored).length }} 句计分，{{ teacherAttempt.sentenceAttempts.filter((item) => !item.scored).length }} 句待确认。</p>
            </div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
