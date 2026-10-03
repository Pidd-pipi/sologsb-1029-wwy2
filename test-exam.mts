// 逻辑自测：限时听写场次的冻结、倒计时收卷、词位重新确认、快照与导出。
// 运行：esbuild 打包后用 node 执行（见 package 脚本外的手动命令）。
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }
};

async function main() {
  const {
    state, lessonById, startExamSession, saveExamAnswer, setExamActiveSentence,
    reconcileActiveExamSessions, finalizeExamSession, sweepExpiredExamSessions,
    updateLessonSentences, exportRecords, activeExamForLesson
  } = await import('./src/store');
  const { sentenceSetVersion, deepClone } = await import('./src/utils');

  let failures = 0;
  const check = (name: string, cond: boolean) => {
    if (!cond) failures += 1;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  };

  const lesson = lessonById('airport-01')!;
  const originalSentences = deepClone(lesson.sentences);

  // 1. 开始后冻结题目版本 + 真实时间截止点
  const t0 = Date.now();
  const session = startExamSession(lesson, 10);
  check('冻结题目快照与课程一致', JSON.stringify(session.frozenSentences) === JSON.stringify(lesson.sentences));
  check('记录题目版本号', session.questionVersion === sentenceSetVersion(lesson.sentences));
  const deadline = new Date(session.deadlineAt).getTime();
  check('截止点=开始+时长（真实时间）', deadline >= t0 + 10 * 60_000 && deadline <= Date.now() + 10 * 60_000);
  check('同课节重复开始返回同一场次', startExamSession(lesson, 20).id === session.id);

  // 2. 答题与当前句保存（刷新/断网可恢复）
  saveExamAnswer(session.id, 'airport-01-s1', 'I would like to check in for my flight to London.');
  saveExamAnswer(session.id, 'airport-01-s2', 'Could I have a window seat, please?');
  saveExamAnswer(session.id, 'airport-01-s3', 'How many bags are you checking in today?');
  saveExamAnswer(session.id, 'airport-01-s4', 'Your gate is B twelve and boarding starts at six thirty.');
  setExamActiveSentence(session.id, 'airport-01-s3');
  check('答案写入场次', Object.keys(session.answers).length === 4);
  check('当前句写入场次', session.activeSentenceId === 'airport-01-s3');
  await new Promise((resolve) => setTimeout(resolve, 0)); // 等 Vue watch 异步落盘
  check('状态已持久化到 localStorage', (store.get('sologsb-1029-dictation-state-v1') ?? '').includes(session.id));

  // 3. 课程句子变化 → 未收卷场次重新确认词位
  const updated = deepClone(originalSentences);
  updated[1] = { ...updated[1], text: 'Could I have a window seat near the front, please?' }; // 同 id 改原文 → 待确认
  updated.splice(2, 1); // 删除 s3 → 待确认
  updated[2] = { ...updated[2], id: 'airport-01-s4-renamed' }; // s4 改 id 但原文不变 → 唯一匹配保留
  updated.push({ id: 'airport-01-s5', text: 'The flight is boarding now.', translation: '航班正在登机。', note: '' });
  const changed = updateLessonSentences('airport-01', updated);
  check('重新确认词位返回变化场次数', changed === 1);
  check('未变句子答案保留', session.answers['airport-01-s1']?.includes('check in'));
  check('改 id 但原文唯一匹配 → 答案随迁', session.answers['airport-01-s4-renamed']?.includes('B twelve'));
  check('无法唯一匹配的列入待确认', session.pendingAnswers.length === 2);
  check('待确认答案不计入 answers', !session.answers['airport-01-s2'] && !session.answers['airport-01-s3']);
  check('场次题目版本跟进新课程', session.questionVersion === sentenceSetVersion(lesson.sentences));
  check('新增句子进入场次题目', session.frozenSentences.some((s) => s.id === 'airport-01-s5'));
  check('当前句失效后回退到首句', session.activeSentenceId === session.frozenSentences[0].id);

  // 4. 重复 reconcile 不产生重复待确认
  reconcileActiveExamSessions();
  check('版本一致时不重复确认', session.pendingAnswers.length === 2);

  // 5. 歧义匹配：原句 id 消失且新课程出现两个相同原文 → 无法唯一匹配
  const dupLesson = deepClone(lesson.sentences).filter((s: any) => s.id !== 'airport-01-s1');
  dupLesson.push({ id: 'airport-01-s1a', text: 'I would like to check in for my flight to London.', translation: '重复句 A', note: '' });
  dupLesson.push({ id: 'airport-01-s1b', text: 'I would like to check in for my flight to London.', translation: '重复句 B', note: '' });
  updateLessonSentences('airport-01', dupLesson);
  check('重复句子导致 s1 答案列入待确认', session.pendingAnswers.some((p) => p.sentenceId === 'airport-01-s1'));
  check('歧义答案不占任何新词位', !session.answers['airport-01-s1'] && !session.answers['airport-01-s1a'] && !session.answers['airport-01-s1b']);

  // 6. 超时立即收卷（真实经过时间），之后不能续写
  const expired = sweepExpiredExamSessions(new Date(session.deadlineAt).getTime() + 1000);
  check('超时场次被收卷', expired.some((s) => s.id === session.id));
  check('收卷后状态为 expired', session.status === 'expired');
  check('收卷生成结果快照', !!session.attemptId);
  saveExamAnswer(session.id, 'airport-01-s1', 'should not be saved');
  check('收卷后不能续写', session.answers['airport-01-s1'] !== 'should not be saved');
  check('收卷后不再出现在进行中列表', !activeExamForLesson('airport-01'));

  const attempt = state.attempts.find((a) => a.id === session.attemptId)!;
  check('结果按冻结题目评分', attempt.sentenceAttempts.every((sa) => session.frozenSentences.some((s) => s.id === sa.sentenceId)));
  const s2Result = attempt.sentenceAttempts.find((sa) => sa.sentenceId === 'airport-01-s2')!;
  check('待确认答案不计分（对应题按未作答处理）', s2Result.answer === '' && s2Result.score === 0);
  check('待确认答案保留在场次记录中', session.pendingAnswers.some((p) => p.answer === 'Could I have a window seat, please?'));

  // 7. 已收卷结果保存快照，不受新版本影响
  const snapshotBefore = JSON.stringify(attempt.sentenceAttempts);
  const versionBefore = session.questionVersion;
  updateLessonSentences('airport-01', [{ id: 'airport-01-s1', text: 'Completely different sentence.', translation: '全新', note: '' }]);
  check('已收卷场次题目版本不变', session.questionVersion === versionBefore);
  check('已收卷结果快照不变', JSON.stringify(attempt.sentenceAttempts) === snapshotBefore);

  // 8. 手动交卷流程（新场次）
  const session2 = startExamSession(lesson, 5);
  saveExamAnswer(session2.id, 'airport-01-s1', 'Completely different sentence.');
  const attempt2 = finalizeExamSession(session2, 'submitted')!;
  check('手动交卷状态为 submitted', session2.status === 'submitted');
  check('手动交卷得满分', attempt2.score === 100);
  check('重复收卷幂等', finalizeExamSession(session2, 'expired')!.id === attempt2.id && session2.status === 'submitted');

  // 9. 导出带场次状态和原始题目版本
  const exported = JSON.parse(exportRecords());
  const exportedSession = exported.examSessions.find((s: any) => s.id === session.id);
  check('导出包含场次状态', exportedSession.status === 'expired');
  check('导出包含原始题目版本', exportedSession.questionVersion === versionBefore && exportedSession.frozenSentences.length > 0);
  check('导出包含待确认答案', exportedSession.pendingAnswers.length >= 2);

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main();
