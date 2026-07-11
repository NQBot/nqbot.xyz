(function () {
  'use strict';

  const security = window.PublicResultsSecurity;
  if (!security) throw new Error('Public results security module did not load');
  const REFRESH_MS = 60000;
  const MAX_BACKOFF_MS = 300000;
  let failures = 0;
  let timer = null;
  let inFlight = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function fmtMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '--';
    const sign = value < 0 ? '-' : '';
    return sign + '$' + Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function statusClass(color) {
    return ({ green: 'st-green', yellow: 'st-yellow', red: 'st-red', grey: 'st-grey', white: 'st-white' })[color] || 'st-white';
  }

  function renderFatal(message) {
    const row = document.createElement('tr');
    const cell = element('td', 'fatal', message);
    cell.colSpan = 7;
    row.append(cell);
    document.getElementById('arena-body').replaceChildren(row);
    document.getElementById('freshness').textContent = 'Snapshot unavailable';
  }

  function freshnessText(updatedIso) {
    if (!updatedIso) return 'Snapshot time unknown';
    const then = new Date(updatedIso);
    if (!Number.isFinite(then.getTime())) return 'Snapshot time unknown';
    const mins = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
    if (mins < 2) return 'Updated moments ago';
    if (mins < 90) return 'Updated ' + mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 36) return 'Updated ' + hrs + ' hr ago';
    return 'Updated ' + then.toLocaleString();
  }

  function numericCell(value, className) {
    return element('td', ('num ' + (className || '')).trim(), value);
  }

  function render(data) {
    const rows = data.rows;
    let passes = 0;
    let fails = 0;
    for (const row of rows) {
      passes += row.official_passes;
      fails += row.official_fails;
    }
    document.getElementById('stat-accounts').textContent = String(rows.length);
    document.getElementById('stat-passes').textContent = String(passes);
    document.getElementById('stat-fails').textContent = String(fails);
    document.getElementById('rule-target').textContent = fmtMoney(data.win_level);
    document.getElementById('rule-size').textContent = fmtMoney(data.account_size) + ' (simulated)';
    document.getElementById('freshness').textContent = freshnessText(data.updated);

    if (!rows.length) {
      renderFatal('No arena data in the current snapshot.');
      return;
    }

    const sorted = [...rows].sort((a, b) => {
      if (b.official_passes !== a.official_passes) return b.official_passes - a.official_passes;
      return (a.to_target == null ? Infinity : a.to_target) - (b.to_target == null ? Infinity : b.to_target);
    });

    const rendered = sorted.map(item => {
      const attempts = item.official_passes + item.official_fails;
      const percent = attempts > 0 ? Math.round((item.official_passes / attempts) * 100) : null;
      const row = document.createElement('tr');

      const identity = document.createElement('td');
      identity.append(
        element('span', 'strat', item.strategy),
        document.createElement('br'),
        element('span', 'acct', item.account),
      );

      const statusCell = document.createElement('td');
      statusCell.append(element('span', 'status ' + statusClass(item.display_color), (item.display_status || item.status || '--').replace(/_/g, ' ')));

      const attemptCell = element('td', 'num');
      attemptCell.append(element('span', 'attempt-chip', item.attempt ? '#' + item.attempt : '#--'));

      const balanceClass = item.shadow_balance == null ? '' : (item.shadow_balance >= 50000 ? 'pos-money' : 'neg-money');
      const recordCell = element('td', 'num');
      recordCell.append(
        element('span', 'pf-pass', item.official_passes),
        document.createTextNode(' - '),
        element('span', 'pf-fail', item.official_fails),
      );

      const percentCell = element('td', 'num');
      if (percent === null) {
        percentCell.append(element('span', 'acct', '--'));
      } else {
        percentCell.append(document.createTextNode(percent + '%'));
        const bar = element('span', 'pct-bar');
        const fill = element('span', 'pct-fill');
        fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
        bar.append(fill);
        percentCell.append(bar);
      }

      row.append(
        identity,
        statusCell,
        attemptCell,
        numericCell(fmtMoney(item.shadow_balance), balanceClass),
        numericCell(fmtMoney(item.to_target)),
        recordCell,
        percentCell,
      );
      return row;
    });
    document.getElementById('arena-body').replaceChildren(...rendered);
  }

  function schedule(delay) {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(poll, Math.max(1000, delay));
  }

  async function poll() {
    if (inFlight) return;
    if (document.hidden || navigator.onLine === false) {
      schedule(30000);
      return;
    }
    inFlight = true;
    try {
      const data = await security.fetchSnapshot('eval_arena_snapshot.json', security.normalizeArena, 7000);
      render(data);
      failures = 0;
      schedule(REFRESH_MS);
    } catch (_error) {
      failures += 1;
      renderFatal(location.protocol === 'file:'
        ? 'Serve this folder over HTTP to preview the arena snapshot.'
        : 'Could not load a valid arena snapshot.');
      schedule(security.retryDelay(failures, 10000, MAX_BACKOFF_MS));
    } finally {
      inFlight = false;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(0);
  });
  window.addEventListener('online', () => {
    failures = 0;
    schedule(0);
  });
  poll();
})();
