/* Grok Bot Desk — Plan B polling + optional Plan A API. No secrets in source. */
(function () {
  "use strict";

  const LS_TOKEN = "desk_app_token";
  const LS_DATA = "desk_data_path";
  const LS_UNREAD = "desk_unread";
  const AGENT_ORDER = ["scanner", "auditor", "analyst", "executor", "risk"];
  const POLL_MS = 8000;
  const RETRY_S = 8;

  const state = {
    mode: "planb", // planb | api | proof | none
    token: null,
    dataPath: null,
    proofRoot: null,
    base: null,
    useApi: false,
    state: null,
    chart: null,
    activity: null,
    account: null,
    settings: null,
    decisions: {},
    coin: null,
    audit: null,
    lastOk: null,
    retryIn: RETRY_S,
    range: "LIVE",
    tab: "home",
    loading: true,
    offline: false,
    openMint: null,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  function toast(msg) {
    let t = $("#toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
  }

  function parseFragment() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash.replace(/;/g, "&"));
    // also support #t=x&d=y
    const t = params.get("t");
    const d = params.get("d");
    if (t) {
      localStorage.setItem(LS_TOKEN, t);
      state.token = t;
    }
    if (d) {
      localStorage.setItem(LS_DATA, d);
      state.dataPath = d;
    }
    // strip fragment from visible URL
    history.replaceState(null, "", location.pathname + location.search);
  }

  function readStoredAuth() {
    state.token = localStorage.getItem(LS_TOKEN);
    state.dataPath = localStorage.getItem(LS_DATA);
  }

  function proofMode() {
    const q = new URLSearchParams(location.search);
    const p = q.get("proof");
    if (p === "1" || p === "demo") return "proof/";
    if (p === "empty") return "proof_empty/";
    if (p === "error") return "proof_error/";
    return null;
  }

  async function tryApi() {
    if (!state.token) return false;
    try {
      const r = await fetch("/api/state", {
        headers: {
          Authorization: "Bearer " + state.token,
          "X-App-Token": state.token,
        },
      });
      if (r.status === 200) {
        state.useApi = true;
        state.mode = "api";
        state.state = await r.json();
        state.lastOk = Date.now();
        state.offline = false;
        return true;
      }
    } catch (_) {}
    state.useApi = false;
    return false;
  }

  function planBUrl(file) {
    if (state.proofRoot) return state.proofRoot + file;
    if (!state.dataPath) return null;
    return "d/" + state.dataPath + "/" + file;
  }

  async function fetchJson(file) {
    if (state.useApi) {
      const map = {
        "state.json": "/api/state",
        "chart.json": "/api/chart?range=" + encodeURIComponent(state.range),
        "activity.json": "/api/activity",
        "account.json": "/api/account",
        "settings.json": "/api/settings",
      };
      let url = map[file];
      if (!url && file.startsWith("coin/")) url = "/api/coin/" + file.slice(5).replace(/\.json$/, "");
      if (!url && file.startsWith("audit/")) url = "/api/audit/" + file.slice(6).replace(/\.json$/, "");
      if (!url && file.startsWith("agents/")) {
        const m = file.match(/^agents\/(\w+)\/decisions\.json$/);
        if (m) url = "/api/agents/" + m[1] + "/decisions";
      }
      if (!url && file.startsWith("chart_")) {
        const rk = file.replace("chart_", "").replace(".json", "");
        url = "/api/chart?range=" + encodeURIComponent(rk);
      }
      if (!url) throw new Error("no api map");
      const r = await fetch(url, {
        headers: { Authorization: "Bearer " + state.token, "X-App-Token": state.token },
      });
      if (!r.ok) throw new Error("api " + r.status);
      return r.json();
    }
    const u = planBUrl(file);
    if (!u) throw new Error("no data path");
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error("fetch " + r.status);
    return r.json();
  }

  async function refreshAll() {
    try {
      const chartFile = state.range === "LIVE" ? "chart.json" : "chart_" + state.range + ".json";
      const [st, ch, act, acc, set] = await Promise.all([
        fetchJson("state.json"),
        fetchJson(chartFile).catch(() => fetchJson("chart.json")),
        fetchJson("activity.json"),
        fetchJson("account.json"),
        fetchJson("settings.json"),
      ]);
      state.state = st;
      state.chart = ch;
      state.activity = act;
      state.account = acc;
      state.settings = set;
      const dec = {};
      await Promise.all(
        AGENT_ORDER.map(async (name) => {
          try {
            dec[name] = await fetchJson("agents/" + name + "/decisions.json");
          } catch (_) {
            dec[name] = { agent: name, decisions: [], status: "running" };
          }
        })
      );
      state.decisions = dec;
      state.lastOk = Date.now();
      state.offline = false;
      state.loading = false;
      state.retryIn = RETRY_S;
      render();
      if (state.openMint) {
        await openCoin(state.openMint, false);
      }
    } catch (err) {
      state.offline = true;
      state.loading = false;
      updateErrorBar();
      // keep last good numbers — still render if we have them
      if (state.state) render();
      else renderBootstrapEmpty();
    }
  }

  function updateErrorBar() {
    const bar = $("#error-bar");
    if (!state.offline && (state.token || state.dataPath || state.proofRoot)) {
      bar.classList.add("hidden");
      return;
    }
    if (!state.token && !state.dataPath && !state.proofRoot) {
      bar.classList.remove("hidden");
      bar.textContent = "Desk offline · add #t= or #d= (or ?proof=1) · last update —";
      return;
    }
    if (state.offline) {
      bar.classList.remove("hidden");
      const last = state.lastOk ? new Date(state.lastOk).toLocaleTimeString() : "—";
      bar.textContent = "Desk offline · retrying in " + state.retryIn + "s · last update " + last;
    } else {
      bar.classList.add("hidden");
    }
  }

  function fmtMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Number(n);
    const abs = Math.abs(v);
    const body = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? "-$" : "$") + body;
  }

  function fmtPct(n, signed) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Number(n);
    const s = (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%";
    return s;
  }

  function setOdometer(el, value) {
    if (!el) return;
    const text = fmtMoney(value);
    if (DeskCharts.reducedMotion() || state.loading) {
      el.textContent = text;
      return;
    }
    const prev = el.dataset.val || "";
    if (prev === text) {
      el.textContent = text;
      return;
    }
    el.dataset.val = text;
    // simple digit roll: rebuild spans
    el.textContent = "";
    const chars = text.split("");
    chars.forEach((ch, i) => {
      const span = document.createElement("span");
      span.textContent = ch;
      span.style.display = "inline-block";
      if (/\d/.test(ch)) {
        span.style.transition = "transform 600ms ease-out, opacity 600ms ease-out";
        span.style.transform = "translateY(40%)";
        span.style.opacity = "0.2";
        const delay = (chars.length - 1 - i) * 30;
        setTimeout(() => {
          span.style.transform = "translateY(0)";
          span.style.opacity = "1";
        }, delay);
      }
      el.appendChild(span);
    });
  }

  function showTab(name) {
    state.tab = name;
    $$(".screen").forEach((s) => {
      if (s.classList.contains("overlay")) return;
      s.classList.toggle("active", s.dataset.screen === name);
    });
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    // close overlays when switching tabs
    $("#screen-coin").classList.remove("active");
    $("#screen-auditor").classList.remove("active");
  }

  function renderBootstrapEmpty() {
    updateErrorBar();
    $("#balance-odo").textContent = "—";
    $("#today-pct").textContent = "—";
    $("#mult-pill").textContent = "—";
    $("#home-chart-empty").classList.remove("hidden");
    $("#home-chart-empty").textContent = state.proofRoot === "proof_error/"
      ? "Desk offline"
      : "Waiting for the first trade";
    $("#agent-carousel").innerHTML = skeletonCards();
    $("#activity-preview").innerHTML = "";
  }

  function skeletonCards() {
    return AGENT_ORDER.map(() => '<div class="agent-card skeleton"></div>').join("");
  }

  function render() {
    updateErrorBar();
    if (!state.state) {
      renderBootstrapEmpty();
      return;
    }
    const st = state.state;
    const mode = (st.mode || "PAPER").toUpperCase();
    $("#paper-badge").classList.toggle("hidden", mode !== "PAPER");
    $("#coin-paper").classList.toggle("hidden", mode !== "PAPER");
    setOdometer($("#balance-odo"), st.balance);
    const tp = st.todayPct;
    const tpEl = $("#today-pct");
    tpEl.textContent = fmtPct(tp, true);
    tpEl.classList.toggle("neg", tp < 0);
    $("#mult-pill").textContent =
      st.multiplier != null ? Number(st.multiplier).toFixed(2) + "×" : "—";

    const running = AGENT_ORDER.filter((n) => st.agents && st.agents[n] && st.agents[n].status !== "paused").length;
    $("#agents-running").textContent = running + " running";

    renderCarousel(st.agents || {});
    renderActivityPreview((state.activity && state.activity.rows) || []);
    renderActivityList((state.activity && state.activity.rows) || []);
    renderAgentsTab(st.agents || {});
    renderAccount();
    drawHomeChart();
    const unread = Number(localStorage.getItem(LS_UNREAD) || "0");
    $("#bell-dot").classList.toggle("hidden", unread <= 0);
  }

  function drawHomeChart() {
    const empty = $("#home-chart-empty");
    if (!state.chart || state.chart.empty) {
      empty.classList.remove("hidden");
      empty.textContent = (state.chart && state.chart.emptyText) || "Waiting for the first trade";
    } else {
      empty.classList.add("hidden");
    }
    DeskCharts.drawEquity($("#home-chart"), state.chart || { empty: true, points: [] });
  }

  function renderCarousel(agents) {
    const el = $("#agent-carousel");
    el.innerHTML = AGENT_ORDER.map((name) => agentCardHtml(agents[name] || { name, agent: name })).join("");
    // score rings
    const a = agents.analyst;
    if (a) {
      const canvas = el.querySelector("[data-score-ring]");
      if (canvas) DeskCharts.drawScoreRing(canvas, a.score, a.greenFrom || 70);
    }
  }

  function agentCardHtml(a) {
    const name = (a.agent || a.name || "").toLowerCase();
    let body = "";
    if (name === "scanner") {
      const feed = (a.feed || []).slice(0, 5).map((f) => {
        const kill = f.verdict === "kill";
        return `<div class="feed-row ${kill ? "kill" : "pass"}"><span class="name">${esc(f.name || f.mint)}</span><span class="${kill ? "reason" : "arrow"}">${esc(kill ? f.reason : "→ auditor")}</span></div>`;
      }).join("") || `<div class="feed-row">${esc(a.empty || "Listening for graduations")}</div>`;
      body = `<div class="ac-name" style="color:#64d2ff">Scanner</div><div class="ac-head">${esc(a.headline || "0 pools")}</div><div class="ac-feed">${feed}</div>`;
    } else if (name === "auditor") {
      const layers = (a.layers || []).slice(0, 8);
      const grid = [0,1,2,3,4,5,6,7].map((i) => {
        const L = layers[i];
        const cls = !L || L.pass == null ? "" : L.pass ? "ok" : "bad";
        return `<div class="layer-chip ${cls}">${L ? L.n : i + 1}</div>`;
      }).join("");
      body = `<div class="ac-name">Auditor</div><div class="ac-head">${esc(a.headline || "0 taken apart")}</div><div class="layer-grid">${grid}</div><div class="ac-feed">${esc(a.summary || a.empty || "")}<div style="margin-top:6px;color:var(--secondary)">${a.rejected || 0} rejected</div></div>`;
    } else if (name === "analyst") {
      body = `<div class="ac-name" style="color:#ffd60a">Analyst</div><div class="ac-head">${esc(a.headline || "Scoring")}</div><div class="score-wrap"><canvas data-score-ring width="96" height="96"></canvas><div>${a.score != null ? "Score " + a.score : "—"}</div></div>`;
    } else if (name === "executor") {
      const filled = a.fillStatus === "bought";
      body = `<div class="ac-name" style="color:#00d35a">Executor</div><div class="ac-head">${esc(a.headline || "0 trades")}</div><div>${esc(a.detail || "")}</div><div class="exec-bar"><i style="width:${filled ? 100 : 40}%"></i></div><div style="margin-top:6px;color:var(--secondary)">${filled ? "✓ Filled" : "Executing..."}</div>`;
    } else {
      const pills = a.pills || {};
      body = `<div class="ac-name" style="color:#ff6b9a">Risk</div><div class="ac-head">${esc(a.headline || "Guarding")}</div><div class="risk-pills"><span class="pill stop">${esc(pills.stop || "stop")}</span><span class="pill trail">${esc(pills.trail || "trail")}</span></div>`;
    }
    return `<article class="agent-card" data-agent="${esc(name)}">${body}</article>`;
  }

  function renderActivityPreview(rows) {
    $("#activity-preview").innerHTML = rows.slice(0, 5).map(activityRow).join("") ||
      `<div class="empty-state">Nothing yet tonight</div>`;
  }

  function renderActivityList(rows) {
    const list = $("#activity-list");
    const empty = $("#activity-empty");
    if (!rows.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.innerHTML = rows.map(activityRow).join("");
  }

  function activityRow(r) {
    const val = r.value || "";
    let cls = "";
    if (/^\+/.test(val) || r.kind === "sold") cls = "pos";
    if (/^-/.test(val) || r.kind === "stopped") cls = "neg";
    return `<button class="activity-row tap" data-kind="${esc(r.kind)}" data-mint="${esc(r.mint || "")}" style="width:100%;background:none;border:none;color:inherit;text-align:left;padding:12px 0">
      <div class="mid"><div class="title">${esc(r.title || "")}</div><div class="sub">${esc(r.subtitle || "")}</div></div>
      <div class="val ${cls}">${esc(val)}</div>
    </button>`;
  }

  function renderAgentsTab(agents) {
    const el = $("#agents-list");
    el.innerHTML = AGENT_ORDER.map((name) => {
      const a = agents[name] || {};
      const dec = (state.decisions[name] && state.decisions[name].decisions) || [];
      const paused = a.status === "paused";
      const locked = name === "risk" && a.pauseLocked;
      const count =
        name === "scanner" ? a.pools :
        name === "auditor" ? a.takenApart :
        name === "analyst" ? a.count :
        name === "executor" ? a.trades :
        a.open;
      const rows = dec.slice(0, 20).map((d) => {
        const label = d.mint ? `<a href="${esc(d.coin_url || "#")}" target="_blank" rel="noopener">${esc((d.mint || "").slice(0, 6))}…</a>` : "—";
        return `<div class="decision-row"><div class="mid"><div class="title">${label} · ${esc(d.verdict || "")}</div><div class="sub">${esc(d.reason || "")}</div></div><div class="val">${fmtTime(d.ts)}</div></div>`;
      }).join("") || `<div class="note">No decisions yet</div>`;
      return `<div class="agent-full" data-agent="${name}">
        <div class="top">
          <span class="status-dot ${paused ? "paused" : ""}"></span>
          <strong>${esc(a.name || name)}</strong>
          <button class="switch ${paused ? "" : "on"} tap" data-pause="${name}" ${locked ? "disabled" : ""} aria-label="pause"></button>
        </div>
        <div class="count">Today · ${count == null ? "—" : count}</div>
        ${rows}
        <button class="settings-link tap" data-settings="${name}">Settings</button>
      </div>`;
    }).join("");
  }

  function renderAccount() {
    const el = $("#account-body");
    const acc = state.account || {};
    const mode = (acc.mode || "PAPER").toUpperCase();
    const settings = (state.settings && state.settings.settings) || {};
    const groups = groupSettings(settings);
    el.innerHTML = `
      <div class="section-head"><span>Mode</span></div>
      <div class="mode-switch">
        <button class="tap ${mode === "PAPER" ? "active" : ""}" data-mode="PAPER">PAPER</button>
        <button class="tap ${mode === "LIVE" ? "active" : ""}" data-mode="LIVE">LIVE</button>
      </div>
      <label class="note">Stack</label>
      <input class="stack-field num" id="stack-input" type="number" value="${esc(acc.stack)}" />
      <div class="account-card">
        <a class="row-link" href="${esc(acc.profile_url || "#")}" target="_blank" rel="noopener"><span>Your FOMO profile</span><span class="chev">›</span></a>
        <button class="row-link tap" id="invite-btn"><span>Invite a friend</span><span class="chev">›</span></button>
      </div>
      <div class="account-card">
        <div class="row-link"><span>Telegram</span><span style="color:var(--secondary)">connected via desk</span></div>
        <button class="row-link tap" id="test-push"><span>Send test push</span><span class="chev">›</span></button>
        <div class="row-link"><span>Notifications</span><span style="color:var(--secondary);font-size:12px;max-width:55%;text-align:right">Plan B: Telegram only — no web push</span></div>
      </div>
      <div class="note">${esc(acc.webPushNote || "")}</div>
      <div class="section-head"><span>Settings</span></div>
      ${Object.keys(groups).map((g) => `
        <div class="settings-group" id="settings-${g}">
          <h3>${esc(g)}</h3>
          ${groups[g].map(([k, v]) => settingRow(k, v)).join("")}
        </div>`).join("")}
    `;
    const invite = $("#invite-btn");
    if (invite) {
      invite.onclick = async () => {
        const url = acc.SIGNUP_URL;
        if (!url) return;
        if (navigator.share) {
          try { await navigator.share({ url, title: "FOMO" }); return; } catch (_) {}
        }
        try {
          await navigator.clipboard.writeText(url);
          toast("Link copied");
        } catch (_) {
          toast(url);
        }
      };
    }
    const testPush = $("#test-push");
    if (testPush) {
      testPush.onclick = () => {
        if (state.useApi) toast("Test push requested via API/Telegram");
        else toast("Plan B: test pushes go through Telegram on the desk");
      };
    }
  }

  function groupSettings(settings) {
    const groups = { scanner: [], auditor: [], analyst: [], rules: [], executor: [], risk: [], desk: [] };
    Object.keys(settings).forEach((k) => {
      if (k.startsWith("scanner.")) groups.scanner.push([k, settings[k]]);
      else if (k.startsWith("auditor.")) groups.auditor.push([k, settings[k]]);
      else if (k.startsWith("analyst") || k === "analyst_mode") groups.analyst.push([k, settings[k]]);
      else if (k.startsWith("rules.")) groups.rules.push([k, settings[k]]);
      else if (k.startsWith("executor.")) groups.executor.push([k, settings[k]]);
      else if (k.startsWith("risk.")) groups.risk.push([k, settings[k]]);
      else groups.desk.push([k, settings[k]]);
    });
    return groups;
  }

  function settingRow(key, value) {
    const isBool = typeof value === "boolean" || value === "true" || value === "false";
    const isNum = typeof value === "number" || (!isBool && !Number.isNaN(Number(value)) && value !== "" && typeof value !== "string" || /_pct$|_s$|_min$|_h$|stack|liquidity|volume|ticket|score|retries|buys|from|discount|nights/.test(key));
    if (isBool || key.endsWith(".enabled") || key === "push_rejects") {
      const on = value === true || value === "true";
      return `<div class="setting-row"><label>${esc(key)}</label><button class="switch ${on ? "on" : ""} tap" data-set="${esc(key)}" data-bool="1"></button></div>`;
    }
    if (typeof value === "number" || (!Number.isNaN(Number(value)) && String(value).trim() !== "" && !/url|mode|handle|time|notifier|below/.test(key))) {
      const n = Number(value);
      return `<div class="setting-row"><label>${esc(key)}</label><div class="controls"><input type="range" min="${n < 1 ? 0 : Math.max(0, n * 0.1)}" max="${n < 1 ? 1 : n * 5}" step="${n < 1 ? 0.01 : 1}" value="${n}" data-set="${esc(key)}" /><input type="number" value="${n}" data-set-num="${esc(key)}" /></div></div>`;
    }
    return `<div class="setting-row"><label>${esc(key)}</label><div class="controls"><input type="text" value="${esc(value)}" data-set-text="${esc(key)}" /></div></div>`;
  }

  async function openCoin(mint, pushHash) {
    if (!mint) return;
    state.openMint = mint;
    try {
      state.coin = await fetchJson("coin/" + mint + ".json");
    } catch (_) {
      state.coin = { mint, name: mint.slice(0, 8), coin_url: null, candles: [], stats: {}, button: "Buy on FOMO" };
    }
    renderCoin();
    $("#screen-coin").classList.add("active");
  }

  function renderCoin() {
    const c = state.coin || {};
    $("#coin-title").textContent = c.name || c.symbol || "Coin";
    const age = c.ageMin != null ? Math.round(c.ageMin / 60) + "h old" : "";
    const body = $("#coin-body");
    const pos = c.position;
    const ex = c.exitLines || {};
    const stats = c.stats || {};
    body.innerHTML = `
      <div class="coin-meta">${esc(c.symbol || "X")} · Solana · ${esc(age)} ${c.shield ? `<span class="shield">${esc(c.shield)}</span>` : ""}</div>
      <div class="price-big num">${c.price != null ? Number(c.price).toPrecision(4) : "—"}</div>
      <div class="since-entry ${ex.pctSinceEntry < 0 ? "neg" : ""}">${ex.pctSinceEntry != null ? "▲ " + fmtPct(ex.pctSinceEntry, true) + " since entry" : ""}</div>
      <div class="chart-wrap" style="height:220px"><canvas id="coin-chart"></canvas></div>
      <div class="stats-grid">
        <div class="stat"><div class="stat-label">Market cap</div><div class="stat-val">${fmtMoney(stats.marketCap)}</div></div>
        <div class="stat"><div class="stat-label">Liquidity</div><div class="stat-val">${fmtMoney(stats.liquidity)}</div></div>
        <div class="stat"><div class="stat-label">24h volume</div><div class="stat-val">${fmtMoney(stats.volume24h)}</div></div>
        <div class="stat"><div class="stat-label">Holders</div><div class="stat-val">${stats.holders == null ? "n/a" : esc(stats.holders)}</div></div>
      </div>
      ${pos ? `<div class="exit-card"><div style="font-weight:600;margin-bottom:8px">Your position · ${fmtMoney(pos.size_usd)} in · Executor</div>
        <div class="line"><span class="k">Stop</span><span class="num">${pos.stop_price != null ? Number(pos.stop_price).toPrecision(4) : "—"}</span></div>
        <div class="line"><span class="k">Trail</span><span class="num">${ex.trail != null ? Number(ex.trail).toPrecision(4) : "—"}</span></div>
        <div class="line"><span class="k">Timeout</span><span class="num">${ex.timeoutRemainingS != null ? Math.round(ex.timeoutRemainingS / 60) + "m left" : "—"}</span></div>
      </div>` : ""}
      <a class="btn" id="fomo-btn" href="${esc(c.coin_url || "#")}" target="_blank" rel="noopener">${esc(c.button || (pos ? "Sell on FOMO" : "Buy on FOMO"))}</a>
    `;
    requestAnimationFrame(() => DeskCharts.drawCandles($("#coin-chart"), c));
  }

  async function openAuditor(mint) {
    if (!mint) return;
    try {
      state.audit = await fetchJson("audit/" + mint + ".json");
    } catch (_) {
      state.audit = { mint, layers: [], empty: true, emptyText: "No coin taken apart yet", coin_url: null };
    }
    renderAuditor();
    $("#screen-auditor").classList.add("active");
  }

  function renderAuditor() {
    const a = state.audit || {};
    const body = $("#auditor-body");
    if (a.empty && !(a.layers || []).length) {
      body.innerHTML = `<div class="empty-state">${esc(a.emptyText || "No coin taken apart yet")}</div>`;
      return;
    }
    const layers = a.layers || [];
    const enabled = state.settings && state.settings.settings
      ? state.settings.settings["auditor.enabled"] !== false && state.settings.settings["auditor.enabled"] !== "false"
      : true;
    const banner = a.rejected
      ? `<div class="audit-banner bad">Rejected · ${esc((layers.find((l) => l.pass === false) || {}).value || "")}<div>Grok Bot won't buy ${esc(a.name || "X")}</div></div>`
      : a.cleared
        ? `<div class="audit-banner ok">Cleared · 8/8 parts<div>Sent to Executor</div></div>`
        : "";
    body.innerHTML = `
      <div class="discs" id="audit-discs">
        ${layers.map((L) => `<div class="disc" data-n="${L.n}"><span class="beam"></span><span>${L.n}. ${esc(L.name || "")}</span><span style="margin-left:auto">${L.pass == null ? "…" : L.pass ? "✓" : "✕"}</span></div>`).join("")}
      </div>
      ${banner}
      <div class="layer-rows">
        ${layers.map((L) => `<div class="row"><span>${esc(L.name || "")}</span><span class="v">${esc(L.value || "not checked")}</span></div>`).join("")}
      </div>
      <div class="toggle-row"><span>Take apart before buying</span><button class="switch ${enabled ? "on" : ""} tap" id="auditor-enabled"></button></div>
      <a class="btn" href="${esc(a.coin_url || "#")}" target="_blank" rel="noopener">Open on FOMO</a>
    `;
    runAuditBeam(layers);
    const sw = $("#auditor-enabled");
    if (sw) {
      sw.onclick = () => {
        if (sw.classList.contains("on")) {
          if (!confirm("Turn off Auditor?")) return;
          if (!confirm("Really buy without taking coins apart?")) return;
          sw.classList.remove("on");
        } else sw.classList.add("on");
      };
    }
  }

  function runAuditBeam(layers) {
    if (DeskCharts.reducedMotion()) {
      $$("#audit-discs .disc").forEach((d, i) => {
        const L = layers[i];
        if (!L || L.pass == null) return;
        d.classList.add(L.pass ? "ok" : "bad");
      });
      return;
    }
    const discs = $$("#audit-discs .disc");
    let i = 0;
    function step() {
      if (i >= discs.length) return;
      const d = discs[i];
      const L = layers[i];
      if (!L || L.pass == null) {
        // wait — server hasn't sent result
        setTimeout(step, 350);
        return;
      }
      d.classList.add("scanning");
      setTimeout(() => {
        d.classList.remove("scanning");
        d.classList.add(L.pass ? "ok" : "bad");
        i += 1;
        setTimeout(step, 150);
      }, 350);
    }
    step();
  }

  function fmtTime(ts) {
    if (!ts) return "";
    try { return new Date(ts * (ts < 1e12 ? 1000 : 1)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return ""; }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bind() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
    $("#btn-avatar").onclick = () => showTab("account");
    $("#activity-see-all").onclick = () => showTab("activity");
    $("#coin-back").onclick = () => { $("#screen-coin").classList.remove("active"); state.openMint = null; };
    $("#auditor-back").onclick = () => $("#screen-auditor").classList.remove("active");
    $("#btn-search").onclick = () => $("#search-sheet").classList.remove("hidden");
    $("#search-close").onclick = () => $("#search-sheet").classList.add("hidden");
    $("#btn-bell").onclick = () => { localStorage.setItem(LS_UNREAD, "0"); $("#bell-dot").classList.add("hidden"); toast("No unread pushes"); };

    $("#range-switch").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-range]");
      if (!b) return;
      state.range = b.dataset.range;
      $$("#range-switch .range").forEach((x) => x.classList.toggle("active", x === b));
      try {
        const file = state.range === "LIVE" ? "chart.json" : "chart_" + state.range + ".json";
        state.chart = await fetchJson(file);
      } catch (_) {}
      drawHomeChart();
    });

    document.addEventListener("click", (e) => {
      const row = e.target.closest(".activity-row");
      if (row) {
        const mint = row.dataset.mint;
        const kind = row.dataset.kind;
        if (!mint) return;
        if (kind === "rejected") openAuditor(mint);
        else openCoin(mint);
        return;
      }
      const pause = e.target.closest("[data-pause]");
      if (pause) {
        if (pause.disabled) { toast("Risk can't pause while a position is open"); return; }
        pause.classList.toggle("on");
        toast(pause.classList.contains("on") ? "Resumed " + pause.dataset.pause : "Paused " + pause.dataset.pause);
        return;
      }
      const set = e.target.closest("[data-settings]");
      if (set) {
        showTab("account");
        const g = document.getElementById("settings-" + set.dataset.settings);
        if (g) g.scrollIntoView({ behavior: "smooth" });
      }
    });

    $("#search-input").addEventListener("input", () => {
      const q = $("#search-input").value.trim().toLowerCase();
      const rows = ((state.activity && state.activity.rows) || []).filter((r) =>
        (r.mint || "").toLowerCase().includes(q) || (r.title || "").toLowerCase().includes(q)
      );
      $("#search-results").innerHTML = rows.slice(0, 10).map(activityRow).join("") || `<div class="note">No matches</div>`;
    });

    $("#account-body").addEventListener("click", (e) => {
      const modeBtn = e.target.closest("[data-mode]");
      if (modeBtn) {
        const m = modeBtn.dataset.mode;
        if (m === "LIVE") {
          const typed = prompt('Type LIVE to confirm');
          if (typed !== "LIVE") { toast("LIVE cancelled"); return; }
        }
        toast("Mode → " + m + (state.useApi ? "" : " (local UI; desk applies when online)"));
      }
    });
  }

  async function boot() {
    parseFragment();
    readStoredAuth();
    state.proofRoot = proofMode();
    if (state.proofRoot) {
      state.mode = "proof";
      if (state.proofRoot === "proof_error/") {
        state.offline = true;
        state.loading = false;
        renderBootstrapEmpty();
      } else {
        await refreshAll();
      }
    } else if (await tryApi()) {
      await refreshAll();
      try {
        const es = new EventSource("/api/stream?token=" + encodeURIComponent(state.token));
        es.addEventListener("message", () => refreshAll());
        es.onmessage = () => refreshAll();
      } catch (_) {}
    } else if (state.dataPath) {
      state.mode = "planb";
      await refreshAll();
      if (state.offline) {
        state.proofRoot = "live/";
        await refreshAll();
      }
    } else {
      // Home Screen / bare URL: show the public paper snapshot (no secrets).
      state.mode = "planb";
      state.proofRoot = "live/";
      await refreshAll();
    }

    setInterval(async () => {
      if (state.mode === "none") return;
      if (state.proofRoot === "proof_error/") {
        state.retryIn = Math.max(0, state.retryIn - 1);
        updateErrorBar();
        if (state.retryIn <= 0) state.retryIn = RETRY_S;
        return;
      }
      if (state.offline) {
        state.retryIn = Math.max(0, state.retryIn - 1);
        updateErrorBar();
        if (state.retryIn <= 0) {
          state.retryIn = RETRY_S;
          await refreshAll();
        }
        return;
      }
      await refreshAll();
    }, POLL_MS);

    // countdown tick for error bar
    setInterval(() => {
      if (state.offline) {
        // refreshAll interval handles retry; soft tick display
        updateErrorBar();
      }
    }, 1000);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").then((reg) => {
        if (reg.waiting) reg.waiting.postMessage("skipWaiting");
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              nw.postMessage("skipWaiting");
            }
          });
        });
      }).catch(() => {});
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (window.__deskSwReloading) return;
        window.__deskSwReloading = true;
        location.reload();
      });
    }
  }

  bind();
  boot();

  // expose for screenshots / proof
  window.DeskApp = { state, refreshAll, openCoin, openAuditor, showTab };
})();
