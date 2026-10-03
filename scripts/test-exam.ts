// 场景验证脚本（不作为应用产物）
const store: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; }
};

import { lessonById, resetDemo, state } from '../src/store';
import { autoSubmitIfExpired, bindPending, finalizeSession, restoreSession, startSession } from '../src/exam';
import { questionVersionOf, remainingMs } from '../src/utils';

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures += 1; }
};

// ---------- 场景 1：开始冻结版本，课程更新后重新确认词位 ----------
console.log('场景 1：开始冻结 + 课程更新后重新确认词位');
resetDemo();
const lesson = lessonById('airport-01')!;
const originalVersion = questionVersionOf(lesson.sentences);
const session = startSession(lesson);
assert(session.questionVersion === originalVersion, '场次冻结原始题目版本');
assert(remainingMs(session.startedAt, session.durationSec) > 0, '剩余时间按真实经过时间计算');

// 学生输入答案（模拟断网/后台期间作答）
const frozenIds = session.frozenSentences.map((f) => f.sentenceId);
runScenarios(session, frozenIds).catch((err) => { console.error(err); process.exit(1); });

async function runScenarios(session: any, frozenIds: string[]) {
  const { setSessionAnswer } = await import('../src/exam');
  setSessionAnswer(session, frozenIds[0], 'I would like to check in for my flight to London');
  setSessionAnswer(session, frozenIds[1], 'Could I have a window seat please');
  setSessionAnswer(session, frozenIds[2], 'How many bags are you checking in today');
  setSessionAnswer(session, frozenIds[3], 'Your gate is B twelve and boarding starts at six thirty');

  // 课程更新：s1 文本微调（同 id）；s2 改 id 但文本不变（可按文本唯一匹配）；
  // s3 删除（无法匹配 → 待确认）；s4 文本被复制成两条相同内容（歧义 → 待确认）
  lesson.sentences = [
    { id: 'airport-01-s1', text: 'I would like to check in for my flight to London now.', translation: '', note: '' },
    { id: 'airport-01-s2-renamed', text: 'Could I have a window seat, please?', translation: '', note: '' },
    { id: 'airport-01-s4a', text: 'Your gate is B twelve and boarding starts at six thirty.', translation: '', note: '' },
    { id: 'airport-01-s4b', text: 'Your gate is B twelve and boarding starts at six thirty.', translation: '', note: '' }
  ];

  const restored = restoreSession(session);
  const statusOf = (id: string) => restored.mappings.find((m) => m.frozenId === id)!;
  assert(statusOf(frozenIds[0]).status === 'matched', '同 id 句子唯一匹配（即使文本已改，仍定位）');
  assert(statusOf(frozenIds[1]).status === 'matched' && statusOf(frozenIds[1]).currentSentenceId === 'airport-01-s2-renamed', 'id 变更但文本唯一 → 自动重新确认词位');
  assert(statusOf(frozenIds[2]).status === 'pending', '删除且无同文本句子 → 待确认，不计分');
  assert(statusOf(frozenIds[3]).status === 'pending', '同文本出现两次（无法唯一匹配）→ 待确认');

  // 人工确认 s3 无法绑定：候选里没有它的词位；s3 不在候选中
  const targets = lesson.sentences.filter((s) => !restored.mappings.some(
    (m) => m.status === 'matched' && m.currentSentenceId === s.id && m.frozenId !== frozenIds[2]
  )).map((s) => s.id);
  assert(!targets.includes('airport-01-s1') && !targets.includes('airport-01-s2-renamed'), '已占用词位不出现在待确认候选中');

  // s4 人工绑定到 s4a
  const bound = bindPending(restored, frozenIds[3], 'airport-01-s4a');
  assert(bound.mappings.find((m) => m.frozenId === frozenIds[3])!.status === 'matched', '人工唯一确认后恢复计分');

  // 再开一场新版本应与旧冻结不同
  assert(questionVersionOf(lesson.sentences) !== session.questionVersion, '课程版本变化可检测');

  // ---------- 场景 2：手动收卷，待确认句不计分，结果为快照 ----------
  console.log('场景 2：收卷快照与计分');
  const { attempt, session: finalized } = finalizeSession(bound, 'submitted');
  assert(finalized.status === 'submitted', '场次状态变为已交卷');
  const byId = (id: string) => attempt.sentenceAttempts.find((a) => a.sentenceId === id)!;
  assert(byId(frozenIds[0]).scored && byId(frozenIds[1]).scored && byId(frozenIds[3]).scored, '匹配句参与计分');
  assert(!byId(frozenIds[2]).scored && byId(frozenIds[2]).tokens.length > 0, '待确认句保留逐词内容但不计分');
  const scored = attempt.sentenceAttempts.filter((a) => a.scored);
  const expectedScore = Math.round(
    scored.flatMap((a) => a.tokens).filter((t) => t.correct).length /
    scored.flatMap((a) => a.tokens).length * 100
  );
  assert(attempt.score === expectedScore, `总分只算匹配句（${attempt.score} === ${expectedScore}）`);
  assert(attempt.questionVersion === session.questionVersion, '结果携带原始题目版本快照');
  assert(attempt.frozenSentences.length === 4, '结果保存原始题目快照');
  assert(attempt.sessionStatus === 'submitted', '导出可见场次状态');

  // 收卷后课程再变，结果不受影响；且不能续写
  lesson.sentences[0].text = '完全不同的新句子。';
  assert(attempt.frozenSentences[0].text.includes('London'), '已收卷快照不受新版本影响');
  const setAgain = setSessionAnswer;
  const answersBefore = finalized.answers[frozenIds[0]];
  setAgain(finalized, frozenIds[0], '续写应被拒绝');
  assert(finalized.answers[frozenIds[0]] === answersBefore, '收卷后不能续写答案');

  // ---------- 场景 3：超时立即收卷（刷新/断网恢复路径） ----------
  console.log('场景 3：超时自动收卷');
  resetDemo();
  const lesson2 = lessonById('airport-02')!;
  const session2 = startSession(lesson2);
  // 模拟刷新/后台很久后重开：把开始时刻回拨到超时之前
  session2.startedAt = new Date(Date.now() - (session2.durationSec + 30) * 1000).toISOString();
  const checked = autoSubmitIfExpired(session2);
  assert(checked.session.status === 'timed_out' && !!checked.attempt, '恢复同一场次时超时立即收卷');
  assert(checked.attempt!.sessionStatus === 'timed_out', '结果标记为超时收卷');
  assert(remainingMs(checked.session.startedAt, checked.session.durationSec) === 0, '剩余时间归零');
  const recheck = autoSubmitIfExpired(checked.session);
  assert(!recheck.attempt, '超时收卷幂等，不重复生成结果');

  // 断网恢复"同一场次"：activeSessionId 持久化后可取回（watch 在下一 tick 落盘）
  await new Promise((resolve) => setTimeout(resolve, 0));
  const persisted = JSON.parse(store['sologsb-1029-dictation-state-v1']);
  assert(Array.isArray(persisted.sessions) && persisted.sessions.some((s: any) => s.id === session2.id), '场次已持久化，可离线恢复同一场');
  assert(persisted.attempts.some((a: any) => a.sessionId === session2.id && a.questionVersion), '导出数据带场次状态与题目版本');

  // ---------- 场景 4：课节在课程包中被移除 ----------
  console.log('场景 4：课节被移除');
  resetDemo();
  const lesson3 = lessonById('meeting-01')!;
  const session3 = startSession(lesson3);
  setSessionAnswer(session3, session3.frozenSentences[0].sentenceId, 'some answer');
  // 课程包更新后整个课程消失
  state.courses = state.courses.filter((c) => c.id !== 'workplace');
  const restored3 = restoreSession(session3);
  assert(restored3.mappings.every((m) => m.status === 'pending'), '课节移除后全部句子进入待确认');
  const { attempt: attempt3 } = finalizeSession(restored3, 'submitted');
  assert(attempt3.score === 0 && attempt3.sentenceAttempts.length === 3, '全部不计分但作答快照完整保留');

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}
