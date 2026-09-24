/**
 * Bench scenarios for the data-plane hot paths — everything that runs in plain
 * Node without a VS Code host (the same import surface as the unit tier).
 * Scenario list is deliberately short: only paths with a plausible reason to
 * get slower (called per keystroke, per hook event, per poll tick, or over
 * user-controlled file sizes). Adding one means having a refactor in mind
 * whose impact it would measure — this is an A/B tool, not a scoreboard.
 *
 * Fixtures approximate real shapes: a Claude-style ~/.claude/settings.json at
 * the size seen in the wild (~8 KB) and a stressed variant (~500 KB), a
 * frecency map far larger than any real user's, and terminal counts past the
 * "how many agents would you seriously run" horizon.
 */

import * as http from "http";
import * as vscode from "vscode";

import {
  type FrecencyMap,
  type MementoLike,
  loadAgents,
  sortByFrecency,
  frecencyScore,
  recordLaunch,
} from "../../agents";
import {
  type SessionState,
  countByStatus,
  statusBarText,
  statusBarTooltip,
  pollExitStatuses,
  readConfigJson,
  writeConfigJson,
  startLifecycleServer,
} from "../../lifecycle";
import { CLAUDE_ADAPTER } from "../../lifecycle-adapters";
import type { BenchFn } from "./harness";

export interface Scenario {
  name: string;
  iterations?: number;
  warmup?: number;
  /** Build fixtures; returns the per-iteration function under test. */
  setup(): BenchFn;
  /** Release scenario-owned resources (the HTTP server). */
  teardown?(): void;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const HOOK_URL = "http://127.0.0.1:63742";
const PORT_FILE =
  "/Users/someone/Library/Application Support/Trae/User/globalStorage/agent-quickpick/hook-server.json";
const SESSION = "Claude";
const NOW = 1_700_000_000_000;

/** A plausible *user-owned* hook command (~1.3 KB, like real ones). */
function userHookCommand(i: number): string {
  return (
    `node /Users/someone/.local/share/some-notifier/dist/cli.js ` +
    `--event "$HOOK_EVENT" --session "$SESSION_ID" --config /Users/someone/.config/some-notifier/config.toml ` +
    `--token tok-${i} ` +
    "x".repeat(1100)
  );
}

/**
 * A Claude-style settings.json: a handful of top-level keys plus N user hooks
 * spread over events, optionally with our hooks already merged in (what
 * autoUpgradeHooks inspects on every activation).
 */
function claudeStyleConfigText(userHooks: number, oursInstalled: boolean): string {
  const events = ["Stop", "Notification", "PreToolUse", "PostToolUse", "SessionStart"];
  const hooks: Record<string, unknown[]> = {};
  for (let i = 0; i < userHooks; i++) {
    const event = events[i % events.length];
    (hooks[event] ??= []).push({
      matcher: i % 3 === 0 ? "Bash|Edit" : undefined,
      hooks: [{ type: "command", command: userHookCommand(i) }],
    });
  }
  let config: unknown = {
    model: "claude-sonnet-4-5",
    permissions: { allow: ["Bash(npm run *)", "Read(~/**)"], deny: ["Bash(curl *)"] },
    env: { FORCE_COLOR: "1", NO_UPDATE_NOTIFIER: "1" },
    statusLine: { type: "command", command: userHookCommand(999) },
    hooks,
  };
  if (oursInstalled) {
    config = CLAUDE_ADAPTER.mergeHooks(config, HOOK_URL, SESSION, PORT_FILE);
  }
  return writeConfigJson(config);
}

/** Map-backed vscode.Memento stand-in (same shape as the unit-tier fake). */
function fakeMemento(initial: Record<string, unknown>): MementoLike {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      store.set(key, value);
    },
  };
}

/** A frecency map with `n` entries, all last-used within the prune horizon. */
function seededFrecency(n: number): FrecencyMap {
  const map: FrecencyMap = {};
  for (let i = 0; i < n; i++) {
    map[`agent-${i}`] = { c: 1 + (i % 40), t: NOW - (i % 90) * 86_400_000 };
  }
  return map;
}

/** Structural fake of vscode.Terminal — only name/creationOptions/exitStatus are read. */
function terminal(name: string, exitCode?: number): vscode.Terminal {
  return {
    name,
    creationOptions: { name },
    ...(exitCode !== undefined ? { exitStatus: { code: exitCode } } : {}),
  } as vscode.Terminal;
}

/** n terminals: mostly agent-named (mixed exited/running) plus plain shells. */
function fakeTerminals(n: number, agentNames: Set<string>): vscode.Terminal[] {
  const agents = [...agentNames];
  const terminals: vscode.Terminal[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) {
      terminals.push(terminal(`zsh${i > 0 ? ` (${i})` : ""}`)); // not ours
      continue;
    }
    const base = agents[i % agents.length];
    const display = i >= agents.length ? `${base} (${Math.floor(i / agents.length) + 1})` : base;
    terminals.push(terminal(display, i % 3 === 0 ? undefined : i % 7));
  }
  return terminals;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const AGENT_NAMES = new Set(["claude", "codex", "opencode", "pi", "oh-my-pi", "droid", "antigravity"]);

/** The install/upgrade pipeline exactly as installHook runs it: parse → merge → serialize. */
function hookInstallPipeline(sizeLabel: string, userHooks: number, iterations: number): Scenario {
  return {
    name: `hooks: install pipeline (${sizeLabel})`,
    iterations,
    setup: () => {
      const text = claudeStyleConfigText(userHooks, false);
      return () => {
        writeConfigJson(CLAUDE_ADAPTER.mergeHooks(readConfigJson(text), HOOK_URL, SESSION, PORT_FILE));
      };
    },
  };
}

/** A live-server POST round-trip per iteration; the server disposes in teardown. */
function serverRoundTrip(iterations: number): Scenario {
  let server: { dispose(): void } | undefined;
  return {
    name: "server: hook POST round-trip",
    iterations,
    setup: () => {
      const s = startLifecycleServer(() => {});
      server = s;
      const body = Buffer.from(
        JSON.stringify({
          marker: "agentQuickpick:claude",
          session: "Claude (2)",
          status: "finished",
          agentName: "Claude",
          cwd: "/Users/someone/src/my-app",
          message: "",
        })
      );
      let url: string | undefined;
      return async () => {
        // Resolves on the probe (pre-warmup) call only; the timed loop then
        // measures a pure request/response round-trip against the live port.
        url ??= await s.url;
        await new Promise<void>((resolve, reject) => {
          const req = http.request(
            url as string,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": body.length,
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            }
          );
          req.on("error", reject);
          req.end(body);
        });
      };
    },
    teardown: () => server?.dispose(),
  };
}

export const SCENARIOS: Scenario[] = [
  // --- Hook config file paths (driven by user-controlled file sizes) ---
  hookInstallPipeline("~8 KB", 4, 2000),
  hookInstallPipeline("~500 KB", 330, 100),
  {
    // The full JSON.stringify().includes(marker) containment check — quantifies
    // whether a targeted walk would pay for itself before anyone writes one.
    name: "hooks: hasCommandHooks (~500 KB)",
    iterations: 200,
    setup: () => {
      const parsed = readConfigJson(claudeStyleConfigText(330, true));
      return () => CLAUDE_ADAPTER.hasOurHooks(parsed);
    },
  },
  {
    name: "hooks: hasCurrentCommandHooks (~500 KB)",
    iterations: 2000,
    setup: () => {
      const parsed = readConfigJson(claudeStyleConfigText(330, true));
      return () => CLAUDE_ADAPTER.hasCurrentHooks(parsed);
    },
  },
  {
    name: "hooks: stripCommandHooks (~500 KB, ours installed)",
    iterations: 200,
    setup: () => {
      const parsed = readConfigJson(claudeStyleConfigText(330, true));
      return () => CLAUDE_ADAPTER.stripHooks(parsed);
    },
  },

  // --- Frecency (per quick-pick open + per launch) ---
  ...[100, 1000, 10000].map((n): Scenario => ({
    name: `frecency: sortByFrecency (${n} entries)`,
    iterations: n <= 1000 ? 2000 : 1000,
    setup: () => {
      const map = seededFrecency(n);
      const names = Object.keys(map);
      const scoreOf = (name: string) => {
        const e = map[name];
        return e ? frecencyScore(e.c, e.t, NOW) : 0;
      };
      return () => sortByFrecency(names, scoreOf);
    },
  })),
  {
    // The per-launch write: read + prune-over-all-keys + update.
    name: "frecency: recordLaunch (10k-entry map)",
    iterations: 2000,
    setup: () => {
      const state = fakeMemento({ "frecency.v1": seededFrecency(10000) });
      return () => recordLaunch(state, "agent-0", NOW);
    },
  },

  // --- Exit-status poller (runs every 3s while terminals are open) ---
  ...[10, 100, 500].map((n): Scenario => ({
    name: `poller: pollExitStatuses (${n} terminals)`,
    iterations: n <= 100 ? 5000 : 1000,
    setup: () => {
      const terminals = fakeTerminals(n, AGENT_NAMES);
      const sessions = new Map<string, SessionState>();
      for (let i = 0; i < terminals.length; i += 3) {
        sessions.set(terminals[i].name, {
          name: terminals[i].name,
          agentName: "Claude",
          status: "running",
          changedAt: NOW,
        });
      }
      return () => pollExitStatuses(terminals, sessions, AGENT_NAMES);
    },
  })),

  // --- Hook server round-trip (what every hook event costs on our side) ---
  serverRoundTrip(500),

  // --- Quick-pick list assembly ---
  {
    name: "agents: loadAgents (20 built-ins + 200 user)",
    iterations: 5000,
    setup: () => {
      const userAgents = Array.from({ length: 200 }, (_, i) => ({
        name: `Custom ${i}`,
        cmd: `agent-${i}`,
        icon: "rocket",
        color: "terminal.ansiBlue",
      }));
      return () => loadAgents(userAgents);
    },
  },

  // --- Status-bar re-render (fires on every hook event / poll hit) ---
  {
    name: "render: statusBar text+tooltip (500 sessions)",
    iterations: 2000,
    setup: () => {
      const statuses = ["running", "finished", "waiting", "failed", "unknown"] as const;
      const states: SessionState[] = Array.from({ length: 500 }, (_, i) => ({
        name: `Claude (${i})`,
        agentName: "Claude",
        status: statuses[i % statuses.length],
        changedAt: NOW - i,
        cwd: i % 2 ? "/Users/someone/src/my-app" : undefined,
        launchedInFolder: i % 2 ? undefined : "/Users/someone/src/other",
      }));
      return () => {
        statusBarText(countByStatus(states));
        statusBarTooltip(states);
      };
    },
  },
];
