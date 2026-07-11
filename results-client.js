(function () {
  'use strict';

  const security = window.PublicResultsSecurity;
  if (!security) throw new Error('Public results security module did not load');
  const REFRESH_MS = 60000;
  const MAX_BACKOFF_MS = 300000;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function svgElement(tag, attributes, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // ------------------------------------------------------------------
  // formatting helpers
  // ------------------------------------------------------------------
  const DOLLAR = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function fmtDollars(n, opts) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const sign = n > 0 ? '+' : (n < 0 ? '-' : '');
    return sign + '$' + DOLLAR.format(Math.abs(Math.round(n)));
  }
  function fmtDollarsPlain(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return '$' + DOLLAR.format(Math.round(n));
  }
  function pnlClass(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return 'flat';
    if (Math.abs(n) < 0.5) return 'flat';
    return n > 0 ? 'pos' : 'neg';
  }
  function fmtPrice(p) {
    if (p === null || p === undefined) return '—';
    return Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPercent(num, denom) {
    if (!denom || denom <= 0) return '—';
    return Math.round((num / denom) * 100) + '%';
  }
  function fmtTimeET(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }
  function fmtAge(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '—';
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.round(sec / 60) + 'm ago';
    return Math.round(sec / 3600) + 'h ago';
  }

  // ------------------------------------------------------------------
  // calendar helpers (week = Mon-Fri based on current trading_day)
  // ------------------------------------------------------------------
  function isoDay(d) {
    return d.toISOString().slice(0, 10);
  }
  function weekdayShort(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  }
  function monthDay(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function buildWeekDates(currentTradingDay) {
    // currentTradingDay is YYYY-MM-DD; treat as UTC noon to avoid TZ off-by-one
    const d = new Date(currentTradingDay + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0 Sun ... 6 Sat
    // Find Monday (ISO weekday 1). If today is Sun (0) treat as next-week Mon-Fri start
    const daysFromMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + daysFromMonday);
    const out = [];
    for (let i = 0; i < 5; i++) {
      const dd = new Date(monday);
      dd.setUTCDate(monday.getUTCDate() + i);
      out.push(isoDay(dd));
    }
    return out;
  }
  function priorCalendarDay(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  }

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  const state = {
    daily: null,
    history: null,
    model: null,
    scopedDay: null,        // YYYY-MM-DD for leaderboard scope (defaults to live day)
    sortKey: 'dayPnl',
    sortDir: -1,
    expandedRowId: null
  };
  const sources = [
    { path: 'account_daily_pnl_snapshot.json', normalize: security.normalizeDaily, value: null, failures: 0, nextAt: 0, required: true },
    { path: 'account_pnl_history_snapshot.json', normalize: security.normalizeHistory, value: null, failures: 0, nextAt: 0, required: false },
  ];
  let loadTimer = null;
  let loadInFlight = false;

  // ------------------------------------------------------------------
  // load
  // ------------------------------------------------------------------
  function scheduleLoad(delay) {
    if (loadTimer !== null) window.clearTimeout(loadTimer);
    loadTimer = window.setTimeout(load, Math.max(1000, delay));
  }

  async function load() {
    if (loadInFlight) return;
    if (location.protocol === 'file:') {
      renderFatal('Serve this folder over HTTP to preview the results snapshots.');
      return;
    }
    if (document.hidden || navigator.onLine === false) {
      scheduleLoad(30000);
      return;
    }

    loadInFlight = true;
    const now = Date.now();
    const due = sources.filter(source => source.nextAt <= now);
    try {
      await Promise.all(due.map(async source => {
        try {
          source.value = await security.fetchSnapshot(source.path, source.normalize, 7000);
          source.failures = 0;
          source.nextAt = Date.now() + REFRESH_MS;
        } catch (_error) {
          source.failures += 1;
          source.nextAt = Date.now() + security.retryDelay(source.failures, 10000, MAX_BACKOFF_MS);
        }
      }));

      const daily = sources[0].value;
      const history = sources[1].value;
      if (!daily) {
        renderFatal('Could not load a valid daily results snapshot.');
      } else {
        state.daily = daily;
        state.history = history;
        state.model = buildModel(daily, history);
        if (!state.scopedDay || !state.model.weekDates.includes(state.scopedDay)) state.scopedDay = state.model.liveDay;
        render();
      }
    } finally {
      loadInFlight = false;
      scheduleLoad(Math.min(...sources.map(source => source.nextAt)) - Date.now());
    }
  }

  // ------------------------------------------------------------------
  // model
  // ------------------------------------------------------------------
  function buildModel(daily, history) {
    const liveDay = daily && daily.trading_day;
    const weekDates = liveDay ? buildWeekDates(liveDay) : [];

    // Index history by trading_day, separated by kind
    const histAlgos = Object.create(null);
    const histBots  = Object.create(null);
    if (history && history.history) {
      (history.history.algos || []).forEach(d => { histAlgos[d.trading_day] = d; });
      (history.history.bots  || []).forEach(d => { histBots[d.trading_day]  = d; });
    }

    // ---- Build account universe ----
    // Include every account that appears in daily OR in any history day.
    const accounts = Object.create(null);
    function ensureAcct(id, seed) {
      if (!accounts[id]) {
        accounts[id] = Object.assign({
          id: id,
          name: id,
          session: '',
          tier: 'A',
          type: 'algo',         // 'algo' | 'bot'
          byDay: {},            // date -> { pnl, trades, wins, losses, source, isLive, trades_arr }
          weekPnl: 0,
          dominantSource: 'none'
        }, seed || {});
      }
      return accounts[id];
    }
    if (daily && Array.isArray(daily.accounts)) {
      daily.accounts.forEach(a => {
        const acct = ensureAcct(a.id, {
          name: a.name || a.id,
          session: a.session || '',
          tier: a.tier || 'A',
          type: a.is_bot ? 'bot' : 'algo'
        });
        acct.byDay[liveDay] = {
          pnl: typeof a.daily_pnl === 'number' ? a.daily_pnl : null,
          trades: a.trade_count || 0,
          wins: null,
          losses: null,
          source: 'live',
          isLive: true,
          trades_arr: null
        };
      });
    }
    function ingestHistDay(dayRecord, type) {
      if (!dayRecord || !Array.isArray(dayRecord.accounts)) return;
      dayRecord.accounts.forEach(a => {
        const acct = ensureAcct(a.id, {
          name: a.name || a.id, session: a.session || '', tier: 'A', type: type
        });
        // prefer daily-snapshot metadata; only fill blanks
        if (!acct.name || acct.name === acct.id) acct.name = a.name || acct.name;
        if (!acct.session) acct.session = a.session || acct.session;
        acct.type = type;
        const qc = a.quality_counts || {};
        const dominantSrc = pickDominantQuality(qc);
        acct.byDay[dayRecord.trading_day] = {
          pnl: (typeof a.pnl === 'number') ? a.pnl :
               (typeof a.gross_pnl === 'number') ? a.gross_pnl : null,
          trades: a.trade_count || 0,
          wins: a.winning_trades || 0,
          losses: a.losing_trades || 0,
          source: dominantSrc,
          isLive: false,
          trades_arr: a.trades || []
        };
      });
    }
    weekDates.forEach(d => {
      ingestHistDay(histAlgos[d], 'algo');
      ingestHistDay(histBots[d],  'bot');
    });

    // ---- Compute per-account aggregates ----
    Object.values(accounts).forEach(a => {
      let week = 0, hasAny = false;
      const sourceTally = {};
      weekDates.forEach(d => {
        const cell = a.byDay[d];
        if (cell && typeof cell.pnl === 'number') {
          week += cell.pnl; hasAny = true;
          if (cell.source && cell.source !== 'live') {
            sourceTally[cell.source] = (sourceTally[cell.source] || 0) + (cell.trades || 1);
          }
        }
      });
      a.weekPnl = hasAny ? week : null;
      a.dominantSource = pickDominantQualityFromTally(sourceTally) || (a.byDay[liveDay] ? 'live' : 'none');
    });

    // ---- Build per-day totals (across all accounts) ----
    const days = weekDates.map(d => {
      const isFuture = d > liveDay;
      const isLive = d === liveDay;
      const histA = histAlgos[d];
      const histB = histBots[d];
      let totalPnl = 0, hasAny = false, totalTrades = 0, accountCount = 0;
      let bestId = null, bestPnl = -Infinity, worstId = null, worstPnl = Infinity;

      // For live day: aggregate from daily snapshot
      if (isLive && daily && Array.isArray(daily.accounts)) {
        daily.accounts.forEach(a => {
          if (typeof a.daily_pnl === 'number') {
            totalPnl += a.daily_pnl; hasAny = true;
            totalTrades += a.trade_count || 0;
            accountCount += 1;
            if (a.daily_pnl > bestPnl) { bestPnl = a.daily_pnl; bestId = a.id; }
            if (a.daily_pnl < worstPnl) { worstPnl = a.daily_pnl; worstId = a.id; }
          }
        });
      } else if (!isFuture) {
        // Prior day: pull from history (algos + bots day records)
        [histA, histB].forEach(rec => {
          if (!rec || !Array.isArray(rec.accounts)) return;
          rec.accounts.forEach(a => {
            const p = typeof a.pnl === 'number' ? a.pnl : (a.gross_pnl || 0);
            totalPnl += p; hasAny = true;
            totalTrades += a.trade_count || 0;
            accountCount += 1;
            if (p > bestPnl) { bestPnl = p; bestId = a.id; }
            if (p < worstPnl) { worstPnl = p; worstId = a.id; }
          });
        });
      }
      return {
        date: d,
        weekday: weekdayShort(d),
        monthDay: monthDay(d),
        sessionOpen: priorCalendarDay(d),
        isLive: isLive,
        isFuture: isFuture,
        totalPnl: hasAny ? totalPnl : null,
        tradeCount: totalTrades,
        accountCount: accountCount,
        bestId: bestId,
        worstId: worstId,
        bestPnl: bestPnl === -Infinity ? null : bestPnl,
        worstPnl: worstPnl === Infinity ? null : worstPnl
      };
    });

    // ---- Week totals ----
    let weekPnl = 0, weekTrades = 0, sessionsTraded = 0, winDays = 0, hasAnyWeek = false;
    let weekBestAcct = null, weekBestVal = -Infinity, weekWorstAcct = null, weekWorstVal = Infinity;
    days.forEach(d => {
      if (d.totalPnl !== null) {
        weekPnl += d.totalPnl; hasAnyWeek = true;
        weekTrades += d.tradeCount;
        sessionsTraded += 1;
        if (d.totalPnl > 0) winDays += 1;
      }
    });
    Object.values(accounts).forEach(a => {
      if (a.weekPnl === null) return;
      if (a.weekPnl > weekBestVal) { weekBestVal = a.weekPnl; weekBestAcct = a; }
      if (a.weekPnl < weekWorstVal) { weekWorstVal = a.weekPnl; weekWorstAcct = a; }
    });

    // Cumulative PnL series for hero sparkline (running total across week, days with data only)
    let running = 0;
    const cumSeries = days.map(d => {
      if (d.totalPnl === null) return null;
      running += d.totalPnl;
      return running;
    });

    // Median 30-day for cut-zone (we don't have 30d data; placeholder uses weekPnl median)
    const allWeek = Object.values(accounts).map(a => a.weekPnl).filter(v => v !== null).sort((a,b)=>a-b);
    const medianWeek = allWeek.length ? allWeek[Math.floor(allWeek.length / 2)] : 0;

    return {
      liveDay: liveDay,
      weekDates: weekDates,
      days: days,
      accounts: Object.values(accounts),
      cumSeries: cumSeries,
      weekTotals: {
        pnl: hasAnyWeek ? weekPnl : null,
        trades: weekTrades,
        sessionsTraded: sessionsTraded,
        winDays: winDays,
        bestAccount: weekBestAcct,
        worstAccount: weekWorstAcct
      },
      medianWeek: medianWeek,
      generatedAt: daily && daily.generated_at,
      historyGeneratedAt: history && history.generated_at
    };
  }

  function pickDominantQuality(qc) {
    if (!qc) return 'none';
    let best = 'none', bestN = 0;
    Object.entries(qc).forEach(([k, v]) => {
      if (v > bestN) { bestN = v; best = k; }
    });
    return best;
  }
  function pickDominantQualityFromTally(tally) {
    return pickDominantQuality(tally);
  }
  function sourceClass(src) {
    if (src === 'exact_ati_fill_gross') return 'exact';
    if (src === 'nt8_realized_pnl') return 'nt8';
    if (src === 'market_snapshot_inferred') return 'est';
    if (src === 'live') return 'live';
    return 'none';
  }
  function sourceLabel(src) {
    if (src === 'exact_ati_fill_gross') return 'Exact fills, gross PnL';
    if (src === 'nt8_realized_pnl') return 'NT8 realized PnL';
    if (src === 'market_snapshot_inferred') return 'Estimated from market snapshots';
    if (src === 'live') return 'Live net liquidation';
    return 'Source unknown';
  }

  // ------------------------------------------------------------------
  // render: top-level
  // ------------------------------------------------------------------
  function render() {
    if (!state.model) return;
    renderHero();
    renderViewerNote();
    renderDayStrip();
    renderLeaderboard();
    renderFreshness();
  }

  function renderFatal(msg) {
    const card = element('div', 'state-card');
    card.append(element('h2', '', 'Snapshot unavailable'), element('p', '', msg));
    document.getElementById('state-mount').replaceChildren(card);
  }

  function heroStat(label, value, sub, color) {
    const card = element('div', 'hero-stat');
    const valueNode = element('div', 'value', value);
    if (color) valueNode.style.color = color;
    card.append(element('div', 'label', label), valueNode);
    if (sub) card.append(element('div', 'sub', sub));
    return card;
  }

  function renderHero() {
    const m = state.model;
    const t = m.weekTotals;

    // remove skel classes
    const heroPnl = document.getElementById('hero-pnl');
    heroPnl.classList.remove('skel');
    heroPnl.classList.remove('pos','neg');
    if (t.pnl !== null) {
      heroPnl.textContent = fmtDollars(t.pnl);
      heroPnl.classList.add(pnlClass(t.pnl));
    } else {
      heroPnl.textContent = '—';
    }

    const tradedDays = m.days.filter(d => d.totalPnl !== null);
    const first = tradedDays[0];
    const last  = tradedDays[tradedDays.length - 1];
    let weekLabel = 'No sessions traded yet this week';
    if (first && last) {
      const range = first.date === last.date
        ? `${first.weekday} ${first.monthDay}`
        : `${first.weekday} ${first.monthDay} — ${last.weekday} ${last.monthDay}`;
      weekLabel = `${range} · ${t.sessionsTraded} session${t.sessionsTraded === 1 ? '' : 's'} traded`;
    }
    document.getElementById('hero-week').textContent = weekLabel;

    const stats = document.getElementById('hero-stats');
    stats.replaceChildren(
      heroStat('Win Days', t.sessionsTraded ? `${t.winDays} / ${t.sessionsTraded}` : '—'),
      heroStat('Trades', t.trades.toLocaleString('en-US')),
      heroStat('Best Account', t.bestAccount ? fmtDollars(t.bestAccount.weekPnl) : '—', t.bestAccount ? t.bestAccount.name : '', 'var(--green)'),
      heroStat('Worst Account', t.worstAccount ? fmtDollars(t.worstAccount.weekPnl) : '—', t.worstAccount ? t.worstAccount.name : '', 'var(--red)'),
    );

    // Sparkline of cumulative PnL across week
    drawHeroSpark();
  }

  function drawHeroSpark() {
    const m = state.model;
    const svg = document.getElementById('hero-spark');
    const axis = document.getElementById('hero-axis');
    const W = 300, H = 110;
    const pts = m.cumSeries;
    const labels = m.days.map(d => d.weekday);

    axis.replaceChildren(...labels.map(label => element('span', '', label)));

    const validIdx = pts.map((v, i) => v === null ? null : i).filter(i => i !== null);
    if (!validIdx.length) {
      svg.replaceChildren(svgElement('text', {
        x: W / 2, y: H / 2, 'text-anchor': 'middle', 'font-size': 11,
        fill: 'rgba(11,18,32,.4)', 'font-family': 'system-ui',
      }, 'No sessions yet this week'));
      return;
    }
    const vals = validIdx.map(i => pts[i]);
    let min = Math.min(...vals, 0), max = Math.max(...vals, 0);
    if (min === max) { min -= 1; max += 1; }
    const xStep = W / (pts.length - 1);
    const y = (v) => H - 14 - ((v - min) / (max - min)) * (H - 28);

    const lineCoords = validIdx.map(i => `${i * xStep},${y(pts[i])}`);
    const linePath = 'M' + lineCoords.join(' L');

    // area path: from first valid down to baseline (zero) then back along zero-line
    const zeroY = y(0);
    const firstX = validIdx[0] * xStep;
    const lastX = validIdx[validIdx.length - 1] * xStep;
    const areaPath = `M${firstX},${zeroY} L${lineCoords.join(' L')} L${lastX},${zeroY} Z`;

    const lastVal = pts[validIdx[validIdx.length - 1]];
    const stroke = lastVal >= 0 ? '#16a34a' : '#dc2626';
    const fillStop = lastVal >= 0 ? '#22c55e' : '#ef4444';

    const defs = svgElement('defs');
    const gradient = svgElement('linearGradient', { id: 'heroGrad', x1: 0, x2: 0, y1: 0, y2: 1 });
    gradient.append(
      svgElement('stop', { offset: '0%', 'stop-color': fillStop, 'stop-opacity': '.30' }),
      svgElement('stop', { offset: '100%', 'stop-color': fillStop, 'stop-opacity': 0 }),
    );
    defs.append(gradient);
    svg.replaceChildren(
      defs,
      svgElement('line', { x1: 0, y1: zeroY, x2: W, y2: zeroY, stroke: 'rgba(11,18,32,.15)', 'stroke-dasharray': '3,3' }),
      svgElement('path', { d: areaPath, fill: 'url(#heroGrad)' }),
      svgElement('path', { d: linePath, fill: 'none', stroke, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
      svgElement('circle', { cx: lastX, cy: y(lastVal), r: 4, fill: stroke }),
    );
  }

  function renderViewerNote() { /* static markup; nothing dynamic */ }

  function renderDayStrip() {
    const m = state.model;
    const root = document.getElementById('day-strip');
    const maxAbs = Math.max(1, ...m.days.map(d => d.totalPnl === null ? 0 : Math.abs(d.totalPnl)));
    const cards = m.days.map(d => {
      const cls = ['day-card'];
      if (d.isLive) cls.push('live');
      if (d.isFuture) cls.push('future');
      if (d.date === state.scopedDay) cls.push('active');

      const pnlClassStr = d.totalPnl === null ? 'flat' : pnlClass(d.totalPnl);
      const pnlText = d.totalPnl === null ? '—' : fmtDollars(d.totalPnl);
      const sessionLabel = d.isFuture
        ? 'Not yet traded'
        : (d.isLive ? `Live · opened 5pm ${d.sessionOpen}` : `Session opened 5pm ${d.sessionOpen}`);
      const meta = (d.isFuture || d.totalPnl === null)
        ? '\u00a0'
        : `${d.tradeCount.toLocaleString('en-US')} trades · ${d.accountCount} accounts`;
      const barWidth = (d.totalPnl === null) ? 0 : Math.round((Math.abs(d.totalPnl) / maxAbs) * 100);
      const barColor = (d.totalPnl !== null && d.totalPnl < 0) ? 'var(--red)' : 'var(--green)';

      const card = element('div', cls.join(' '));
      card.dataset.date = d.date;
      const bar = element('div', 'day-bar');
      const fill = document.createElement('span');
      fill.style.width = Math.max(0, Math.min(100, barWidth)) + '%';
      fill.style.background = barColor;
      bar.append(fill);
      card.append(
        element('div', 'day-label', `${d.weekday} · ${d.monthDay}`),
        element('div', 'day-session', sessionLabel),
        element('div', `day-pnl ${pnlClassStr}`, pnlText),
        element('div', 'day-meta', meta),
        bar,
      );
      card.addEventListener('click', () => {
        if (d.isFuture || d.totalPnl === null) return;
        state.scopedDay = d.date;
        state.expandedRowId = null;
        render();
      });
      return card;
    });
    root.replaceChildren(...cards);
  }

  // ------------------------------------------------------------------
  // leaderboard
  // ------------------------------------------------------------------
  const COLS = [
    { key: 'rank',     label: '#',          sortable: false, align: 'center', cls: 'lb-rank' },
    { key: 'name',     label: 'Account',    sortable: true,  align: 'left',   cls: 'lb-name' },
    { key: 'type',     label: 'Type',       sortable: true,  align: 'left',   cls: 'lb-type-c' },
    { key: 'sparkline',label: '5-Day Trend',sortable: false, align: 'left',   cls: 'lb-spark' },
    { key: 'dayPnl',   label: 'Day PnL',    sortable: true,  align: 'right',  cls: 'lb-pnl-c' },
    { key: 'trades',   label: 'Trades',     sortable: true,  align: 'right',  cls: 'lb-trades-c lb-num lb-trades' },
    { key: 'winrate',  label: 'Win Rate',   sortable: true,  align: 'right',  cls: 'lb-winrate-c lb-num' },
    { key: 'bestDay',  label: 'Best Day',   sortable: true,  align: 'right',  cls: 'lb-bestday-c lb-num' },
    { key: 'worstDay', label: 'Worst Day',  sortable: true,  align: 'right',  cls: 'lb-worstday-c lb-num' },
    { key: 'weekPnl',  label: 'Week PnL',   sortable: true,  align: 'right',  cls: 'lb-month-c lb-num' },
    { key: 'expand',   label: '',           sortable: false, align: 'center', cls: 'lb-expand' }
  ];

  function renderLeaderboard() {
    const m = state.model;
    const day = m.days.find(d => d.date === state.scopedDay) || m.days.find(d => d.isLive);
    const scope = day ? day.date : null;

    document.getElementById('lb-title').textContent =
      `Leaderboard · ${day ? day.weekday + ' ' + day.monthDay : ''}${day && day.isLive ? ' (Live)' : ''}`;
    const hint = day && day.totalPnl !== null
      ? `Click a row for trade detail · click a different day above to re-rank`
      : `No data for this day`;
    document.getElementById('lb-scope-hint').textContent = hint;

    // build per-account row data
    const rows = m.accounts.map(a => {
      const cell = a.byDay[scope];
      const dayPnl = cell ? cell.pnl : null;
      const trades = cell ? cell.trades : 0;
      const wins = cell && cell.wins !== null ? cell.wins : null;
      const losses = cell && cell.losses !== null ? cell.losses : null;
      const total = (wins !== null && losses !== null) ? (wins + losses) : null;
      const winrate = (total && total > 0 && wins !== null) ? (wins / total) : null;

      let bestDay = null, worstDay = null;
      m.weekDates.forEach(d => {
        const c = a.byDay[d];
        if (c && typeof c.pnl === 'number') {
          if (bestDay === null || c.pnl > bestDay) bestDay = c.pnl;
          if (worstDay === null || c.pnl < worstDay) worstDay = c.pnl;
        }
      });

      return {
        acct: a,
        scope: scope,
        dayPnl: dayPnl,
        trades: trades,
        wins: wins, losses: losses, winrate: winrate,
        bestDay: bestDay, worstDay: worstDay,
        weekPnl: a.weekPnl,
        cellSource: cell ? cell.source : null,
        isLive: cell ? cell.isLive : false,
        cellTradesArr: cell ? cell.trades_arr : null
      };
    });

    // sort
    const dir = state.sortDir;
    const key = state.sortKey;
    rows.sort((a, b) => {
      const va = sortVal(a, key);
      const vb = sortVal(b, key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });

    const root = document.getElementById('leaderboard');
    const head = element('div', 'lb-row head');
    for (const column of COLS) {
      const sortable = column.sortable ? ' sortable' : '';
      const active = column.sortable && column.key === key ? ' active-sort' : '';
      const arrow = column.sortable && column.key === key ? (dir === -1 ? ' ▼' : ' ▲') : '';
      const header = element('div', column.cls + sortable + active, column.label + arrow);
      if (column.align !== 'left') header.style.textAlign = column.align;
      if (column.sortable) {
        header.addEventListener('click', () => {
          if (state.sortKey === column.key) {
            state.sortDir = -state.sortDir;
          } else {
            state.sortKey = column.key;
            state.sortDir = (column.key === 'name' || column.key === 'type') ? 1 : -1;
          }
          renderLeaderboard();
        });
      }
      head.append(header);
    }

    const rendered = [head];
    rows.forEach((r, i) => {
      const a = r.acct;
      const rank = i + 1;
      const rankCls = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
      const cutCls =
        (a.weekPnl !== null && a.weekPnl < 0 && a.weekPnl < m.medianWeek) ? 'cut-hard' :
        (a.weekPnl !== null && a.weekPnl < 0) ? 'cut-soft' : '';
      const expanded = (state.expandedRowId === a.id) ? 'expanded' : '';
      const tierCls = `tier-${(a.tier || 'A').toUpperCase()}`;
      const srcClass = sourceClass(r.isLive ? 'live' : (a.dominantSource || 'none'));
      const srcLabel = sourceLabel(r.isLive ? 'live' : (a.dominantSource || 'none'));
      const row = element('div', `lb-row ${cutCls} ${expanded}`.trim());
      row.addEventListener('click', () => {
        state.expandedRowId = state.expandedRowId === a.id ? null : a.id;
        renderLeaderboard();
      });

      const nameCell = element('div', 'lb-name');
      const tier = (a.tier || 'A').toUpperCase();
      const tierBadge = element('span', `tier-badge ${tierCls}`, tier);
      tierBadge.title = 'Tier ' + tier;
      const provenance = element('span', `prov ${srcClass}`);
      provenance.title = srcLabel;
      const name = element('span', 'name-text', a.name);
      name.title = a.name;
      nameCell.append(tierBadge, provenance, name);

      const typeCell = element('div', 'lb-type-c');
      typeCell.append(element('span', `type-pill ${a.type}`, a.type === 'bot' ? 'Bot' : 'Algo'));
      const sparkCell = element('div', 'lb-spark');
      sparkCell.append(sparkNode(a, m.weekDates));

      const dayPnl = element('div', `lb-pnl-c lb-num lb-pnl ${r.dayPnl === null ? 'flat' : pnlClass(r.dayPnl)}`, r.dayPnl === null ? '—' : fmtDollars(r.dayPnl));
      const trades = element('div', 'lb-trades-c lb-num lb-trades', (r.trades || 0).toLocaleString('en-US') || '—');
      const winrate = element('div', 'lb-winrate-c lb-num', r.winrate === null ? '—' : fmtPercent(r.wins, (r.wins || 0) + (r.losses || 0)));
      const bestDay = element('div', `lb-bestday-c lb-num ${r.bestDay === null ? '' : pnlClass(r.bestDay)}`, r.bestDay === null ? '—' : fmtDollars(r.bestDay));
      const worstDay = element('div', `lb-worstday-c lb-num ${r.worstDay === null ? '' : pnlClass(r.worstDay)}`, r.worstDay === null ? '—' : fmtDollars(r.worstDay));
      const weekPnl = element('div', `lb-month-c lb-num ${a.weekPnl === null ? '' : pnlClass(a.weekPnl)}`, a.weekPnl === null ? '—' : fmtDollars(a.weekPnl));
      for (const cell of [dayPnl, trades, winrate, bestDay, worstDay, weekPnl]) cell.style.textAlign = 'right';
      if (r.bestDay === null) bestDay.style.color = 'var(--muted)';
      if (r.worstDay === null) worstDay.style.color = 'var(--muted)';
      if (a.weekPnl === null) weekPnl.style.color = 'var(--muted)';
      else weekPnl.style.fontWeight = '900';

      row.append(
        element('div', `lb-rank ${rankCls}`, rank), nameCell, typeCell, sparkCell,
        dayPnl, trades, winrate, bestDay, worstDay, weekPnl,
        element('div', 'lb-expand', expanded ? '▾' : '▸'),
      );
      rendered.push(row);
      if (expanded) rendered.push(renderDrill(r));
    });
    root.replaceChildren(...rendered);
  }

  function sortVal(r, key) {
    switch (key) {
      case 'name':     return r.acct.name.toLowerCase();
      case 'type':     return r.acct.type;
      case 'dayPnl':   return r.dayPnl;
      case 'trades':   return r.trades || 0;
      case 'winrate':  return r.winrate;
      case 'bestDay':  return r.bestDay;
      case 'worstDay': return r.worstDay;
      case 'weekPnl':  return r.acct.weekPnl;
      default:         return null;
    }
  }

  function sparkNode(acct, weekDates) {
    const W = 90, H = 22;
    const svg = svgElement('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', width: '100%', height: H });
    const vals = weekDates.map(d => {
      const c = acct.byDay[d];
      return c && typeof c.pnl === 'number' ? c.pnl : null;
    });
    const validIdx = vals.map((v, i) => v === null ? null : i).filter(i => i !== null);
    if (validIdx.length < 1) {
      svg.append(svgElement('text', { x: W / 2, y: H / 2 + 3, 'text-anchor': 'middle', 'font-size': 9, fill: 'rgba(11,18,32,.35)', 'font-family': 'system-ui' }, 'no data'));
      return svg;
    }
    if (validIdx.length === 1) {
      const v = vals[validIdx[0]];
      const stroke = v > 0 ? '#16a34a' : (v < 0 ? '#dc2626' : '#94a3b8');
      const cx = validIdx[0] * (W / (vals.length - 1 || 1));
      svg.append(svgElement('circle', { cx, cy: H / 2, r: 2.5, fill: stroke }));
      return svg;
    }
    const realVals = validIdx.map(i => vals[i]);
    let min = Math.min(...realVals), max = Math.max(...realVals);
    if (min === max) { min -= 1; max += 1; }
    const xStep = W / (vals.length - 1);
    const y = v => H - 3 - ((v - min) / (max - min)) * (H - 6);
    const coords = validIdx.map(i => `${(i * xStep).toFixed(1)},${y(vals[i]).toFixed(1)}`);
    const path = 'M' + coords.join(' L');
    const first = vals[validIdx[0]];
    const last  = vals[validIdx[validIdx.length - 1]];
    const stroke = (last > first) ? '#16a34a' : (last < first) ? '#dc2626' : '#94a3b8';
    const lastX = validIdx[validIdx.length - 1] * xStep;
    const lastY = y(last);
    svg.setAttribute('class', 'lb-spark');
    svg.append(
      svgElement('path', { d: path, fill: 'none', stroke, 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
      svgElement('circle', { cx: lastX.toFixed(1), cy: lastY.toFixed(1), r: 2, fill: stroke }),
    );
    return svg;
  }

  function renderDrill(r) {
    const a = r.acct;
    const cell = a.byDay[r.scope];
    const day = state.model.days.find(d => d.date === r.scope);
    const dayLabel = day ? `${day.weekday} ${day.monthDay}` : r.scope;
    const root = element('div', 'drill');

    if (!cell) {
      root.append(element('div', 'drill-empty', `No activity for ${a.name} on ${dayLabel}.`));
      return root;
    }
    if (cell.isLive) {
      root.append(
        element('div', 'drill-title', `${a.name} · ${dayLabel} · live session`),
        element('div', 'drill-empty', "Live trade-by-trade detail isn't published yet for the open session. The bar above shows the current day's PnL from live net liquidation. Detailed fills land here after the 5 pm session close."),
      );
      return root;
    }
    const trades = Array.isArray(cell.trades_arr) ? cell.trades_arr : [];
    if (!trades.length) {
      root.append(element('div', 'drill-title', `${a.name} · ${dayLabel}`), element('div', 'drill-empty', 'No closed trades recorded.'));
      return root;
    }
    const visible = trades.slice(0, 12);
    const more = Math.max(0, trades.length - visible.length);
    root.append(element('div', 'drill-title', `${a.name} · ${dayLabel} · ${trades.length} trade${trades.length === 1 ? '' : 's'}`));
    const table = element('table', 'drill-table');
    const thead = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of ['Exit (ET)', 'Side', 'Entry', 'Exit', 'Pts', '$ PnL', 'Reason']) header.append(element('th', '', label));
    thead.append(header);
    const tbody = document.createElement('tbody');
    for (const trade of visible) {
      const pnlD = trade.pnl_dollars !== null ? trade.pnl_dollars : trade.gross_pnl_dollars;
      const pcls = (pnlD || 0) >= 0 ? 'pos' : 'neg';
      const row = element('tr', trade.source_quality === 'market_snapshot_inferred' ? 'dim' : '');
      const pnlCell = element('td', pcls, fmtDollars(pnlD));
      const provenance = element('span', `prov ${sourceClass(trade.source_quality)}`);
      provenance.title = sourceLabel(trade.source_quality);
      provenance.style.marginLeft = '6px';
      pnlCell.append(provenance);
      const reason = element('td', '', trade.exit_reason || '');
      reason.style.color = 'var(--muted)';
      row.append(
        element('td', '', fmtTimeET(trade.exit_ts || trade.entry_ts)),
        element('td', '', trade.direction || ''),
        element('td', '', fmtPrice(trade.entry_price)),
        element('td', '', fmtPrice(trade.exit_price)),
        element('td', '', trade.pnl_points === null ? '—' : (trade.pnl_points >= 0 ? '+' : '') + trade.pnl_points.toFixed(2)),
        pnlCell,
        reason,
      );
      tbody.append(row);
    }
    if (more > 0) {
      const row = document.createElement('tr');
      const cell = element('td', '', `+ ${more} more trade${more === 1 ? '' : 's'} this session`);
      cell.colSpan = 7;
      cell.style.textAlign = 'right';
      cell.style.color = 'var(--muted)';
      cell.style.fontSize = '11px';
      cell.style.paddingTop = '8px';
      row.append(cell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    root.append(table);
    return root;
  }

  function renderFreshness() {
    const m = state.model;
    const el = document.getElementById('freshness');
    const ageMs = m.generatedAt ? (Date.now() - new Date(m.generatedAt).getTime()) : null;
    const ageStr = m.generatedAt ? fmtAge(m.generatedAt) : '—';
    el.classList.toggle('stale', ageMs !== null && ageMs > 5 * 60 * 1000);
    el.textContent = ageMs !== null && ageMs > 5 * 60 * 1000
      ? `Snapshot · ${ageStr} · may be stale`
      : `Snapshot · ${ageStr}`;
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  load();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleLoad(0);
  });
  window.addEventListener('online', () => {
    for (const source of sources) source.nextAt = 0;
    scheduleLoad(0);
  });

})();
