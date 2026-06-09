#!/usr/bin/env node
'use strict';

// nudges — scheduled reminders injected into your AI agent's context.
// As a Claude Code plugin this runs from a UserPromptSubmit hook (no args) and prints
// the due reminders as additionalContext JSON. With a subcommand it manages on-disk
// state:  done <id> | skip <id> | snooze <id> <HH:MM> | undo <id>
//
// Config + state live in the plugin data dir (CLAUDE_PLUGIN_DATA) so they survive
// updates and never touch the repo. On first run the config is seeded from
// nudges.example.yaml. Override any path via env: NUDGE_CONF / NUDGE_STATE_DIR.
// Test overrides: NUDGE_NOW=HH:MM  NUDGE_TODAY=YYYY-MM-DD

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR  = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugin-data', 'nudges');
const CONF      = process.env.NUDGE_CONF      || path.join(DATA_DIR, 'nudges.yaml');
const STATE_DIR = process.env.NUDGE_STATE_DIR || path.join(DATA_DIR, 'state');
const EXAMPLE   = path.join(__dirname, 'nudges.example.yaml');
const ACK_FILE    = path.join(STATE_DIR, 'nudge-acks');     // "<date> <id> <status>"
const SNOOZE_FILE = path.join(STATE_DIR, 'nudge-snoozes');  // "<date> <id> <untilMins>"
const IVL_FILE    = path.join(STATE_DIR, 'nudge-intervals');// "<id> <epoch>"

// How the agent invokes us (shown in footers).
const SELF = process.env.NUDGE_CMD || `node ${__filename}`;

// ---- time helpers (NUDGE_NOW / NUDGE_TODAY override for tests) ----
const pad = (n) => String(n).padStart(2, '0');
const hm2min = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
function clock() {
  if (process.env.NUDGE_NOW) { const [h, m] = process.env.NUDGE_NOW.split(':').map(Number); return { hm: process.env.NUDGE_NOW, mins: h * 60 + m }; }
  const d = new Date();
  return { hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, mins: d.getHours() * 60 + d.getMinutes() };
}
function today() {
  if (process.env.NUDGE_TODAY) return process.env.NUDGE_TODAY;
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const nowEpoch = () => Math.floor(Date.now() / 1000);

// ---- first-run: seed the user's config from the shipped example ----
function ensureConfig() {
  if (fs.existsSync(CONF)) return true;
  try {
    fs.mkdirSync(path.dirname(CONF), { recursive: true });
    fs.copyFileSync(EXAMPLE, CONF);
    process.stderr.write(`nudges: created ${CONF} from the example — edit it to set up your reminders.\n`);
    return true;
  } catch (e) {
    process.stderr.write(`nudges: could not create config at ${CONF}: ${e.message}\n`);
    return false;
  }
}

// ---- tiny line-based state store ----
function readLines(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } }
function writeLines(file, lines) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : ''); }

function ackedToday(id) { const t = today(); return readLines(ACK_FILE).some((l) => l === `${t} ${id}` || l.startsWith(`${t} ${id} `)); }
function snoozeUntil(id) { const t = today(); let u = null; for (const l of readLines(SNOOZE_FILE)) { const [d, i, m] = l.split(' '); if (d === t && i === id) u = Number(m); } return u; }
function intervalLast(id) { for (const l of readLines(IVL_FILE)) { const [i, e] = l.split(' '); if (i === id) return Number(e); } return null; }
function setIntervalLast(id, epoch) { const lines = readLines(IVL_FILE).filter((l) => l.split(' ')[0] !== id); lines.push(`${id} ${epoch}`); writeLines(IVL_FILE, lines); }

// ---- rendering ----
const actionsFor = (n) => (n.kind === 'scheduled' ? '[done/skip/snooze]' : '[snooze]');
const tiersOf = (n) => (n.tiers && n.tiers.length ? n.tiers : [{ time: n.time, message: n.message }]);

// Latest tier whose time has passed; null if not due. Handles midnight wrap when
// stops_at is earlier than the start (e.g. bedtime 22:00 -> 06:00).
function dueScheduled(n, mins) {
  const tiers = tiersOf(n);
  const start = hm2min(tiers[0].time);
  if (Number.isNaN(start)) return tiers[0]; // no time given = always active (fires until acked/removed)
  const wrap = n.stops_at != null && hm2min(n.stops_at) < start;

  if (n.stops_at != null) {
    const end = hm2min(n.stops_at);
    const inWin = wrap ? (mins >= start || mins < end) : (mins >= start && mins < end);
    if (!inWin) return null;
  } else if (mins < start) {
    return null;
  }

  const off = (m) => (wrap && m < start ? m + 1440 - start : m - start);
  const nowOff = off(mins);
  let best = null, bestOff = -1;
  for (const tier of tiers) {
    const tOff = off(hm2min(tier.time));
    if (nowOff >= tOff && tOff > bestOff) { bestOff = tOff; best = tier; }
  }
  return best;
}

// ---- the hook ----
function runHook() {
  let yaml;
  try { yaml = require('js-yaml'); }
  catch { process.stderr.write(`nudges: js-yaml not installed — run \`npm install\` in ${__dirname}\n`); return; }
  if (!ensureConfig()) return;

  let conf;
  try { conf = yaml.load(fs.readFileSync(CONF, 'utf8')); }
  catch (e) { process.stderr.write(`nudges: cannot read config: ${e.message}\n`); return; }
  if (!Array.isArray(conf)) return;

  const { hm, mins } = clock();
  const fired = [];

  for (const n of conf) {
    if (!n || !n.id || !n.kind) continue;

    if (n.kind === 'interval') {
      if (n.window) { const [ws, we] = n.window.split('-'); if (!(mins >= hm2min(ws) && mins < hm2min(we))) continue; }
      const suI = snoozeUntil(n.id);
      if (suI != null && mins < suI) continue;                       // snoozed
      const every = Number(n.every || 60);
      const last = intervalLast(n.id);
      const e = nowEpoch();
      if (last == null) { setIntervalLast(n.id, e); continue; }      // start the clock, don't fire
      if (e - last >= every * 60) { setIntervalLast(n.id, e); fired.push({ n, body: n.message }); }
      continue;
    }

    if (n.kind === 'scheduled') {
      if (ackedToday(n.id)) continue;
      const su = snoozeUntil(n.id);
      if (su != null && mins < su) continue;                          // snoozed
      const tier = dueScheduled(n, mins);
      if (tier) fired.push({ n, body: tier.message });
    }
  }

  if (!fired.length) return;

  const preamble =
    `[NUDGES · now ${hm}] Relay each reminder below to the user. ` +
    `Each repeats every message until handled. When they confirm they ACTUALLY did it ` +
    `(not just say they will), clear it: ${SELF} done <id>  (also: skip <id>, snooze <id> HH:MM).`;
  const lines = fired.map((f) => `• ${f.n.id} ${actionsFor(f.n)}: ${f.body}`);
  const ctx = preamble + '\n' + lines.join('\n');

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }) + '\n');
}

// ---- subcommands ----
function ackWrite(id, status) {
  if (!id) { console.log(`usage: ${status === 'skipped' ? 'skip' : 'done'} <id>`); process.exit(1); }
  const t = today();
  if (ackedToday(id)) { console.log(`already acked today: ${id} (${t})`); return; }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(ACK_FILE, `${t} ${id} ${status}\n`);
  console.log(`marked ${status}: ${id} (${t})`);
}
function cmdUndo(id) {
  if (!id) { console.log('usage: undo <id>'); process.exit(1); }
  const t = today();
  const reAck = new RegExp(`^${t} ${id}( |$)`);
  const acks = readLines(ACK_FILE), keptAcks = acks.filter((l) => !reAck.test(l));
  const sn = readLines(SNOOZE_FILE), keptSn = sn.filter((l) => { const [d, i] = l.split(' '); return !(d === t && i === id); });
  let changed = false;
  if (keptAcks.length !== acks.length) { writeLines(ACK_FILE, keptAcks); changed = true; }
  if (keptSn.length !== sn.length) { writeLines(SNOOZE_FILE, keptSn); changed = true; }
  console.log(changed ? `re-armed: ${id} (${t})` : `nothing to undo: ${id} (${t})`);
}
function cmdSnooze(id, hhmm) {
  if (!id || !/^\d{1,2}:\d{2}$/.test(hhmm || '')) { console.log('usage: snooze <id> <HH:MM>'); process.exit(1); }
  const t = today();
  const lines = readLines(SNOOZE_FILE).filter((l) => { const [d, i] = l.split(' '); return !(d === t && i === id); });
  lines.push(`${t} ${id} ${hm2min(hhmm)}`);
  writeLines(SNOOZE_FILE, lines);
  console.log(`snoozed: ${id} until ${hhmm} today`);
}

// ---- dispatch ----
const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case undefined:
  case 'hook':   runHook(); break;
  case 'done':   ackWrite(a, 'done'); break;
  case 'skip':   ackWrite(a, 'skipped'); break;
  case 'undo':   cmdUndo(a); break;
  case 'snooze': cmdSnooze(a, b); break;
  default: process.stderr.write(`unknown command: ${cmd}\n`); process.exit(1);
}
