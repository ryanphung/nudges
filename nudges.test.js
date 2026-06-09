'use strict';

// Tests for nudges.js using Node's built-in test runner (zero deps).
// Run:  node --test   (or: npm test).  Coverage: npm run coverage.
// Each test drives the engine as a subprocess via env overrides
// (NUDGE_CONF / NUDGE_NOW / NUDGE_TODAY / NUDGE_STATE_DIR), exercising real code paths.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NJ = path.join(__dirname, 'nudges.js');
const FIXTURE = path.join(__dirname, 'test', 'fixtures', 'nudges.yaml'); // stable test config
const TODAY = '2026-06-09';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-test-')); });

function run(env, args = []) {
  return execFileSync('node', [NJ, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NUDGE_CONF: FIXTURE, NUDGE_STATE_DIR: tmp, NUDGE_TODAY: TODAY, ...env },
  });
}
function hook(now, day = TODAY) {
  const out = run({ NUDGE_NOW: now, NUDGE_TODAY: day });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}
const cmd = (...args) => run({}, args);
const seedInterval = (id, secondsAgo) =>
  fs.writeFileSync(path.join(tmp, 'nudge-intervals'), `${id} ${Math.floor(Date.now() / 1000) - secondsAgo}\n`);
const has = (ctx, id) => ctx.includes(`• ${id} `);

describe('scheduled timing + midnight wrap', () => {
  it('is silent when nothing is due (08:00)', () => assert.equal(hook('08:00'), ''));
  it('fires morning-meds at 09:30, not lunch yet', () => {
    const c = hook('09:30');
    assert.ok(has(c, 'morning-meds'));
    assert.ok(!has(c, 'lunch'));
  });
  it('keeps firing morning-meds past its time (no cutoff) alongside lunch', () => {
    const c = hook('12:30');
    assert.ok(has(c, 'morning-meds'));
    assert.ok(has(c, 'lunch'));
  });
  it('shows pickup normal tier before 18:30', () => assert.match(hook('17:00'), /LEAVE by 18:30/));
  it('escalates pickup to the urgent tier after 18:30', () => assert.match(hook('19:00'), /PAST the 18:30/));
  it('fires evening-meds + bedtime wind-down at 22:30', () => {
    const c = hook('22:30');
    assert.ok(has(c, 'evening-meds'));
    assert.match(c, /wind-down/);
  });
  it('wraps past midnight to the PAST-1am tier, with no daytime nudges', () => {
    const c = hook('02:00');
    assert.match(c, /PAST the 1am/);
    assert.ok(!has(c, 'morning-meds') && !has(c, 'lunch'));
  });
  it('goes silent after stops_at (06:30)', () => assert.equal(hook('06:30'), ''));
});

describe('done / skip', () => {
  it('suppresses a nudge once done, leaving others', () => {
    cmd('done', 'lunch');
    const c = hook('12:30');
    assert.ok(!has(c, 'lunch'));
    assert.ok(has(c, 'morning-meds'));
  });
  it('skip suppresses too and records honest status', () => {
    cmd('done', 'lunch');
    cmd('skip', 'morning-meds');
    assert.equal(hook('12:30'), '');
    const acks = fs.readFileSync(path.join(tmp, 'nudge-acks'), 'utf8');
    assert.match(acks, /lunch done/);
    assert.match(acks, /morning-meds skipped/);
  });
});

describe('snooze', () => {
  it('hides a scheduled nudge until the snooze ends', () => {
    cmd('snooze', 'pickup', '17:30');
    assert.ok(!has(hook('17:00'), 'pickup'));
    assert.ok(has(hook('17:45'), 'pickup'));
  });
  it('hides an interval nudge until the snooze ends', () => {
    seedInterval('water', 7200);
    cmd('snooze', 'water', '11:00');
    assert.ok(!has(hook('10:30'), 'water'));
    assert.ok(has(hook('11:15'), 'water'));
  });
});

describe('undo', () => {
  it('re-arms a done nudge', () => {
    cmd('done', 'lunch');
    cmd('undo', 'lunch');
    assert.ok(has(hook('12:30'), 'lunch'));
  });
  it('also clears a snooze', () => {
    cmd('snooze', 'pickup', '18:00');
    cmd('undo', 'pickup');
    assert.ok(has(hook('17:00'), 'pickup'));
  });
});

describe('daily reset', () => {
  it('clears acks the next day', () => {
    cmd('done', 'lunch');
    assert.ok(!has(hook('12:30'), 'lunch'));
    assert.ok(has(hook('12:30', '2026-06-10'), 'lunch'));
  });
});

describe('interval', () => {
  it('starts the clock on first sight without firing', () => {
    const c = hook('10:00');
    assert.ok(!has(c, 'water') && !has(c, 'stretch'));
  });
  it('fires once it is due (last fire 2h ago)', () => {
    seedInterval('water', 7200);
    assert.ok(has(hook('10:00'), 'water'));
  });
  it('does not fire when not yet due (last fire 1 min ago)', () => {
    seedInterval('water', 60);
    assert.ok(!has(hook('10:00'), 'water'));
  });
});

describe('first-run seeding', () => {
  it('creates the config from the example when missing', () => {
    const conf = path.join(tmp, 'seeded.yaml');
    assert.ok(!fs.existsSync(conf));
    const out = run({ NUDGE_NOW: '10:00', NUDGE_CONF: conf }); // missing config -> seeds from nudges.example.yaml
    assert.ok(fs.existsSync(conf));
    assert.match(fs.readFileSync(conf, 'utf8'), /kind:/);
    // first run surfaces the resolved config path so the user knows what to edit
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /First run/);
    assert.ok(ctx.includes(conf));
  });
});

describe('always-active scheduled (no time)', () => {
  it('fires at any time and can be acknowledged', () => {
    const conf = path.join(tmp, 'always.yaml');
    fs.writeFileSync(conf, '- id: setup\n  kind: scheduled\n  message: "Do the setup."\n');
    assert.ok(run({ NUDGE_NOW: '03:17', NUDGE_CONF: conf }).includes('• setup '));
    run({}, ['done', 'setup']);
    assert.ok(!run({ NUDGE_NOW: '03:17', NUDGE_CONF: conf }).includes('• setup '));
  });
});

describe('ack/hook data-dir consistency (installed-plugin fix)', () => {
  // Simulate an installed plugin: the hook runs WITH CLAUDE_PLUGIN_DATA set (Claude Code
  // sets it only for the hook), but the agent's ack command does NOT have it. The fix
  // bakes `--data <dir>` into the emitted ack command so both resolve the same state dir.
  const fire = (env) => {
    const o = execFileSync('node', [NJ], { encoding: 'utf8', env });
    return o.trim() ? JSON.parse(o).hookSpecificOutput.additionalContext : '';
  };
  it('bakes --data into the ack command, and the ack clears the hook nudge', () => {
    const dir = path.join(tmp, 'pdata');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dir, 'nudges.yaml'));
    const base = { ...process.env, NUDGE_TODAY: TODAY };
    delete base.NUDGE_CONF; delete base.NUDGE_STATE_DIR; delete base.CLAUDE_PLUGIN_DATA;
    const hookEnv = { ...base, CLAUDE_PLUGIN_DATA: dir, NUDGE_NOW: '12:30' };

    const ctx = fire(hookEnv);
    assert.ok(ctx.includes('• lunch '));
    assert.ok(ctx.includes('--data ' + dir));               // emitted command pins the dir
    // agent runs the ack WITHOUT CLAUDE_PLUGIN_DATA, relying on the baked-in --data
    execFileSync('node', [NJ, '--data', dir, 'done', 'lunch'], { encoding: 'utf8', env: base });
    assert.ok(!fire(hookEnv).includes('• lunch '));         // cleared — both resolved `dir`
  });
});

describe('edge cases & errors', () => {
  it('emits nothing and warns on a malformed config (no crash)', () => {
    const bad = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(bad, 'oops: [1, 2');
    const r = spawnSync('node', [NJ], {
      encoding: 'utf8',
      env: { ...process.env, NUDGE_STATE_DIR: tmp, NUDGE_TODAY: TODAY, NUDGE_NOW: '12:30', NUDGE_CONF: bad },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /cannot read config/);
  });
  it('done twice is a no-op the second time', () => {
    cmd('done', 'lunch');
    assert.match(cmd('done', 'lunch'), /already acked/);
  });
  it('undo with nothing to undo is a no-op', () => {
    assert.match(cmd('undo', 'lunch'), /nothing to undo/);
  });
});
