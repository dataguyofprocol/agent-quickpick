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
} from "../../lifecycle";
import { ProgramStatusParser } from "../../program-status";
import { TerminalSignals } from "../../terminal-signals";
import { SessionTracker } from "../../session-tracker";
import {
  cleanupLegacyHooks,
  readConfigJson,
  stripCommandHooks,
  writeConfigJson,
  type LegacyIo,
} from "../../legacy-hooks";
import type { BenchFn } from "./harness";

export interface Scenario {
  name: string;
  iterations?: number;
  warmup?: number;
  setup(): BenchFn;
  teardown?(): void;
}

const NOW = 1_700_000_000_000;
const MARKER = "agentQuickpick:claude";

function userHookCommand(i: number): string {
  return `node -e "/* user hook ${i} */ const x = ${JSON.stringify("y".repeat(1200))};"`;
}

function claudeSettings(extra: number): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  const perEvent = Math.max(1, Math.ceil(extra / 6 / 1300));
  for (const event of ["Stop", "Notification", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    hooks[event] = Array.from({ length: perEvent }, (_, i) => ({
      matcher: "*",
      hooks: [{ type: "command", command: userHookCommand(i) }],
    }));
  }
  return { model: "sonnet", hooks };
}

function agentBurst(status: "working" | "blocked" | "done"): string {
  const msg = Buffer.from(`Refactoring ${"x".repeat(40)}`).toString("base64");
  return [
    "\u001b[2K\u001b[1A\u001b[2K",
    "⠹ Running…\r⠸ Running…\r⠼ Running…\r",
    "\u001b]2;⠹ claude — refactoring\u0007",
    "\u001b]9;4;3;\u0007",
    `\u001b]7501;state=${status}:kind=permission:app=claude-code:msg=${msg}\u001b\\`,
    "\u001b[38;5;246m❯\u001b[0m ",
  ].join("");
}

const PERMISSION_TAIL = [
  "╭──────────────────────────────────────────────╮",
  "│ Bash command                                 │",
  "│   rm -rf build                               │",
  "│                                              │",
  "│ Do you want to proceed?                      │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and don't ask again for: rm*        │",
  "│   3. No                                      │",
  "╰──────────────────────────────────────────────╯",
  "  esc to cancel · tab to amend",
].join("\n");

export const SCENARIOS: Scenario[] = [
  {
    name: "osc7501: parse + snapshot (realistic burst)",
    iterations: 4000,
    setup: () => {
      const burst = agentBurst("working");
      const parser = new ProgramStatusParser();
      return () => {
        parser.push(burst);
      };
    },
  },
  {
    name: "signals: title + progress + text tail (realistic burst)",
    iterations: 4000,
    setup: () => {
      const burst = agentBurst("working");
      const signals = new TerminalSignals();
      return () => {
        signals.push(burst);
        signals.text();
      };
    },
  },
  {
    name: "status: classify from a permission prompt (24-line tail)",
    iterations: 4000,
    setup: () => {
      const tracker = new SessionTracker();
      tracker.track("Claude", "Claude");
      tracker.output("Claude", "start", NOW);
      let clock = NOW + 5_000;
      const chunk = `${PERMISSION_TAIL}\u001b]2;Claude\u0007`;
      return () => {
        clock += 1_000;
        tracker.output("Claude", chunk, clock);
        tracker.tick(clock);
      };
    },
  },
  {
    name: "status: classify with no rule match (activity/idle decay)",
    iterations: 4000,
    setup: () => {
      const tracker = new SessionTracker();
      tracker.track("Claude", "Claude");
      tracker.output("Claude", "hello", NOW);
      let clock = NOW + 5_000;
      return () => {
        clock += 1_000;
        tracker.output("Claude", "plain line\n", clock);
        tracker.tick(clock);
      };
    },
  },
  {
    name: "legacy: strip our hooks (~500 KB config)",
    iterations: 200,
    setup: () => {
      const config = claudeSettings(500 * 1024);
      const hooks = config.hooks as Record<string, unknown[]>;
      hooks.Stop = [
        ...(hooks.Stop ?? []),
        {
          matcher: "*",
          hooks: [
            { type: "command", command: userHookCommand(999) },
            { type: "command", command: `node -e "/*${MARKER}:v4*/post()"` },
          ],
        },
      ];
      return () => {
        stripCommandHooks(config, MARKER);
      };
    },
  },
  {
    name: "legacy: cleanup pass over every target (in-memory IO)",
    iterations: 100,
    setup: () => {
      const parsed = stripCommandHooks(claudeSettings(8 * 1024), MARKER);
      const installed = JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: `node -e "/*${MARKER}*/"` }] }] },
      });
      const files = new Map<string, string>([
        ["/home/me/.claude/settings.json", installed],
        ["/home/me/.factory/settings.json", installed],
        ["/home/me/.codex/hooks.json", installed],
        ["/home/me/.gemini/config/hooks.json", JSON.stringify({ "agent-quickpick": { Stop: [{ command: `x ${MARKER}` }] } })],
        ["/home/me/.config/opencode/plugin/agent-quickpick-lifecycle.js", `/* ${MARKER} */`],
        ["/home/me/.pi/agent/extensions/agent-quickpick-lifecycle.js", `/* ${MARKER} */`],
      ]);
      const io: LegacyIo = {
        read: async (file) => {
          const text = files.get(file);
          if (text === undefined) return undefined;
          return text;
        },
        write: async (file, text) => {
          files.set(file, text);
        },
        remove: async (file) => {
          files.delete(file);
        },
      };
      return async () => {
        files.set("/home/me/.claude/settings.json", installed);
        await cleanupLegacyHooks(io, { PI_CODING_AGENT_DIR: "/home/me/.pi/agent" }, "linux", "/home/me");
      };
    },
  },
  {
    name: "legacy: read + write config JSON (~500 KB)",
    iterations: 200,
    setup: () => {
      const text = writeConfigJson(claudeSettings(500 * 1024));
      return () => {
        writeConfigJson(readConfigJson(text));
      };
    },
  },
  {
    name: "poll: exit statuses (500 terminals)",
    iterations: 2000,
    setup: () => {
      const agentNames = new Set(["claude", "codex", "opencode", "pi"]);
      const terminals = Array.from({ length: 500 }, (_, i) => ({
        name: `Claude (${i})`,
        ...(i % 3 === 0 ? { exitStatus: { code: i % 6 === 0 ? 0 : 1 } } : {}),
      })) as unknown as vscode.Terminal[];
      return () => {
        pollExitStatuses(terminals, agentNames);
      };
    },
  },
  {
    name: "frecency: recordLaunch (10k-entry map)",
    iterations: 5000,
    setup: () => {
      const state: FrecencyMap = {};
      for (let i = 0; i < 10_000; i++) {
        state[`agent ${i}`] = { c: i % 50, t: NOW - i * 60_000 };
      }
      const memento: MementoLike = {
        get: <T>() => state as unknown as T,
        update: () => {},
      };
      let i = 0;
      return () => {
        recordLaunch(memento, `Agent ${i++ % 10_000}`, NOW);
      };
    },
  },
  {
    name: "frecency: sort 320 agents",
    iterations: 5000,
    setup: () => {
      const agents = Array.from({ length: 320 }, (_, i) => ({
        name: `Agent ${i}`,
        cmd: `agent-${i}`,
        icon: "claude.svg",
        color: "terminal.ansiGreen",
      }));
      const state: FrecencyMap = {};
      for (let i = 0; i < agents.length; i++) {
        state[agents[i].name.toLowerCase()] = { c: i % 40, t: NOW - i * 3600_000 };
      }
      return () => {
        sortByFrecency(agents, (a) => {
          const entry = state[a.name.toLowerCase()];
          return entry ? frecencyScore(entry.c, entry.t, NOW) : 0;
        });
      };
    },
  },
  {
    name: "agents: loadAgents (20 built-ins + 200 user)",
    iterations: 2000,
    setup: () => {
      const user = Array.from({ length: 200 }, (_, i) => ({
        name: `Custom ${i}`,
        cmd: `custom-${i}`,
      }));
      return () => {
        loadAgents(user);
      };
    },
  },
  {
    name: "render: statusBar text+tooltip (500 sessions)",
    iterations: 2000,
    setup: () => {
      const statuses = ["working", "done", "blocked", "error", "idle", "unknown"] as const;
      const states: SessionState[] = Array.from({ length: 500 }, (_, i) => ({
        name: `Claude (${i})`,
        agentName: "Claude",
        status: statuses[i % statuses.length],
        changedAt: NOW - i * 1000,
        cwd: `/repo/${i}`,
        source: "osc",
      }));
      return () => {
        statusBarTooltip(states);
        statusBarText(countByStatus(states));
      };
    },
  },
];
