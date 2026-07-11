'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const security = require('../public-results-security.js');
const root = path.join(__dirname, '..');

test('arena, daily, and history snapshots require schema v2 and required arrays', () => {
  assert.throws(() => security.normalizeArena({ schema_version: 1, rows: [] }), /schema_version 2/);
  assert.throws(() => security.normalizeArena({ schema_version: 2 }), /rows must be an array/);
  assert.throws(() => security.normalizeDaily({ schema_version: 2, trading_day: '2026-07-10' }), /accounts must be an array/);
  assert.throws(() => security.normalizeHistory({ schema_version: 2, history: {} }), /history arrays are required/);
});

test('arena normalization bounds hostile strings, rows, colors, and numeric values', () => {
  const hostile = '<img src=x onerror=alert(1)>' + 'x'.repeat(500);
  const normalized = security.normalizeArena({
    schema_version: 2,
    updated: '2026-07-10T16:00:00Z',
    account_size: '50000',
    win_level: '53000',
    rows: Array.from({ length: 100 }, () => ({
      account: hostile,
      strategy: hostile,
      display_status: hostile,
      display_color: 'url(javascript:alert(1))',
      attempt: '3',
      shadow_balance: '50125.5',
      to_target: '2874.5',
      official_passes: '2',
      official_fails: '1',
    })),
  });

  assert.equal(normalized.rows.length, security.MAX_ARENA_ROWS);
  assert.equal(normalized.rows[0].display_color, 'white');
  assert.equal(normalized.rows[0].attempt, 3);
  assert.equal(normalized.rows[0].shadow_balance, 50125.5);
  assert.ok(normalized.rows[0].strategy.length <= 160);
});

test('daily and history collections are capped and trade text remains inert data', () => {
  const hostile = '<svg onload=alert(1)>' + 'y'.repeat(700);
  const accounts = Array.from({ length: 100 }, (_, index) => ({
    id: index === 0 ? '__proto__' : 'account-' + index,
    name: hostile,
    tier: 'not-a-tier',
    daily_pnl: '25.5',
    trade_count: '2',
  }));
  const daily = security.normalizeDaily({
    schema_version: 2,
    trading_day: '2026-07-10',
    generated_at: '2026-07-10T16:00:00Z',
    accounts,
    summary: {},
  });
  assert.equal(daily.accounts.length, security.MAX_ACCOUNTS);
  assert.equal(daily.accounts[0].tier, 'A');
  assert.equal(daily.accounts[0].daily_pnl, 25.5);

  const trade = {
    exit_ts: '2026-07-10T16:00:00Z', direction: hostile, entry_price: '22500', exit_price: '22505',
    pnl_points: '5', pnl_dollars: '100', exit_reason: hostile, source_quality: 'market_snapshot_inferred',
  };
  const history = security.normalizeHistory({
    schema_version: 2,
    generated_at: '2026-07-10T16:01:00Z',
    history: {
      algos: Array.from({ length: 40 }, (_, day) => ({
        trading_day: `2026-07-${String((day % 28) + 1).padStart(2, '0')}`,
        accounts: day === 0
          ? Array.from({ length: 100 }, (_unused, index) => ({
              id: 'algo-' + index, name: hostile, trades: Array(150).fill(trade), quality_counts: {},
            }))
          : [],
      })),
      bots: [],
    },
  });
  assert.equal(history.history.algos.length, security.MAX_HISTORY_DAYS);
  assert.equal(history.history.algos[0].accounts.length, security.MAX_ACCOUNTS);
  assert.equal(history.history.algos[0].accounts[0].trades.length, security.MAX_TRADES);
  assert.ok(history.history.algos[0].accounts[0].trades[0].exit_reason.length <= 512);
  assert.equal({}.polluted, undefined);
});

test('eval and results pages use only ordered deferred local scripts', () => {
  const expectations = [
    ['eval-arena.html', ['public-results-security.js', 'eval-arena-client.js']],
    ['results.html', ['public-results-security.js', 'results-client.js']],
  ];
  for (const [file, expectedSources] of expectations) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.deepEqual(scripts.map(match => match[1].match(/\bsrc=["']([^"']+)["']/i)?.[1]), expectedSources);
    assert.equal(scripts.every(match => /\bdefer\b/i.test(match[1]) && match[2].trim() === ''), true);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  }
});

test('public result clients contain no HTML injection sinks and enforce hardened fetch behavior', () => {
  const sources = ['public-results-security.js', 'eval-arena-client.js', 'results-client.js']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
  assert.match(sources, /credentials:\s*'omit'/);
  assert.match(sources, /redirect:\s*'error'/);
  assert.match(sources, /AbortController/);
  assert.match(sources, /retryDelay/);
  assert.match(sources, /document\.hidden/);
});
