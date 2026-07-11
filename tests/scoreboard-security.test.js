'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const security = require('../scoreboard-security.js');

function scoreboard(overrides = {}) {
  return {
    schema_version: 2,
    timestamp: '2026-07-10T16:00:00Z',
    session: 'US',
    price: 22500.25,
    summary: {},
    active_trades: [],
    recent_exits: [],
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    schema_version: 2,
    timestamp: '2026-07-10T16:00:00Z',
    trading_day: '2026-07-10',
    tracking_since: '2026-01-01',
    session: 'US',
    algos: [],
    ...overrides,
  };
}

function daily(overrides = {}) {
  return {
    schema_version: 2,
    timestamp: '2026-07-10T16:00:00Z',
    generated_at: '2026-07-10T16:00:00Z',
    trading_day: '2026-07-10',
    sample_interval_sec: 60,
    accounts: [],
    summary: {},
    ...overrides,
  };
}

test('all public snapshot normalizers reject non-v2 payloads', () => {
  for (const normalize of [security.normalizeScoreboard, security.normalizeState, security.normalizeDaily]) {
    assert.throws(() => normalize({ schema_version: 1 }), /schema_version 2/);
    assert.throws(() => normalize(null), /must be an object/);
  }
});

test('scoreboard fields are bounded and numeric strings are safely coerced', () => {
  const malicious = '<img src=x onerror=alert(1)>\u0000' + 'x'.repeat(500);
  const normalized = security.normalizeScoreboard(scoreboard({
    price: '22501.50',
    summary: { trades_today: '7', open_trades: Infinity },
    active_trades: [{
      name: malicious,
      direction: 'not-a-direction',
      entry_price: '22499.25',
      unrealized_pnl: '4.5',
      duration: malicious,
    }],
  }));

  assert.equal(normalized.price, 22501.5);
  assert.equal(normalized.summary.trades_today, 7);
  assert.equal(normalized.summary.open_trades, 0);
  assert.equal(normalized.active_trades[0].direction, 'FLAT');
  assert.equal(normalized.active_trades[0].entry_price, 22499.25);
  assert.equal(normalized.active_trades[0].unrealized_pnl, 4.5);
  assert.ok(normalized.active_trades[0].name.length <= 160);
  assert.equal(normalized.active_trades[0].name.includes('\u0000'), false);
});

test('account and time-series input is capped client-side', () => {
  const accounts = Array.from({ length: 100 }, (_, index) => ({
    id: 'account-' + index,
    name: 'Account ' + index,
    series: Array.from({ length: 700 }, (_unused, point) => ({
      ts: new Date(Date.UTC(2026, 6, 10, 12, point)).toISOString(),
      daily_pnl: point,
    })),
  }));
  const normalized = security.normalizeDaily(daily({ accounts }));

  assert.equal(normalized.accounts.length, security.MAX_ACCOUNTS);
  assert.equal(normalized.accounts[0].series.length, security.MAX_SERIES_POINTS);
  assert.equal(normalized.accounts[0].series[0].daily_pnl, 0);
  assert.equal(normalized.accounts[0].series.at(-1).daily_pnl, 699);
});

test('state normalization ignores prototype-shaped input and caps accounts', () => {
  const raw = JSON.parse('{"schema_version":2,"timestamp":"2026-07-10T16:00:00Z","session":"US","algos":[{"id":"safe","name":"Safe","__proto__":{"polluted":true}}]}');
  const normalized = security.normalizeState(raw);

  assert.equal(normalized.algos[0].id, 'safe');
  assert.equal({}.polluted, undefined);
  assert.equal(security.normalizeState(state({ algos: Array(100).fill({}) })).algos.length, security.MAX_ACCOUNTS);
});

test('scoreboard uses ordered deferred scripts with no executable inline JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'scoreboard.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'scoreboard-client.js'), 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  assert.equal(scriptTags.length, 2);
  assert.match(scriptTags[0][1], /\bsrc=["']scoreboard-security\.js["']/i);
  assert.match(scriptTags[1][1], /\bsrc=["']scoreboard-client\.js["']/i);
  assert.match(scriptTags[0][1], /\bdefer\b/i);
  assert.match(scriptTags[1][1], /\bdefer\b/i);
  assert.equal(scriptTags.every(match => match[2].trim() === ''), true);

  assert.doesNotMatch(html + client, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(client, /credentials:\s*'omit'/);
  assert.match(client, /redirect:\s*'error'/);
  assert.match(client, /AbortController/);
  assert.match(client, /retryDelay/);
});
