# Polymarket Dashboard — Project Context

This is a standalone project for building and iterating on a Polymarket leaderboard/dashboard.
Nothing here should bleed into other projects (TikTok Shop, Car Matchmaker, etc.).

## What we built

A live interactive leaderboard widget pulling from the Polymarket public Data API.
No API key required — fully public endpoints.

### API reference

Base URL: `https://data-api.polymarket.com`

**Leaderboard endpoint:**
```
GET https://data-api.polymarket.com/v1/leaderboard
```

Query params:
| Param | Options | Default |
|---|---|---|
| `category` | OVERALL, POLITICS, SPORTS, CRYPTO, CULTURE, ECONOMICS, TECH, FINANCE | OVERALL |
| `timePeriod` | DAY, WEEK, MONTH, ALL | DAY |
| `orderBy` | PNL, VOL | PNL |
| `limit` | 1–50 | 25 |
| `offset` | 0–1000 | 0 |
| `user` | 0x wallet address | — |
| `userName` | string | — |

Response fields per trader: `rank`, `proxyWallet`, `userName`, `xUsername`, `verifiedBadge`, `vol`, `pnl`, `profileImage`

**Other useful Data API endpoints (no auth):**
- `GET /activity?user=0x...` — trade history for a wallet
- `GET /positions?user=0x...` — open positions
- `GET /value?user=0x...` — total portfolio value

**Gamma API (market discovery):**
- `GET https://gamma-api.polymarket.com/markets` — browse all markets

## Widget location

The leaderboard widget was built as an inline chat widget (HTML/JS).
Source is in `leaderboard-widget.html` in this directory.

## Next steps / ideas

- Add market browser (pull from Gamma API)
- User wallet lookup — paste a 0x address to see their positions + PnL
- Embed into a standalone web page
- Category breakdown chart (which categories generate most profit)

## Stack preferences

- Vanilla HTML/JS for quick prototypes (no build step)
- Deploy with `npx vercel --prod --yes` if it becomes a full site
- No emojis in UI
- Light theme if styled: white cards, cyan-600 accent, gray-900 headings
