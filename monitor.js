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
const PERSIST_WINDOW_MS = 5 * 60 * 1000;
const EXIT_CONFIRM_MISSES = 2; // must be gone 2 consecutive runs before we call it a real exit, not an API blip

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.pendingExit) s.pendingExit = {};
    return s;
  } catch (_) {
    return { consensusFirstSeen: {}, alertedAt: {}, alertedMeta: {}, pendingExit: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchJSON(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'polymarket-consensus-monitor' } });
    if (res.status === 429 && attempt < retries) {
      const waitMs = Number(res.headers.get('retry-after')) * 1000 || (1000 * 2 ** attempt);
      console.log(`429 rate limited, retrying in ${waitMs}ms: ${url}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }
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
      // currentValue is the reliable liveness signal: a resolved/lost position
      // settles to 0 here, a resolved/won one snaps to a terminal curPrice (0 or 1)
      // rather than sitting mid-range. endDate is NOT reliable for this — Polymarket
      // returns it as a date-only string (e.g. "2026-07-02"), which parses as
      // midnight UTC, making every still-live same-day market look "already ended"
      // for the rest of that day.
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

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '');
}

function summarizeEntry(item, count, total, reason) {
  const avgPrice = item.prices.length
    ? (item.prices.reduce((s, p) => s + Number(p), 0) / item.prices.length * 100)
    : null;
  const avgEntry = item.entries.length
    ? (item.entries.reduce((s, p) => s + p, 0) / item.entries.length * 100)
    : null;
  const m = Math.floor((item.ageMs || 0) / 60000);
  const heldTxt = m < 60 ? `held ${m}m` : `held ${Math.floor(m / 60)}h ${m % 60}m`;
  const label = reason === 'new' ? `${count}/${total} traders agree, ${heldTxt}` : `${count}/${total} traders — grew while held`;
  const chase = (avgPrice != null && avgEntry != null && (avgPrice - avgEntry) > 8)
    ? `WARNING: price is ${(avgPrice - avgEntry).toFixed(0)}c above their entry - do not chase` : null;
  return { item, count, total, label, avgPrice, avgEntry, chase };
}

async function sendEntryPush(s) {
  const { item, count, total, label, avgPrice, avgEntry, chase } = s;
  const p = avgPrice != null ? avgPrice.toFixed(1) : '?';
  const e = avgEntry != null ? avgEntry.toFixed(1) : '?';
  const outcome = item.outcome.toUpperCase();
  console.log(`BUY: ${label} :: ${outcome} on "${item.title}" @ ${p}c (entry ~${e}c) :: ${item.traders.join(', ')}`);
  if (!NTFY_TOPIC) return;
  const body = `**${outcome}** now ${p}c (their entry ~${e}c)\n${label}${chase ? `\n**${chase}**` : ''}\n\nTraders: ${item.traders.join(', ')}`;
  const headers = {
    'Title': `📈 BUY · ${truncate(item.title, 40)} — ${outcome}`,
    'Priority': count >= 5 ? 'urgent' : 'high',
    'Tags': 'chart_increasing',
    'Markdown': 'yes',
  };
  if (item.slug) headers['Click'] = `https://polymarket.com/event/${item.slug}`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body, headers });
  } catch (e) {
    console.error('ntfy send failed:', e.message);
  }
}

async function sendExitPush(key, meta) {
  const [, outcome] = key.split('|');
  const o = outcome?.toUpperCase() || '';
  const title = meta?.title || key.slice(0, 40);
  console.log(`SELL: traders left ${o} on "${title}"`);
  if (!NTFY_TOPIC) return;
  const headers = {
    'Title': `📉 SELL · ${truncate(title, 40)} — ${o}`,
    'Priority': 'urgent',
    'Tags': 'chart_decreasing',
    'Markdown': 'yes',
  };
  if (meta?.slug) headers['Click'] = `https://polymarket.com/event/${meta.slug}`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      body: `**Top traders exited ${o}.** If you copied this bet, close it.\n\n${title}`,
      headers,
    });
  } catch (e) {
    console.error('ntfy exit send failed:', e.message);
  }
}

// Sends one push per run no matter how many signals fired, so multiple
// simultaneous events land as a single organized message instead of a burst.
async function sendDigest(entryEvents, exitEvents) {
  const totalEvents = entryEvents.length + exitEvents.length;
  if (totalEvents === 0) return;

  if (totalEvents === 1) {
    if (entryEvents.length) await sendEntryPush(entryEvents[0]);
    else await sendExitPush(exitEvents[0].key, exitEvents[0].meta);
    return;
  }

  const lines = [];
  if (exitEvents.length) {
    lines.push('**SELL**');
    for (const { key, meta } of exitEvents) {
      const [, outcome] = key.split('|');
      lines.push(`📉 ${truncate(meta?.title || key, 45)} — ${outcome?.toUpperCase() || ''}`);
    }
  }
  if (entryEvents.length) {
    if (lines.length) lines.push('');
    lines.push('**BUY**');
    for (const s of entryEvents) {
      const p = s.avgPrice != null ? s.avgPrice.toFixed(1) : '?';
      lines.push(`📈 ${truncate(s.item.title, 45)} — ${s.item.outcome.toUpperCase()} @ ${p}c${s.chase ? ' — do not chase' : ''} (${s.count}/${s.total})`);
    }
  }
  const body = lines.join('\n');
  console.log(`DIGEST (${exitEvents.length} sell, ${entryEvents.length} buy):\n${body}`);
  if (!NTFY_TOPIC) return;

  const headers = {
    'Title': `Polymarket: ${exitEvents.length} SELL, ${entryEvents.length} BUY`,
    'Priority': 'high',
    'Tags': 'bell',
    'Markdown': 'yes',
  };
  const firstSlug = entryEvents[0]?.item.slug || exitEvents[0]?.meta?.slug;
  if (firstSlug) headers['Click'] = `https://polymarket.com/event/${firstSlug}`;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body, headers });
  } catch (e) {
    console.error('ntfy digest send failed:', e.message);
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

  const entryEvents = [];
  const exitEvents = [];

  // A key drops out (price left the band, a trader closed, etc). Don't sell-alert
  // on the first miss — that could just be one wallet's API call hiccuping. Only
  // fire once it's been gone EXIT_CONFIRM_MISSES runs in a row.
  const trackedKeys = new Set([
    ...Object.keys(state.consensusFirstSeen),
    ...Object.keys(state.alertedAt),
    ...Object.keys(state.pendingExit),
  ]);
  for (const key of trackedKeys) {
    const alive = map[key] && map[key].traders.length >= 2;
    if (alive) {
      delete state.pendingExit[key]; // false alarm, cancel any pending exit
      continue;
    }
    if (state.alertedAt[key]) {
      const misses = (state.pendingExit[key] || 0) + 1;
      if (misses >= EXIT_CONFIRM_MISSES) {
        // Position dropped out of the top traders' holdings — either they sold,
        // or the market resolved against them (currentValue hit 0 either way).
        // Same actionable message either way: they're no longer in it.
        exitEvents.push({ key, meta: state.alertedMeta[key] });
        delete state.consensusFirstSeen[key];
        delete state.alertedAt[key];
        delete state.alertedMeta[key];
        delete state.pendingExit[key];
      } else {
        state.pendingExit[key] = misses;
      }
    } else {
      // Was still forming (never reached the alert threshold) — nothing to sell, just clean up.
      delete state.consensusFirstSeen[key];
      delete state.pendingExit[key];
    }
  }

  const total = top10.length || 10;
  for (const item of Object.values(map)) {
    const count = item.traders.length;
    if (count >= THRESHOLD && (item.ageMs || 0) >= PERSIST_WINDOW_MS) {
      const lastAlerted = state.alertedAt[item.key] || 0;
      if (count > lastAlerted) {
        entryEvents.push(summarizeEntry(item, count, total, lastAlerted === 0 ? 'new' : 'increased'));
        state.alertedAt[item.key] = count;
        state.alertedMeta[item.key] = { title: item.title, slug: item.slug };
      }
    }
  }

  await sendDigest(entryEvents, exitEvents);

  console.log(`Run complete. Consensus positions tracked: ${Object.values(map).filter(i => i.traders.length >= 2).length}. Buys: ${entryEvents.length}. Sells: ${exitEvents.length}.`);
  saveState(state);
}

main().catch(e => {
  console.error('Monitor run failed:', e);
  process.exit(1);
});
