(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PublicResultsSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const MAX_RESPONSE_BYTES = 500000;
  const MAX_ARENA_ROWS = 64;
  const MAX_HISTORY_DAYS = 31;
  const MAX_ACCOUNTS = 64;
  const MAX_TRADES = 100;
  const MAX_TEXT = 160;
  const MAX_LONG_TEXT = 512;
  const MAX_NUMBER = 1000000000;
  const QUALITY_KEYS = ['exact_ati_fill_gross', 'nt8_realized_pnl', 'market_snapshot_inferred'];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function requireV2(payload, label) {
    if (!isRecord(payload)) throw new TypeError(label + ' must be an object');
    if (payload.schema_version !== SCHEMA_VERSION) {
      throw new TypeError(label + ' must use schema_version ' + SCHEMA_VERSION);
    }
    return payload;
  }

  function text(value, fallback, limit) {
    const max = Number.isInteger(limit) && limit > 0 ? limit : MAX_TEXT;
    if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback || '';
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || (fallback || '');
  }

  function number(value, fallback, min, max) {
    let parsed = value;
    if (typeof value === 'string' && value.length <= 32 &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
      parsed = Number(value);
    }
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
    return Math.min(max == null ? MAX_NUMBER : max, Math.max(min == null ? -MAX_NUMBER : min, parsed));
  }

  function integer(value, fallback, min, max) {
    return Math.trunc(number(value, fallback, min, max));
  }

  function bool(value) {
    return value === true || value === 1 || value === 'true';
  }

  function timestamp(value) {
    const raw = text(value, '', 64);
    if (!raw) return null;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const year = new Date(parsed).getUTCFullYear();
    return year >= 2000 && year <= 2100 ? raw : null;
  }

  function dateOnly(value) {
    const raw = text(value, '', 10);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(raw)) return null;
    const date = new Date(raw + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
  }

  function limitedArray(value, limit) {
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  function qualityCounts(raw) {
    const value = isRecord(raw) ? raw : {};
    const result = {};
    for (const key of QUALITY_KEYS) result[key] = integer(value[key], 0, 0, 100000);
    return result;
  }

  function normalizeArenaRow(raw, index) {
    const value = isRecord(raw) ? raw : {};
    const color = text(value.display_color, 'white', 16).toLowerCase();
    return {
      account: text(value.account, 'Account ' + (index + 1), 96),
      strategy: text(value.strategy, 'Strategy ' + (index + 1)),
      status: text(value.status, '', 48),
      display_status: text(value.display_status, '', 48),
      display_color: ['green', 'yellow', 'red', 'grey', 'white'].includes(color) ? color : 'white',
      attempt: integer(value.attempt, 0, 0, 100000),
      shadow_balance: number(value.shadow_balance, null),
      to_target: number(value.to_target, null),
      official_passes: integer(value.official_passes, 0, 0, 100000),
      official_fails: integer(value.official_fails, 0, 0, 100000),
    };
  }

  function normalizeArena(payload) {
    const value = requireV2(payload, 'eval_arena');
    if (!Array.isArray(value.rows)) throw new TypeError('eval_arena.rows must be an array');
    return {
      schema_version: SCHEMA_VERSION,
      updated: timestamp(value.updated),
      account_size: number(value.account_size, 50000, 0),
      win_level: number(value.win_level, 53000, 0),
      rows: limitedArray(value.rows, MAX_ARENA_ROWS).map(normalizeArenaRow),
    };
  }

  function normalizeDailyAccount(raw, index) {
    const value = isRecord(raw) ? raw : {};
    const id = text(value.id, 'account-' + (index + 1), 96);
    const rawTier = text(value.tier, 'A', 8).toUpperCase();
    return {
      id,
      name: text(value.name, id),
      session: text(value.session, '', 32),
      tier: ['A', 'P', 'E', 'F'].includes(rawTier) ? rawTier : 'A',
      is_bot: bool(value.is_bot),
      trade_count: integer(value.trade_count, 0, 0, 100000),
      daily_pnl: number(value.daily_pnl, null),
      stale: bool(value.stale),
    };
  }

  function normalizeDaily(payload) {
    const value = requireV2(payload, 'account_daily_pnl');
    if (!Array.isArray(value.accounts)) throw new TypeError('account_daily_pnl.accounts must be an array');
    if (!isRecord(value.summary)) throw new TypeError('account_daily_pnl.summary must be an object');
    const tradingDay = dateOnly(value.trading_day);
    if (!tradingDay) throw new TypeError('account_daily_pnl.trading_day must be a valid date');
    return {
      schema_version: SCHEMA_VERSION,
      generated_at: timestamp(value.generated_at || value.timestamp),
      trading_day: tradingDay,
      accounts: limitedArray(value.accounts, MAX_ACCOUNTS).map(normalizeDailyAccount),
    };
  }

  function normalizeTrade(raw) {
    const value = isRecord(raw) ? raw : {};
    const source = text(value.source_quality, '', 48);
    return {
      entry_ts: timestamp(value.entry_ts),
      exit_ts: timestamp(value.exit_ts),
      direction: text(value.direction, '', 12).toUpperCase(),
      quantity: integer(value.quantity, 0, 0, 1000),
      entry_price: number(value.entry_price, null),
      exit_price: number(value.exit_price, null),
      exit_reason: text(value.exit_reason, '', MAX_LONG_TEXT),
      outcome: text(value.outcome, '', 32),
      pnl_points: number(value.pnl_points, null),
      pnl_dollars: number(value.pnl_dollars, null),
      gross_pnl_dollars: number(value.gross_pnl_dollars, null),
      r_multiple: number(value.r_multiple, null, -10000, 10000),
      source_quality: QUALITY_KEYS.includes(source) ? source : '',
      commission_included: bool(value.commission_included),
    };
  }

  function normalizeHistoryAccount(raw, index) {
    const value = isRecord(raw) ? raw : {};
    if (!Array.isArray(value.trades)) throw new TypeError('history account trades must be an array');
    const id = text(value.id, 'account-' + (index + 1), 96);
    return {
      id,
      name: text(value.name, id),
      session: text(value.session, '', 32),
      trade_count: integer(value.trade_count, 0, 0, 100000),
      gross_pnl: number(value.gross_pnl, null),
      net_pnl: number(value.net_pnl, null),
      pnl: number(value.pnl, null),
      winning_trades: integer(value.winning_trades, 0, 0, 100000),
      losing_trades: integer(value.losing_trades, 0, 0, 100000),
      flat_trades: integer(value.flat_trades, 0, 0, 100000),
      quality_counts: qualityCounts(value.quality_counts),
      trades: limitedArray(value.trades, MAX_TRADES).map(normalizeTrade),
    };
  }

  function normalizeSummaryAccount(raw) {
    if (!isRecord(raw)) return null;
    return {
      id: text(raw.id, '', 96),
      name: text(raw.name, '', MAX_TEXT),
      trade_count: integer(raw.trade_count, 0, 0, 100000),
      pnl: number(raw.pnl, null),
      gross_pnl: number(raw.gross_pnl, null),
      quality_counts: qualityCounts(raw.quality_counts),
    };
  }

  function normalizeHistoryDay(raw, index) {
    const value = isRecord(raw) ? raw : {};
    const tradingDay = dateOnly(value.trading_day);
    if (!tradingDay) throw new TypeError('history day must use a valid trading_day');
    if (!Array.isArray(value.accounts)) throw new TypeError('history day accounts must be an array');
    return {
      trading_day: tradingDay,
      kind: text(value.kind, '', 16),
      trade_count: integer(value.trade_count, 0, 0, 100000),
      account_count: integer(value.account_count, 0, 0, MAX_ACCOUNTS),
      total_pnl: number(value.total_pnl, null),
      total_gross_pnl: number(value.total_gross_pnl, null),
      positive_accounts: integer(value.positive_accounts, 0, 0, MAX_ACCOUNTS),
      negative_accounts: integer(value.negative_accounts, 0, 0, MAX_ACCOUNTS),
      flat_accounts: integer(value.flat_accounts, 0, 0, MAX_ACCOUNTS),
      best_account: normalizeSummaryAccount(value.best_account),
      worst_account: normalizeSummaryAccount(value.worst_account),
      quality_counts: qualityCounts(value.quality_counts),
      accounts: limitedArray(value.accounts, MAX_ACCOUNTS).map(normalizeHistoryAccount),
    };
  }

  function normalizeHistory(payload) {
    const value = requireV2(payload, 'account_pnl_history');
    if (!isRecord(value.history)) throw new TypeError('account_pnl_history.history must be an object');
    const history = value.history;
    if (!Array.isArray(history.algos) || !Array.isArray(history.bots)) {
      throw new TypeError('account_pnl_history history arrays are required');
    }
    return {
      schema_version: SCHEMA_VERSION,
      generated_at: timestamp(value.generated_at),
      timezone: text(value.timezone, 'America/New_York', 64),
      reset_time_et: text(value.reset_time_et, '', 32),
      instrument: text(value.instrument, 'NQ', 32),
      point_value: number(value.point_value, 20, 0, 100000),
      history: {
        algos: limitedArray(history.algos, MAX_HISTORY_DAYS).map(normalizeHistoryDay),
        bots: limitedArray(history.bots, MAX_HISTORY_DAYS).map(normalizeHistoryDay),
      },
    };
  }

  async function fetchSnapshot(relativeUrl, normalize, timeoutMs) {
    const url = new URL(relativeUrl, window.location.href);
    if (url.origin !== window.location.origin) throw new Error('Cross-origin snapshot blocked');
    url.searchParams.set('t', String(Date.now()));
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs || 7000);
    try {
      const response = await fetch(url.href, {
        method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || response.redirected) throw new Error('Snapshot request failed');
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('application/json')) throw new Error('Unexpected snapshot media type');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Snapshot exceeds size limit');
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new Error('Snapshot exceeds size limit');
      return normalize(JSON.parse(body));
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function retryDelay(failures, baseMs, maxMs) {
    const exponent = Math.min(Math.max(failures, 1), 6);
    const base = Math.min(maxMs || 300000, (baseMs || 10000) * (2 ** exponent));
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }

  return Object.freeze({
    SCHEMA_VERSION, MAX_RESPONSE_BYTES, MAX_ARENA_ROWS, MAX_HISTORY_DAYS, MAX_ACCOUNTS, MAX_TRADES,
    normalizeArena, normalizeDaily, normalizeHistory, fetchSnapshot, retryDelay,
  });
});
