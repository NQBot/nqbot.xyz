const POLL_MS = 10000;
const STALE_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 7000;
const MAX_POLL_BACKOFF_MS = 5 * 60 * 1000;
const SCOREBOARD_URL = 'scoreboard_snapshot.json';
const STATE_URL = 'scoreboard_state_snapshot.json';
const DAILY_PNL_URL = 'account_daily_pnl_snapshot.json';
const SECURITY = window.ScoreboardSecurity;
if (!SECURITY) throw new Error('Scoreboard security module did not load');

let lastDataTime = null;
let activeSessionTab = 'US';
let cachedStateData = null;
let cachedDailyPnlData = null;
let activePnlAccountId = null;

function pnlColor(val) {
  if (val > 0) return 'val-green';
  if (val < 0) return 'val-red';
  return '';
}

function formatDollar(val) {
  if (val == null || val === 0) return '$0.00';
  const abs = Math.abs(val).toFixed(2);
  return val > 0 ? '+$' + abs : '-$' + abs;
}

function formatUnsignedDollar(val) {
  if (val == null || val === 0) return '$0.00';
  return '$' + Math.abs(val).toFixed(2);
}

function formatSignedWholeDollar(val) {
  if (val == null || val === 0) return '$0';
  const sign = val > 0 ? '+$' : '-$';
  return sign + Math.trunc(Math.abs(val)).toLocaleString('en-US');
}

function formatWholeCurrency(val) {
  if (val == null || val === 0) return '$0';
  return '$' + Math.trunc(Math.abs(val)).toLocaleString('en-US');
}

function formatWholeDollar(val) {
  if (val == null || val === 0) return '0';
  const sign = val < 0 ? '-' : '';
  return sign + Math.trunc(Math.abs(val)).toLocaleString('en-US');
}

function formatPnlPts(val) {
  if (val == null) return '0.0';
  return (val > 0 ? '+' : '') + val.toFixed(1);
}

function prettyName(name) {
  return name || '';
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function replaceWithMessage(target, message) {
  target.replaceChildren(makeElement('div', 'no-data', message));
}

function makeSvgElement(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes || {})) {
    node.setAttribute(name, String(value));
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function safeTimeLabel(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function normalizeTier(tier) {
  const t = String(tier || 'P').trim().toUpperCase();
  if (t === 'E' || t === 'EVAL') return 'E';
  if (t === 'F' || t === 'FUNDED') return 'F';
  return 'P';
}

function tierClass(tier) {
  const t = normalizeTier(tier);
  if (t === 'E') return 'tier-E';
  if (t === 'F') return 'tier-F';
  return 'tier-P';
}

function formatTrackingDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}

function checkStale() {
  const banner = document.getElementById('offline-banner');
  const timeSpan = document.getElementById('offline-time');
  if (!lastDataTime) {
    banner.classList.add('show');
    timeSpan.textContent = '';
    return;
  }
  const age = Date.now() - lastDataTime.getTime();
  if (age > STALE_MS) {
    banner.classList.add('show');
    timeSpan.textContent = 'Last seen: ' + lastDataTime.toLocaleTimeString();
  } else {
    banner.classList.remove('show');
  }
}

function formatTradingDay(day) {
  if (!day) return '--';
  try {
    const d = new Date(day + 'T12:00:00');
    return 'Futures day: ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return 'Futures day: ' + day;
  }
}

function dailyPnlAccounts(data) {
  return (data?.accounts || []).filter(a => !a.stale);
}

function updateDailyPnl(data) {
  if (!data) return;
  cachedDailyPnlData = data;
  const accounts = dailyPnlAccounts(data);
  const summary = data.summary || {};

  document.getElementById('pnl-trading-day').textContent = formatTradingDay(data.trading_day);

  const total = summary.total_daily_pnl || 0;
  const totalEl = document.getElementById('pnl-total');
  totalEl.textContent = formatSignedWholeDollar(total);
  totalEl.className = 'pnl-metric-value ' + pnlColor(total);

  const best = summary.best_account;
  const worst = summary.worst_account;
  const bestEl = document.getElementById('pnl-best');
  const worstEl = document.getElementById('pnl-worst');
  if (best) {
    bestEl.replaceChildren(
      document.createTextNode(best.name + ' '),
      makeElement('span', pnlColor(best.daily_pnl), formatSignedWholeDollar(best.daily_pnl)),
    );
  } else {
    bestEl.textContent = '--';
  }
  if (worst) {
    worstEl.replaceChildren(
      document.createTextNode(worst.name + ' '),
      makeElement('span', pnlColor(worst.daily_pnl), formatSignedWholeDollar(worst.daily_pnl)),
    );
  } else {
    worstEl.textContent = '--';
  }
  document.getElementById('pnl-counts').textContent =
    `${summary.positive_accounts || 0} / ${summary.negative_accounts || 0}`;

  renderPnlAccountSelect(accounts);
  renderPnlLineChart(accounts);
  renderPnlBars(accounts);
  renderPnlTable(accounts);
}

function renderPnlAccountSelect(accounts) {
  const select = document.getElementById('pnl-account-select');
  if (!accounts.length) {
    select.replaceChildren();
    activePnlAccountId = null;
    return;
  }

  const sorted = [...accounts].sort((a, b) => Math.abs(b.daily_pnl || 0) - Math.abs(a.daily_pnl || 0));
  if (!activePnlAccountId || !accounts.some(a => a.id === activePnlAccountId)) {
    activePnlAccountId = sorted[0].id;
  }

  const options = sorted.map(a => {
    const option = makeElement('option', '', a.name);
    option.value = a.id;
    option.selected = a.id === activePnlAccountId;
    return option;
  });
  select.replaceChildren(...options);
}

function switchPnlAccount(accountId) {
  activePnlAccountId = accountId;
  if (cachedDailyPnlData) {
    renderPnlLineChart(dailyPnlAccounts(cachedDailyPnlData));
  }
}

function renderPnlLineChart(accounts) {
  const target = document.getElementById('pnl-line-chart');
  const account = accounts.find(a => a.id === activePnlAccountId) || accounts[0];
  if (!account || !account.series || account.series.length < 2) {
    replaceWithMessage(target, 'Need at least two samples for the intraday curve');
    return;
  }

  const series = account.series
    .filter(p => Number.isFinite(Number(p.daily_pnl)))
    .map(p => ({ ts: p.ts, pnl: Number(p.daily_pnl) }));
  if (series.length < 2) {
    replaceWithMessage(target, 'Need at least two samples for the intraday curve');
    return;
  }

  const width = 720;
  const height = 250;
  const padL = 58;
  const padR = 18;
  const padT = 16;
  const padB = 32;
  let minPnl = Math.min(0, ...series.map(p => p.pnl));
  let maxPnl = Math.max(0, ...series.map(p => p.pnl));
  if (maxPnl - minPnl < 1) {
    maxPnl += 1;
    minPnl -= 1;
  }

  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xFor = i => padL + (series.length === 1 ? 0 : (i / (series.length - 1)) * plotW);
  const yFor = pnl => padT + ((maxPnl - pnl) / (maxPnl - minPnl)) * plotH;
  const points = series.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.pnl).toFixed(1)}`).join(' ');
  const zeroY = yFor(0);
  const stroke = (series[series.length - 1].pnl || 0) >= 0 ? '#166534' : '#991b1b';
  const firstTime = safeTimeLabel(series[0].ts);
  const lastTime = safeTimeLabel(series[series.length - 1].ts);
  const svg = makeSvgElement('svg', {
    class: 'pnl-chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': account.name + ' daily PnL curve',
  });
  svg.append(
    makeSvgElement('rect', { x: padL, y: padT, width: plotW, height: plotH, rx: 10, fill: 'rgba(255,255,255,.08)' }),
    makeSvgElement('line', { x1: padL, y1: zeroY.toFixed(1), x2: width - padR, y2: zeroY.toFixed(1), stroke: 'rgba(11,18,32,.35)', 'stroke-width': 1 }),
    makeSvgElement('polyline', { points, fill: 'none', stroke, 'stroke-width': 4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    makeSvgElement('circle', { cx: xFor(series.length - 1).toFixed(1), cy: yFor(series[series.length - 1].pnl).toFixed(1), r: 5, fill: stroke }),
    makeSvgElement('text', { x: 8, y: padT + 10, fill: 'rgba(11,18,32,.65)', 'font-size': 12, 'font-weight': 800 }, formatSignedWholeDollar(maxPnl)),
    makeSvgElement('text', { x: 8, y: zeroY - 4, fill: 'rgba(11,18,32,.55)', 'font-size': 12, 'font-weight': 800 }, '$0'),
    makeSvgElement('text', { x: 8, y: height - padB, fill: 'rgba(11,18,32,.65)', 'font-size': 12, 'font-weight': 800 }, formatSignedWholeDollar(minPnl)),
    makeSvgElement('text', { x: padL, y: height - 8, fill: 'rgba(11,18,32,.55)', 'font-size': 12, 'font-weight': 800 }, firstTime),
    makeSvgElement('text', { x: width - padR, y: height - 8, 'text-anchor': 'end', fill: 'rgba(11,18,32,.55)', 'font-size': 12, 'font-weight': 800 }, lastTime),
    makeSvgElement('text', { x: width - padR, y: padT + 18, 'text-anchor': 'end', fill: stroke, 'font-size': 15, 'font-weight': 900 }, formatSignedWholeDollar(series[series.length - 1].pnl)),
  );
  target.replaceChildren(svg);
}

function renderPnlBars(accounts) {
  const target = document.getElementById('pnl-bar-chart');
  if (!accounts.length) {
    replaceWithMessage(target, 'No daily PnL data');
    return;
  }

  const ranked = [...accounts].sort((a, b) => (b.daily_pnl || 0) - (a.daily_pnl || 0));
  const maxAbs = Math.max(1, ...ranked.map(a => Math.abs(a.daily_pnl || 0)));
  const rows = ranked.map(a => {
    const pnl = a.daily_pnl || 0;
    const width = Math.max(1, Math.min(50, Math.abs(pnl) / maxAbs * 50));
    const cls = pnl >= 0 ? 'pos' : 'neg';
    const row = makeElement('div', 'pnl-bar-row');
    const name = makeElement('div', 'pnl-bar-name', a.name);
    name.title = a.name;
    const track = makeElement('div', 'pnl-bar-track');
    const fill = makeElement('div', `pnl-bar-fill ${cls}`);
    fill.style.width = width.toFixed(1) + '%';
    track.append(makeElement('div', 'pnl-bar-axis'), fill);
    row.append(name, track, makeElement('div', `pnl-bar-value ${pnlColor(pnl)}`, formatSignedWholeDollar(pnl)));
    return row;
  });
  target.replaceChildren(...rows);
}

function renderPnlTable(accounts) {
  const body = document.getElementById('pnl-results-body');
  if (!accounts.length) {
    const row = document.createElement('tr');
    const cell = makeElement('td', 'no-data', 'No daily PnL data');
    cell.colSpan = 5;
    row.append(cell);
    body.replaceChildren(row);
    return;
  }

  const ranked = [...accounts].sort((a, b) => (b.daily_pnl || 0) - (a.daily_pnl || 0));
  const rows = ranked.map(a => {
    const pnl = a.daily_pnl || 0;
    const status = a.in_trade ? (a.direction || 'LIVE') : (a.session_active ? 'Watching' : 'Idle');
    const row = document.createElement('tr');
    row.append(
      makeElement('td', '', a.name),
      makeElement('td', pnlColor(pnl), formatSignedWholeDollar(pnl)),
      makeElement('td', '', formatWholeCurrency(a.current_net_liquidation)),
      makeElement('td', '', a.trade_count || 0),
      makeElement('td', '', status),
    );
    return row;
  });
  body.replaceChildren(...rows);
}

function updateScoreboard(data) {
  if (!data || !data.summary) return;
  const s = data.summary;

  lastDataTime = data.timestamp ? new Date(data.timestamp) : new Date();

  document.getElementById('session').textContent = data.session || '--';
  document.getElementById('price').textContent = data.price ? data.price.toFixed(2) : '--';

  const trades = data.active_trades || [];
  const openCount = trades.length || s.open_trades || 0;

  document.getElementById('trades-today').textContent = s.trades_today + openCount;
  document.getElementById('open-pos').textContent = openCount;

  // Active trades
  const activeDiv = document.getElementById('active-trades');
  if (trades.length === 0) {
    replaceWithMessage(activeDiv, 'No open trades');
  } else {
    const tradeRows = [];
    for (const t of trades) {
      const dirClass = t.direction === 'LONG' ? 'dir-long' : 'dir-short';
      const pnlCls = pnlColor(t.unrealized_pnl);
      const row = makeElement('div', 'trade-item');
      const info = makeElement('div', 'trade-info');
      const details = document.createElement('div');
      details.append(
        makeElement('div', 'trade-name', prettyName(t.name)),
        makeElement('div', 'trade-meta', `Entry: ${t.entry_price.toFixed(2)} | ${t.duration}`),
      );
      info.append(makeElement('span', `trade-dir ${dirClass}`, t.direction), details);
      row.append(info, makeElement('div', `trade-pnl ${pnlCls}`, `${formatPnlPts(t.unrealized_pnl)} pts`));
      tradeRows.push(row);
    }
    activeDiv.replaceChildren(...tradeRows);
  }

  // Recent exits
  const exitsDiv = document.getElementById('recent-exits');
  const exits = data.recent_exits || [];
  if (exits.length === 0) {
    replaceWithMessage(exitsDiv, 'No exits yet');
  } else {
    const exitRows = [];
    for (const e of [...exits].reverse()) {
      const pnlCls = pnlColor(e.pnl_pts);
      const row = makeElement('div', 'exit-item');
      const details = document.createElement('div');
      details.append(
        makeElement('strong', '', prettyName(e.name)),
        makeElement('span', 'exit-reason', e.reason),
      );
      const value = makeElement('div', pnlCls, `${formatPnlPts(e.pnl_pts)} pts`);
      value.style.fontWeight = '800';
      row.append(details, value);
      exitRows.push(row);
    }
    exitsDiv.replaceChildren(...exitRows);
  }

  // Timestamp
  document.getElementById('updated').textContent =
    'Last updated: ' + (lastDataTime ? lastDataTime.toLocaleTimeString() : '--');

  checkStale();
}

function updateFromState(stateData) {
  if (!stateData) return;
  cachedStateData = stateData;

  const algos = stateData.algos || [];

  // Tracking since banner
  const trackEl = document.getElementById('tracking-since');
  if (stateData.tracking_since) {
    trackEl.textContent = 'Tracking since: ' + formatTrackingDate(stateData.tracking_since);
  }

  // Session from state
  if (stateData.session) {
    document.getElementById('session').textContent = stateData.session;
  }

  // Total PnL — sum all algo pnl values (NT8 commission-accurate dollars)
  const totalPnl = algos.reduce((sum, a) => sum + (a.pnl || 0), 0);
  const pnlEl = document.getElementById('net-pnl');
  pnlEl.textContent = formatDollar(totalPnl);
  pnlEl.className = 'value ' + pnlColor(totalPnl);

  const totalNetLiq = algos.reduce((sum, a) => sum + (a.net_liquidation || a.balance || 0), 0);
  const netLiqEl = document.getElementById('net-liq');
  netLiqEl.textContent = formatUnsignedDollar(totalNetLiq);
  netLiqEl.className = 'value';

  // Health grid
  updateHealthGrid(algos);

  // Session tables from state data
  renderSessionTables(algos);

  if (stateData.timestamp) {
    lastDataTime = new Date(stateData.timestamp);
  }
}

function updateHealthGrid(algos) {
  const grid = document.getElementById('health-grid');
  if (!algos || algos.length === 0) {
    replaceWithMessage(grid, 'No state data available');
    return;
  }

  const tiles = [];
  for (const algo of algos) {
    let dotClass = 'dot-gray';
    if (algo.in_trade) {
      dotClass = 'dot-green';
    } else if (algo.session_active) {
      dotClass = 'dot-blue';
    }

    const pnl = algo.pnl || 0;
    const pnlCls = pnlColor(pnl);
    const netLiquidation = algo.net_liquidation || algo.balance || 0;

    const tier = normalizeTier(algo.tier);
    const tile = makeElement('div', 'health-tile');
    const head = makeElement('div', 'tile-head');
    const name = makeElement('div', 'tile-name');
    name.title = algo.id;
    name.append(
      document.createTextNode(algo.name || algo.id),
      makeElement('span', `tier-pill ${tierClass(tier)}`, tier),
    );
    head.append(makeElement('div', `tile-dot ${dotClass}`), name);
    tile.append(
      head,
      makeElement('div', `tile-pnl ${pnlCls}`, formatDollar(pnl)),
      makeElement('div', 'tile-netliq', `Net liq ${formatWholeDollar(netLiquidation)}`),
    );
    tiles.push(tile);
  }

  grid.replaceChildren(...tiles);
}

function renderSessionTables(algos) {
  const tabsDiv = document.getElementById('session-tabs');
  const contentDiv = document.getElementById('session-content');
  const sessionOrder = ['US', 'Asian', 'European'];

  if (!algos || algos.length === 0) {
    tabsDiv.replaceChildren();
    replaceWithMessage(contentDiv, 'No session data');
    return;
  }

  // Group algos by their session field
  const sessions = {};
  for (const a of algos) {
    const sess = a.session || 'Unknown';
    // An algo can be in multiple sessions (e.g. "Asian/European" → first one used)
    if (!sessions[sess]) sessions[sess] = [];
    sessions[sess].push(a);
  }

  // Build tabs
  const tabButtons = [];
  for (const sess of sessionOrder) {
    if (!sessions[sess] || sessions[sess].length === 0) continue;
    const cls = sess === activeSessionTab ? 'session-tab-btn active' : 'session-tab-btn';
    const button = makeElement('button', cls, sess);
    button.type = 'button';
    button.addEventListener('click', () => switchSessionTab(sess));
    tabButtons.push(button);
  }
  tabsDiv.replaceChildren(...tabButtons);

  // Build table for active tab
  const sessionAlgos = sessions[activeSessionTab];
  if (!sessionAlgos || sessionAlgos.length === 0) {
    replaceWithMessage(contentDiv, 'No algos in this session');
    return;
  }

  const table = makeElement('table', 'session-table');
  const header = document.createElement('tr');
  for (const label of ['Algo', 'Status', 'PnL', 'Net Liq']) {
    header.append(makeElement('th', '', label));
  }
  table.append(header);
  for (const a of sessionAlgos) {
    const isOpen = a.in_trade;
    const pnl = a.pnl || 0;
    const pnlCls = pnlColor(pnl);
    const netLiquidation = a.net_liquidation || a.balance || 0;
    const tier = normalizeTier(a.tier);
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.append(
      makeElement('strong', '', prettyName(a.name)),
      makeElement('span', `tier-pill ${tierClass(tier)}`, tier),
    );
    const statusCell = document.createElement('td');
    if (isOpen) {
      statusCell.append(makeElement('span', 'status-open'), document.createTextNode('In Trade'));
    } else {
      statusCell.textContent = a.session_active ? 'Watching' : 'Idle';
    }
    const pnlCell = makeElement('td', pnlCls, formatDollar(pnl));
    pnlCell.style.fontWeight = '700';
    const netCell = makeElement('td', '', formatWholeDollar(netLiquidation));
    netCell.style.fontWeight = '700';
    netCell.style.opacity = '.72';
    row.append(nameCell, statusCell, pnlCell, netCell);
    table.append(row);
  }
  contentDiv.replaceChildren(table);
}

function switchSessionTab(sess) {
  activeSessionTab = sess;
  if (cachedStateData) {
    renderSessionTables(cachedStateData.algos || []);
  }
}

async function fetchSnapshot(relativeUrl, normalize) {
  const url = new URL(relativeUrl, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('Cross-origin snapshot blocked');
  url.searchParams.set('t', String(Date.now()));

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || response.redirected) throw new Error('Snapshot request failed');

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) throw new Error('Unexpected snapshot media type');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > SECURITY.MAX_RESPONSE_BYTES) {
      throw new Error('Snapshot exceeds size limit');
    }

    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > SECURITY.MAX_RESPONSE_BYTES) {
      throw new Error('Snapshot exceeds size limit');
    }
    return normalize(JSON.parse(body));
  } finally {
    window.clearTimeout(timeout);
  }
}

const pollSources = [
  { url: SCOREBOARD_URL, normalize: SECURITY.normalizeScoreboard, apply: updateScoreboard, failures: 0, nextAt: 0 },
  { url: STATE_URL, normalize: SECURITY.normalizeState, apply: updateFromState, failures: 0, nextAt: 0 },
  { url: DAILY_PNL_URL, normalize: SECURITY.normalizeDaily, apply: updateDailyPnl, failures: 0, nextAt: 0 },
];
let pollTimer = null;
let pollInFlight = false;

function retryDelay(failures) {
  const exponent = Math.min(Math.max(failures, 1), 6);
  const base = Math.min(MAX_POLL_BACKOFF_MS, POLL_MS * (2 ** exponent));
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

function schedulePoll(delay) {
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(poll, Math.max(1000, delay));
}

async function poll() {
  if (pollInFlight) return;
  if (document.hidden || navigator.onLine === false) {
    schedulePoll(30000);
    return;
  }

  pollInFlight = true;
  const startedAt = Date.now();
  const due = pollSources.filter(source => source.nextAt <= startedAt);
  try {
    await Promise.all(due.map(async source => {
      try {
        const data = await fetchSnapshot(source.url, source.normalize);
        source.apply(data);
        source.failures = 0;
        source.nextAt = Date.now() + POLL_MS;
      } catch (_error) {
        source.failures += 1;
        source.nextAt = Date.now() + retryDelay(source.failures);
      }
    }));
  } finally {
    pollInFlight = false;
    checkStale();
    const nextAt = Math.min(...pollSources.map(source => source.nextAt));
    schedulePoll(nextAt - Date.now());
  }
}

document.getElementById('pnl-account-select').addEventListener('change', event => {
  switchPnlAccount(event.currentTarget.value);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) schedulePoll(0);
});
window.addEventListener('online', () => {
  for (const source of pollSources) source.nextAt = 0;
  schedulePoll(0);
});

poll();
setInterval(checkStale, 30000);
