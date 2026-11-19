const AGENTS = [
  { name: "claude", cmd: "claude", icon: "claude.svg", color: "#f14c4c", native: true },
  { name: "opencode", cmd: "opencode", icon: "opencode.svg", color: "#4fc1ff", native: true },
  { name: "codex", cmd: "codex", icon: "codex.svg", color: "#4ec9b0", native: true },
  { name: "pi", cmd: "pi", icon: "pi.svg", color: "#dcdcaa", native: true },
  { name: "crush", cmd: "crush", icon: "crush.svg", color: "#c586c0", native: true },
  { name: "aider", cmd: "uvx aider", icon: "aider.svg", color: "#ce9178", native: false },
  { name: "gemini", cmd: "gemini", icon: "gemini.svg", color: "#89d185", native: false },
  { name: "goose", cmd: "goose", icon: "goose.svg", color: "#d7ba7d", native: false },
  { name: "copilot", cmd: "gh copilot", icon: "copilot.svg", color: "#4fc1ff", native: false },
  { name: "amp", cmd: "amp", icon: "amp.svg", color: "#c586c0", native: false },
  { name: "droid", cmd: "droid", icon: "droid.svg", color: "#f14c4c", native: false },
  { name: "qwen", cmd: "qwen", icon: "qwen.svg", color: "#4ec9b0", native: false },
  { name: "grok", cmd: "grok", icon: "grok.svg", color: "#dcdcaa", native: false },
  { name: "plandex", cmd: "plandex", icon: "plandex.svg", color: "#89d185", native: false },
  { name: "cody", cmd: "cody", icon: "cody.svg", color: "#4fc1ff", native: false },
  { name: "kilo", cmd: "kilo", icon: "kilo.svg", color: "#ce9178", native: false },
  { name: "qodo", cmd: "qodo", icon: "qodo.svg", color: "#d7ba7d", native: false },
  { name: "commandcode", cmd: "cmd", icon: "commandcode.svg", color: "#c586c0", native: false },
];

const CHECK = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 8.5l4 4 7-8"/></svg>';
const GLYPH = { working: "●", blocked: "⏸", done: CHECK, error: "✗", idle: "○", unknown: "·" }; // taste-skill-ignore: the extension’s own status glyphs
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let frecency = new Map(AGENTS.map((a) => [a.name, 0]));
let showUninstalled = false;
const launched = new Map();

function renderList(filter = "") {
  const list = $("qp-list");
  list.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const installed = AGENTS.filter((a) => f === "" || a.name.includes(f) || a.cmd.includes(f));
  const uninstalled = [
    { name: "oh-my-pi", cmd: "omp", icon: "omp.svg", color: "#dcdcaa", native: false },
    { name: "droid-cli", cmd: "droid-cli", icon: "terminal.svg", color: "#f14c4c", native: false },
  ].filter((a) => f === "" || a.name.includes(f));
  const sorted = [...installed].sort((a, b) => (frecency.get(b.name) ?? 0) - (frecency.get(a.name) ?? 0));
  const mk = (a, extra) => {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.setAttribute("role", "option");
    const state = launched.has(a.name) ? `<span class="qp-state live">${GLYPH[launched.get(a.name).status]}</span>` : (a.native ? `<span class="qp-state live">speaks OSC 7501</span>` : "");
    li.innerHTML = `<img src="assets/agents/${a.icon}" alt="" width="18" height="18"><span class="qp-name">${a.name}</span><span class="qp-desc">${a.cmd}</span>${state}`;
    li.addEventListener("click", () => launch(a));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); launch(a); } });
    if (extra) li.appendChild(extra);
    return li;
  };
  sorted.forEach((a, i) => { const li = mk(a); if (i === 0) li.classList.add("selected"); list.appendChild(li); });
  if (showUninstalled && uninstalled.length > 0) {
    const sep = document.createElement("li");
    sep.className = "qp-sep";
    sep.textContent = "Not installed";
    list.appendChild(sep);
    uninstalled.forEach((a) => list.appendChild(mk(a)));
  }
}

function launch(agent) {
  frecency.set(agent.name, (frecency.get(agent.name) ?? 0) + 10);
  renderList($("qp-filter").value);
  if (launched.has(agent.name)) { launched.get(agent.name).run(); return; }
  const tab = document.createElement("div");
  tab.className = "tab active";
  tab.innerHTML = `<span class="dot" style="background:${agent.color}"></span><img src="assets/agents/${agent.icon}" width="14" height="14" alt="">${agent.name}`;
  const strip = $("tabstrip");
  [...strip.children].forEach((t) => t.classList.remove("active"));
  strip.appendChild(tab);
  const session = { status: "working", timers: [], run };
  launched.set(agent.name, session);
  const set = (status) => {
    session.status = status;
    [...strip.children].forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    renderList($("qp-filter").value);
    updateSb();
  };
  function run() {
    session.timers.forEach(clearTimeout);
    session.timers = [];
    const steps = [
      [0, () => set("working")],
      [1400, () => { set("blocked"); toast(`${cap(agent.name)} needs your approval`, "Refactor the parser…", false); }],
      [3200, () => set("working")],
      [4400, () => { set("done"); toast(`${cap(agent.name)} finished`, "Turn complete: 3 files changed", true); }],
      [5900, () => set("idle")],
    ];
    steps.forEach(([ms, fn]) => session.timers.push(setTimeout(fn, reduced ? 0 : ms)));
  }
  run();
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const SB_ICON = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M3 8.5 6 5h12l3 3.5v2L13.4 19h-2.8L3 10.5z"/></svg>';

function updateSb() {
  const counts = {};
  launched.forEach((s) => { counts[s.status] = (counts[s.status] ?? 0) + 1; });
  const parts = Object.entries(counts).filter(([k]) => k !== "unknown").map(([k, n]) => `${GLYPH[k]}${n}`);
  $("sb-count").innerHTML = SB_ICON + (parts.length > 0 ? ` Agent&nbsp;&nbsp;${parts.join("&nbsp;&nbsp;")}` : " Agent");
}

let toastTimer;
let firstPing = true;
function toast(title, body, good) {
  const t = $("toast");
  t.className = "toast show" + (good ? " t-done" : "");
  t.innerHTML = `<strong>${title}</strong>${body}<span class="toast-action">Show</span>`;
  t.querySelector(".toast-action").addEventListener("click", () => t.classList.remove("show"));
  clearTimeout(toastTimer);
  const ms = firstPing ? 6500 : 2600;
  firstPing = false;
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

$("qp-filter").addEventListener("input", (e) => renderList(e.target.value));
$("qp-toggle").addEventListener("click", () => {
  showUninstalled = !showUninstalled;
  $("qp-toggle").setAttribute("aria-pressed", String(showUninstalled));
  renderList($("qp-filter").value);
});
$("qp-toggle").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("qp-toggle").click(); }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    document.querySelector(".stage").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    $("qp-filter").focus();
    $("qp-filter").select();
  }
});

const WIRE_STEPS = [
  { text: "$ claude\n", cls: "plain", status: null },
  { text: "╭───────────────────────────────╮\n│  Claude Code  ·  new session  │\n╰───────────────────────────────╯\n", cls: "plain", status: null },
  { text: "> refactor the parser to drop the shim\n\n", cls: "plain", status: "working" },
  { text: "\x1b]7501;state=working:app=claude\x1b\\\n", cls: "esc", status: null },
  { text: "● Reading 4 files…  src/agent-reporters.ts\n", cls: "plain", status: null },
  { text: "\x1b]7501;state=blocked:kind=permission:app=claude\x1b\\\n", cls: "esc", status: "blocked" },
  { text: "⏸ Allow edit of src/agent-reporters.ts?  [y/n]\n", cls: "plain", status: null },
  { text: "\x1b]7501;state=working:app=claude\x1b\\\n", cls: "plain", status: "working" },
  { text: "\x1b]7501;state=done:app=claude\x1b\\\n", cls: "esc", status: "done" },
  { text: "Turn finished: 3 files changed\n", cls: "plain", status: null },
];

const SIG_LABEL = { working: ["●", "working", "Refactor the parser…", 0.35], blocked: ["⏸", "blocked", "Waiting on you: permission", 0.6], done: [CHECK, "done", "Turn complete", 1] }; // taste-skill-ignore: the extension’s own status glyphs

let wireStarted = false;
function runWire() {
  const pre = $("wire-transcript");
  pre.innerHTML = "";
  const caret = document.createElement("span");
  caret.className = "caret";
  pre.appendChild(caret);
  let si = 0, ci = 0, cur = null;
  const stepSpeed = reduced ? 0 : 9;
  function tick() {
    if (si >= WIRE_STEPS.length) { caret.remove(); return; }
    const step = WIRE_STEPS[si];
    if (cur === null) {
      cur = document.createElement("span");
      cur.className = step.cls;
      caret.before(cur);
      if (step.status) {
        const [g, label, title, w] = SIG_LABEL[step.status];
        $("sig-glyph").innerHTML = g;
        $("sig-label").textContent = label;
        $("sig-title").textContent = title;
        $("sig-bar").firstElementChild.style.transform = `scaleX(${w})`;
      }
    }
    if (ci < step.text.length) {
      cur.textContent += step.text[ci++];
      setTimeout(tick, stepSpeed);
    } else {
      si++; ci = 0; cur = null;
      setTimeout(tick, step.status ? 350 : 90);
    }
  }
  tick();
}
new IntersectionObserver((entries, obs) => {
  if (entries.some((e) => e.isIntersecting) && !wireStarted) {
    wireStarted = true;
    runWire();
    obs.disconnect();
  }
}, { threshold: 0.4 }).observe($("wire"));
$("wire-replay").addEventListener("keydown", (e) => { if (e.key === "Enter") runWire(); });

const FQ = ["claude", "opencode", "codex", "aider", "gemini"];
const FQ_N = { claude: 84, opencode: 61, codex: 37, aider: 22, gemini: 9 };
function renderFrecency() {
  const box = $("frag-frecency");
  box.innerHTML = "";
  FQ.forEach((name) => {
    const a = AGENTS.find((x) => x.name === name);
    const row = document.createElement("div");
    row.className = "fq-row";
    row.innerHTML = `<img src="assets/agents/${a.icon}" alt="" width="17" height="17">${name}<span class="fq-n">${FQ_N[name]}×</span>`;
    row.addEventListener("click", () => {
      FQ.splice(FQ.indexOf(name), 1);
      FQ.unshift(name);
      FQ_N[name] += 1;
      renderFrecency();
    });
    box.appendChild(row);
  });
}
renderFrecency();

function renderEye() {
  const box = $("frag-eye");
  box.innerHTML = "";
  const mk = (name, icon, note) => {
    const row = document.createElement("div");
    row.className = "fq-row";
    row.innerHTML = `<img src="assets/agents/${icon}" alt="" width="17" height="17">${name}<span class="fq-n">${note}</span>`;
    return row;
  };
  box.appendChild(mk("claude", "claude.svg", "on PATH"));
  box.appendChild(mk("opencode", "opencode.svg", "on PATH"));
  const sep = document.createElement("div");
  sep.className = "qp-sep";
  sep.textContent = "Not installed";
  const eye = document.createElement("div");
  eye.className = "fq-row";
  eye.setAttribute("role", "button");
  eye.tabIndex = 0;
  eye.innerHTML = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/></svg> <span style="color:#4ec9b0">show uninstalled</span>`;
  const hidden = [mk("amp", "amp.svg", "hidden"), mk("grok", "grok.svg", "hidden")];
  let open = false;
  const paint = () => {
    box.innerHTML = "";
    box.appendChild(mk("claude", "claude.svg", "on PATH"));
    box.appendChild(mk("opencode", "opencode.svg", "on PATH"));
    if (open) {
      box.appendChild(sep);
      hidden.forEach((h) => box.appendChild(h));
    } else {
      box.appendChild(eye);
      eye.onclick = () => { open = true; paint(); };
    }
  };
  paint();
}
renderEye();

const REPORTS = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 8.5l4 4 7-8"/></svg>';
const BANDS = {
  native: [
    { icon: "opencode.svg", name: "OpenCode ≥ 2.1", note: "Reports unconditionally, no handshake needed", glyph: REPORTS },
    { icon: "codex.svg", name: "Codex", note: "Reports unconditionally", glyph: REPORTS },
    { icon: "pi.svg", name: "pi ≥ 1.1", note: "PI_PROGRAM_STATUS=1 is set for you, never overriding your own", glyph: REPORTS },
    { icon: "claude.svg", name: "Claude Code", note: "Gated by a handshake VS Code can’t answer, so a launch-time reporter supplies the reports", glyph: REPORTS },
    { icon: "crush.svg", name: "Crush", note: "Ships the protocol; reports", glyph: REPORTS },
  ],
  inferred: [
    { icon: "gemini.svg", name: "Gemini CLI", note: "Window title, progress and output are read instead", glyph: "○" },
    { icon: "goose.svg", name: "Goose", note: "Same inference, per-agent rules ported from Herdr", glyph: "○" },
    { icon: "aider.svg", name: "Aider", note: "Diff and output patterns; exit code decides done and error", glyph: "○" },
    { icon: "amp.svg", name: "Amp", note: "Inferred", glyph: "○" },
    { icon: "droid.svg", name: "Droid", note: "Speaks the protocol but stays handshake-gated, so inferred for now", glyph: "○" },
    { icon: "copilot.svg", name: "Copilot CLI", note: "Inferred today", glyph: "○" },
    { icon: "qwen.svg", name: "Qwen Code", note: "Inferred today", glyph: "○" },
    { icon: "grok.svg", name: "Grok Build", note: "Inferred", glyph: "○" },
  ],
  own: [
    { icon: "terminal.svg", name: "Any command, your own entry", note: "agentQuickpick.agents in settings: name it, give it a command, pick an icon and a tab color. Detection rules still apply.", glyph: "+" },
  ],
};
const TABS = [
  { id: "native", label: "Reports natively", sub: "believed word for word" },
  { id: "inferred", label: "Read from the terminal", sub: "title · progress · output" },
  { id: "own", label: "Bring your own", sub: "any CLI" },
];

function renderTabs(active = "native") {
  const tabs = $("agents-tabs");
  const bands = $("agents-bands");
  tabs.innerHTML = "";
  bands.innerHTML = "";
  TABS.forEach((t) => {
    const b = document.createElement("button");
    b.className = "agents-tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === active));
    b.innerHTML = `${t.label}<small>${t.sub}</small>`;
    b.addEventListener("click", () => renderTabs(t.id));
    tabs.appendChild(b);
  });
  BANDS[active].forEach((band) => {
    const li = document.createElement("li");
    li.className = "band" + (active === "own" ? " band-own" : "");
    li.innerHTML = `<div class="band-side"><img src="assets/agents/${band.icon}" alt="" width="32" height="32"><div><div class="band-name">${band.name}</div><div class="band-note">${band.note}</div></div></div><span></span><span class="band-glyph">${band.glyph}</span>`;
    bands.appendChild(li);
  });
}
renderTabs();

const QA = [
  { q: "Does it install anything?", a: "No. It reads your PATH, launches terminals, and watches what they print.", more: "The one exception is deliberate and per-launch only: Claude Code is started with a --settings flag pointing at a hooks file shipped inside the extension, because VS Code can’t answer Claude’s status handshake. Nothing is ever written to ~/.claude, ~/.config/opencode, or any agent’s own config." },
  { q: "Which agents report their own status?", a: "OpenCode ≥ 2.1, Codex and pi report over OSC 7501; Claude Code reports through a launch-time reporter; Crush ships the protocol too.", more: "Everyone else — Gemini CLI, Goose, Aider, Amp, Copilot CLI and more — is tracked by reading the window title, progress sequences and output, with per-agent rules ported from Herdr (Apache-2.0)." },
  { q: "Does it work in Cursor, Windsurf or Trae?", a: "Yes — any VS Code–compatible editor from 1.93 onward.", more: "VS Code, Cursor, Windsurf, Trae, Antigravity and Vodium all work. The only requirement is the terminal shell-integration API introduced in VS Code 1.93." },
  { q: "What is OSC 7501?", a: "An open terminal protocol — the Program Status Protocol — that lets a program announce ‘I’m working’, ‘I’m blocked on you’, ‘I’m done’.", more: "Announced in October 2026 and already shipped by Claude Code, OpenCode, Codex, pi, Crush, Droid, Copilot CLI and others. When an agent speaks it, Agent Quickpick believes it word for word." },
  { q: "What does it cost?", a: "Nothing. MIT-licensed, open source.", more: "The code is on GitHub, the package on OpenVSX, and there is no telemetry, account or subscription." },
  { q: "Windows and Linux?", a: "The extension runs everywhere; launch-time reporters are macOS and Linux only.", more: "Status detection itself — protocol, heuristics and exit codes — works on every platform. Only the injected Claude reporter is skipped on Windows, where Claude there falls back to inference." },
];

function renderQa(sel = 0) {
  const list = $("q-list");
  list.innerHTML = "";
  const head = document.createElement("h2");
  head.textContent = "Questions";
  list.appendChild(head);
  QA.forEach((item, i) => {
    const d = document.createElement("div");
    d.className = "q-item";
    d.setAttribute("role", "button");
    d.setAttribute("tabindex", "0");
    d.setAttribute("aria-selected", String(i === sel));
    d.textContent = item.q;
    const select = () => {
      const phone = window.matchMedia("(max-width: 900px)").matches;
      if (phone) {
        list.querySelectorAll(".q-item").forEach((x) => x.setAttribute("aria-selected", "false"));
        d.setAttribute("aria-selected", "true");
        const ans = $("q-answer");
        ans.classList.add("mobile-open");
        ans.classList.remove("fade");
        ans.innerHTML = `${item.a}<span class="q-more">${item.more}</span>`;
        return;
      }
      renderQa(i);
    };
    d.addEventListener("click", select);
    d.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
    d.addEventListener("mouseenter", () => {
      if (window.matchMedia("(min-width: 901px)").matches && i !== sel) {
        renderQa(i);
      }
    });
    d.addEventListener("focus", () => {
      if (window.matchMedia("(min-width: 901px)").matches && i !== sel) renderQa(i);
    });
    list.appendChild(d);
  });
  const ans = $("q-answer");
  ans.classList.add("fade");
  setTimeout(() => {
    ans.classList.remove("fade");
    ans.innerHTML = `${QA[sel].a}<span class="q-more">${QA[sel].more}</span>`;
  }, 150);
}
renderQa();

updateSb();
renderList();
setTimeout(() => { if (!launched.has("claude")) launch(AGENTS[0]); }, reduced ? 0 : 900);

const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
}, { threshold: 0.2 });
setTimeout(() => document.querySelectorAll(".anim:not(.in)").forEach((el) => el.classList.add("in")), 3000);
document.querySelectorAll(".anim").forEach((el) => io.observe(el));
const archBand = document.querySelector(".arch-band");
if (archBand) {
  archBand.classList.add("shutter");
  new IntersectionObserver((entries, obs) => {
    entries.forEach((e) => { if (e.isIntersecting) { archBand.classList.add("in"); obs.disconnect(); } });
  }, { threshold: 0.25 }).observe(archBand);
}
const demoImg = document.getElementById("demo-img");
const demoPlay = document.getElementById("demo-play");
function playDemo() {
  const v = document.createElement("video");
  v.src = "assets/demo.mp4";
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("aria-label", demoImg.alt);
  v.className = "demo-video";
  demoImg.replaceWith(v);
  if (demoPlay) demoPlay.remove();
}
if (demoImg && demoPlay) {
  demoImg.addEventListener("click", playDemo);
  demoPlay.addEventListener("click", playDemo);
}

document.querySelectorAll("section > h2, .feat-cell, .wire-terminal, .wire-signal, .wire-caption, .ladder-field, .agents-head, .agents-body, .editors-lead, .editors-row, .q-list, .q-answer, .demo-lead").forEach((el, i) => {
  el.classList.add("anim");
  if (i % 3 === 1) el.classList.add("d1");
  if (i % 3 === 2) el.classList.add("d2");
  io.observe(el);
});
