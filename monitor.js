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
const MIN_PRICE = 0.1;
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

async function loadTopTraders() {
  const [month, week] = await Promise.all([
    fetchJSON(`${LEADERBOARD_URL}?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=50`),
    fetchJSON(`${LEADERBOARD_URL}?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=50`),
  ]);
  const seen = new Set();
  const candidates = [];
  for (const t of [...month, ...week]) {
    if (seen.has(t.proxyWallet)) continue;
    seen.add(t.proxyWallet);
    const vol = t.vol || 0;
    if (vol < MIN_VOLUME) continue;
    candidates.push({
      wallet: t.proxyWallet,
      name: t.userName || t.proxyWallet.slice(0, 8),
      pnl: t.pnl || 0, vol,
      eff: vol > 0 ? (t.pnl || 0) / vol : 0,
    });
  }
  candidates.sort((a, b) => b.eff - a.eff);
  return candidates.slice(0, 20);
}

async function fetchPositions(wallet) {
  try {
    return await fetchJSON(`${POSITIONS_URL}?user=${wallet}&sizeThreshold=0.01`);
  } catch (e) {
    console.error(`positions fetch failed for ${wallet}: ${e.message}`);
    return [];
  }
}

function buildConsensus(topTraders, positionsByWallet, state, now) {
  const map = {};

  for (const t of topTraders) {
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

// Exit check for an alerted position: look at the EXACT wallets that formed the
// consensus, ignoring the 20-80c BUY band and the leaderboard entirely. A winning
// position crossing 80c, or a trader slipping to rank #21, must never read as an exit.
function checkHolders(key, wallets, positionsByWallet) {
  const idx = key.indexOf('|');
  const cid = key.slice(0, idx);
  const outcome = key.slice(idx + 1);
  let holding = 0, lost = 0, maxPrice = 0;
  for (const w of wallets) {
    const p = (positionsByWallet[w] || []).find(x => x.conditionId === cid && x.outcome === outcome);
    if (!p) continue;
    if ((p.currentValue ?? 1) <= 0) { lost++; continue; }
    holding++;
    const pr = Number(p.curPrice ?? NaN);
    if (!Number.isNaN(pr) && pr > maxPrice) maxPrice = pr;
  }
  return { holding, lost, maxPrice };
}

// Plain "..." not the unicode ellipsis: this gets used inside ntfy Title headers,
// which must stay ISO-8859-1 — the '…' character alone was enough to break them.
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 3) + '...' : (s || '');
}

// Market titles come from Polymarket's API and can contain smart quotes/dashes
// (e.g. "Women's" with a curly apostrophe) or other characters outside Latin-1.
// Any of those inside an ntfy header value throws and silently kills the push
// (see sendEntryPush). Normalize the common cases, then strip anything left —
// this only touches header text; body text keeps full original formatting.
function asciiSafe(s) {
  return (s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x00-\xFF]/g, '');
}

// Risk read from what's already computed — no extra API calls. Longshot price
// means big variance (win big or lose the stake); chasing means paying more
// than the smart money did; thin trader count means weaker confirmation.
function riskLevel(avgPrice, count, chase) {
  let score = 0;
  if (avgPrice != null) {
    if (avgPrice < 25) score += 2;
    else if (avgPrice > 65) score += 1;
  }
  if (chase) score += 2;
  if (count <= THRESHOLD) score += 1;
  else if (count >= 4) score -= 1;
  if (score >= 3) return { tag: 'HIGH', emoji: '🔴' };
  if (score >= 1) return { tag: 'MED', emoji: '🟡' };
  return { tag: 'LOW', emoji: '🟢' };
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
  const risk = riskLevel(avgPrice, count, chase);
  return { item, count, total, label, avgPrice, avgEntry, chase, risk };
}

// ntfy header VALUES must be ISO-8859-1 (single-byte). Any emoji here — including
// the risk-tag emoji — throws a "Cannot convert to ByteString" error that fetch()
// raises synchronously; the catch below swallows it silently. That previously
// killed every solo (non-digest) push while leaving state marked as "sent".
// Emoji are safe in the body (free-form UTF-8) and in 'Tags' (ntfy renders its
// own icon from the shortcode) — just never in a header string like Title/Click.
async function sendEntryPush(s) {
  const { item, count, total, label, avgPrice, avgEntry, chase, risk } = s;
  const p = avgPrice != null ? avgPrice.toFixed(1) : '?';
  const e = avgEntry != null ? avgEntry.toFixed(1) : '?';
  const outcome = item.outcome.toUpperCase();
  console.log(`BUY [${risk.tag}]: ${label} :: ${outcome} on "${item.title}" @ ${p}c (entry ~${e}c) :: ${item.traders.join(', ')}`);
  if (!NTFY_TOPIC) return true;
  const body = `**${outcome}** now ${p}c (their entry ~${e}c)\n${label}\n**Risk: ${risk.tag}**${chase ? `\n**${chase}**` : ''}\n\nTraders: ${item.traders.join(', ')}`;
  const headers = {
    'Title': asciiSafe(`[${risk.tag}] BUY - ${truncate(item.title, 38)} - ${outcome}`),
    'Priority': count >= 5 ? 'urgent' : 'high',
    'Tags': 'chart_increasing',
    'Markdown': 'yes',
  };
  if (item.slug) headers['Click'] = `https://polymarket.com/event/${item.slug}`;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body, headers });
    if (!res.ok) { console.error(`ntfy send failed: HTTP ${res.status}`); return false; }
    return true;
  } catch (e) {
    console.error('ntfy send failed:', e.message);
    return false;
  }
}

// kind: 'sell' = traders genuinely closed mid-market (act fast).
// 'lost' = market resolved against the outcome (nothing to do).
// 'won'  = price snapped to ~1 and traders are holding to resolution (redeem, don't panic).
async function sendExitPush(key, meta, kind = 'sell') {
  const outcome = key.slice(key.indexOf('|') + 1);
  const o = outcome?.toUpperCase() || '';
  const title = meta?.title || key.slice(0, 40);
  const variants = {
    sell: {
      head: `SELL - ${truncate(title, 40)} - ${o}`, prio: 'urgent', tags: 'chart_decreasing',
      body: `**Top traders exited ${o} while the market is still live.** If you copied this bet, close it now.\n\n${title}`,
    },
    lost: {
      head: `LOST - ${truncate(title, 40)} - ${o}`, prio: 'high', tags: 'x',
      body: `Market resolved against **${o}**. Position settled at 0 — nothing to do.\n\n${title}`,
    },
    won: {
      head: `WON - ${truncate(title, 40)} - ${o}`, prio: 'high', tags: 'white_check_mark',
      body: `**${o}** is at ~100c and traders are holding to resolution. **Hold — redeem when it settles.** Do not panic-sell.\n\n${title}`,
    },
  };
  const v = variants[kind] || variants.sell;
  console.log(`${kind.toUpperCase()}: ${o} on "${title}"`);
  if (!NTFY_TOPIC) return true;
  const headers = { 'Title': asciiSafe(v.head), 'Priority': v.prio, 'Tags': v.tags, 'Markdown': 'yes' };
  if (meta?.slug) headers['Click'] = `https://polymarket.com/event/${meta.slug}`;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body: v.body, headers });
    if (!res.ok) { console.error(`ntfy exit send failed: HTTP ${res.status}`); return false; }
    return true;
  } catch (e) {
    console.error('ntfy exit send failed:', e.message);
    return false;
  }
}

// Sends one push per run no matter how many signals fired, so multiple
// simultaneous events land as a single organized message instead of a burst.
async function sendDigest(entryEvents, exitEvents) {
  const totalEvents = entryEvents.length + exitEvents.length;
  if (totalEvents === 0) return true;

  if (totalEvents === 1) {
    if (entryEvents.length) return await sendEntryPush(entryEvents[0]);
    return await sendExitPush(exitEvents[0].key, exitEvents[0].meta, exitEvents[0].kind);
  }

  const lines = [];
  if (exitEvents.length) {
    const icon = { sell: '📉 SELL', lost: '❌ LOST', won: '✅ WON' };
    lines.push('**EXITS / RESULTS**');
    for (const { key, meta, kind } of exitEvents) {
      const outcome = key.slice(key.indexOf('|') + 1);
      lines.push(`${icon[kind] || icon.sell} · ${truncate(meta?.title || key, 45)} — ${outcome?.toUpperCase() || ''}`);
    }
  }
  if (entryEvents.length) {
    if (lines.length) lines.push('');
    lines.push('**BUY**');
    for (const s of entryEvents) {
      const p = s.avgPrice != null ? s.avgPrice.toFixed(1) : '?';
      lines.push(`${s.risk.emoji} ${truncate(s.item.title, 45)} — ${s.item.outcome.toUpperCase()} @ ${p}c${s.chase ? ' — do not chase' : ''} (${s.count}/${s.total}, ${s.risk.tag})`);
    }
  }
  const body = lines.join('\n');
  console.log(`DIGEST (${exitEvents.length} sell, ${entryEvents.length} buy):\n${body}`);
  if (!NTFY_TOPIC) return true;

  const headers = {
    'Title': `Polymarket: ${exitEvents.length} EXIT, ${entryEvents.length} BUY`,
    'Priority': 'high',
    'Tags': 'bell',
    'Markdown': 'yes',
  };
  const firstSlug = entryEvents[0]?.item.slug || exitEvents[0]?.meta?.slug;
  if (firstSlug) headers['Click'] = `https://polymarket.com/event/${firstSlug}`;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', body, headers });
    if (!res.ok) { console.error(`ntfy digest send failed: HTTP ${res.status}`); return false; }
    return true;
  } catch (e) {
    console.error('ntfy digest send failed:', e.message);
    return false;
  }
}

async function main() {
  const now = Date.now();
  const state = loadState();

  const topTraders = await loadTopTraders();
  console.log(`Top ${topTraders.length} traders by efficiency (MONTH+WEEK, vol>=$${MIN_VOLUME / 1e6}M):`);
  topTraders.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}  eff=${(t.eff * 100).toFixed(1)}%  vol=$${(t.vol / 1e6).toFixed(1)}M`));

  const positionsByWallet = {};
  for (const t of topTraders) {
    positionsByWallet[t.wallet] = await fetchPositions(t.wallet);
    await new Promise(r => setTimeout(r, 150)); // gentle on the public API
  }

  const map = buildConsensus(topTraders, positionsByWallet, state, now);

  // Migrate pre-wallet-tracking alerts: while their consensus is still visible,
  // record which wallets it's made of so exits can be judged wallet-by-wallet.
  for (const key of Object.keys(state.alertedAt)) {
    const meta = state.alertedMeta[key];
    if (meta && !meta.wallets && map[key] && map[key].traders.length >= 2) {
      meta.wallets = [...map[key].wallets];
    }
  }

  // Exit checks must see the consensus wallets even if they've dropped out of
  // the top-20 pool this run — fetch any that weren't already pulled.
  const extraWallets = new Set();
  for (const key of Object.keys(state.alertedAt)) {
    for (const w of state.alertedMeta[key]?.wallets || []) {
      if (!positionsByWallet[w]) extraWallets.add(w);
    }
  }
  for (const w of extraWallets) {
    positionsByWallet[w] = await fetchPositions(w);
    await new Promise(r => setTimeout(r, 150));
  }

  const entryEvents = [];
  const exitEvents = [];
  // Mutations that must only take effect once the push actually reaches ntfy —
  // otherwise a failed send still gets recorded as "delivered" and never retries.
  const commitOps = [];

  // A key drops out (price left the band, a trader closed, etc). Don't sell-alert
  // on the first miss — that could just be one wallet's API call hiccuping. Only
  // fire once it's been gone EXIT_CONFIRM_MISSES runs in a row.
  const trackedKeys = new Set([
    ...Object.keys(state.consensusFirstSeen),
    ...Object.keys(state.alertedAt),
    ...Object.keys(state.pendingExit),
  ]);
  const dropAlert = (key) => {
    delete state.consensusFirstSeen[key];
    delete state.alertedAt[key];
    delete state.alertedMeta[key];
    delete state.pendingExit[key];
  };
  for (const key of trackedKeys) {
    const meta = state.alertedMeta[key];
    if (state.alertedAt[key] && meta?.wallets) {
      // Wallet-based exit: judged only by whether the consensus wallets still
      // hold, at any price — immune to the BUY band and leaderboard churn.
      const { holding, lost, maxPrice } = checkHolders(key, meta.wallets, positionsByWallet);
      if (holding >= 2) {
        delete state.pendingExit[key];
        if (maxPrice >= 0.95 && !meta.wonNotified) {
          // one-time heads-up; keep tracking in case it reverses
          exitEvents.push({ key, meta, kind: 'won' });
          commitOps.push(() => { meta.wonNotified = true; });
        }
        continue;
      }
      const misses = (state.pendingExit[key] || 0) + 1;
      if (misses >= EXIT_CONFIRM_MISSES) {
        exitEvents.push({ key, meta, kind: lost > 0 ? 'lost' : 'sell' });
        commitOps.push(() => dropAlert(key));
      } else {
        state.pendingExit[key] = misses;
      }
      continue;
    }
    // Legacy / un-alerted keys: original consensus-visibility check.
    const alive = map[key] && map[key].traders.length >= 2;
    if (alive) {
      delete state.pendingExit[key]; // false alarm, cancel any pending exit
      continue;
    }
    if (state.alertedAt[key]) {
      const misses = (state.pendingExit[key] || 0) + 1;
      if (misses >= EXIT_CONFIRM_MISSES) {
        exitEvents.push({ key, meta: state.alertedMeta[key], kind: 'sell' });
        commitOps.push(() => dropAlert(key));
      } else {
        state.pendingExit[key] = misses;
      }
    } else {
      // Was still forming (never reached the alert threshold) — nothing to sell, just clean up.
      delete state.consensusFirstSeen[key];
      delete state.pendingExit[key];
    }
  }

  const total = topTraders.length || 10;
  for (const item of Object.values(map)) {
    const count = item.traders.length;
    if (count >= THRESHOLD && (item.ageMs || 0) >= PERSIST_WINDOW_MS) {
      const lastAlerted = state.alertedAt[item.key] || 0;
      if (count > lastAlerted) {
        entryEvents.push(summarizeEntry(item, count, total, lastAlerted === 0 ? 'new' : 'increased'));
        commitOps.push(() => {
          state.alertedAt[item.key] = count;
          state.alertedMeta[item.key] = { title: item.title, slug: item.slug, wallets: [...item.wallets] };
        });
      }
    }
  }

  const sent = await sendDigest(entryEvents, exitEvents);
  if (sent) {
    for (const op of commitOps) op();
  } else if (commitOps.length) {
    console.error(`Push failed — ${commitOps.length} alert(s) deferred to retry next run instead of being marked delivered.`);
  }

  console.log(`Run complete. Consensus positions tracked: ${Object.values(map).filter(i => i.traders.length >= 2).length}. Buys: ${entryEvents.length}. Sells: ${exitEvents.length}.`);
  saveState(state);
}

main().catch(e => {
  console.error('Monitor run failed:', e);
  process.exit(1);
});
