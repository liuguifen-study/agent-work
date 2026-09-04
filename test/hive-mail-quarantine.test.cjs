'use strict';

/**
 * Regression for silent mail failure. `routeOnce` quarantined an outbox file
 * it could not parse/route by renaming it to `outbox/.sent/bad-*.json` — and
 * then stopped: no log line, no renderer event, no commit. A broken sender
 * (schema drift, half-written write) therefore failed silently until its mail
 * simply stopped arriving, with nothing in the activity feed or git history to
 * say why. Every quarantine must now record a structured `mail-quarantine`
 * event: the sender, the `bad-*` filename, and a redacted reason — and
 * deliberately NOT the envelope contents, so a half-written file that captured
 * a secret can't leak it into log.jsonl or across IPC. Valid delivery
 * behavior is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t, emit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-quarantine-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, emit);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('a malformed outbox envelope is quarantined to bad-* with a structured log + emit event', async (t) => {
  const pushed = [];
  const { hive } = await floor(t, (channel, payload) => { pushed.push({ channel, payload }); return true; });
  const outbox = path.join(hive.root(), 'agents', 'jim-1', 'outbox');
  // Unclosed string → SyntaxError, like a half-written envelope. The captured
  // fragment is secret-shaped on purpose: nothing about it may survive.
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  fs.writeFileSync(
    path.join(outbox, '2026-09-04T10-00-00-000Z-broken.json'),
    `{ "to": "god-1", "act": "request", "subject": "broken", "body": "${secret}`
  );

  assert.equal(hive.routeOnce(), 0, 'a broken envelope routes nothing');

  const quarantined = 'bad-2026-09-04T10-00-00-000Z-broken.json';
  assert.ok(
    fs.existsSync(path.join(outbox, '.sent', quarantined)),
    'the file is moved under outbox/.sent with the bad- prefix'
  );
  assert.equal(
    fs.readdirSync(outbox).filter((f) => f.endsWith('.json')).length,
    0,
    'nothing is left in the live outbox to spin on'
  );

  const [event] = entries(hive, 'mail-quarantine');
  assert.ok(event, 'a mail-quarantine event is logged');
  assert.equal(event.agentId, 'jim-1', 'the event names the sender');
  assert.equal(event.file, quarantined, 'the event preserves the quarantined filename');
  assert.ok(event.reason.length > 0, 'the event carries a reason');
  assert.ok(!('body' in event), 'the event never carries a body field');
  assert.ok(!('subject' in event), 'the event never carries a subject field');
  assert.ok(!event.reason.includes(secret), 'the reason never leaks envelope content');
  assert.ok(!JSON.stringify(event).includes(secret), 'no serialized event field leaks the secret');

  assert.equal(pushed.length, 1, 'the router pushed exactly one renderer event');
  assert.equal(pushed[0].channel, 'hive:mailQuarantine');
  assert.deepEqual(pushed[0].payload, { agentId: 'jim-1', file: quarantined, reason: event.reason });
  assert.ok(!JSON.stringify(pushed[0].payload).includes(secret), 'the pushed payload never leaks the secret');

  const logText = fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8');
  assert.ok(!logText.includes(secret), 'log.jsonl never contains the malformed body fragment');
});

test('valid outbox envelopes still route and archive unchanged', async (t) => {
  const { hive } = await floor(t);
  const outbox = path.join(hive.root(), 'agents', 'jim-1', 'outbox');
  const name = '2026-09-04T10-00-01-000Z-ok.json';
  fs.writeFileSync(path.join(outbox, name), JSON.stringify({
    id: '2026-09-04T10-00-01-000Z-ok',
    to: 'god-1',
    act: 'inform',
    subject: 'still works',
    body: 'hey'
  }));

  assert.equal(hive.routeOnce(), 1, 'the valid envelope routes');

  const delivered = hive.inbox('god-1');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].subject, 'still works');
  assert.equal(delivered[0].body, 'hey');
  // Archived plainly — no bad- prefix, no quarantine event.
  assert.ok(fs.existsSync(path.join(outbox, '.sent', name)));
  assert.equal(fs.readdirSync(path.join(outbox, '.sent')).filter((f) => f.startsWith('bad-')).length, 0);
  assert.equal(entries(hive, 'mail-quarantine').length, 0, 'healthy mail emits no quarantine event');
});
