/* super-dictation-jp — IndexedDB 学習記録 */
"use strict";

const SDJ_DB_NAME = "super-dictation-jp";
const SDJ_DB_VERSION = 1;

function sdjOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SDJ_DB_NAME, SDJ_DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "sid" });
        s.createIndex("by-date", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains("answers")) {
        const a = db.createObjectStore("answers", { keyPath: "id", autoIncrement: true });
        a.createIndex("by-date", "date", { unique: false });
        a.createIndex("by-sid", "sid", { unique: false });
        a.createIndex("by-qid", "qid", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function sdjTx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    const out = fn(st);
    tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => reject(tx.error);
  });
}

async function sdjPut(store, value) {
  const db = await sdjOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function sdjGet(store, key) {
  const db = await sdjOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function sdjGetAll(store, index) {
  const db = await sdjOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const st = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
    const req = st.getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/* 学習データ操作 ---------- */

/* チューニング用デモ(音声つき体験)のセッションは記録に入れない */
function sdjIsDemoSession(s) {
  return s && s.level === "デモ";
}

/* 問題1件の得点クイズ数(中のクイズ数: 全部=2)。採点は「正解したクイズの数」 */
function sdjCountItems(entry) {
  return entry.qs.length;
}

/* セッション作成: {sid, date, level, qids, total, created}
   total = 5問ぶんのクイズ数合計(sdjCountItems の和・記録用) */
async function sdjCreateSession(level, qids, total = 0) {
  const sid = Date.now();
  const session = { sid, date: sdjToday(), level, qids, total, created: sid };
  await sdjPut("sessions", session);
  return session;
}

/* 回答1件を記録: {sid, date, ts, level, qid, qn, correct, chosen} */
async function sdjSaveAnswer(rec) {
  return sdjPut("answers", rec);
}

/* sid の回答全件 */
async function sdjAnswersOf(sid) {
  const all = await sdjGetAll("answers", "by-sid");
  return all.filter((r) => r.sid === sid);
}

/* 日付ユーティリティ */
function sdjToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* 日別スコア: {date: {sum, n}} の累計(ソート済み配列) */
function sdjGroupByDate(records) {
  const map = new Map();
  for (const r of records) {
    if (!r || typeof r.correct !== "boolean") continue;
    const g = map.get(r.date) || { sum: 0, n: 0 };
    g.sum += r.correct ? 1 : 0;
    g.n += 1;
    map.set(r.date, g);
  }
  return map;
}

/* 未完セッション(全問題に回答記録がないもの)を削除: セッション+その回答。
   ホームに戻る = 途中までの記録はなかったことになる。削除数を返す */
async function sdjPurgeUnfinishedSessions() {
  const sessions = await sdjGetAll("sessions");
  const answers = await sdjGetAll("answers");
  const answersBySid = new Map();
  for (const a of answers) {
    if (!answersBySid.has(a.sid)) answersBySid.set(a.sid, new Map());
    const m = answersBySid.get(a.sid);
    if (!m.has(a.qid)) m.set(a.qid, []);
    m.get(a.qid).push(a);
  }
  const deadSid = new Set();
  for (const s of sessions) {
    if (sdjIsDemoSession(s)) continue;   // デモは記録対象外なので消さない
    const qids = Array.isArray(s.qids) ? s.qids : [];
    const m = answersBySid.get(s.sid) || new Map();
    const complete = qids.length && qids.every((qid) => (m.get(qid) || []).length);
    if (!complete) deadSid.add(s.sid);
  }
  if (!deadSid.size) return 0;
  const db = await sdjOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "answers"], "readwrite");
    for (const s of sessions) {
      if (deadSid.has(s.sid)) tx.objectStore("sessions").delete(s.sid);
    }
    for (const a of answers) {
      if (deadSid.has(a.sid)) tx.objectStore("answers").delete(a.id);
    }
    tx.oncomplete = () => { db.close(); resolve(deadSid.size); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/* 出題回数(完了セッションのみ): Map qid -> 終了したセッションの回数 */
async function sdjPlayCounts() {
  const sessions = await sdjGetAll("sessions");
  const answers = await sdjGetAll("answers");
  const answersBySid = new Map();
  for (const a of answers) {
    if (!answersBySid.has(a.sid)) answersBySid.set(a.sid, new Map());
    const m = answersBySid.get(a.sid);
    if (!m.has(a.qid)) m.set(a.qid, []);
    m.get(a.qid).push(a);
  }
  const counts = new Map();
  for (const s of sessions) {
    if (sdjIsDemoSession(s)) continue;   // デモは出題回数に入れない
    const qids = Array.isArray(s.qids) ? s.qids : [];
    const m = answersBySid.get(s.sid) || new Map();
    const complete = qids.length && qids.every((qid) => (m.get(qid) || []).length);
    if (!complete) continue;   // 未完(消された)セットは回数に入れない
    for (const qid of qids) counts.set(qid, (counts.get(qid) || 0) + 1);
  }
  return counts;
}

/* セッション単位の成績。
   クイズ(Q1/Q2)1つ正解 = 1 点(5問セッションは 10 点満点)。
   {sid, date, level, qids, total, score, entryCount, ratio} の配列を返す。 */
async function sdjSessionResults() {
  const sessions = await sdjGetAll("sessions");
  const answers = await sdjGetAll("answers");
  const bySid = new Map();
  for (const a of answers) {
    if (typeof a.correct !== "boolean") continue;
    if (!bySid.has(a.sid)) bySid.set(a.sid, new Map());
    const m = bySid.get(a.sid);
    if (!m.has(a.qid)) m.set(a.qid, []);
    m.get(a.qid).push(a);
  }
  return sessions
    .filter((s) => !sdjIsDemoSession(s))   // デモはきょうの成績に入れない
    .map((s) => {
    const m = bySid.get(s.sid) || new Map();
    const qids = Array.isArray(s.qids) ? s.qids : [];
    let score = 0;
    let n = 0;
    for (const qid of qids) {
      for (const r of m.get(qid) || []) {
        n += 1;
        if (r.correct) score += 1;
      }
    }
    if (!n) n = qids.length;
    return {
      ...s,
      score,
      entryCount: n,
      ratio: n ? score / n : 0,
    };
  });
}

/* 複数セッションの平均正答率(%)。空なら null */
function sdjAvgRatio(results) {
  if (!results.length) return null;
  return results.reduce((s, r) => s + r.ratio, 0) / results.length;
}

/* きょうの平均(%) と 昨日までの平均をまとめて取る(参考用・項目単位) */
async function sdjStats() {
  const answers = await sdjGetAll("answers");
  const byDate = sdjGroupByDate(answers);
  const todayKey = sdjToday();
  const today = byDate.get(todayKey) || { sum: 0, n: 0 };
  let pastSum = 0, pastN = 0;
  for (const [date, g] of byDate) {
    if (date !== todayKey) { pastSum += g.sum; pastN += g.n; }
  }
  return {
    todayCount: today.n,
    todayRatio: today.n ? today.sum / today.n : null,
    pastRatio: pastN ? pastSum / pastN : null,
    byDate,
  };
}
