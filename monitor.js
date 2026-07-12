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
// Polymarket-v1 research (Qin & Yang, arXiv 2606.04217) documents a favorite-
// longshot REVERSAL on this platform: 0-30c is systematically overpriced
// (negative returns), 70-100c is systematically underpriced (positive returns)
// — backwards from the classic sports-betting bias. Floor matches that decile
// boundary. Cap stays at 80c on purpose: the 80-95c edge is real in EV terms,
// but risking 90c to win 10c means one upset erases ~9 wins — that's a
// bankroll-survival call, not a data disagreement.
const MIN_PRICE = 0.3;
const MAX_PRICE = 0.8;
const PERSIST_WINDOW_MS = 5 * 60 * 1000;
const EXIT_CONFIRM_MISSES = 2; // must be gone 2 consecutive runs before we call it a real exit, not an API blip
const FORM_MISS_TOLERANCE = 2; // same grace period, applied while a signal is still accumulating its 5-min age

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
// Luke's own Polymarket wallet (public on-chain data). When set, exit pushes
// (SELL/LOST/WON/TRIM) only fire for markets he actually holds — BUYs unaffected.
const MY_WALLET = process.env.MY_WALLET || '';
// MY_WALLET alone only feeds the calibration history log (read-only, matches
// Luke's real trades against our alert history). The exit-suppression feature
// he declined stays off unless this is separately turned on.
const FILTER_EXITS_TO_MY_WALLET = process.env.FILTER_EXITS_TO_MY_WALLET === 'true';

const HISTORY_FILE = path.join(__dirname, 'history.jsonl');

// state.json only tracks what's CURRENTLY active — the moment an alert
// resolves, dropAlert() deletes it entirely, so there was never any durable
// record of what we alerted, at what price/risk/conviction, or how it turned
// out. That's the missing piece for calibrating against real results (ours or
// Luke's). Append-only JSON Lines: cheap to write, no read-modify-write race
// with the rest of state, trivial to grep or replay later.
function appendHistory(records) {
  if (!records.length) return;
  fs.appendFileSync(HISTORY_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

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

// Retries 429 (rate limit), 5xx (transient server errors), and network-level
// failures (timeout, DNS, connection reset) - anything NOT retried here throws
// straight out of loadTopTraders()'s Promise.all and kills the entire run with
// zero traders checked, zero alerts, for what's usually a one-off blip.
async function fetchJSON(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'polymarket-consensus-monitor' } });
    } catch (e) {
      if (attempt < retries) {
        const waitMs = 1000 * 2 ** attempt;
        console.log(`network error, retrying in ${waitMs}ms: ${url} (${e.message})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const waitMs = Number(res.headers.get('retry-after')) * 1000 || (1000 * 2 ** attempt);
      console.log(`${res.status} response, retrying in ${waitMs}ms: ${url}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }
}

async function loadTopTraders() {
  // Blended, not replaced: OVERALL currently doubles as a sports leaderboard
  // since the World Cup dominates platform-wide volume, but that won't last —
  // once general activity normalizes, OVERALL drifts back toward crypto/
  // politics specialists with no sports edge. SPORTS keeps the pool anchored
  // to what's actually being bet on (soccer, tennis, esports) regardless.
  const [overallMonth, overallWeek, sportsMonth, sportsWeek] = await Promise.all([
    fetchJSON(`${LEADERBOARD_URL}?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=50`),
    fetchJSON(`${LEADERBOARD_URL}?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=50`),
    fetchJSON(`${LEADERBOARD_URL}?category=SPORTS&timePeriod=MONTH&orderBy=PNL&limit=50`),
    fetchJSON(`${LEADERBOARD_URL}?category=SPORTS&timePeriod=WEEK&orderBy=PNL&limit=50`),
  ]);
  // Tag traders only reachable via the SPORTS boards, so history can later
  // prove whether the blend improves hit rate — if sports-only consensus
  // underperforms, the blend gets removed on evidence instead of a guess.
  const overallWallets = new Set([...overallMonth, ...overallWeek].map(t => t.proxyWallet));
  const seen = new Set();
  const candidates = [];
  for (const t of [...overallMonth, ...overallWeek, ...sportsMonth, ...sportsWeek]) {
    if (seen.has(t.proxyWallet)) continue;
    seen.add(t.proxyWallet);
    const vol = t.vol || 0;
    if (vol < MIN_VOLUME) continue;
    candidates.push({
      wallet: t.proxyWallet,
      name: t.userName || t.proxyWallet.slice(0, 8),
      pnl: t.pnl || 0, vol,
      eff: vol > 0 ? (t.pnl || 0) / vol : 0,
      sportsOnly: !overallWallets.has(t.proxyWallet),
    });
  }
  // Efficiency (PNL/vol) with the $500k floor, NOT raw-PNL leaderboard order.
  // This is the config with measured results behind it: the 12W-3L 2026-07-06
  // day ran on it, and the corrected Jul 9-12 record (after fixing wins being
  // mislogged as sells) was 23W-16L (59%). A raw-PNL pool pulls in $200M+
  // volume grinders at 1-9% return-per-dollar whose individual bets carry no
  // copyable per-bet edge — briefly tried 2026-07-12, reverted same day.
  candidates.sort((a, b) => b.eff - a.eff);
  // 30, not 20: daily leaderboard churn regularly drops one half of a live
  // 2-trader consensus to rank ~21-25, silently killing the signal (measured
  // live 2026-07-09: top-20 saw 0 plays on France-Morocco, top-30 saw 4, the
  // full 72-wallet pool saw 36 mostly self-contradicting ones).
  return candidates.slice(0, 30);
}

// null = fetch FAILED (unknown state), [] = fetch succeeded and wallet holds
// nothing. The distinction drives exit speed: a confirmed-empty response is
// proof they sold; a failed fetch proves nothing and must not look identical.
async function fetchPositions(wallet) {
  try {
    return await fetchJSON(`${POSITIONS_URL}?user=${wallet}&sizeThreshold=0.01`);
  } catch (e) {
    console.error(`positions fetch failed for ${wallet}: ${e.message}`);
    return null;
  }
}

function buildConsensus(topTraders, positionsByWallet, state, now) {
  const map = {};
  // Every live pool position per conditionId|outcome, counted BEFORE the price
  // band filter — an alert at 75c has its natural counterparty at 25c, outside
  // the band, so band-filtered `map` alone systematically hides opposition.
  // Used only to annotate alerts with who's on the other side; never gates them.
  const sides = {};

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

      const sideKey = `${p.conditionId}|${p.outcome}`;
      const side = (sides[sideKey] ||= { conditionId: p.conditionId, outcome: p.outcome, wallets: new Set(), names: [], usd: 0 });
      if (!side.wallets.has(t.wallet)) {
        side.wallets.add(t.wallet);
        side.names.push(t.name);
        side.usd += Number(p.initialValue) || 0;
      }

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
          usd: 0,
        };
      }
      if (map[key].wallets.has(t.wallet)) continue;
      map[key].wallets.add(t.wallet);
      map[key].traders.push(t.name);
      if (!Number.isNaN(price)) map[key].prices.push(price);
      if (!Number.isNaN(entry)) map[key].entries.push(entry);
      map[key].usd += Number(p.initialValue) || 0; // cost basis = conviction in dollars
      if (t.sportsOnly) map[key].sportsOnlyCount = (map[key].sportsOnlyCount || 0) + 1;
      map[key].size = (map[key].size || 0) + (Number(p.size) || 0); // shares held, baseline for trim detection
    }
  }

  for (const item of Object.values(map)) {
    if (item.traders.length >= 2) {
      if (!state.consensusFirstSeen[item.key]) state.consensusFirstSeen[item.key] = now;
      item.firstSeen = state.consensusFirstSeen[item.key];
      item.ageMs = now - item.firstSeen;
    }
  }

  return { map, sides };
}

// Fact-only opposition summary for an alert: which pool traders hold any OTHER
// outcome of the same market right now. No verdict, no scoring — with ~8 days
// of outcome history any "which side is smarter" weighting would be invented
// confidence, not evidence. Revisit once calibration history can back a model.
function oppositionFor(item, sides) {
  const opp = { n: 0, usd: 0, names: [] };
  for (const s of Object.values(sides)) {
    if (s.conditionId !== item.conditionId || s.outcome === item.outcome) continue;
    opp.n += s.wallets.size;
    opp.usd += s.usd;
    opp.names.push(...s.names);
  }
  return opp.n > 0 ? opp : null;
}

// Exit check for an alerted position: look at the EXACT wallets that formed the
// consensus, ignoring the 20-80c BUY band and the leaderboard entirely. A winning
// position crossing 80c, or a trader slipping to rank #21, must never read as an exit.
function checkHolders(key, wallets, positionsByWallet) {
  const idx = key.indexOf('|');
  const cid = key.slice(0, idx);
  const outcome = key.slice(idx + 1);
  let holding = 0, lost = 0, maxPrice = 0, totalSize = 0, unknown = 0;
  for (const w of wallets) {
    const pos = positionsByWallet[w];
    if (pos == null) { unknown++; continue; } // fetch failed — no evidence either way
    const p = pos.find(x => x.conditionId === cid && x.outcome === outcome);
    if (!p) continue;
    if ((p.currentValue ?? 1) <= 0) { lost++; continue; }
    holding++;
    totalSize += Number(p.size) || 0;
    const pr = Number(p.curPrice ?? NaN);
    if (!Number.isNaN(pr) && pr > maxPrice) maxPrice = pr;
  }
  return { holding, lost, maxPrice, totalSize, unknown };
}

// Plain "..." not the unicode ellipsis: this gets used inside ntfy Title headers,
// which must stay ISO-8859-1 — the '…' character alone was enough to break them.
function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 3) + '...' : (s || '');
}

// Keeps the whole Title within a fixed character budget no matter how long the
// outcome word or market question are, so the OS never cuts it off mid-word at
// an unpredictable point — our own "..." always lands cleanly instead.
// Collapses a market's slug down to its underlying real-world event. Per-game
// slugs carry an embedded date ("fifwc-mex-eng-2026-07-05-more-markets" -> the
// same key for every sub-market of that one match). Standing tournament
// outrights have no date ("world-cup-winner") and are left exactly as-is,
// since each team there is a genuinely separate, independent bet.
// Returns null for anything WITHOUT an embedded date — e.g. "world-cup-winner"
// groups every team's outright bet under one category slug, but those are
// genuinely independent bets (France winning vs Argentina winning are
// different real-world outcomes) and must never be clustered just because the
// slug string matches. Only a real per-game date means "same actual event."
function eventKey(slug) {
  if (!slug) return null;
  const m = slug.match(/^(.*?\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function boundTitle(prefix, title, maxTotal = 48) {
  const room = Math.max(maxTotal - prefix.length, 12);
  return asciiSafe(prefix + truncate(title, room));
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
function riskLevel(avgPrice, count, chase, usd = 0) {
  let score = 0;
  if (avgPrice != null) {
    if (avgPrice < 25) score += 2;
    else if (avgPrice > 65) score += 1;
  }
  if (chase) score += 2;
  // Trader count is deliberately NOT scored. Twice this got tuned on broken
  // accounting: first a "more heads = safer" bonus (intuition, no data), then
  // a 0W-8L penalty that turned out to be redeemed WINS mislogged as sells.
  // Corrected record through 2026-07-12: 2x = 48W-37L (56%), 3x = 9W-10L
  // (47%), 4+ = 12W-8L (60%) — no consistent signal either direction.
  // Leave neutral until calibrate.js shows a bucket that survives the
  // exit-price correction.
  // Dollar conviction: $50k+ of the traders' own cost basis is a stronger
  // signal than an extra head; pocket-change consensus is weaker than it looks.
  if (usd >= 50_000) score -= 1;
  else if (usd > 0 && usd < 5_000) score += 1;
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
  const risk = riskLevel(avgPrice, count, chase, item.usd);
  return { item, count, total, label, avgPrice, avgEntry, chase, risk };
}

function fmtUsd(n) {
  if (!n || n <= 0) return null;
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
}

// ntfy header VALUES must be ISO-8859-1 (single-byte). Any emoji here — including
// the risk-tag emoji — throws a "Cannot convert to ByteString" error that fetch()
// raises synchronously; the catch below swallows it silently. That previously
// killed every solo (non-digest) push while leaving state marked as "sent".
// Emoji are safe in the body (free-form UTF-8) and in 'Tags' (ntfy renders its
// own icon from the shortcode) — just never in a header string like Title/Click.
async function sendEntryPush(s) {
  const { item, count, total, label, avgPrice, avgEntry, chase, risk, corroborating } = s;
  const p = avgPrice != null ? avgPrice.toFixed(1) : '?';
  const e = avgEntry != null ? avgEntry.toFixed(1) : '?';
  const outcome = item.outcome.toUpperCase();
  console.log(`BUY [${risk.tag}]: ${label} :: ${outcome} on "${item.title}" @ ${p}c (entry ~${e}c) :: ${item.traders.join(', ')}`);
  if (!NTFY_TOPIC) return true;
  // Title is a fixed-budget ASCII summary (side + price only — risk/emoji can't
  // live in a header). Body leads with the risk emoji since that's unrestricted
  // and is what you actually read once the notification's open.
  const usd = fmtUsd(item.usd);
  const corrLine = corroborating?.length
    ? `\n\n🔗 Same game, already active: ${corroborating.map(c => `${c.title} (${c.outcome})`).join(', ')}`
    : '';
  const opp = s.opposition;
  const oppLine = opp
    ? `\n⚖️ Note: ${opp.n} pool trader${opp.n > 1 ? 's' : ''} on the other side (${fmtUsd(opp.usd) || '<$1k'}): ${opp.names.slice(0, 3).join(', ')}${opp.names.length > 3 ? '…' : ''}`
    : '';
  const body = `${risk.emoji} **${outcome} @ ${p}c** — Risk: ${risk.tag}${usd ? ` — 💰 ${usd} behind it` : ''}\n${item.title}\nEntry ~${e}c · ${label}${chase ? `\n⚠️ **${chase}**` : ''}${oppLine}\n\n👥 ${item.traders.join(', ')}${corrLine}`;
  const headers = {
    'Title': boundTitle(`BUY ${outcome} @ ${Math.round(avgPrice ?? 0)}c - `, item.title),
    // Attention matches risk: green buzzes, yellow lands quietly, red whispers.
    // All still send (yellow carried the Argentina @19c winner) — Luke reads
    // green first but nothing is hidden, and calibration keeps logging all tiers.
    // No count>=5 'urgent' override anymore: big-crowd consensus is the 0W-8L
    // bucket — the tag (HIGH → min) is the honest volume knob, not a megaphone.
    'Priority': risk.tag === 'LOW' ? 'high' : risk.tag === 'MED' ? 'default' : 'min',
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
async function sendExitPush(key, meta, kind = 'sell', pct = 0) {
  const outcome = key.slice(key.indexOf('|') + 1);
  const o = outcome?.toUpperCase() || '';
  const title = meta?.title || key.slice(0, 40);
  const variants = {
    trim: {
      head: boundTitle(`TRIM ${o} -${pct}% - `, title), prio: 'high', tags: 'warning',
      body: `⚠️ **${o} — traders cut ${pct}% of their position**\n${title}\nThey haven't fully exited, but they've reduced hard since the alert. Consider trimming yours too.`,
    },
    sell: {
      head: boundTitle(`SELL ${o} NOW - `, title), prio: 'urgent', tags: 'chart_decreasing',
      body: `📉 **${o} — close this now**\n${title}\nTop traders exited while the market is still live. If you copied this bet, close it.`,
    },
    lost: {
      head: boundTitle(`LOST ${o} - `, title), prio: 'high', tags: 'x',
      body: `❌ **${o} — lost**\n${title}\nMarket resolved against ${o}. Position settled at 0 — nothing to do.`,
    },
    won: {
      head: boundTitle(`WON ${o}, redeem - `, title), prio: 'high', tags: 'white_check_mark',
      body: `✅ **${o} — won**\n${title}\nPrice hit ~100c. If it hasn't settled yet, hold and redeem at resolution — do not panic-sell.`,
    },
  };
  const v = variants[kind] || variants.sell;
  console.log(`${kind.toUpperCase()}: ${o} on "${title}"`);
  if (!NTFY_TOPIC) return true;
  const headers = { 'Title': v.head, 'Priority': v.prio, 'Tags': v.tags, 'Markdown': 'yes' };
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

// One push per play (Luke's preference — matches the original tracker): every
// BUY and every exit lands as its own notification instead of one merged
// digest. Same-game correlation still shows, but inside each push via the
// corroborating line. Returns true only if EVERY push succeeded — a partial
// failure re-fires the whole batch next run, so a flaky send can duplicate an
// already-delivered play; a duplicated play beats a silently dropped one.
async function sendDigest(entryEvents, exitEvents) {
  if (entryEvents.length + exitEvents.length === 0) return true;

  // Urgency order preserved across separate pushes: live SELLs first (act
  // now), then results, then BUYs safest-first, with a short gap so they
  // arrive on the phone in that order.
  const kindOrder = { sell: 0, trim: 1, lost: 2, won: 3 };
  const sortedExits = [...exitEvents].sort((a, b) => (kindOrder[a.kind] ?? 0) - (kindOrder[b.kind] ?? 0));
  const riskOrder = { LOW: 0, MED: 1, HIGH: 2 };
  const sortedEntries = [...entryEvents].sort((a, b) =>
    (riskOrder[a.risk.tag] - riskOrder[b.risk.tag]) || (b.count - a.count));

  // Same-run same-game signals cross-reference each other in their
  // corroborating lines, replacing the old grouped-digest block.
  for (const s of sortedEntries) {
    if (!s.groupKey) continue;
    const others = sortedEntries
      .filter(x => x.groupKey === s.groupKey && x.item.key !== s.item.key)
      .map(x => ({ title: x.item.title, outcome: x.item.outcome.toUpperCase() }));
    if (others.length) s.corroborating = [...(s.corroborating || []), ...others];
  }

  let allOk = true;
  for (const e of sortedExits) {
    allOk = (await sendExitPush(e.key, e.meta, e.kind, e.pct)) && allOk;
    if (NTFY_TOPIC) await new Promise(r => setTimeout(r, 400));
  }
  for (const s of sortedEntries) {
    allOk = (await sendEntryPush(s)) && allOk;
    if (NTFY_TOPIC) await new Promise(r => setTimeout(r, 400));
  }
  return allOk;
}

async function main() {
  const now = Date.now();
  const state = loadState();

  const topTraders = await loadTopTraders();
  console.log(`Top ${topTraders.length} traders by efficiency (MONTH+WEEK, vol>=$${MIN_VOLUME / 1e6}M):`);
  topTraders.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}  eff=${(t.eff * 100).toFixed(1)}%  pnl=$${(t.pnl / 1e6).toFixed(2)}M  vol=$${(t.vol / 1e6).toFixed(1)}M`));

  const positionsByWallet = {};
  for (const t of topTraders) {
    positionsByWallet[t.wallet] = await fetchPositions(t.wallet);
    await new Promise(r => setTimeout(r, 150)); // gentle on the public API
  }

  const { map, sides } = buildConsensus(topTraders, positionsByWallet, state, now);

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
  // Durable calibration log — only appended alongside commitOps, so a failed
  // push doesn't record history for something Luke never actually saw either.
  const historyRecords = [];

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
      const { holding, lost, maxPrice, totalSize, unknown } = checkHolders(key, meta.wallets, positionsByWallet);
      if (holding >= 2) {
        delete state.pendingExit[key];
        // Track last price seen while they still hold — by the time a SELL
        // fires the positions are gone, so this is the only record of what
        // price they exited around. Lets calibration split profit-taking
        // sells from panic sells instead of lumping both as "unknown".
        if (maxPrice > 0) meta.lastPrice = Math.round(maxPrice * 1000) / 10; // cents
        if (maxPrice >= 0.95 && !meta.wonNotified) {
          // one-time heads-up; keep tracking in case it reverses
          exitEvents.push({ key, meta, kind: 'won' });
          commitOps.push(() => { meta.wonNotified = true; });
          historyRecords.push({ ts: now, type: 'resolution', key, title: meta.title, kind: 'won' });
        } else if (meta.size0 > 0 && totalSize > 0 && totalSize < meta.size0 * 0.6 && !meta.trimNotified) {
          // Still in it, but they've cut 40%+ of the shares they held at alert
          // time. Price drawdowns are noise (they often ADD into dips) — a size
          // cut is the real "they're nervous" signal. Fire once.
          const pct = Math.round((1 - totalSize / meta.size0) * 100);
          exitEvents.push({ key, meta, kind: 'trim', pct });
          commitOps.push(() => { meta.trimNotified = true; });
          historyRecords.push({ ts: now, type: 'resolution', key, title: meta.title, kind: 'trim', pct });
        }
        continue;
      }
      // Every wallet fetch succeeded and the positions are confirmed gone —
      // that's proof, not a blip. Fire the exit NOW instead of waiting the
      // 2-run debounce; the slow path only applies when a fetch failed and
      // "gone" could just mean "couldn't see it this run".
      const misses = unknown === 0 ? EXIT_CONFIRM_MISSES : (state.pendingExit[key] || 0) + 1;
      if (misses >= EXIT_CONFIRM_MISSES) {
        // When a market resolves in our favor, holders redeem and their
        // positions vanish from the API — indistinguishable here from a live
        // exit. lastPrice disambiguates: if the last price seen while they
        // still held was >=95c, this is a WIN being redeemed, not a sell.
        // Without this, every fast redeem logged (and pushed) as "SELL NOW",
        // which made a 23W-16L stretch read as 0W-16L in calibration.
        const kind = lost > 0 ? 'lost' : ((meta.lastPrice ?? 0) >= 95 ? 'won' : 'sell');
        // A win already announced at the >=95c heads-up doesn't push twice —
        // but the history record still writes, since this one carries exitPrice.
        if (!(kind === 'won' && meta.wonNotified)) exitEvents.push({ key, meta, kind });
        commitOps.push(() => dropAlert(key));
        historyRecords.push({ ts: now, type: 'resolution', key, title: meta.title, kind, exitPrice: meta.lastPrice ?? null });
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
        // Same won-vs-sell disambiguation as the wallet-tracked path above:
        // last price >=95c at disappearance means redeem, not a live exit.
        const lm = state.alertedMeta[key];
        const kind = (lm?.lastPrice ?? 0) >= 95 ? 'won' : 'sell';
        if (!(kind === 'won' && lm?.wonNotified)) exitEvents.push({ key, meta: lm, kind });
        commitOps.push(() => dropAlert(key));
        historyRecords.push({ ts: now, type: 'resolution', key, title: lm?.title, kind, exitPrice: lm?.lastPrice ?? null });
      } else {
        state.pendingExit[key] = misses;
      }
    } else {
      // Still forming, not yet alerted, and briefly invisible this run — could be
      // one wallet's API hiccup or a live-game price tick outside the band, not
      // real dissolution. Previously this wiped consensusFirstSeen on ANY single
      // miss, meaning the "5-minute persistence" gate actually required 5
      // consecutive flawless minutes with zero flicker — a much harder bar than
      // intended, and one that could make a genuinely long-running but choppy
      // consensus never qualify. Now it gets the same grace period as exits.
      const misses = (state.pendingExit[key] || 0) + 1;
      if (misses >= FORM_MISS_TOLERANCE) {
        delete state.consensusFirstSeen[key];
        delete state.pendingExit[key];
      } else {
        state.pendingExit[key] = misses;
      }
    }
  }

  // One market can have opposing outcomes (Over/Under, Yes/No) reach consensus
  // independently, from different traders — that produced literal "BUY OVER"
  // then 5 minutes later "BUY UNDER" on the identical line. Group by conditionId
  // so at most one outcome per market ever alerts: whichever already has an open
  // alert keeps exclusive claim on that market; among brand-new candidates on
  // the same market in the same run, only the stronger side (more traders, then
  // longer-held) fires — the other stays silently tracked, never pushed.
  const total = topTraders.length || 10;
  const claimedOutcome = {};
  for (const key of Object.keys(state.alertedAt)) {
    const idx = key.indexOf('|');
    claimedOutcome[key.slice(0, idx)] = key.slice(idx + 1);
  }
  const byCondition = {};
  for (const item of Object.values(map)) {
    (byCondition[item.conditionId] ||= []).push(item);
  }
  for (const cid of Object.keys(byCondition)) {
    let candidates = byCondition[cid].filter(item => {
      const count = item.traders.length;
      if (count < THRESHOLD || (item.ageMs || 0) < PERSIST_WINDOW_MS) return false;
      return count > (state.alertedAt[item.key] || 0);
    });
    if (!candidates.length) continue;
    const claimed = claimedOutcome[cid];
    if (claimed) candidates = candidates.filter(item => item.outcome === claimed);
    if (!candidates.length) continue;
    candidates.sort((a, b) => (b.traders.length - a.traders.length) || ((b.ageMs || 0) - (a.ageMs || 0)));
    const item = candidates[0];
    const count = item.traders.length;
    const lastAlerted = state.alertedAt[item.key] || 0;
    const s = summarizeEntry(item, count, total, lastAlerted === 0 ? 'new' : 'increased');
    s.opposition = oppositionFor(item, sides);
    // Hard skip, not just a warning: >15c above the traders' own entry means
    // their edge is already priced in — a late copy is the losing version of the
    // same bet. Not marked alerted, so if price comes back it can alert later.
    if (s.avgPrice != null && s.avgEntry != null && (s.avgPrice - s.avgEntry) > 15) {
      console.log(`SKIP (stale price): ${item.outcome.toUpperCase()} on "${item.title}" @ ${s.avgPrice.toFixed(1)}c vs entry ~${s.avgEntry.toFixed(1)}c`);
      continue;
    }
    // Player scoring props ("Haaland: 1+ goals") are 1W-4L through 2026-07-12
    // and the record HOLDS under exit-price-corrected accounting (all four
    // losses settled at 0 — no mislabeled redeems here, unlike the crowd-size
    // bucket). Traders hold these as small lottery tickets alongside their
    // real position, so "consensus" here isn't conviction. Skipped, not marked
    // alerted, so this can be lifted later if calibrate.js ever disagrees.
    if (/:\s*\d+\+\s*(goal|assist|shot|point|save)/i.test(item.title)) {
      console.log(`SKIP (player prop, 1W-4L bucket): ${item.outcome.toUpperCase()} on "${item.title}"`);
      continue;
    }
    entryEvents.push(s);
    commitOps.push(() => {
      state.alertedAt[item.key] = count;
      state.alertedMeta[item.key] = { title: item.title, slug: item.slug, wallets: [...item.wallets], size0: item.size || 0 };
    });
    historyRecords.push({
      ts: now, type: 'alert', key: item.key, title: item.title, outcome: item.outcome, slug: item.slug,
      count, total, avgPrice: s.avgPrice, avgEntry: s.avgEntry, usd: item.usd || 0, riskTag: s.risk.tag,
      sportsOnlyCount: item.sportsOnlyCount || 0,
      oppCount: s.opposition?.n || 0, oppUsd: Math.round(s.opposition?.usd || 0),
    });
  }

  // Multiple DIFFERENT markets (moneyline, spread, O/U, props) tied to the same
  // single game often reach consensus together — not 7 opportunities, but the
  // same read on the same event told 7 ways. Cluster same-event signals firing
  // in this run so they render as one grouped call (primary + confirming echoes)
  // instead of N separate equal-weight pushes. A lone new signal whose game
  // already has other active alerts from earlier runs gets those noted as
  // context instead, so it's never a surprise how correlated it is.
  const clusters = {};
  for (const s of entryEvents) {
    const ek = eventKey(s.item.slug);
    if (!ek) continue; // dateless category slug (tournament outright) — never cluster
    (clusters[ek] ||= []).push(s);
  }
  for (const ek of Object.keys(clusters)) {
    const group = clusters[ek];
    if (group.length >= 2) {
      group.sort((a, b) => (b.count - a.count) || ((b.item.usd || 0) - (a.item.usd || 0)));
      group.forEach((s, i) => { s.groupKey = ek; s.groupRole = i === 0 ? 'primary' : 'echo'; });
    } else {
      const s = group[0];
      const corroborating = Object.entries(state.alertedMeta)
        .filter(([k, m]) => k !== s.item.key && eventKey(m.slug) === ek)
        .map(([k, m]) => ({ title: m.title, outcome: k.slice(k.indexOf('|') + 1).toUpperCase() }));
      if (corroborating.length) s.corroborating = corroborating;
    }
  }

  // Exit alerts are only actionable for bets Luke actually placed. His wallet's
  // positions are public — suppress SELL/LOST/WON/TRIM for markets he isn't in.
  // BUYs always send (can't know what he'll want to enter). State cleanup for
  // suppressed exits still commits, so they don't re-fire forever.
  let sendableExits = exitEvents;
  if (FILTER_EXITS_TO_MY_WALLET && MY_WALLET && exitEvents.length) {
    const mine = await fetchPositions(MY_WALLET);
    if (mine != null) { // failed fetch → can't know what he holds → send everything
      const myCids = new Set(mine.map(p => p.conditionId));
      sendableExits = exitEvents.filter(e => myCids.has(e.key.slice(0, e.key.indexOf('|'))));
      const skipped = exitEvents.length - sendableExits.length;
      if (skipped) console.log(`${skipped} exit event(s) suppressed — not held in MY_WALLET.`);
    }
  }

  const sent = await sendDigest(entryEvents, sendableExits);
  if (sent) {
    for (const op of commitOps) op();
    appendHistory(historyRecords);
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
