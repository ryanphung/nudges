# nudges — design notes & rationale

(User-facing usage lives in [README.md](./README.md); this is the *why*.)

## What it is

A tiny, config-driven reminder system for AI agents, shipped as a Claude Code plugin. A `UserPromptSubmit` hook injects time-based reminders (meds, meals, pickup, bedtime, breaks, water — anything time-based) into the agent's context; the agent relays them to the user. No background process, no separate app — the reminders ride on the messages you're already sending.

## Why it works this way

The agent has **no background clock** — it only acts when you message it. So rather than fight that, the hook checks the time on each message and surfaces whatever is due. Reminders reach you exactly when you're at the keyboard, and never nag while you sleep (no messages = no nudges).

## Origin

Born 2026-06-08 as a 2am "go to bed" nag (the author kept working past his own 1am limit). Over a single day it grew into a general nudge engine, then a standalone plugin.

## Design decisions (the non-obvious ones)

- **Relay through the agent, not a direct OS notification.** The hook injects `additionalContext` only (no `systemMessage`) — a deliberate experiment in whether the agent reliably *relaying* the nudge is enough. (Revisit if it proves unreliable.)
- **Acknowledge on confirmation, not intent.** "I ate" ends a nudge; "I'm going to" does not (people get pulled away).
- **Keep the rules in the emitted text, not the agent's memory.** Portable — the guidance ships with the tool and works for any user/agent.
- **Judgment over baked rules.** Whether to honor a *skip* (lenient for lunch; push back on child pickup unless someone else is collecting) or a long *snooze* on something you can't miss is the agent's call — not enforced by config flags. The deadline lives in the message text so the agent can reason about it.
- **No give-up cutoffs.** A late lunch still counts; a deadline escalates past its time instead of going silent.
- **Snooze on everything.**
- **Config split from code.** All nudges live in `nudges.yaml`; adding one needs no code change.
- **"Idle is the ack" for bedtime.** Scheduled nudges *can* be acknowledged, but you can't press *done* while asleep — so bedtime usually just ends with you going idle (your absence is the signal), and its `stops_at` silences it in the morning regardless.
- **Node engine for cross-platform.** Pure shell would exclude native Windows; Node runs everywhere Claude Code does.

## Architecture

### The config — `nudges.yaml`

Config has three roles: **`nudges.yaml`** is the user's personal config (lives in the plugin data dir `~/.claude/plugin-data/nudges/`, seeded from the example on first run — never in the repo); **`nudges.example.yaml`** is the shipped sample (ships with a single self-deleting `setup-nudges` onboarding reminder); and **`test/fixtures/`** holds stable configs the test suite pins against, so changing the example never breaks the tests.

Two kinds of nudge:

- **scheduled** — fires at a clock time (or escalating `tiers`) until acknowledged (`done`/`skip`), or until its optional `stops_at` (earlier-than-start wraps past midnight, as bedtime does `22:00 → 06:00`). **Omit `time`** for an always-active reminder that fires every turn until acked or removed (good for one-off setup/todos).
- **interval** — fires every N minutes whenever you're active (water, movement). First fire is ~`every` minutes after you start; no ack.
- All nudges are snoozeable.

### The engine — `nudges.js` (Node; depends on `js-yaml`)

Run with no argument it's the hook; with a subcommand it manages state: `done` / `skip` / `snooze <HH:MM>` / `undo`. Config + state default to the plugin data dir (`CLAUDE_PLUGIN_DATA`); every path is env-overridable (`NUDGE_CONF`, `NUDGE_STATE_DIR`), which is what makes the tests hermetic.

**State** (acks, snoozes, interval timestamps) lives on disk, keyed by date so it auto-resets daily, kept out of git.

**Assembly** — when nudges are due, the engine emits a one-time **preamble** (current time + the relay instruction + the confirm-not-intent rule + the command to acknowledge), then one line per nudge:

```
• <id> [done/skip/snooze]: <message>
```

The action hint comes from the kind (`scheduled` → `[done/skip/snooze]`, `interval` → `[snooze]`); the full command is stated once in the preamble, not repeated per line. When nothing is due, the engine emits nothing at all (zero context cost).

## Status

- **Released** as a Claude Code plugin (this repo): engine + `hooks/hooks.json` + manifest, with 23 tests via `node --test` (`npm test` / `npm run coverage`).
- **Roadmap:** clean-machine install test; submit to the community marketplace; optional direct-notification channel; a per-user configurable name (the engine text is already name-neutral, but example messages say "the user").

## Lineage

Originated as a one-off bedtime nag, incubated inside a personal repo for version control, then graduated here as a standalone open-source plugin.
