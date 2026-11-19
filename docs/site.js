const AGENTS = [
  { name: "claude", cmd: "claude", icon: "claude.svg", native: true },
  { name: "opencode", cmd: "opencode", icon: "opencode.svg", native: true },
  { name: "codex", cmd: "codex", icon: "codex.svg", native: true },
  { name: "pi", cmd: "pi", icon: "pi.svg", native: true },
  { name: "crush", cmd: "crush", icon: "crush.svg", native: true },
  { name: "copilot", cmd: "gh copilot", icon: "copilot.svg", native: false },
  { name: "gemini", cmd: "gemini", icon: "gemini.svg", native: false },
  { name: "goose", cmd: "goose", icon: "goose.svg", native: false },
  { name: "aider", cmd: "uvx aider", icon: "aider.svg", native: false },
  { name: "qwen", cmd: "qwen", icon: "qwen.svg", native: false },
  { name: "grok", cmd: "grok", icon: "grok.svg", native: false },
  { name: "droid", cmd: "droid", icon: "droid.svg", native: false },
  { name: "amp", cmd: "amp", icon: "amp.svg", native: false },
  { name: "plandex", cmd: "plandex", icon: "plandex.svg", native: false },
  { name: "cody", cmd: "cody", icon: "cody.svg", native: false },
  { name: "kilo", cmd: "kilo", icon: "kilo.svg", native: false },
  { name: "qodo", cmd: "qodo", icon: "qodo.svg", native: false },
  { name: "commandcode", cmd: "cmd", icon: "commandcode.svg", native: false },
];

const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const LAUNCH_COUNT = { claude: 84, opencode: 61, codex: 37, pi: 22, crush: 15, gemini: 9 };
const HIDDEN = [
  { name: "omp", cmd: "omp", icon: "omp.svg" },
  { name: "your own", cmd: "any command", icon: "terminal.svg" },
];
let freq = new Map(Object.entries(LAUNCH_COUNT));
let showHidden = false;

function renderPicker(filter = "") {
  const list = $("qp-list");
  list.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const rows = AGENTS.filter((a) => f === "" || a.name.includes(f) || a.cmd.includes(f));
  const sorted = [...rows].sort((a, b) => (freq.get(b.name) ?? 0) - (freq.get(a.name) ?? 0));
  sorted.forEach((a, i) => {
    const li = document.createElement("li");
    li.tabIndex = 0;
    if (i === 0) li.classList.add("top");
    li.innerHTML = `<img src="assets/agents/${a.icon}" alt=""><span>${a.name}</span><span class="qp-cmd">${a.cmd}</span><span class="qp-freq">${freq.get(a.name) ?? 0}×</span>`;
    li.addEventListener("click", () => {
      freq.set(a.name, (freq.get(a.name) ?? 0) + 1);
      renderPicker($("qp-filter").value);
    });
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } });
    list.appendChild(li);
  });
  if (showHidden) {
    const sep = document.createElement("li");
    sep.className = "sep";
    sep.textContent = "Not installed";
    list.appendChild(sep);
    HIDDEN.forEach((a) => {
      const li = document.createElement("li");
      li.innerHTML = `<img src="assets/agents/${a.icon}" alt=""><span>${a.name}</span><span class="qp-cmd">${a.cmd}</span><span class="qp-freq"></span>`;
      list.appendChild(li);
    });
  }
}
renderPicker();

$("qp-filter").addEventListener("input", (e) => renderPicker(e.target.value));
const eye = $("qp-eye");
function toggleEye() {
  showHidden = !showHidden;
  eye.setAttribute("aria-pressed", String(showHidden));
  renderPicker($("qp-filter").value);
}
eye.addEventListener("click", toggleEye);
eye.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleEye(); } });

const WALL_NOTE =
  `<strong>Reports itself:</strong> OpenCode, Codex, pi, Crush (and Claude Code with a per-launch reporter). ` +
  `<strong>Watched:</strong> Copilot, Gemini, Goose, Aider, Qwen, Grok, Droid, Amp, Plandex, Cody, Kilo, Qodo, Command Code. ` +
  `Bring your own command and it gets the same treatment.`;
const wallNote = $("wall-note");
if (wallNote) wallNote.innerHTML = WALL_NOTE;

const wall = $("wall");
const MY_TILE = { name: "your own", icon: "terminal.svg" };
[...AGENTS, MY_TILE].forEach((a) => {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.innerHTML = `<img src="assets/agents/${a.icon}" alt=""><span>${a.name}</span>`;
  wall.appendChild(tile);
});

const CYCLE = [
  { title: "claude wants your approval", body: "Permission request · refactor the parser", glyph: "g-blocked", mark: "⏸", what: "waiting on permission", row: 0 },
  { title: "codex finished its turn", body: "3 files changed · 4m 12s", glyph: "g-done", mark: "done", what: "turn complete", row: 2 },
  { title: "aider exited with an error", body: "exit code 1", glyph: "g-error", mark: "error", what: "exited 1", row: 3 },
];
let cycleIndex = 0;
function pingStep() {
  const step = CYCLE[cycleIndex % CYCLE.length];
  cycleIndex += 1;
  $("banner-title").textContent = step.title;
  $("banner-body").textContent = step.body;
  const rows = document.querySelectorAll("#ping .pb-row");
  rows.forEach((r) => { r.style.background = ""; });
  if (rows[step.row]) rows[step.row].style.background = "var(--vshover)";
}
if (!reduced) setInterval(pingStep, 3400);

const demoImg = $("demo-img");
const demoPlay = $("demo-play");
function playDemo() {
  const v = document.createElement("video");
  v.src = "assets/demo.mp4";
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("aria-label", demoImg.alt);
  demoImg.replaceWith(v);
  if (demoPlay) demoPlay.remove();
}
if (demoImg && demoPlay) {
  demoPlay.addEventListener("click", playDemo);
  demoImg.addEventListener("click", playDemo);
}

const FAQ = [
  { q: "Does it install anything?", a: "No. It reads your PATH, launches terminals, and watches what they print. The one exception is per-launch and reversible: Claude Code is started with a --settings flag pointing at a hooks file shipped inside the extension, because VS Code cannot answer Claude’s status handshake. Nothing is ever written to ~/.claude, ~/.config/opencode, or any agent’s own config." },
  { q: "Which agents report their own status?", a: "OpenCode, Codex, pi and Crush report over OSC 7501; Claude Code reports through a per-launch reporter. Everyone else is tracked by reading the window title, progress sequences and output, with per-agent rules ported from Herdr (Apache-2.0)." },
  { q: "Does it work in Cursor, Windsurf or Trae?", a: "Yes — any VS Code-compatible editor from version 1.93 onward. That covers VS Code, Cursor, Windsurf, Trae, Antigravity and Vodium. The only requirement is terminal shell integration." },
  { q: "What is OSC 7501?", a: "An open protocol where a program announces its state over the terminal: working, blocked, done. Announced in October 2026 and already shipped by Claude Code, OpenCode, Codex, pi, Crush, Copilot CLI and others. When an agent speaks it, Agent Quickpick believes it word for word." },
  { q: "What does it cost?", a: "Nothing. It is MIT-licensed and open source. No telemetry, no account, no subscription." },
  { q: "Windows and Linux?", a: "The extension runs everywhere, and status detection works on every platform. Only the injected Claude reporter is skipped on Windows — Claude there falls back to reading the terminal like everyone else." },
];
const faqList = $("faq-list");
FAQ.forEach((item) => {
  const wrap = document.createElement("div");
  wrap.className = "faq-item";
  const q = document.createElement("div");
  q.className = "faq-q";
  q.setAttribute("role", "button");
  q.setAttribute("tabindex", "0");
  q.innerHTML = `<span>${item.q}</span><span class="faq-mark">+</span>`;
  const a = document.createElement("div");
  a.className = "faq-a";
  a.textContent = item.a;
  const toggle = () => {
    const open = wrap.classList.toggle("open");
    q.querySelector(".faq-mark").textContent = open ? "−" : "+";
  };
  q.addEventListener("click", toggle);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  wrap.appendChild(q);
  wrap.appendChild(a);
  faqList.appendChild(wrap);
});

const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
}, { threshold: 0.15 });
document.querySelectorAll("section > h2, .hero-copy > *, .hero-demo, .ping-copy, .ping-stage, .beat, .picker-copy, .qp, .agents-head, .tile, .know-cell, .arch-band, .faq-list").forEach((el, i) => {
  el.classList.add("anim");
  if (i % 3 === 1) el.style.transitionDelay = "70ms";
  if (i % 3 === 2) el.style.transitionDelay = "140ms";
  io.observe(el);
});
setTimeout(() => document.querySelectorAll(".anim:not(.in)").forEach((el) => el.classList.add("in")), 3000);
