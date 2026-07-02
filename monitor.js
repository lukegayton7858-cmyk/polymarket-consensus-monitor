// Polymarket consensus monitor — headless version of dashboard.html for GitHub Actions.
// Runs stateless per-invocation; state.json (committed back to the repo each run) carries
// consensus age and alert history across runs so the persistence gate actually works.

const fs = require('fs');
const path = require('path');

const LEADERBOARD_URL = 'https://data-api.polymarket.com/v1/leaderboard';
const POSITIONS_URL = 'https://data-api.polymarket.com/positions';
const STATE_FILE = path.join(__dirname, 'state.json');

const THRESHOLD = 2;
const MIN_VOLUME = 500_000;
const MIN_PRICE = 0.2;
const MAX_PRICE = 0.8;
const PERSIST_WINDOW_MS = 15 * 60 * 1000;

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return { consensusFirstSeen: {}, alertedAt: {}, alertedMeta: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-consensus-monitor' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function loadTop10() {
  const data = await fetchJSON(`${LEADERBOARD_URL}?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=50`);
  const candidates = data
    .map(t => ({
      wallet: t.proxyWallet,
      name: t.userName || t.proxyWallet.slice(0, 8),
      pnl: t.pnl || 0,
      vol: t.vol || 0,
      eff: t.vol > 0 ? (t.pnl || 0) / t.vol : 0,
    }))
    .filter(t => t.vol >= MIN_VOLUME);
  candidates.sort((a, b) => b.eff - a.eff);
  return candidates.slice(0, 10);
}

async function fetchPositions(wallet) {
  try {
    return await fetchJSON(`${POSITIONS_URL}?user=${wallet}&sizeThreshold=0.01`);
  } catch (e) {
    console.error(`positions fetch failed for ${wallet}: ${e.message}`);
    return [];
  }
}

function buildConsensus(top10, positionsByWallet, state, now) {
  const map = {};

  for (const t of top10) {
    const pos = positionsByWallet[t.wallet] || [];
    const seenForTrader = new Set();
    for (const p of pos) {
      if (!p.conditionId || !p.outcome) continue;
      if ((p.currentValue ?? 1) <= 0) continue; // skip settled/resolved positions

      const cur = Number(p.curPrice ?? NaN);
      const entry = Number(p.avgPrice ?? NaN);
      const price = Number.isNaN(cur) ? entry : cur;
      if (!Number.isNaN(price) && (price < MIN_PRICE || price > MAX_PRICE)) continue;

      const key = `${p.conditionId}|${p.outcome}`;
      if (seenForTrader.has(key)) continue;
      seenForTrader.add(key);

      if (!map[key]) {
        map[key] = {
          key,
          conditionId: p.conditionId,
          title: p.title || p.conditionId.slice(0, 12) + '…',
          outcome: p.outcome,
          slug: p.eventSlug || p.slug || '',
          wallets: new Set(),
          traders: [],
          prices: [],
          entries: [],
        };
      }
      if (map[key].wallets.has(t.wallet)) continue;
      map[key].wallets.add(t.wallet);
      map[key].traders.push(t.name);
      if (!Number.isNaN(price)) map[key].prices.push(price);
      if (!Number.isNaN(entry)) map[key].entries.push(entry);
    }
  }

  for (const item of Object.values(map)) {
    if (item.traders.length >= 2) {
      if (!state.consensusFirstSeen[item.key]) state.consensusFirstSeen[item.key] = now;
      item.firstSeen = state.consensusFirstSeen[item.key];
      item.ageMs = now - item.firstSeen;
    }
  }

  return map;
}

async function fireConsensusAlert(item, count, total, reason) {
  const avgPrice = item.prices.length
    ? (item.prices.reduce((s, p) => s + Number(p), 0) / item.prices.length * 100).toFixed(1)
    : null;
  const avgEntry = item.entries.length
    ? (item.entries.reduce((s, p) => s + p, 0) / item.entries.length * 100).toFixed(1)
    : null;
  const m = Math.floor((item.ageMs || 0) / 60000);
  const heldTxt = m < 60 ? `held ${m}m` : `held ${Math.floor(m / 60)}h ${m % 60}m`;
  const label = reason === 'new' ? `${count}/${total} traders agree, ${heldTxt}` : `${count}/${total} traders — grew while held`;

  console.log(`ALERT: ${label} :: ${item.outcome.toUpperCase()} on "${item.title}" @ ${avgPrice}c (entry ~${avgEntry}c) :: ${item.traders.join(', ')}`);

  if (!NTFY_TOPIC) return;
  const chase = (avgPrice && avgEntry && (avgPrice - avgEntry) > 8)
    ? `\nWARNING: price is ${(avgPrice - avgEntry).toFixed(0)}c above their entry - do not chase` : '';
  const body = `${label}\n\n${item.title}\n\n${item.outcome.toUpperCase()} now ${avgPrice}c (their entry ~${avgEntry}c)${chase}\n\nTraders: ${item.traders.join(', ')}`;
  const headers = {
    'Title': `Polymarket Consensus: ${count}/${total} traders agree`,
    'Priority': count >= 5 ? 'urgent' : 'high',
    'Tags': 'chart_increasing',
  };
  if (item.slug) headers['Click'] = `https://polymarket.com/event/${item.slug}`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body, headers });
  } catch (e) {
    console.error('ntfy send failed:', e.message);
  }
}

async function fireExitAlert(key, meta) {
  const [, outcome] = key.split('|');
  const title = meta?.title || key.slice(0, 40);
  console.log(`EXIT: traders left ${outcome?.toUpperCase() || ''} on "${title}"`);
  if (!NTFY_TOPIC) return;
  const headers = { 'Title': 'Polymarket EXIT: consensus dissolved', 'Priority': 'urgent', 'Tags': 'rotating_light' };
  if (meta?.slug) headers['Click'] = `https://polymarket.com/event/${meta.slug}`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      body: `${title}\n\nTop traders exited ${outcome?.toUpperCase() || ''}. If you copied this bet, consider closing.`,
      headers,
    });
  } catch (e) {
    console.error('ntfy exit send failed:', e.message);
  }
}

async function main() {
  const now = Date.now();
  const state = loadState();

  const top10 = await loadTop10();
  console.log(`Top ${top10.length} traders by efficiency (vol>=$${MIN_VOLUME / 1e6}M):`);
  top10.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}  eff=${(t.eff * 100).toFixed(1)}%  vol=$${(t.vol / 1e6).toFixed(1)}M`));

  const positionsByWallet = {};
  for (const t of top10) {
    positionsByWallet[t.wallet] = await fetchPositions(t.wallet);
    await new Promise(r => setTimeout(r, 150)); // gentle on the public API
  }

  const map = buildConsensus(top10, positionsByWallet, state, now);

  // Prune / fire exits for keys that dissolved below 2 traders.
  const trackedKeys = new Set([...Object.keys(state.consensusFirstSeen), ...Object.keys(state.alertedAt)]);
  for (const key of trackedKeys) {
    if (!map[key] || map[key].traders.length < 2) {
      if (state.alertedAt[key]) await fireExitAlert(key, map[key] || state.alertedMeta[key]);
      delete state.consensusFirstSeen[key];
      delete state.alertedAt[key];
      delete state.alertedMeta[key];
    }
  }

  const total = top10.length || 10;
  let fired = 0;
  for (const item of Object.values(map)) {
    const count = item.traders.length;
    if (count >= THRESHOLD && (item.ageMs || 0) >= PERSIST_WINDOW_MS) {
      const lastAlerted = state.alertedAt[item.key] || 0;
      if (count > lastAlerted) {
        await fireConsensusAlert(item, count, total, lastAlerted === 0 ? 'new' : 'increased');
        state.alertedAt[item.key] = count;
        state.alertedMeta[item.key] = { title: item.title, slug: item.slug };
        fired++;
      }
    }
  }

  console.log(`Run complete. Consensus positions tracked: ${Object.values(map).filter(i => i.traders.length >= 2).length}. Alerts fired: ${fired}.`);
  saveState(state);
}

main().catch(e => {
  console.error('Monitor run failed:', e);
  process.exit(1);
});
