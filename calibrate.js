// Run on demand: node calibrate.js
// Reads history.jsonl (built up by monitor.js every run since the history-log
// feature shipped) and reports real hit rate broken down by signal quality.
// If MY_WALLET is set, also cross-references Luke's real trades against the
// alert history to show his personal results, not just the system's.

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const MY_WALLET = process.env.MY_WALLET || '';

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs.readFileSync(HISTORY_FILE, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function bucket(alerts, keyFn) {
  const groups = {};
  for (const a of alerts) {
    const k = keyFn(a);
    (groups[k] ||= { total: 0, won: 0, lost: 0, pending: 0, other: 0 }).total++;
    if (a.resolution?.kind === 'won') groups[k].won++;
    else if (a.resolution?.kind === 'lost') groups[k].lost++;
    else if (!a.resolution) groups[k].pending++;
    else groups[k].other++; // sell/trim — ambiguous without exit price, not counted as win/loss
  }
  return groups;
}

function printBuckets(title, groups) {
  console.log(`\n${title}`);
  for (const [k, g] of Object.entries(groups)) {
    const resolved = g.won + g.lost;
    const rate = resolved ? `${Math.round((g.won / resolved) * 100)}%` : 'n/a';
    console.log(`  ${k}: ${g.total} alerts | ${g.won}W-${g.lost}L (${rate}) | ${g.pending} pending | ${g.other} sell/trim`);
  }
}

async function fetchMyTrades(wallet) {
  const trades = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${offset}`, { headers: { 'User-Agent': 'polymarket-consensus-monitor' } });
    if (!res.ok) break;
    const batch = await res.json();
    trades.push(...batch.filter(t => t.type === 'TRADE' && t.side === 'BUY'));
    if (batch.length < 500) break;
    offset += 500;
  }
  return trades;
}

async function main() {
  const raw = loadHistory();
  const alerts = raw.filter(r => r.type === 'alert');
  const resolutions = raw.filter(r => r.type === 'resolution');
  // last resolution per key wins (won can be followed by a later sell, etc.)
  const resByKey = {};
  for (const r of resolutions) resByKey[r.key] = r;
  for (const a of alerts) a.resolution = resByKey[a.key];

  console.log(`Loaded ${alerts.length} alert record(s), ${resolutions.length} resolution record(s) from history.jsonl.`);
  if (!alerts.length) {
    console.log('No history yet — this just started logging. Check back after some alerts have resolved.');
    return;
  }

  printBuckets('By risk tag:', bucket(alerts, a => a.riskTag || '?'));
  printBuckets('By trader count:', bucket(alerts, a => a.count >= 4 ? '4+' : String(a.count)));
  printBuckets('By dollar conviction:', bucket(alerts, a => a.usd >= 50000 ? '$50K+' : a.usd >= 5000 ? '$5K-50K' : '<$5K'));

  if (!MY_WALLET) {
    console.log('\nMY_WALLET not set — set it as an env var to also see your personal matched results.');
    return;
  }

  console.log(`\nFetching real trades for ${MY_WALLET}...`);
  const myTrades = await fetchMyTrades(MY_WALLET);
  const myKeys = new Set(myTrades.map(t => `${t.conditionId}|${t.outcome}`));
  const mine = alerts.filter(a => myKeys.has(a.key));
  console.log(`Matched ${mine.length} of your real trades against ${alerts.length} logged alerts.`);
  printBuckets('YOUR results, by risk tag:', bucket(mine, a => a.riskTag || '?'));
  printBuckets('YOUR results, by trader count:', bucket(mine, a => a.count >= 4 ? '4+' : String(a.count)));
}

main().catch(e => { console.error('Calibration run failed:', e); process.exit(1); });
