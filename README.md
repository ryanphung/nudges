# nudges

**Scheduled nudges for your AI agent** — gentle, time-based reminders (meds, meals,
bedtime, standups, breaks, "drink water") injected into your agent's context every turn,
so it reminds *you*.

A [Claude Code](https://code.claude.com) plugin. Born one night when its author kept
working past his own bedtime — and grew into a general reminder engine.

## Why it works this way

Your agent has **no background clock** — it only acts when you message it. So instead of
fighting that, `nudges` checks the time on each prompt and surfaces whatever is due. The
reminder reaches you exactly when you're at the keyboard, and never nags while you sleep
(no messages = no nudges). It's *push*, not a tool the agent has to remember to call.

## Install

```
/plugin install github:ryanphung/nudges
```

On first run it seeds a starter config at `~/.claude/plugin-data/nudges/nudges.yaml` and
greets you with a `setup-nudges` reminder that walks you through making it yours.

> Requires `node` on your PATH (used by the hook). Works on macOS, Linux, and Windows.

## Configure

Edit `~/.claude/plugin-data/nudges/nudges.yaml`. Two kinds of nudge:

```yaml
# Fires at a clock time, until you acknowledge it:
- id: lunch
  kind: scheduled
  time: "12:00"
  message: "Remind me to have lunch — a late lunch still counts."

# Escalating tiers + an end time that wraps past midnight:
- id: bedtime
  kind: scheduled
  stops_at: "06:00"
  tiers:
    - { time: "22:00", message: "Wind-down hour — pick a stopping point." }
    - { time: "00:00", message: "Past midnight — head to bed." }

# Fires every N minutes while you're active:
- id: water
  kind: interval
  every: 60
  message: "Drink some water."

# No time = always active until you handle or delete it (great for one-off setup/todos):
- id: call-the-dentist
  kind: scheduled
  message: "Remind me to call the dentist."
```

| field | meaning |
|---|---|
| `id` | short name + the handle for done/skip/snooze/undo |
| `kind` | `scheduled` (clock time / tiers, ack-able) or `interval` (every N min) |
| `time` | `"HH:MM"`; **omit** for an always-active reminder |
| `tiers` | `[{time, message}]` — escalation; latest passed tier shows |
| `stops_at` | scheduled only; when it stops (earlier than start ⇒ wraps midnight) |
| `every` | interval only; minutes between fires |
| `message` | the reminder, written as an instruction to the agent |

## Acknowledging

When a nudge fires, just tell your agent — it runs the right command for you:

```
node <plugin>/nudges.js done   <id>          # I did it (stops today; resets tomorrow)
node <plugin>/nudges.js skip   <id>          # consciously skipping today
node <plugin>/nudges.js snooze <id> HH:MM    # quiet until a time, then resume
node <plugin>/nudges.js undo   <id>          # re-arm (clears done/skip/snooze)
```

The agent acknowledges on real **confirmation** ("I ate"), not intent ("I'm about to") —
because people get pulled away. The first time it runs a command you may be asked to
approve it; allowing `Bash(node …/nudges.js:*)` once makes it seamless.

## How it stays out of your way

- **Silent when nothing's due** — zero context cost on a normal message.
- **No give-up cutoffs** — a late lunch still counts; deadlines escalate rather than go quiet.
- **Everything is snoozeable**; bedtime-style nudges just stop at `stops_at` (you can't
  press *done* while asleep — going idle is the acknowledgment).
- **Your config + state live in the data dir**, never in this repo, and reset daily.

## Develop

```
npm install
npm test          # Node's built-in test runner
npm run coverage
```

Config is data (`nudges.yaml`); the engine (`nudges.js`) has no runtime deps beyond
`js-yaml`. Tests pin against `test/fixtures/`, independent of any personal config.

## License

MIT
