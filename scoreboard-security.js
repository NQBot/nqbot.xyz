(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScoreboardSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const MAX_RESPONSE_BYTES = 500000;
  const MAX_ACCOUNTS = 64;
  const MAX_ACTIVE_TRADES = 64;
  const MAX_RECENT_EXITS = 100;
  const MAX_SERIES_POINTS = 300;
  const MAX_TEXT = 160;
  const MAX_LONG_TEXT = 512;
  const MAX_NUMBER = 1000000000;

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
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return fallback || '';
    }
    return String(value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max) || (fallback || '');
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
    return /^20\d{2}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  }

  function direction(value, fallback) {
    const normalized = text(value, '', 12).toUpperCase();
    return ['LONG', 'SHORT', 'FLAT', 'LIVE'].includes(normalized) ? normalized : (fallback || 'FLAT');
  }

  function tier(value) {
    const normalized = text(value, 'P', 8).toUpperCase();
    if (normalized === 'E' || normalized === 'EVAL') return 'E';
    if (normalized === 'F' || normalized === 'FUNDED') return 'F';
    return 'P';
  }

  function limitedArray(value, limit) {
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  function normalizeSummary(raw) {
    const value = isRecord(raw) ? raw : {};
    return {
      total_algos: integer(value.total_algos, 0, 0, MAX_ACCOUNTS),
      active_algos: integer(value.active_algos, 0, 0, MAX_ACCOUNTS),
      open_trades: integer(value.open_trades, 0, 0, MAX_ACTIVE_TRADES),
      trades_today: integer(value.trades_today, 0, 0, 10000),
      net_pnl: number(value.net_pnl, 0),
      net_pnl_pts: number(value.net_pnl_pts, 0),
      wins: integer(value.wins, 0, 0, 10000),
      losses: integer(value.losses, 0, 0, 10000),
      win_rate: number(value.win_rate, 0, 0, 100),
      peak_equity: number(value.peak_equity, 0),
      current_drawdown: number(value.current_drawdown, 0),
      max_drawdown: number(value.max_drawdown, 0),
      max_drawdown_time: timestamp(value.max_drawdown_time),
    };
  }

  function normalizeActiveTrade(raw, index) {
    const value = isRecord(raw) ? raw : {};
    return {
      name: text(value.name, 'Trade ' + (index + 1)),
      direction: direction(value.direction, 'FLAT'),
      entry_price: number(value.entry_price, 0),
      unrealized_pnl: number(value.unrealized_pnl, 0),
      duration: text(value.duration, '--', 48),
    };
  }

  function normalizeRecentExit(raw, index) {
    const value = isRecord(raw) ? raw : {};
    return {
      name: text(value.name, 'Trade ' + (index + 1)),
      direction: direction(value.direction, 'FLAT'),
      entry_price: number(value.entry_price, 0),
      pnl_pts: number(value.pnl_pts, 0),
      duration: text(value.duration, '--', 48),
      reason: text(value.reason, 'Closed', MAX_LONG_TEXT),
    };
  }

  function normalizeScoreboard(payload) {
    const value = requireV2(payload, 'scoreboard');
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: timestamp(value.timestamp),
      session: text(value.session, '--', 32),
      price: number(value.price, 0),
      summary: normalizeSummary(value.summary),
      active_trades: limitedArray(value.active_trades, MAX_ACTIVE_TRADES).map(normalizeActiveTrade),
      recent_exits: limitedArray(value.recent_exits, MAX_RECENT_EXITS).map(normalizeRecentExit),
    };
  }

  function normalizeStateAccount(raw, index) {
    const value = isRecord(raw) ? raw : {};
    const id = text(value.id, 'account-' + (index + 1), 96);
    return {
      id,
      name: text(value.name, id),
      session: text(value.session, 'Unknown', 32),
      session_active: bool(value.session_active),
      in_trade: bool(value.in_trade),
      direction: direction(value.direction, 'FLAT'),
      pnl: number(value.pnl, 0),
      net_liquidation: number(value.net_liquidation, 0),
      balance: number(value.balance, 0),
      tier: tier(value.tier),
      trade_count: integer(value.trade_count, 0, 0, 100000),
      is_bot: bool(value.is_bot),
      status: text(value.status, '', 48),
      display_status: text(value.display_status, '', 48),
      display_color: text(value.display_color, '', 32),
    };
  }

  function normalizeState(payload) {
    const value = requireV2(payload, 'scoreboard_state');
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: timestamp(value.timestamp),
      trading_day: dateOnly(value.trading_day),
      tracking_since: dateOnly(value.tracking_since),
      session: text(value.session, '--', 32),
      algos: limitedArray(value.algos, MAX_ACCOUNTS).map(normalizeStateAccount),
    };
  }

  function evenlySample(values, limit) {
    if (values.length <= limit) return values;
    const last = values.length - 1;
    const result = [];
    for (let index = 0; index < limit; index += 1) {
      result.push(values[Math.floor(index * last / (limit - 1))]);
    }
    return result;
  }

  function normalizeSeries(raw) {
    const sampled = Array.isArray(raw) ? evenlySample(raw, MAX_SERIES_POINTS) : [];
    return sampled.reduce(function (points, point) {
      if (!isRecord(point)) return points;
      const pnl = number(point.daily_pnl, null);
      if (pnl === null) return points;
      points.push({ ts: timestamp(point.ts), daily_pnl: pnl });
      return points;
    }, []);
  }

  function normalizeDailyAccount(raw, index) {
    const value = isRecord(raw) ? raw : {};
    const id = text(value.id, 'account-' + (index + 1), 96);
    return {
      id,
      name: text(value.name, id),
      session: text(value.session, 'Unknown', 32),
      tier: tier(value.tier),
      is_bot: bool(value.is_bot),
      session_active: bool(value.session_active),
      in_trade: bool(value.in_trade),
      direction: direction(value.direction, 'FLAT'),
      trade_count: integer(value.trade_count, 0, 0, 100000),
      current_net_liquidation: number(value.current_net_liquidation, 0),
      daily_pnl: number(value.daily_pnl, 0),
      daily_realized_pnl: number(value.daily_realized_pnl, 0),
      unrealized_pnl: number(value.unrealized_pnl, 0),
      stale: bool(value.stale),
      series: normalizeSeries(value.series),
    };
  }

  function normalizeDailySummaryAccount(raw) {
    if (!isRecord(raw)) return null;
    const account = normalizeDailyAccount(raw, 0);
    account.series = [];
    return account;
  }

  function normalizeDaily(payload) {
    const value = requireV2(payload, 'account_daily_pnl');
    const summary = isRecord(value.summary) ? value.summary : {};
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: timestamp(value.timestamp),
      generated_at: timestamp(value.generated_at),
      trading_day: dateOnly(value.trading_day),
      sample_interval_sec: integer(value.sample_interval_sec, 0, 0, 86400),
      accounts: limitedArray(value.accounts, MAX_ACCOUNTS).map(normalizeDailyAccount),
      summary: {
        account_count: integer(summary.account_count, 0, 0, MAX_ACCOUNTS),
        stale_account_count: integer(summary.stale_account_count, 0, 0, MAX_ACCOUNTS),
        total_daily_pnl: number(summary.total_daily_pnl, 0),
        total_daily_realized_pnl: number(summary.total_daily_realized_pnl, 0),
        positive_accounts: integer(summary.positive_accounts, 0, 0, MAX_ACCOUNTS),
        negative_accounts: integer(summary.negative_accounts, 0, 0, MAX_ACCOUNTS),
        flat_accounts: integer(summary.flat_accounts, 0, 0, MAX_ACCOUNTS),
        best_account: normalizeDailySummaryAccount(summary.best_account),
        worst_account: normalizeDailySummaryAccount(summary.worst_account),
      },
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    MAX_RESPONSE_BYTES,
    MAX_ACCOUNTS,
    MAX_ACTIVE_TRADES,
    MAX_RECENT_EXITS,
    MAX_SERIES_POINTS,
    normalizeScoreboard,
    normalizeState,
    normalizeDaily,
  });
});
