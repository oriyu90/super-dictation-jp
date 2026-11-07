/* 1問ページ: 音声 → 問題 → 答え合わせ(採点印) → 要約+聞き直し → 次へ */
"use strict";

(function () {
  const QDB = window.QUESTIONS || { questions: [] };
  const byId = new Map(QDB.questions.map((q) => [q.id, q]));
  const params = new URLSearchParams(location.search);
  const sid = Number(params.get("sid"));
  const DEMO_IDS = ["2-01-1", "2-01-2", "2-01-3", "2-01-4", "2-01-5"];   // 標準レベル・音声つき5問

  const STAMP_KINDS = [
    { min: 0.8, cls: "is-good", ch: "◎" },
    { min: 0.6, cls: "is-ok", ch: "◯" },
    { min: 0.4, cls: "is-warn", ch: "△" },
    { min: -1, cls: "is-bad", ch: "✕" },
  ];

  function stampFor(ratio) {
    return STAMP_KINDS.find((k) => ratio >= k.min) || STAMP_KINDS[3];
  }

  /* ===== 状態 ===== */
  const S = {
    session: null,
    entry: null,
    qs: [],
    i: 0,
    choice: new Map(),     // qn -> 値 (文字の答え: masu / write)
    blanks: new Map(),     // qn -> {けたindex: 数字} (数字の答え four / digits / embed)
    graded: false,
    audio: null,
    playBtn: null,
    replayGranted: false,   // 答え合わせあと: 聞き直しは自由
  };

  const main = document.getElementById("main");

  /* 体験デモ(音声つき)モード: 記録は残らない */
  function demoMode() {
    return (S.session && S.session.level === "デモ") || params.get("demo") === "1";
  }

  /* ===== 起動 ===== */

  async function init() {
    let noSession = false;
    let qid = params.get("q");           // 単体閲覧モード
    if (!sid || Number.isNaN(sid)) noSession = true;

    if (!noSession && !qid) {
      S.session = await sdjGet("sessions", sid);
      if (!S.session) noSession = true;
    }

    if (noSession && !qid) {
      renderNoSession();
      return;
    }

    if (qid) {
      if (DEMO_IDS.includes(qid) && params.get("demo") === "1") {
        // デモ: デモ問題の先頭から開始
        const idx = DEMO_IDS.indexOf(qid);
        S.queue = DEMO_IDS.slice(idx).map((id) => byId.get(id)).filter(Boolean);
      } else {
        S.queue = [byId.get(qid)].filter(Boolean);
        if (!S.queue.length) { renderNotFound(qid); return; }
      }
      S.i = 0;
      document.getElementById("progressNum").textContent = "体験デモ";
    } else {
      S.queue = S.session.qids.map((id) => byId.get(id)).filter(Boolean);
      S.i = Math.min(Number(params.get("i") || 0), S.queue.length - 1);
      document.getElementById("progressNum").textContent =
        `${S.i + 1}問め / 全${S.queue.length}問(${S.session.level})`;
      buildHud();
    }
    renderQuestion();
    wireHomeConfirm();
  }

  /* ===== ヘッダーの進捗バー(採点セル+いま何点) ===== */

  /* 各問題の採点印: クイズ全部正解=◎, 一部正解=△, 全部まちがえ=✕ */
  function buildHud() {
    const hud = document.getElementById("hud");
    const cells = document.getElementById("hudCells");
    if (!hud || !cells || !S.session) return;
    hud.hidden = false;
    cells.innerHTML = "";
    for (let k = 0; k < S.queue.length; k++) {
      const cell = document.createElement("span");
      cell.className = "hud-cell is-void";
      cell.textContent = "▢";
      cells.appendChild(cell);
    }
    updateHudScore();
    restoreHudMarks();
  }

  async function restoreHudMarks() {
    if (!S.session) return;
    const all = await sdjAnswersOf(sid);
    const sdate = S.session.date || sdjToday();
    const mine = all.filter((r) => (S.session.qids || []).includes(r.qid) && r.date === sdate);
    for (let k = 0; k < S.queue.length; k++) {
      const recs = mine.filter((r) => r.qid === S.session.qids[k]);
      if (recs.length) {
        const good = recs.filter((r) => r.correct).length;
        setHudCell(k, good, Math.max(S.queue[k].qs.length, good));
      }
    }
  }

  function setHudCell(idx, good, count) {
    const cell = document.querySelectorAll("#hudCells .hud-cell")[idx];
    if (!cell) return;
    cell.classList.remove("is-void", "is-good", "is-half", "is-bad");
    if (good > 0 && good >= count) {
      cell.classList.add("is-good");
      cell.textContent = "◎";
    } else if (good > 0) {
      cell.classList.add("is-half");
      cell.textContent = "△";
    } else {
      cell.classList.add("is-bad");
      cell.textContent = "✕";
    }
    cell.dataset.k = String(good);
    updateHudScore();
  }

  function updateHudScore() {
    const cells = [...document.querySelectorAll("#hudCells .hud-cell")];
    const n = cells.reduce((s, c) => s + Number(c.dataset.k || 0), 0);
    const el = document.getElementById("hudScore");
    if (el) el.textContent = String(n);
  }

  function renderNoSession() {
    main.innerHTML = `<p class="quiz-loading">セッションの記録が見つかりません。<a href="index.html">ホーム</a>から始めてください。</p>`;
  }

  function renderNotFound(qid) {
    main.innerHTML = `<p class="quiz-loading">問題 ${escapeHtml(String(qid))} が見つかりません。<a href="index.html">ホーム</a>にもどってください。</p>`;
  }

  /* ===== 音声プレイヤー ===== */

  const RATE_KEY = "sdj-rate";
  const RATES = [1, 1.25, 1.5];

  function savedRate() {
    const n = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(n) ? n : 1;
  }

  /* 速度ボタン(選択は localStorage に保存し、次のページでも引き継ぐ) */
  function renderRateGroup(audio) {
    const group = document.createElement("div");
    group.className = "rate-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "再生の速さ");
    const cur = savedRate();
    audio.playbackRate = cur;
    for (const r of RATES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rate-btn" + (r === cur ? " is-active" : "");
      b.textContent = r === 1 ? "1倍" : `${r}倍`;
      b.setAttribute("aria-pressed", r === cur ? "true" : "false");
      b.addEventListener("click", () => {
        audio.playbackRate = r;
        localStorage.setItem(RATE_KEY, String(r));
        for (const x of group.querySelectorAll(".rate-btn")) {
          const on = x === b;
          x.classList.toggle("is-active", on);
          x.setAttribute("aria-pressed", on ? "true" : "false");
        }
      });
      group.appendChild(b);
    }
    return group;
  }

  function renderBroadcast(entry) {
    const hasAudio = !!(entry && entry.audio);
    const wrap = document.createElement("section");
    wrap.className = "broadcast";
    wrap.innerHTML = `
      <div class="broadcast-box">
        <button class="play-btn" id="playBtn" type="button" aria-label="音声を再生して問題をひらく">
          <svg class="icon-play" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 3.5v13l12-6.5z"/></svg>
          <svg class="icon-stop" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="4.5" y="4.5" width="11" height="11" rx="1"/></svg>
        </button>
        <p class="broadcast-label">音声を聞こう</p>
      </div>
      <p class="broadcast-audio-fallback" id="broadcastFallback" hidden></p>
      <audio id="audioEl" preload="auto"></audio>`;

    const audio = wrap.querySelector("#audioEl");
    const fallback = wrap.querySelector("#broadcastFallback");
    S.audio = audio;

    if (!hasAudio) {
      wrap.querySelector(".play-btn").disabled = true;
      wrap.querySelector(".broadcast-label").textContent = "音声の声は準備中…";
      fallback.hidden = false;
      fallback.textContent = "(この問題は音声がまだありません)しばらくすると問題が出ます。";
      setTimeout(revealQuiz, 900);
    } else {
      audio.src = entry.audio;
      audio.playbackRate = savedRate();   // ページをまたいで速度を引き継ぐ
      const box = wrap.querySelector(".broadcast-box");
      box.appendChild(renderRateGroup(audio));
      const playBtn = wrap.querySelector("#playBtn");
      S.playBtn = playBtn;
      playBtn.addEventListener("click", togglePlay);
      // 読み込み失敗時のみフォールバック表示
      audio.addEventListener("error", () => {
        fallback.hidden = false;
        fallback.textContent = "(この問題は音声がまだありません)問題だけが出ます。";
        revealQuiz();
      });
      // 最後まで聴いたら問題をひらく。それ以降はもう再生できない(1回だけ)
      audio.addEventListener("ended", finishFirstListen);
    }
    return wrap;
  }

  // スペースキーで再生/停止(入力中は除く)
  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") return;
    if (ev.target.closest("input, textarea")) return;
    const audio = S.audio;
    if (!audio || !audio.getAttribute("src")) return;
    ev.preventDefault();
    togglePlay();
  });

  function togglePlay() {
    const audio = S.audio;
    if (!audio || !audio.src) return;
    if (S.audioHeard && !S.replayGranted) return;   // 答え合わせまでは1回だけ: 最後まで聞いたら封じる
    if (!audio.paused) {
      audio.pause();
      S.playBtn && S.playBtn.classList.remove("is-playing");
      return;
    }
    audio.play().catch(() => {});
    S.playBtn && S.playBtn.classList.add("is-playing");
  }

  /* 音声を1回聴き終えたら再生を封じる(答え合わせあとは聞き直し自由) */
  function finishFirstListen() {
    if (S.replayGranted) {
      // 採点あとの聞き直しが終わったとき: 封じないで元に戻すだけ
      S.playBtn && S.playBtn.classList.remove("is-playing");
      return;
    }
    S.audioHeard = true;
    revealQuiz();
    if (S.playBtn) {
      S.playBtn.disabled = true;
      S.playBtn.setAttribute("aria-label", "答え合わせしたら、もう一度聴けます");
      S.playBtn.classList.remove("is-playing");
    }
  }

  /* 答え合わせ(正誤表示+文表示)がそろったら聞き直しを解禁 */
  function allowReplay() {
    if (!S.audio || !S.audio.getAttribute("src")) return;
    S.replayGranted = true;
    S.audioHeard = false;
    if (S.playBtn) {
      S.playBtn.disabled = false;
      S.playBtn.setAttribute("aria-label", "音声をもう一度聴く");
    }
  }

  /* ===== ます幕 ・不要幕 ===== */

  let quizRevealed = false;
  function quizOpenRevealed() { return quizRevealed; }

  /* 最後まで聴くまで、問題はぼかされて読めない */
  function revealQuiz() {
    if (quizRevealed) return;
    quizRevealed = true;
    const body = document.getElementById("quizBody");
    if (body) body.classList.remove("is-veiled");
  }

  /* ===== 問題の構築 ===== */

  function renderQuestion() {
    quizRevealed = false;
    S.choice.clear();
    S.blanks.clear();
    S.graded = false;
    S.audioHeard = false;

    const entry = S.queue[S.i];
    S.entry = entry;
    S.qs = entry.qs;

    main.innerHTML = "";
    main.appendChild(renderBroadcast(entry));

    const veilWrap = document.createElement("div");
    veilWrap.className = "quiz-veiled-wrap";

    const body = document.createElement("div");
    body.id = "quizBody";
    body.className = "quiz-body is-veiled";
    const head = document.createElement("div");
    head.className = "qid-line";
    head.innerHTML = `<span class="qid-ellipsis">もんだい</span><span class="qid-name">${escapeHtml(entry.level + entry.spec)} ${escapeHtml(entry.specName || "")}</span>`;
    body.appendChild(head);

    for (const q of entry.qs) body.appendChild(renderQ(q));

    // 答え合わせ+判定+ナビ
    const area = document.createElement("div");
    area.className = "answer-area";
    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "check-btn";
    checkBtn.id = "checkBtn";
    checkBtn.textContent = "答え合わせ";
    checkBtn.disabled = true;
    checkBtn.addEventListener("click", grade);
    area.appendChild(checkBtn);
    const verdictZone = document.createElement("div");
    verdictZone.className = "verdict-zone";
    area.appendChild(verdictZone);
    const nav = document.createElement("div");
    nav.className = "q-nav";
    area.appendChild(nav);
    body.appendChild(area);

    veilWrap.appendChild(body);
    main.appendChild(veilWrap);

    stateCheckBtn = checkBtn;
    stateVerdictZone = verdictZone;
    stateNav = nav;
  }

  let stateCheckBtn = null;
  let stateVerdictZone = null;
  let stateNav = null;

  function qTextEl(html) {
    const p = document.createElement("p");
    p.className = "q-text";
    p.innerHTML = html;
    return p;
  }

  /* ===== 中断確認(ホームに戻ると未完セットの記録は消える) ===== */

  function sessionSettled() {
    // 全部解き終わった(最後の問題を採点済み)なら確認なしで戻れる
    const last = S.i >= S.queue.length - 1;
    return last && S.graded;
  }

  function wireHomeConfirm() {
    if (!S.session || demoMode()) return;   // デモは記録されないので確認不要
    const link = document.getElementById("backLink") || document.querySelector('.site-head a[href*="index"]');
    if (!link) return;
    link.addEventListener("click", (ev) => {
      if (demoMode()) return;
      if (sessionSettled()) return;
      ev.preventDefault();
      openAbortConfirm();
    });
  }

  function openAbortConfirm() {
    closePop();
    const ov = document.createElement("div");
    ov.className = "confirm-overlay";
    ov.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true" aria-label="中断の確認">
        <p class="confirm-title">ここでやめますか。</p>
        <p class="confirm-note">このままホームにもどると、このセットの記録は消えてなくなります。</p>
        <div class="confirm-actions">
          <button class="confirm-keep" type="button">つづけて解く</button>
          <button class="confirm-quit" type="button">やめてもどる</button>
        </div>
      </div>`;
    const esc = (ev) => { if (ev.key === "Escape") close(); };
    const close = () => {
      ov.remove();
      document.removeEventListener("keydown", esc);
    };
    ov.querySelector(".confirm-keep").addEventListener("click", close);
    ov.querySelector(".confirm-quit").addEventListener("click", () => { location.href = "index.html"; });
    ov.addEventListener("click", (ev) => { if (ev.target === ov) close(); });
    document.addEventListener("keydown", esc);
    document.body.appendChild(ov);
    ov.querySelector(".confirm-keep").focus();
  }

  /* ===== 数字の答え(空ますごとに 0〜9 を選ぶ) ===== */

  const DIGIT_OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const DIGIT_UNITS = ["一の位", "十の位", "百の位", "千の位", "万の位"];   // 下のけたから

  /* こたえが数字だけの四択 → 空ます式にする */
  function qIsNumeric(q) {
    return q.type === "four" && /^[0-9]+$/.test(String(q.answer));
  }

  /* 問題文の「何〇」から数え語(円/個/人…)を取る。見つからなければ空 */
  function digitUnit(q) {
    const t = String(q.text);
    let m = t.match(/何(ダース|まい|きれ|年生|番目|年目|年前|日後|回目|年後|人分)/);
    if (m) return m[1];
    m = t.match(/何([個人本回枚日才月円段組粒こ冊年缶箱斤分時])/);
    return m ? m[1] : "";
  }

  function qCellLen(q) {
    return q.type === "digits" ? q.digits.length : String(q.answer).length;
  }

  /* 入力欄とは別の「まとまり表示」: 入れた数字が1つの数として見える行 */
  function digitPreviewEl(q) {
    const p = document.createElement("p");
    p.className = "digit-preview";
    p.dataset.qn = String(q.n);
    const { text, unit } = composeDigitText(q);
    p.innerHTML =
      `<span class="preview-label">こたえ</span>` +
      `<strong>${escapeHtml(text)}</strong>` +
      (unit ? `<span class="preview-unit">${escapeHtml(unit)}</span>` : "");
    return p;
  }

  function composeDigitText(q) {
    const len = qCellLen(q);
    const a = S.blanks.get(q.n) || {};
    let s = "";
    for (let i = 0; i < len; i++) s += (a[i] ?? "▢");
    return { text: s, unit: digitUnit(q) };
  }

  function updateDigitPreview(q) {
    const p = document.querySelector(`.digit-preview[data-qn="${q.n}"]`);
    if (!p) return;
    const { text, unit } = composeDigitText(q);
    p.innerHTML =
      `<span class="preview-label">こたえ</span>` +
      `<strong>${escapeHtml(text)}</strong>` +
      (unit ? `<span class="preview-unit">${escapeHtml(unit)}</span>` : "");
  }

  /* 文中の穴埋め: 回答文のプレビュー(選んだことばが入る) */
  function embedPreviewEl(q) {
    const p = document.createElement("p");
    p.className = "embed-preview";
    p.dataset.qn = String(q.n);
    updateEmbedPreview(q, p);
    return p;
  }

  function updateEmbedPreview(q, p) {
    p = p || document.querySelector(`.embed-preview[data-qn="${q.n}"]`);
    if (!p) return;
    const txt = q.answer_sentence || q.text;
    const a = S.blanks.get(q.n) || {};
    p.innerHTML = "";
    for (const part of txt.split(/(\[空欄\d\])/)) {
      const m = part.match(/^\[空欄(\d+)\]$/);
      if (m) {
        const idx = Number(m[1]);
        const val = a[idx];
        const span = document.createElement("span");
        span.className = "preview-blank" + (val ? " is-filled" : "");
        span.textContent = val || String(idx);   // 空のときは空欄番号を下線枠に
        p.appendChild(span);
      } else if (part) {
        p.appendChild(document.createTextNode(part));
      }
    }
  }

  /* 桁の空ますの列。cells = [{label}] (labelなしなら1ますだけ) */
  function buildDigitRow(q, cells) {
    const row = document.createElement("div");
    row.className = "masu-row";
    const showLabels = cells.length > 1;
    cells.forEach((_, gi) => {
      const cell = document.createElement("span");
      cell.className = "digit-cell";
      if (showLabels && cells[gi].label) {
        const label = document.createElement("span");
        label.className = "cell-label";
        label.textContent = cells[gi].label;
        cell.appendChild(label);
      }
      cell.appendChild(makeMasu(q, gi, DIGIT_OPTIONS));
      row.appendChild(cell);
    });
    return row;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* 記入式(ます)のボタンを1個作る(空のます) */
  function makeMasu(q, fillN, opts) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "masu is-empty";
    btn.textContent = "";
    btn.addEventListener("click", (ev) => {
      openPop(ev.currentTarget, opts, (val) => {
        btn.textContent = val;
        btn.classList.remove("is-empty");
        btn.classList.add("is-picked");
        const cur = S.blanks.get(q.n) || {};
        cur[fillN] = val;
        S.blanks.set(q.n, cur);
        updateDigitPreview(q);
        updateEmbedPreview(q);
        refreshCheck();
      });
    });
    return btn;
  }

  function renderQ(q) {
    const block = document.createElement("div");
    block.className = "q-block";
    block.dataset.qn = q.n;

    if (q.type === "four" || qIsNumeric(q)) {
      if (qIsNumeric(q)) {
        // 数字のこたえ: まとまり表示 → けたの数ぶんの空ます(2けた= 十の位・一の位)
        block.appendChild(qTextEl(escapeHtml(q.text)));
        const len = String(q.answer).length;
        block.appendChild(digitPreviewEl(q));
        block.appendChild(buildDigitRow(
          q,
          Array.from({ length: len }, (_, i) => ({
            label: DIGIT_UNITS[len - 1 - i] || "",
          }))
        ));
      } else {
        block.appendChild(qTextEl(escapeHtml(q.text)));
        const ul = document.createElement("ul");
        ul.className = "choice-list";
        for (const opt of q.options) {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.className = "choice-btn";
          b.textContent = opt;
          b.dataset.value = opt;
          b.addEventListener("click", () => {
            S.choice.set(q.n, opt);
            for (const x of block.querySelectorAll(".choice-btn")) {
              x.classList.toggle("is-picked", x.dataset.value === opt);
            }
            refreshCheck();
          });
          li.appendChild(b);
          ul.appendChild(li);
        }
        block.appendChild(ul);
      }

    } else if (q.type === "masu") {
      const head = qTextEl(`${escapeHtml(q.text)} <button class="masu is-empty" data-role="masu" aria-label="こたえのます"></button>`);
      const masuBtn = head.querySelector('[data-role="masu"]');
      masuBtn.addEventListener("click", (ev) => {
        openPop(ev.currentTarget, q.options, (val) => {
          masuBtn.textContent = val;
          masuBtn.classList.remove("is-empty");
          masuBtn.classList.add("is-picked");
          S.choice.set(q.n, val);
          refreshCheck();
        });
      });
      block.appendChild(head);

    } else if (q.type === "embed") {
      // 文と回答部分(プレビュー)を上に、ますの入力を下に置く
      if (q.answer_sentence || q.text.includes("[空欄")) {
        block.appendChild(qTextEl(escapeHtml(q.text.replace(/回答文[「『].*[」』]/, "").trim())));
        block.appendChild(embedPreviewEl(q));
        const row = document.createElement("div");
        row.className = "masu-row";
        q.blanks.forEach((b, idx) => {
          const label = document.createElement("span");
          label.className = "cell-label";
          label.textContent = `空欄${idx + 1}`;
          row.appendChild(label);
          row.appendChild(makeMasu(q, idx + 1, b.options));
        });
        block.appendChild(row);
      } else {
        block.appendChild(qTextEl(escapeHtml(q.text)));
        const row = document.createElement("div");
        row.className = "masu-row";
        q.blanks.forEach((b, idx) => {
          const label = document.createElement("span");
          label.className = "cell-label";
          label.textContent = `空欄${idx + 1}`;
          row.appendChild(label);
          row.appendChild(makeMasu(q, idx + 1, b.options));
        });
        block.appendChild(row);
      }

    } else if (q.type === "digits") {
      block.appendChild(qTextEl(escapeHtml(q.text)));
      block.appendChild(digitPreviewEl(q));
      block.appendChild(buildDigitRow(q, q.digits.map((g) => ({ label: g.label }))));

    } else if (q.type === "write") {
      block.appendChild(qTextEl(escapeHtml(q.text)));
      const input = document.createElement("input");
      input.type = "text";
      input.className = "write-input";
      input.placeholder = "ここに こたえを書く";
      input.autocomplete = "off";
      input.addEventListener("input", () => {
        S.choice.set(q.n, input.value.trim());
        refreshCheck();
      });
      S.inputs = S.inputs || {};
      S.inputs[q.n] = input;
      block.appendChild(input);
    }
    return block;
  }

  /* ===== ポップオーバー ===== */

  let popEl = null;
  function openPop(anchor, options, onPick) {
    closePop();
    popEl = document.createElement("div");
    popEl.className = "masu-pop";
    popEl.setAttribute("role", "menu");
    for (const opt of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice-btn";
      b.textContent = opt;
      b.addEventListener("click", () => { closePop(); onPick(opt); });
      popEl.appendChild(b);
    }
    document.body.appendChild(popEl);

    /* 画面の外に出ないよう、実際の大きさを測ってから置く。
       下に出しきれないときは上に出す。横も端末の内側に収める */
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pw = popEl.offsetWidth;
    const ph = popEl.offsetHeight;
    const r = anchor.getBoundingClientRect();
    let left = Math.min(Math.max(r.left, 8), Math.max(8, vw - 8 - pw));
    let top = r.bottom + 6;
    if (top + ph > vh - 8) {
      const above = r.top - ph - 6;
      top = above >= 8 ? above : Math.max(8, Math.min(r.bottom + 6, vh - 8 - ph));
    }
    popEl.style.left = `${left}px`;
    popEl.style.top = `${top}px`;
    requestAnimationFrame(() => document.addEventListener("click", popOutside));
  }
  function popOutside(ev) {
    if (popEl && !popEl.contains(ev.target)) closePop();
  }
  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
    document.removeEventListener("click", popOutside);
  }
  // 画面の大きさが変わったら置き直し(回転・ソフトキーボード対応)
  window.addEventListener("resize", closePop, { passive: true });
  window.addEventListener("scroll", closePop, { passive: true });

  /* ===== 回答状態/採点 ===== */

  function refreshCheck() {
    if (S.graded || !stateCheckBtn) return;
    stateCheckBtn.disabled = !allAnswered();
  }

  function allAnswered() {
    for (const q of S.qs) {
      if (qIsNumeric(q)) {
        const a = S.blanks.get(q.n);
        const len = String(q.answer).length;
        if (!a || Array.from({ length: len }, (_, i) => a[i]).some((v) => v === undefined)) return false;
      } else if (q.type === "four" || q.type === "masu") {
        if (!S.choice.has(q.n)) return false;
      } else if (q.type === "embed") {
        const a = S.blanks.get(q.n);
        if (!a || q.blanks.some((_, idx) => !a[idx + 1])) return false;
      } else if (q.type === "digits") {
        const a = S.blanks.get(q.n);
        if (!a || q.digits.some((_, idx) => !a[idx])) return false;
      } else if (q.type === "write") {
        const v = S.choice.get(q.n);
        if (!v) return false;
      }
    }
    return true;
  }

  function qIsCorrect(q) {
    if (qIsNumeric(q)) {
      const a = S.blanks.get(q.n) || {};
      const v = Array.from({ length: String(q.answer).length }, (_, i) => a[i] ?? "").join("");
      return v === q.answer;
    }
    if (q.type === "four" || q.type === "masu" || q.type === "write")
      return S.choice.get(q.n) === q.answer;
    if (q.type === "embed") {
      const a = S.blanks.get(q.n) || {};
      return q.blanks.every((b, idx) => a[idx + 1] === b.answer);
    }
    if (q.type === "digits") {
      const a = S.blanks.get(q.n) || {};
      return q.digits.map((_, idx) => a[idx] ?? "").join("") === q.answer;
    }
    return false;
  }

  function qAnswerText(q) {
    if (q.type === "four" || q.type === "masu" || q.type === "write") return q.answer;
    if (q.type === "embed") return q.blanks.map((b, i) => `${b.answer}`).join("、");
    if (q.type === "digits") return q.answer;
    return "";
  }

  async function grade() {
    if (S.graded) return;
    S.graded = true;
    closePop();
    document.getElementById("checkBtn").hidden = true;

    for (const q of S.qs) {
      const ok = qIsCorrect(q);
      const verdict = document.createElement("div");
      verdict.className = "verdict";
      const stamp = ok
        ? `<span class="stamp is-good">◎</span>`
        : `<span class="stamp is-bad">✕</span>`;
      verdict.innerHTML = `
        <span class="qid-ellipsis">Q${q.n}</span>
        ${stamp}
        ${ok
          ? `<div class="verdict-words">せいかい !</div>`
          : `<div class="verdict-words">こたえは <strong>${escapeHtml(qAnswerText(q))}</strong></div>`}`;
      stateVerdictZone.appendChild(verdict);

      if (S.session) {
        await sdjSaveAnswer({
          sid, date: sdjToday(), ts: Date.now(),
          level: S.entry.level, qid: S.entry.id, qn: q.n, correct: ok,
        });
      }
    }

    // ヘッダー進捗バー: この問題の採点印(正解したクイズの数で ◎/△/✕)
    if (S.session) {
      const good = S.qs.filter(qIsCorrect).length;
      setHudCell(S.i, good, Math.max(S.qs.length, good));
    }

    // 要約(音声の文)。答え合わせあとは上部の再生ボタンで聞き直せる
    if (S.entry.text) {
      const summary = document.createElement("div");
      summary.className = "summary";
      summary.innerHTML = `
        <strong class="summary-label">音声の文</strong>
        <p class="summary-text">${escapeHtml(S.entry.text)}</p>`;
      stateVerdictZone.parentElement.insertBefore(summary, stateNav);
    }

    // 正誤が出たら上の再生ボタンで聞き直しOK(答え合わせ中までは1回だけ)
    allowReplay();

    // 次へ
    const last = S.i >= S.queue.length - 1;
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "next-btn";
    if (last && demoMode()) {
      // 体験デモ: 成績画面を出さずホームへ
      nextBtn.textContent = "ホームにもどる";
      nextBtn.addEventListener("click", () => { location.href = "index.html"; });
    } else if (last && S.session) {
      nextBtn.textContent = "成績を見る";
      nextBtn.addEventListener("click", showResult);
    } else if (last) {
      nextBtn.textContent = "ホームにもどる";
      nextBtn.addEventListener("click", () => { location.href = "index.html"; });
    } else {
      nextBtn.textContent = "次の問題 →";
      nextBtn.addEventListener("click", () => {
        location.href = `quiz.html?sid=${sid}&i=${S.i + 1}`;
      });
    }
    stateNav.appendChild(nextBtn);
    nextBtn.focus();
  }

  /* ===== 結果 ===== */

  async function showResult() {
    let score = 0;
    let total = 0;
    if (S.session) {
      // 採点: 正解したクイズ(Q1/Q2)の数 = 得点(全5問で10点満点)
      total = S.queue.reduce((n, e) => n + e.qs.length, 0);
      const answers = await sdjAnswersOf(sid);
      const sdate = S.session.date || sdjToday();
      const mine = answers.filter((r) => (S.session.qids || []).includes(r.qid) && r.date === sdate);
      score = mine.filter((r) => r && r.correct === true).length;
    }
    const ratio = total ? score / total : 0;
    const k = stampFor(ratio);
    const note = demoMode()
      ? "これは体験デモなので、ホームの記録には入りません。"
      : "クイズ1つ正解 = 1点(全5問で10クイズ)。この成績はホームの「きょうの採点」に加算されています。";
    main.innerHTML = `
      <div class="result-box">
        <div class="result-stamp"><span class="stamp ${k.cls}">${k.ch}</span></div>
        <p class="result-score">${score} / ${total} 点</p>
        <p class="result-note">${note}</p>
        <div class="result-actions">
          <a class="next-btn" href="index.html" style="text-decoration:none">ホームにもどる</a>
        </div>
      </div>`;
    document.getElementById("progressNum").textContent = "成績";
  }

  init();
})();
