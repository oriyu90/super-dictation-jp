/* ホーム画面: スコア・レベル選択・履歴 */
"use strict";

(function () {
  const DMA_ARROW = "→";
  const STAMP_KINDS = [
    { min: 0.8, cls: "is-good", ch: "◎" },
    { min: 0.6, cls: "is-ok", ch: "◯" },
    { min: 0.4, cls: "is-warn", ch: "△" },
    { min: -1, cls: "is-bad", ch: "✕" },
  ];

  function stampFor(ratio) {
    for (const k of STAMP_KINDS) {
      if (ratio >= k.min) return k;
    }
    return STAMP_KINDS[3];
  }

  function jpDate(dstr) {
    const [y, m, d] = dstr.split("-").map(Number);
    const w = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
    return `${m}月${d}日(${w})`;
  }

  /* レベルの一覧を組み立て */
  function levelMeta() {
    const info = [
      { level: "簡単", desc: "計算なし。3文をきいて、すぐこたえる。" },
      { level: "標準", desc: "ことばの聞き取りが本番。たし算も少しある。" },
      { level: "応用", desc: "数字や人の関係が、もういちおし。" },
      { level: "難関", desc: "かけ算・わり算が登場。追加の情報にも注意。" },
      { level: "最難関", desc: "電車の遅れ・日またぎなど、むずかしい内容。" },
    ];
    const counts = new Map();
    for (const q of (window.QUESTIONS || []).questions) {
      counts.set(q.level, (counts.get(q.level) || 0) + 1);
    }
    return info.map((x) => ({ ...x, count: counts.get(x.level) || 0 }));
  }

  async function renderToday() {
    const dateEl = document.getElementById("todayDate");
    dateEl.textContent = jpDate(sdjToday());
    const results = await sdjSessionResults();
    const todayKey = sdjToday();
    const today = results.filter((r) => r.date === todayKey);
    const stampMon = document.getElementById("todayStamp");
    const scoreEl = document.getElementById("todayScore");
    const pastEl = document.getElementById("pastScore");
    const hintEl = document.getElementById("todayHint");

    if (!today.length) {
      stampMon.innerHTML = `<span class="stamp is-void">・</span>`;
      stampMon.classList.remove("is-settled");
      scoreEl.textContent = "—";
      hintEl.textContent = "きょうはまだ 0セット。レベルをえらんで「始める」を押そう。";
      hintEl.hidden = false;
    } else {
      const avg = sdjAvgRatio(today);
      const sumScore = today.reduce((s, r) => s + r.score, 0);
      const k = stampFor(avg);
      stampMon.innerHTML = `<span class="stamp ${k.cls}">${k.ch}</span>`;
      stampMon.classList.add("is-settled");
      scoreEl.textContent = `${Math.round(avg * 100)}%`;
      const n = today.length;
      hintEl.textContent = n === 1
        ? `きょうは 1セット 実施。合計 ${sumScore} 点。`
        : `きょうは ${n}セット 実施。合計 ${sumScore} 点。`;
      hintEl.hidden = false;
    }
    const past = results.filter((r) => r.date && r.date < todayKey);
    const pastAvg = sdjAvgRatio(past);
    pastEl.textContent = pastAvg === null ? "—" : `${Math.round(pastAvg * 100)}%`;
  }

  async function renderHistory() {
    const results = await sdjSessionResults();
    const ul = document.getElementById("historyDays");
    const days = [];
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
      const daySessions = results.filter((r) => r.date === key);
      days.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        w,
        avg: sdjAvgRatio(daySessions),
        score: daySessions.reduce((s, r) => s + r.score, 0),
      });
    }
    ul.innerHTML = "";
    for (const day of days) {
      const li = document.createElement("li");
      li.className = "history-day" + (day.avg === null ? " is-empty" : "");
      let inner = `<span class="history-day-date">${day.label}<small>(${day.w})</small></span>`;
      if (day.avg !== null) {
        const k = stampFor(day.avg);
        inner += `<span class="history-day-stamp"><span class="stamp ${k.cls}">${k.ch}</span></span>
          <span class="history-day-score">${Math.round(day.avg * 100)}%</span>
          <span class="history-day-sub">${day.score}点</span>`;
      } else {
        inner += `<span class="history-day-stamp"><span class="stamp is-void">・</span></span>
          <span class="history-day-score">—</span>`;
      }
      li.innerHTML = inner;
      ul.appendChild(li);
    }
  }

  function renderLevels() {
    const ul = document.getElementById("levelList");
    const list = levelMeta();
    window.__picked_level = null;
    ul.innerHTML = "";
    list.forEach((lv) => {
      const li = document.createElement("li");
      li.className = "level-item";
      li.innerHTML = `
        <button class="level-btn" type="button" aria-pressed="false" data-level="${lv.level}">
          <span class="level-name">${lv.level}</span>
          <span class="level-count">${lv.count}問</span>
        </button>`;
      ul.appendChild(li);
    });
    const startBtn = document.getElementById("startBtn");
    ul.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".level-btn");
      if (!btn) return;
      window.__picked_level = btn.dataset.level;
      for (const b of ul.querySelectorAll(".level-btn")) {
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      }
      startBtn.disabled = false;
    });
    startBtn.addEventListener("click", startSession);
  }

  /* セッション生成 → 1問ページへ */
  /* ランダム選択: 出題回数の少ない問題を優先(0度→1度→2度…の順で減っていく) */
  async function pickQuestions(pool, n = 5) {
    const counts = await sdjPlayCounts();
    const tiers = new Map();
    for (const q of pool) {
      const c = counts.get(q.id) || 0;
      if (!tiers.has(c)) tiers.set(c, []);
      tiers.get(c).push(q);
    }
    const sorted = [...tiers.keys()].sort((a, b) => a - b);
    const picked = [];
    for (const c of sorted) {
      const batch = shuffle(tiers.get(c));
      while (batch.length && picked.length < n) picked.push(batch.pop());
      if (picked.length >= n) break;
    }
    return picked;
  }

  async function startSession() {
    const level = window.__picked_level;
    if (!level) return;
    const pool = (window.QUESTIONS || []).questions.filter((q) => q.level === level);
    const picked = await pickQuestions(pool, 5);
    const total = picked.reduce((s, q) => s + sdjCountItems(q), 0);
    const session = await sdjCreateSession(level, picked.map((q) => q.id), total);
    location.href = `quiz.html?sid=${session.sid}&i=0`;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* 音声つきデモ(標準レベルを5問。うまくいくぶんは採点に数えない) */
  async function startDemo() {
    const ids = ["2-01-1", "2-01-2", "2-01-3", "2-01-4", "2-01-5"];
    const byId = new Map((window.QUESTIONS || []).questions.map((q) => [q.id, q]));
    const picked = ids.map((id) => byId.get(id)).filter(Boolean).slice(0, 5);
    const total = picked.reduce((s, q) => s + sdjCountItems(q), 0);
    const session = await sdjCreateSession("デモ", picked.map((q) => q.id), total);
    location.href = `quiz.html?sid=${session.sid}&i=0&demo=1`;
  }

  document.getElementById("demoBtn").addEventListener("click", startDemo);

  /* 起動: 途中でやめたセットの記録を消してから描画 */
  async function boot() {
    await sdjPurgeUnfinishedSessions(); // 中断セットはなかったことに
    renderToday();
    renderHistory();
    renderLevels();
  }
  boot();
})();
