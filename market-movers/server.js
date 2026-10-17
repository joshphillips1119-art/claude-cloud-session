// Market Movers — top crypto & Nasdaq gainers
// Zero-dependency Node server: serves the frontend and proxies/caches the data APIs.

import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

const execFileP = promisify(execFile);

// ---- Secrets -------------------------------------------------------------
// Credentials live in .env (gitignored, chmod 600) and are read into memory
// once. They are NEVER written into source, never logged, and never returned
// by any endpoint — the Bybit routes expose account DATA, not the key.
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
const parseEnv = () => {
  try {
    return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        // Strip quotes and any stray whitespace — pasting from a GUI editor
        // easily leaves both, and a trailing space breaks HMAC signing with a
        // "signature invalid" error that looks nothing like its cause.
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["'\u201c\u201d]|["'\u201c\u201d]$/g, '').trim()];
      }));
  } catch { return {}; }
};
// Re-read when the file changes on disk, so editing .env takes effect without a
// restart. Cheap: one stat() per access, and only re-parses when mtime moves.
let _envCache = parseEnv();
let _envMtime = (() => { try { return fs.statSync(ENV_FILE).mtimeMs; } catch { return 0; } })();
const SECRETS = new Proxy({}, {
  get(_, k) {
    try {
      const m = fs.statSync(ENV_FILE).mtimeMs;
      if (m !== _envMtime) { _envMtime = m; _envCache = parseEnv(); console.log('[env] .env changed — credentials reloaded'); }
    } catch { /* file may be mid-save */ }
    return _envCache[k];
  },
});

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const CACHE_TTL_MS = 60 * 1000; // both upstream APIs rate-limit; 60s is plenty fresh

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = {}; // key -> { ts, data }
const inflight = {}; // key -> Promise, so concurrent requests share one fetch

// On upstream failure, serve the last good data (stale) rather than erroring.
async function cached(key, fetcher, ttl = CACHE_TTL_MS) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  if (inflight[key]) return inflight[key];
  inflight[key] = (async () => {
    try {
      const data = await fetcher();
      cache[key] = { ts: Date.now(), data };
      return data;
    } catch (err) {
      if (hit) {
        console.error(`[api] ${key} refresh failed (serving stale):`, err.message);
        return hit.data;
      }
      throw err;
    } finally {
      delete inflight[key];
    }
  })();
  return inflight[key];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = 15 * 1000; // a hung upstream must never wedge a cache key

// Yahoo rate-limits Node's fetch fingerprint separately from curl's, so on a
// 429 we retry once and then fall back to a curl subprocess, which Yahoo
// keeps serving even while the Node bucket is throttled.
async function curlJson(url) {
  const { stdout } = await execFileP(
    'curl', ['-s', '-m', '25', '-A', UA, '-H', 'Accept: application/json', url],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${url} -> curl fallback got non-JSON (${stdout.slice(0, 60)})`);
  }
}

// Circuit breaker: once Yahoo 429s through both fetch AND curl, stop hitting it
// for a cooldown window instead of burning 3 requests + 2s sleep per attempt.
// Callers all have non-Yahoo fallbacks, so failing fast here is strictly better.
let yahooCooldownUntil = 0;
const isYahoo = (url) => url.includes('finance.yahoo.com');

// Shared GeckoTerminal pacer. The free tier allows ~30 requests/minute, and
// that budget is SHARED by every section that uses it (Meme Sniper and Smart
// Wallets). Without one queue the two starve each other into 429s — measured
// 30 Sep: scanning network pages alone tripped the limit. Serialise all calls
// and space them >= 2.2s apart (~27/min) so the budget is never exceeded.
const isGecko = (u) => typeof u === 'string' && u.includes('api.geckoterminal.com');
let gtQueue = Promise.resolve();
let gtLast = 0;
function gtSlot() {
  const turn = gtQueue.then(async () => {
    const wait = gtLast + 2200 - Date.now();
    if (wait > 0) await sleep(wait);
    gtLast = Date.now();
  });
  gtQueue = turn.catch(() => {});
  return turn;
}

async function fetchJson(url, attempt = 0, timeoutMs = FETCH_TIMEOUT_MS) {
  if (isGecko(url)) await gtSlot();
  if (isYahoo(url) && Date.now() < yahooCooldownUntil) {
    throw new Error(`Yahoo cooling down after 429s (${Math.ceil((yahooCooldownUntil - Date.now()) / 1000)}s left)`);
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429 && isGecko(url)) {
    // A GeckoTerminal 429 means the per-minute budget is spent; the curl
    // fallback below would hit the same limit. Wait for the window to roll.
    if (attempt < 2) { await sleep(15000 * (attempt + 1)); return fetchJson(url, attempt + 1, timeoutMs); }
    throw new Error('GeckoTerminal rate limit — try again in a minute');
  }
  if (res.status === 429) {
    if (attempt < 1) {
      await sleep(2000);
      return fetchJson(url, attempt + 1, timeoutMs);
    }
    try {
      const data = await curlJson(url);
      if (isYahoo(url)) yahooCooldownUntil = 0; // curl path still healthy
      return data;
    } catch (err) {
      if (isYahoo(url)) yahooCooldownUntil = Date.now() + 5 * 60 * 1000;
      throw err;
    }
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  if (isYahoo(url)) yahooCooldownUntil = 0;
  return res.json();
}

async function getCrypto() {
  return cached('crypto', async () => {
    // Top 250 by market cap, then rank by 24h % change so the "gainers" are
    // liquid coins rather than zero-volume microcaps.
    const coins = await fetchJson(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h'
    );
    return coins
      .filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h)
      .slice(0, 25)
      .map((c) => ({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        image: c.image,
        price: c.current_price,
        changePct: c.price_change_percentage_24h,
        marketCap: c.market_cap,
        volume: c.total_volume,
      }));
  });
}

// Primary: Yahoo screener (25 rows, includes market cap). Yahoo rate-limits
// aggressively, so fall back to Nasdaq.com's official MostAdvanced list.
async function yahooGainers() {
  const data = await fetchJson(
    'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=100'
  );
  const quotes = data?.finance?.result?.[0]?.quotes || [];
  const items = quotes
    .filter((q) => (q.fullExchangeName || '').startsWith('Nasdaq'))
    .filter((q) => q.regularMarketChangePercent != null)
    .sort((a, b) => b.regularMarketChangePercent - a.regularMarketChangePercent)
    .slice(0, 25)
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      changePct: q.regularMarketChangePercent,
      marketCap: q.marketCap,
      volume: q.regularMarketVolume,
    }));
  if (!items.length) throw new Error('Yahoo returned no Nasdaq quotes');
  return items;
}

async function nasdaqOfficialGainers() {
  const data = await fetchJson('https://api.nasdaq.com/api/marketmovers?assetclass=stocks');
  const rows = data?.data?.STOCKS?.MostAdvanced?.table?.rows || [];
  const items = rows.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    price: parseFloat(String(r.lastSalePrice).replace(/[$,]/g, '')),
    changePct: parseFloat(String(r.change).replace(/[+%,]/g, '')),
    marketCap: null,
    volume: null,
  }));
  if (!items.length) throw new Error('Nasdaq.com returned no rows');
  return items;
}

async function getNasdaq() {
  return cached('nasdaq', async () => {
    try {
      return await yahooGainers();
    } catch (err) {
      console.error('[api] Yahoo failed, falling back to Nasdaq.com:', err.message);
      return nasdaqOfficialGainers();
    }
  });
}

// ---------------------------------------------------------------------------
// Wallet leaderboard — Hyperliquid public data.
// The full leaderboard is ~32MB / ~38k wallets, so it gets its own long TTL.
// "Win rate" = profitable closes / all closes across each wallet's most
// recent fills (up to 2000); wallets need >= MIN_TRADES closes to qualify.
// ---------------------------------------------------------------------------
const MIN_TRADES = 30;
const WALLET_CANDIDATES = 25; // top wallets by 30d PnL to analyze
const WALLET_RESULTS = 15;

async function hlLeaderboardCandidates() {
  return cached(
    'hl-leaderboard',
    async () => {
      // ~32MB download — needs a much bigger timeout budget than API calls
      const data = await fetchJson('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', 0, 90 * 1000);
      const rows = data?.leaderboardRows || [];
      const candidates = rows
        .map((r) => {
          const windows = Object.fromEntries(r.windowPerformances || []);
          return {
            address: r.ethAddress,
            displayName: r.displayName || null,
            accountValue: parseFloat(r.accountValue),
            monthPnl: parseFloat(windows.month?.pnl ?? 'NaN'),
            monthRoi: parseFloat(windows.month?.roi ?? 'NaN'),
            monthVlm: parseFloat(windows.month?.vlm ?? 'NaN'),
          };
        })
        .filter((w) => w.accountValue >= 50_000 && w.monthPnl > 0 && w.monthVlm > 0)
        .sort((a, b) => b.monthPnl - a.monthPnl)
        .slice(0, WALLET_CANDIDATES);
      console.log(`[wallets] leaderboard: ${rows.length} wallets, kept top ${candidates.length} by 30d PnL`);
      return candidates;
    },
    60 * 60 * 1000 // 32MB download; rankings shift slowly — refetch hourly
  );
}

async function hlWinRate(address, attempt = 0) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ type: 'userFills', user: address, aggregateByTime: true }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 429 && attempt < 2) {
    await sleep(3000 * (attempt + 1));
    return hlWinRate(address, attempt + 1);
  }
  if (!res.ok) throw new Error(`userFills ${address} -> HTTP ${res.status}`);
  const fills = await res.json();
  const closes = fills.filter((f) => parseFloat(f.closedPnl) !== 0);
  const wins = closes.filter((f) => parseFloat(f.closedPnl) > 0);
  const closedPnl = closes.reduce((s, f) => s + parseFloat(f.closedPnl), 0);
  const oldest = fills.length ? Math.min(...fills.map((f) => f.time)) : null;
  return { trades: closes.length, wins: wins.length, closedPnl, since: oldest };
}

async function getWallets() {
  return cached(
    'wallets',
    async () => {
      const candidates = await hlLeaderboardCandidates();
      const results = [];
      const BATCH = 3; // be polite to the info API — it 429s on bursts
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        const stats = await Promise.allSettled(batch.map((w) => hlWinRate(w.address)));
        stats.forEach((s, j) => {
          if (s.status === 'fulfilled') results.push({ ...batch[j], ...s.value });
          else console.error('[wallets]', s.reason.message);
        });
        if (i + BATCH < candidates.length) await sleep(1200);
      }
      console.log(`[wallets] analyzed ${results.length}/${candidates.length} wallets`);
      return results
        .filter((w) => w.trades >= MIN_TRADES)
        .map((w) => ({ ...w, winRate: w.wins / w.trades }))
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, WALLET_RESULTS);
    },
    10 * 60 * 1000
  );
}

// ---------------------------------------------------------------------------
// Candles for the backtester — Binance for crypto, Yahoo chart for stocks.
// ---------------------------------------------------------------------------
const SYMBOL_RE = /^[A-Za-z0-9.\-^]{1,12}$/;

async function getCandles(market, symbol, interval) {
  const key = `candles:${market}:${symbol}:${interval}`;
  return cached(key, async () => {
    if (market === 'crypto') {
      const pair = `${symbol.toUpperCase()}USDT`;
      const binInterval = interval === '1d' ? '1d' : '1h';
      const raw = await fetchJson(
        `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${binInterval}&limit=1000`
      );
      return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    }
    // stocks via Yahoo chart API; daily falls back to Nasdaq.com when Yahoo
    // rate-limits (Nasdaq.com has no intraday history, so 1h is Yahoo-only)
    try {
      return await yahooChart(symbol, interval);
    } catch (err) {
      if (interval !== '1d') throw new Error(`${err.message} — hourly stock data is Yahoo-only; try the 1-day timeframe`);
      console.error('[candles] Yahoo failed, falling back to Nasdaq.com:', err.message);
      return nasdaqHistory(symbol);
    }
  });
}

async function yahooChart(symbol, interval) {
  const range = interval === '1d' ? '2y' : '3mo';
  const yInterval = interval === '1d' ? '1d' : '1h';
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${yInterval}`
  );
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || `no chart data for ${symbol}`);
  const q = result.indicators.quote[0];
  return result.timestamp
    .map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter((c) => c.c != null && c.o != null);
}

async function nasdaqHistory(symbol) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
  const data = await fetchJson(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${from}&todate=${today}&limit=9999`
  );
  const rows = data?.data?.tradesTable?.rows || [];
  if (!rows.length) throw new Error(`no Nasdaq.com history for ${symbol}`);
  const num = (s) => parseFloat(String(s).replace(/[$,]/g, ''));
  return rows
    .map((r) => ({
      t: new Date(r.date).getTime(),
      o: num(r.open), h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume),
    }))
    .filter((c) => !isNaN(c.c) && !isNaN(c.o))
    .sort((a, b) => a.t - b.t); // Nasdaq returns newest-first
}

// ---------------------------------------------------------------------------
// 5-minute scalp scanner — analyzes live 5m candles and emits concrete setups
// (entry trigger, stop, two targets) from three classic scalping strategies:
// EMA 9/21 pullback, VWAP snap-back, and coil (range) breakout.
// ---------------------------------------------------------------------------
const SCALP_UNIVERSE = [
  ...['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'LINK'].map((s) => ({
    display: s, fetch: s, kind: 'crypto', group: 'crypto', name: s,
  })),
  ...['NVDA', 'TSLA', 'AAPL', 'AMD', 'MSFT', 'QQQ'].map((s) => ({
    display: s, fetch: s, cnbc: s, kind: 'yahoo', group: 'stock', name: s,
  })),
  { display: 'GOLD', fetch: 'GC=F', cnbc: '@GC.1', kind: 'yahoo', group: 'metal', name: 'Gold futures' },
  { display: 'SILVER', fetch: 'SI=F', cnbc: '@SI.1', kind: 'yahoo', group: 'metal', name: 'Silver futures' },
  { display: 'COPPER', fetch: 'HG=F', cnbc: '@HG.1', kind: 'yahoo', group: 'metal', name: 'Copper futures' },
  { display: 'PLAT', fetch: 'PL=F', cnbc: '@PL.1', kind: 'yahoo', group: 'metal', name: 'Platinum futures' },
  { display: 'OIL', fetch: 'CL=F', cnbc: '@CL.1', kind: 'yahoo', group: 'commodity', name: 'WTI Crude futures' },
  { display: 'NATGAS', fetch: 'NG=F', cnbc: '@NG.1', kind: 'yahoo', group: 'commodity', name: 'Natural Gas futures' },
  { display: 'WHEAT', fetch: 'ZW=F', cnbc: '@W.1', kind: 'yahoo', group: 'commodity', name: 'Wheat futures' },
];
const STALE_AFTER_MS = 30 * 60 * 1000; // non-crypto: bar older than this = market closed
const TF_MIN = { '1m': 1, '5m': 5, '15m': 15 };
const TF_MS_MAP = { '1m': 60000, '5m': 300000, '15m': 900000 };

function emaArr(v, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = v[0];
  v.forEach((x, i) => { e = i ? x * k + e * (1 - k) : x; out.push(e); });
  return out;
}
function rsiArr(v, n) {
  const out = new Array(v.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (i <= n) {
      g += Math.max(d, 0); l += Math.max(-d, 0);
      if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    } else {
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = 100 - 100 / (1 + g / (l || 1e-9));
    }
  }
  return out;
}
function atrArr(c, n) {
  const out = [];
  let a = c[0].h - c[0].l;
  for (let i = 0; i < c.length; i++) {
    const tr = i
      ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c))
      : c[i].h - c[i].l;
    a = i ? (a * (n - 1) + tr) / n : tr;
    out.push(a);
  }
  return out;
}
function sessionVwap(c) {
  // anchored at the start of the last UTC day in the series (= today's session)
  const lastDay = new Date(c.at(-1).t).toISOString().slice(0, 10);
  let start = c.length - 1;
  while (start > 0 && new Date(c[start - 1].t).toISOString().slice(0, 10) === lastDay) start--;
  let pv = 0, vol = 0;
  for (let i = start; i < c.length; i++) {
    const typ = (c[i].h + c[i].l + c[i].c) / 3;
    pv += typ * (c[i].v || 0);
    vol += c[i].v || 0;
  }
  return vol ? pv / vol : c.at(-1).c;
}

// ---- Extra technical indicators for the scalp chart --------------------------
function smaArr(v, n) {
  const out = new Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function stdevAt(v, i, n) {
  if (i < n - 1) return null;
  let m = 0; for (let j = i - n + 1; j <= i; j++) m += v[j]; m /= n;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - m) ** 2;
  return Math.sqrt(s / n);
}
function macdLast(v, f = 12, s = 26, sig = 9) {
  const ef = emaArr(v, f), es = emaArr(v, s);
  const line = v.map((_, i) => ef[i] - es[i]);
  const signal = emaArr(line, sig);
  const i = v.length - 1;
  return { line: line[i], signal: signal[i], hist: line[i] - signal[i] };
}
function stochLast(c, k = 14, d = 3) {
  const ks = [];
  for (let i = 0; i < c.length; i++) {
    if (i < k - 1) { ks.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - k + 1; j <= i; j++) { hi = Math.max(hi, c[j].h); lo = Math.min(lo, c[j].l); }
    ks.push(hi === lo ? 50 : ((c[i].c - lo) / (hi - lo)) * 100);
  }
  const i = c.length - 1;
  let ds = 0, cnt = 0;
  for (let j = Math.max(0, i - d + 1); j <= i; j++) if (ks[j] != null) { ds += ks[j]; cnt++; }
  return { k: ks[i], d: cnt ? ds / cnt : null };
}
function adxLast(c, n = 14) {
  if (c.length < 2 * n + 1) return { adx: null, plusDI: null, minusDI: null };
  let tr = 0, pDM = 0, mDM = 0;
  for (let i = 1; i <= n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    tr += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    pDM += (up > dn && up > 0) ? up : 0;
    mDM += (dn > up && dn > 0) ? dn : 0;
  }
  const dxs = [];
  for (let i = n + 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    const trI = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    tr = tr - tr / n + trI;
    pDM = pDM - pDM / n + ((up > dn && up > 0) ? up : 0);
    mDM = mDM - mDM / n + ((dn > up && dn > 0) ? dn : 0);
    const pDI = 100 * pDM / (tr || 1e-9), mDI = 100 * mDM / (tr || 1e-9);
    dxs.push({ dx: 100 * Math.abs(pDI - mDI) / ((pDI + mDI) || 1e-9), pDI, mDI });
  }
  if (!dxs.length) return { adx: null, plusDI: null, minusDI: null };
  let adx = dxs.slice(0, n).reduce((s, x) => s + x.dx, 0) / Math.min(n, dxs.length);
  for (let i = n; i < dxs.length; i++) adx = (adx * (n - 1) + dxs[i].dx) / n;
  const last = dxs.at(-1);
  return { adx, plusDI: last.pDI, minusDI: last.mDI };
}
function sessionVwapBands(c) {
  const lastDay = new Date(c.at(-1).t).toISOString().slice(0, 10);
  let start = c.length - 1;
  while (start > 0 && new Date(c[start - 1].t).toISOString().slice(0, 10) === lastDay) start--;
  let pv = 0, vol = 0;
  for (let i = start; i < c.length; i++) { const typ = (c[i].h + c[i].l + c[i].c) / 3; pv += typ * (c[i].v || 0); vol += c[i].v || 0; }
  const vwap = vol ? pv / vol : c.at(-1).c;
  let vw = 0;
  for (let i = start; i < c.length; i++) { const typ = (c[i].h + c[i].l + c[i].c) / 3; vw += (c[i].v || 0) * (typ - vwap) ** 2; }
  const sd = vol ? Math.sqrt(vw / vol) : 0;
  return { vwap, upper1: vwap + sd, lower1: vwap - sd, upper2: vwap + 2 * sd, lower2: vwap - 2 * sd };
}
function swingLevels(c, look = 3) {
  const highs = [], lows = [];
  for (let i = look; i < c.length - look; i++) {
    let isH = true, isL = true;
    for (let j = i - look; j <= i + look; j++) { if (c[j].h > c[i].h) isH = false; if (c[j].l < c[i].l) isL = false; }
    if (isH) highs.push(c[i].h);
    if (isL) lows.push(c[i].l);
  }
  const px = c.at(-1).c;
  const resistance = highs.filter((h) => h > px).sort((a, b) => a - b)[0] ?? Math.max(...c.map((x) => x.h));
  const support = lows.filter((l) => l < px).sort((a, b) => b - a)[0] ?? Math.min(...c.map((x) => x.l));
  return { support, resistance };
}
function htfBias(c, factor = 3) {
  const agg = [];
  for (let i = 0; i < c.length; i += factor) {
    const slice = c.slice(i, i + factor);
    if (!slice.length) break;
    agg.push({ c: slice.at(-1).c });
  }
  if (agg.length < 25) return { trend: 'flat', factor };
  const cl = agg.map((x) => x.c);
  const e9 = emaArr(cl, 9), e21 = emaArr(cl, 21);
  const i = agg.length - 1;
  return { trend: e9[i] > e21[i] ? 'up' : e9[i] < e21[i] ? 'down' : 'flat', factor };
}

// Bundle every extra indicator into one object for the chart panel.
function computeIndicators(c, interval) {
  const v = c.map((x) => x.c);
  const i = v.length - 1;
  const r2 = (n) => (n == null ? null : parseFloat(n.toPrecision(5)));
  const macd = macdLast(v);
  const bbMid = smaArr(v, 20)[i], sd20 = stdevAt(v, i, 20);
  const bbUpper = bbMid != null && sd20 != null ? bbMid + 2 * sd20 : null;
  const bbLower = bbMid != null && sd20 != null ? bbMid - 2 * sd20 : null;
  const pctB = bbUpper != null && bbUpper !== bbLower ? ((v[i] - bbLower) / (bbUpper - bbLower)) * 100 : null;
  const bandwidth = bbMid ? ((bbUpper - bbLower) / bbMid) * 100 : null;
  const stoch = stochLast(c), adx = adxLast(c);
  const roc = i >= 10 ? (v[i] / v[i - 10] - 1) * 100 : null;
  const vb = sessionVwapBands(c), sr = swingLevels(c), htf = htfBias(c, 3);
  return {
    macd: { line: r2(macd.line), signal: r2(macd.signal), hist: r2(macd.hist), state: macd.hist >= 0 ? 'bull' : 'bear' },
    bb: {
      upper: r2(bbUpper), mid: r2(bbMid), lower: r2(bbLower),
      pctB: pctB == null ? null : +pctB.toFixed(0), bandwidth: bandwidth == null ? null : +bandwidth.toFixed(2),
      state: pctB == null ? 'mid' : pctB > 100 ? 'breakout↑' : pctB < 0 ? 'breakout↓' : pctB > 80 ? 'upper' : pctB < 20 ? 'lower' : 'mid',
    },
    stoch: {
      k: stoch.k == null ? null : +stoch.k.toFixed(0), d: stoch.d == null ? null : +stoch.d.toFixed(0),
      state: stoch.k == null ? '—' : stoch.k > 80 ? 'overbought' : stoch.k < 20 ? 'oversold' : 'neutral',
    },
    adx: {
      adx: adx.adx == null ? null : +adx.adx.toFixed(0), plusDI: adx.plusDI == null ? null : +adx.plusDI.toFixed(0), minusDI: adx.minusDI == null ? null : +adx.minusDI.toFixed(0),
      state: adx.adx == null ? '—' : adx.adx >= 25 ? 'trending' : adx.adx < 20 ? 'choppy' : 'weak',
    },
    roc: roc == null ? null : +roc.toFixed(2),
    vwapBands: { upper1: r2(vb.upper1), lower1: r2(vb.lower1), upper2: r2(vb.upper2), lower2: r2(vb.lower2) },
    sr: { support: r2(sr.support), resistance: r2(sr.resistance) },
    htf,
  };
}

// ---- Real-time event context (economic calendar + crypto funding) -----------
async function getEvents() {
  return cached('events', async () => {
    const data = await fetchJson('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    return (Array.isArray(data) ? data : [])
      .filter((e) => e.impact === 'High' || e.impact === 'Medium')
      .map((e) => ({ title: e.title, country: e.country, impact: e.impact, time: new Date(e.date).getTime(), forecast: e.forecast, previous: e.previous }))
      .filter((e) => !isNaN(e.time))
      .sort((a, b) => a.time - b.time);
  }, 30 * 60 * 1000);
}
function eventContext(events) {
  const now = Date.now();
  const mins = (t) => Math.round((t - now) / 60000);
  const upcoming = events.filter((e) => e.time > now - 20 * 60000);
  const risk = upcoming.find((e) => e.impact === 'High' && Math.abs(e.time - now) <= 30 * 60000);
  return {
    next: upcoming.slice(0, 4).map((e) => ({ ...e, minsUntil: mins(e.time) })),
    risk: !!risk,
    riskEvent: risk ? { ...risk, minsUntil: mins(risk.time) } : null,
  };
}
// Crowd positioning vs top-trader positioning. Funding tells you what leverage
// costs; this tells you who is actually holding the bag. The divergence is the
// real signal — when retail is heavily long and the top cohort is not, retail
// is the exit liquidity. Contrarian by construction.
// Crypto/equity correlation regime. The Options Desk reads crypto-native flow
// (funding, tape, positioning) but had no notion of whether crypto is currently
// trading as its own asset or as a leveraged Nasdaq proxy. When the two move
// together, macro drives the tape and crypto-native signals are the weaker read;
// when they decouple, crypto-native flow is what matters. Computed from data the
// app already pulls — Binance dailies and the CNBC QQQ series — so no new source.
async function getCorrelation(symbol) {
  return cached(`corr:${symbol}`, async () => {
    const [btc, qqq] = await Promise.all([
      fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=60`),
      cnbcDaily('QQQ'),
    ]);
    // Align on calendar date — equities do not trade weekends, crypto does.
    const cMap = new Map(btc.map((k) => [new Date(k[0]).toISOString().slice(0, 10), +k[4]]));
    const qMap = new Map(cnbcDailyDates(qqq));
    const days = [...cMap.keys()].filter((d) => qMap.has(d)).sort();
    if (days.length < 22) throw new Error('not enough overlapping sessions');
    const ret = (m) => days.slice(1).map((d, i) => Math.log(m.get(d) / m.get(days[i])));
    const a = ret(cMap), b = ret(qMap);
    const n = Math.min(a.length, b.length);
    const win = Math.min(n, 30);
    const x = a.slice(-win), y = b.slice(-win);
    const mx = x.reduce((p, q) => p + q, 0) / win, my = y.reduce((p, q) => p + q, 0) / win;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < win; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
    const r = (vx && vy) ? cov / Math.sqrt(vx * vy) : 0;
    const abs = Math.abs(r);
    return {
      r: +r.toFixed(2), sessions: win,
      regime: abs >= 0.5 ? (r > 0 ? 'coupled to equities' : 'inversely coupled') : abs <= 0.2 ? 'decoupled' : 'loosely coupled',
      read: abs >= 0.5
        ? 'Crypto is trading as a leveraged equity proxy — macro and index direction dominate, and crypto-native flow is the weaker signal.'
        : abs <= 0.2
          ? 'Crypto is moving on its own — funding, tape and positioning are the signals that matter here.'
          : 'Partial coupling — treat equity direction as context, not as the driver.',
    };
  }, 60 * 60 * 1000);
}
// CNBC daily bars -> [dateString, close] pairs
function cnbcDailyDates(bars) {
  return bars.map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c]);
}

// Relative strength against the sector benchmark. A scalp long on a stock that
// is lagging QQQ is a different trade from the same setup on the leader, and
// nothing in the desk could see that — every symbol was scored in isolation.
// Deliberately NOT scored this pass: the grader's existing weights measured
// zero predictive power (correlation +0.0007 over 1,202 trades), so adding
// another hand-picked weight would repeat the mistake this pass exists to fix.
// It is recorded on every signal instead, so factorAttribution() can set its
// weight from measured lift once enough signals resolve.
async function getRelStrength(symbol, benchmark = 'QQQ') {
  return cached(`rs:${symbol}`, async () => {
    const [a, b] = await Promise.all([cnbcDaily(symbol), cnbcDaily(benchmark)]);
    if (a.length < 7 || b.length < 7) throw new Error('not enough daily bars');
    const perf = (bars, n) => (bars.at(-1).c / bars.at(-1 - n).c - 1) * 100;
    const r5 = perf(a, 5) - perf(b, 5);
    const r20 = perf(a, 20) - perf(b, 20);
    return {
      benchmark, rs5: +r5.toFixed(2), rs20: +r20.toFixed(2),
      state: r5 >= 2 ? 'leading' : r5 <= -2 ? 'lagging' : 'in line',
      read: r5 >= 2 ? `Outperforming ${benchmark} by ${r5.toFixed(1)} pts over 5 sessions — longs have the sector behind them.`
        : r5 <= -2 ? `Underperforming ${benchmark} by ${Math.abs(r5).toFixed(1)} pts over 5 sessions — longs are fighting the sector.`
          : `Tracking ${benchmark} within 2 pts — no sector edge either way.`,
    };
  }, 30 * 60 * 1000);
}

// ---- Smart Wallets (Axiom-style wallet tracking) -------------------------
// Axiom (axiom.trade) sits behind a Cloudflare bot challenge and publishes no
// API; the only programmatic routes are unofficial SDKs driving a logged-in
// account. Neither is used here. What Axiom shows is public on-chain data,
// so this rebuilds the same view from it: every trade on these chains is
// public, and GeckoTerminal exposes each pool's trades with the trader's wallet.
//
// Measured 30 Sep: 300 raw trades cover only ~10 minutes of a busy pool, far
// too short to judge anyone. Filtering to larger trades (>= $2k on a $12M/day
// pool) stretched it to ~22h and focused on wallets trading real size, so the
// threshold scales with each pool's volume.
const SW_CHAINS = {
  sol: { gt: 'solana', label: 'Solana', explorer: 'https://solscan.io/account/' },
  base: { gt: 'base', label: 'Base', explorer: 'https://basescan.org/address/' },
  bnb: { gt: 'bsc', label: 'BNB Chain', explorer: 'https://bscscan.com/address/' },
  eth: { gt: 'eth', label: 'Ethereum', explorer: 'https://etherscan.io/address/' },
  hype: { gt: 'hyperevm', label: 'HyperEVM', explorer: null },
  ink: { gt: 'ink', label: 'Ink', explorer: null },
  arc: { gt: 'arc', label: 'Arc', explorer: null },
  robinhood: { gt: 'robinhood', label: 'Robinhood', explorer: null },
};
const SW_POOLS_PER_CHAIN = 6;

async function smartWalletsChain(chainKey) {
  const ch = SW_CHAINS[chainKey];
  if (!ch) throw new Error(`Unknown chain "${chainKey}"`);
  return cached(`sw:${chainKey}`, async () => {
    const GT = 'https://api.geckoterminal.com/api/v2';
    const tp = await fetchJson(`${GT}/networks/${ch.gt}/trending_pools?include=base_token&page=1`);
    const syms = new Map((tp.included || []).filter((x) => x.type === 'token')
      .map((x) => [x.id, x.attributes?.symbol || '?']));
    const pools = (tp.data || []).slice(0, SW_POOLS_PER_CHAIN).map((p) => {
      const a = p.attributes || {};
      const baseId = p.relationships?.base_token?.data?.id || '';
      const vol = parseFloat(a.volume_usd?.h24) || 0;
      return {
        address: a.address, name: a.name, baseId,
        base: baseId.split('_').slice(1).join('_').toLowerCase(),
        symbol: syms.get(baseId) || (a.name || '?').split(' / ')[0],
        price: parseFloat(a.base_token_price_usd) || null, vol24h: vol,
        // bigger pools need a higher bar or the window collapses to minutes
        minUsd: Math.max(100, Math.min(2000, Math.round(vol / 6000))),
      };
    });

    const W = new Map(); // wallet -> aggregate
    let tradesSeen = 0, windowStart = Infinity, windowEnd = 0;
    // wallet|block -> kinds, ACROSS ALL POOLS. Measured 30 Sep: a per-pool check
    // let an arbitrage bot through — it buys on one pool and sells on another in
    // the same transaction, so each pool alone saw an ordinary trade. Across
    // pools, a buy and a sell in one block is arbitrage or a sandwich either way.
    const blocks = new Map();
    for (const pool of pools) {
      let tr;
      try {
        tr = await fetchJson(`${GT}/networks/${ch.gt}/pools/${pool.address}/trades?trade_volume_in_usd_greater_than=${pool.minUsd}`);
      } catch (e) { console.error('[smart-wallets]', chainKey, pool.symbol, e.message); continue; }
      for (const t of (tr.data || [])) {
        const a = t.attributes || {};
        const w = a.tx_from_address; if (!w) continue;
        const kind = a.kind === 'sell' ? 'sell' : 'buy';
        const usd = parseFloat(a.volume_in_usd) || 0;
        const ts = Date.parse(a.block_timestamp) || 0;
        const to = String(a.to_token_address || '').toLowerCase();
        const from = String(a.from_token_address || '').toLowerCase();
        const amt = to === pool.base ? parseFloat(a.to_token_amount)
          : from === pool.base ? parseFloat(a.from_token_amount) : NaN;
        if (!Number.isFinite(amt) || amt <= 0) continue;
        tradesSeen++; windowStart = Math.min(windowStart, ts); windowEnd = Math.max(windowEnd, ts);
        const bk = `${w}|${a.block_number}`;
        const ks = blocks.get(bk) || new Set(); ks.add(kind); blocks.set(bk, ks);
        let rec = W.get(w);
        if (!rec) { rec = { address: w, trades: 0, bot: false, lastTs: 0, tokens: {} }; W.set(w, rec); }
        rec.trades++; rec.lastTs = Math.max(rec.lastTs, ts);
        const tk = rec.tokens[pool.base] ||= {
          symbol: pool.symbol, token: pool.base, pool: pool.address, price: pool.price,
          boughtUsd: 0, soldUsd: 0, boughtAmt: 0, soldAmt: 0, buys: 0, sells: 0,
        };
        if (kind === 'buy') { tk.boughtUsd += usd; tk.boughtAmt += amt; tk.buys++; }
        else { tk.soldUsd += usd; tk.soldAmt += amt; tk.sells++; }
      }
    }
    // A buy and a sell in the same block — on one pool (sandwich) or across
    // pools (arbitrage) — is a bot pattern, not a trade anyone can copy.
    for (const [bk, ks] of blocks) if (ks.size > 1) { const r = W.get(bk.split('|')[0]); if (r) r.bot = true; }

    const wallets = [];
    let bots = 0;
    for (const rec of W.values()) {
      if (rec.bot || rec.trades > 60) { bots++; continue; }
      let pnl = 0, known = 0, wins = 0, vol = 0, bought = 0, sold = 0, realizedSum = 0, unrealizedSum = 0;
      const coins = Object.values(rec.tokens).map((t) => {
        vol += t.boughtUsd + t.soldUsd; bought += t.boughtUsd; sold += t.soldUsd;
        let tp = null, realized = null, unrealized = null;
        if (t.boughtAmt > 0) {
          const avgBuy = t.boughtUsd / t.boughtAmt;
          realized = t.soldAmt > 0 ? Math.min(t.boughtAmt, t.soldAmt) * (t.soldUsd / t.soldAmt - avgBuy) : 0;
          const open = Math.max(0, t.boughtAmt - t.soldAmt);
          unrealized = open > 0 && t.price ? open * (t.price - avgBuy) : 0;
          tp = realized + unrealized;
        }
        // Only-sold: bought before the window, so the cost basis is unknown.
        // Leave it unknown rather than count the whole sale as profit — the
        // most common way these leaderboards flatter themselves.
        if (tp !== null) { pnl += tp; known++; if (tp > 0) wins++; realizedSum += realized; unrealizedSum += unrealized; }
        return {
          symbol: t.symbol, token: t.token, pool: t.pool,
          action: t.boughtAmt > 0 && t.soldAmt === 0 ? 'accumulating'
            : t.boughtAmt === 0 ? 'selling (bought before window)'
              : t.soldAmt >= t.boughtAmt * 0.95 ? 'round-trip' : 'trimming',
          boughtUsd: +t.boughtUsd.toFixed(2), soldUsd: +t.soldUsd.toFixed(2),
          pnl: tp === null ? null : +tp.toFixed(2),
          realized: realized === null ? null : +realized.toFixed(2),
          unrealized: unrealized === null ? null : +unrealized.toFixed(2),
        };
      }).sort((a, b) => (b.boughtUsd + b.soldUsd) - (a.boughtUsd + a.soldUsd));
      if (!known || vol < 1000) continue;
      wallets.push({
        address: rec.address, trades: rec.trades, lastTs: rec.lastTs,
        pnl: +pnl.toFixed(2), realized: +realizedSum.toFixed(2), unrealized: +unrealizedSum.toFixed(2),
        volume: +vol.toFixed(2), netFlow: +(bought - sold).toFixed(2),
        tokensKnown: known, winTokens: wins, winRate: +(wins / known * 100).toFixed(0), coins,
        consistent: wins >= 2,                            // profitable on 2+ coins, not one lucky hold
        paperOnly: realizedSum === 0 && unrealizedSum > 0, // nothing locked in yet
      });
    }
    // Ranked by REALISED P&L — profit actually locked in by closing trades.
    // Measured 30 Sep on Solana: ranking by total P&L put 21 single-coin wallets
    // in the top 25, led by one with $0 realised and $9,469 of paper gains on
    // the day's hottest coin. That measures who held the pump, not who can
    // trade. Paper gains are kept, in their own clearly labelled list.
    wallets.sort((a, b) => b.realized - a.realized || b.pnl - a.pnl);
    let ranked = wallets.filter((w) => w.realized > 0);

    // On-chain bot check for Solana leaders. The trade scan sees only a slice of
    // each wallet's activity (6 pools, larger trades), so an arbitrage bot whose
    // two legs rarely both land in that slice slips past the same-block test.
    // Measured 30 Sep: the one "consistent" wallet was an arbitrage bot — 63-75%
    // of its transactions failed and every successful one was in-and-out. One
    // cheap call per leader reads its failed-transaction rate; spray bots fail
    // most of what they send, so >= 50% removes them. Solana only: EVM chains
    // have no keyless per-wallet transaction list.
    let botsVerified = 0;
    if (chainKey === 'sol') {
      const checked = [];
      for (const w of ranked) {
        if (checked.length >= 25) break;
        try {
          await sleep(350);
          const sigs = await solRpc('getSignaturesForAddress', [w.address, { limit: 30 }]);
          const fr = sigs.length ? sigs.filter((x) => x.err).length / sigs.length : 0;
          w.failRate = +(fr * 100).toFixed(0);
          if (sigs.length >= 10 && fr >= 0.5) { botsVerified++; continue; }
        } catch { w.failRate = null; } // unverified is shown, not assumed clean or dirty
        checked.push(w);
      }
      ranked = checked;
    }
    const top = ranked.slice(0, 25);
    const paperLeaders = [...wallets].filter((w) => w.unrealized > 0)
      .sort((a, b) => b.unrealized - a.unrealized).slice(0, 10);

    // Where are the leaders converging? Coins the top wallets are net buying.
    const hot = new Map();
    for (const w of top) for (const c of w.coins) {
      const h = hot.get(c.token) || { symbol: c.symbol, token: c.token, pool: c.pool, buyers: 0, sellers: 0, netFlow: 0 };
      const net = c.boughtUsd - c.soldUsd;
      if (net > 0) h.buyers++; else if (net < 0) h.sellers++;
      h.netFlow += net; hot.set(c.token, h);
    }
    return {
      chain: chainKey, label: ch.label, explorer: ch.explorer, gtNetwork: ch.gt,
      pools: pools.map(({ address, name, symbol, vol24h, minUsd, price }) => ({ address, name, symbol, vol24h, minUsd, price })),
      wallets: top,
      paperLeaders,
      // Ranked by net MONEY flow, not by how many wallets bought. Measured 30 Sep:
      // ranked by buyer count, PARASITE topped a "coins they're buying" list with
      // 9 buyers vs 5 sellers — but a net flow of -$54,926. The sellers moved far
      // more money: the leaders were taking profit, the opposite of the headline.
      hotCoins: [...hot.values()].map((h) => ({ ...h, netFlow: +h.netFlow.toFixed(2),
        stance: h.netFlow > 0 ? 'accumulating' : h.netFlow < 0 ? 'taking profit' : 'mixed' }))
        .sort((a, b) => b.netFlow - a.netFlow).slice(0, 12),
      stats: { tradesSeen, walletsSeen: W.size, botsExcluded: bots + botsVerified, botsOnChain: botsVerified, ranked: wallets.length, withRealizedProfit: top.length,
        windowHours: Number.isFinite(windowStart) && windowEnd > windowStart ? +((windowEnd - windowStart) / 3600000).toFixed(1) : null },
      caveats: [
        'Built from public on-chain trades, not Axiom\'s own rankings — Axiom publishes no API and blocks automated access.',
        'P&L covers the observed window only (larger trades on this chain\'s trending pools). A wallet that only SOLD here bought earlier, so its cost basis is unknown and it is left out of P&L rather than counted as profit.',
        'Bots are excluded: any wallet that buys and sells in the same block — on one pool (sandwich) or across pools (arbitrage) — or trades at bot frequency.',
        'Ranked by REALISED P&L — profit actually locked in by closing trades. Open paper gains are listed separately: a wallet holding the day\'s hottest coin can top a total-P&L ranking without having proven anything.',
        'A snapshot of the observed window, not a long-term track record. "Consistent" marks wallets profitable on two or more coins.',
      ],
    };
  }, 10 * 60 * 1000);
}

// Hyperliquid perps: the leaderboard gives a genuine 30-day track record, and
// clearinghouseState shows what each of those wallets is holding right now.
async function hlPositions(address) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`clearinghouseState -> HTTP ${res.status}`);
  const d = await res.json();
  return (d.assetPositions || []).map((x) => x.position).filter(Boolean).map((p) => ({
    coin: p.coin, side: parseFloat(p.szi) >= 0 ? 'LONG' : 'SHORT',
    size: Math.abs(parseFloat(p.szi)), entryPx: parseFloat(p.entryPx),
    value: parseFloat(p.positionValue), unrealizedPnl: parseFloat(p.unrealizedPnl),
    leverage: p.leverage?.value ?? null,
  })).sort((a, b) => b.value - a.value);
}

async function smartWalletsHyperliquid() {
  return cached('sw:hl-perps', async () => {
    const cands = (await hlLeaderboardCandidates()).slice(0, 15);
    const out = [];
    for (let i = 0; i < cands.length; i += 3) {
      const batch = cands.slice(i, i + 3);
      const res = await Promise.allSettled(batch.map((w) => hlPositions(w.address)));
      res.forEach((r, j) => out.push({ ...batch[j], positions: r.status === 'fulfilled' ? r.value : [], error: r.status === 'rejected' ? r.reason.message : null }));
      if (i + 3 < cands.length) await sleep(1200);
    }
    const hot = new Map();
    for (const w of out) for (const p of w.positions) {
      const h = hot.get(p.coin) || { coin: p.coin, longs: 0, shorts: 0, value: 0 };
      if (p.side === 'LONG') h.longs++; else h.shorts++;
      h.value += p.value; hot.set(p.coin, h);
    }
    return {
      wallets: out,
      hotCoins: [...hot.values()].sort((a, b) => (b.longs + b.shorts) - (a.longs + a.shorts) || b.value - a.value).slice(0, 12),
      caveats: ['Hyperliquid perps: ranked by genuine 30-day realised P&L from the public leaderboard, with the positions each wallet holds right now.'],
    };
  }, 5 * 60 * 1000);
}

// Watchlist: wallets the user found on Axiom (or anywhere) and wants followed.
const SW_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'smartwallets.json');
const SW_MAX = 10;
let swWatch = null;
function swLoad() {
  if (swWatch) return swWatch;
  try { swWatch = JSON.parse(fs.readFileSync(SW_FILE, 'utf8')); } catch { swWatch = []; }
  return swWatch;
}
function swSave() {
  fs.mkdirSync(path.dirname(SW_FILE), { recursive: true });
  fs.writeFileSync(SW_FILE, JSON.stringify(swWatch, null, 2));
}
const isSolAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const isEvmAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

// Recent token buys/sells for a Solana wallet, read from the chain itself.
// Deltas in the wallet's own token accounts give direction and size exactly;
// USD value uses the CURRENT price, so it is labelled as such.
async function solWalletActivity(address, limit = 6) {
  // Active memecoin traders fail a LOT of transactions (slippage, priority-fee
  // races). Measured 30 Sep on a wallet from the scan: 5 of its last 6 had
  // failed. Looking at only the last ~10 found almost nothing, so read further
  // back and skip past the failures.
  const sigs = await solRpc('getSignaturesForAddress', [address, { limit: 40 }]);
  const failed = sigs.filter((x) => x.err).length;
  const trades = [];
  let read = 0, unreadable = 0, arbTxs = 0;
  for (const s of sigs.filter((x) => !x.err)) {
    if (read >= limit) break;
    await sleep(300); // the public RPC 429s on bursts
    let tx;
    try { tx = await solRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]); }
    catch { unreadable++; continue; } // counted and reported, never silently dropped
    read++;
    if (!tx?.meta) continue;
    const d = {};
    for (const b of tx.meta.postTokenBalances || []) if (b.owner === address && !STABLE_MINTS.has(b.mint)) d[b.mint] = (b.uiTokenAmount?.uiAmount || 0);
    for (const b of tx.meta.preTokenBalances || []) if (b.owner === address && !STABLE_MINTS.has(b.mint)) d[b.mint] = (d[b.mint] || 0) - (b.uiTokenAmount?.uiAmount || 0);
    // Touched tokens but ended flat: bought and sold inside ONE transaction.
    // That is arbitrage (in on one pool, out on another), not a position.
    const touched = Object.keys(d).length > 0;
    const moved = Object.values(d).some((v) => Math.abs(v) > 1e-9);
    if (touched && !moved) { arbTxs++; continue; }
    for (const [mint, delta] of Object.entries(d)) {
      if (Math.abs(delta) <= 1e-9) continue;
      let tok = { symbol: `${mint.slice(0, 4)}…` };
      try { tok = await resolveMint(mint); } catch { /* unresolvable */ }
      trades.push({
        time: (s.blockTime || 0) * 1000, side: delta > 0 ? 'BUY' : 'SELL', mint,
        symbol: tok.symbol, amount: Math.abs(delta),
        valueNowUsd: tok.priceUsd ? +(Math.abs(delta) * tok.priceUsd).toFixed(2) : null,
        sig: s.signature,
      });
    }
  }
  const failRate = sigs.length ? failed / sigs.length : 0;
  return {
    trades, scanned: sigs.length, failed, unreadable, read, arbTxs,
    failRate: +(failRate * 100).toFixed(0),
    arbitrage: read >= 3 && arbTxs / read >= 0.5,
    // A high failed-transaction rate is the signature of automated sniping:
    // bots spray transactions and let most of them fail.
    likelyBot: sigs.length >= 10 && failRate >= 0.5,
  };
}

async function smartWalletsWatch() {
  return cached('sw:watch', async () => {
    const list = swLoad();
    const rows = [];
    for (const w of list) {
      const row = { ...w, explorer: SW_CHAINS[w.chain]?.explorer ? SW_CHAINS[w.chain].explorer + w.address : null };
      if (w.chain === 'sol') {
        try {
          const a = await solWalletActivity(w.address);
          row.activity = a.trades;
          row.txStats = { scanned: a.scanned, failed: a.failed, failRate: a.failRate, unreadable: a.unreadable,
            likelyBot: a.likelyBot, read: a.read, arbTxs: a.arbTxs, arbitrage: a.arbitrage };
        } catch (e) { row.error = e.message; row.activity = []; }
      } else {
        // No keyless per-wallet history for EVM chains; show what the discovery
        // scan has seen this wallet do on trending pools, if anything.
        const cachedChain = cache[`sw:${w.chain}`]?.data; // peek only; never trigger a scan from here
        const hit = cachedChain?.wallets?.find((x) => x.address.toLowerCase() === w.address.toLowerCase());
        row.seenInScan = hit || null;
        row.note = 'EVM wallets: activity shown when this wallet trades the trending pools scanned for its chain. Use the explorer link for full history.';
      }
      rows.push(row);
    }
    return { max: SW_MAX, wallets: rows };
  }, 3 * 60 * 1000);
}

// ---- TradingAgents desk (external LLM multi-agent framework) --------------
// Runs the TauricResearch/TradingAgents framework and scores its decisions in
// THIS app's ledger, on identical rules, so an LLM debate desk and the app's own
// signal engine can be compared rather than argued about.
//
// The framework has no exchange-execution code (verified on clone: no ccxt, no
// broker client, no place_order) and this wrapper adds none. It produces a
// direction; levels come from ATR at a fixed 2:1, the same geometry the picks
// desk uses, so the only variable under test is the decision itself.
const AGENTS_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'TradingAgents');
const AGENTS_PY = path.join(AGENTS_DIR, '.venv', 'bin', 'python');
const AGENTS_BRIDGE = path.join(AGENTS_DIR, 'bridge', 'to_ledger.py');
// Only symbols the daily resolver can score. Doubles as an allowlist so nothing
// user-supplied is ever passed through as a free-form argument.
const AGENTS_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'LINK',
  'NVDA', 'TSLA', 'AAPL', 'AMD', 'MSFT', 'QQQ', 'GOOGL', 'AMZN', 'META',
  'AVGO', 'NFLX', 'INTC', 'MU', 'PLTR', 'GOLD', 'SILVER', 'COPPER', 'PLAT', 'OIL', 'NATGAS', 'WHEAT'];

let agentRun = null; // one run at a time; these are slow and cost money

// Which key the framework actually needs depends on the SELECTED provider, not on
// whichever key happens to be present. The first version of this check reported
// "ready (anthropic)" whenever an Anthropic key existed, while the framework
// defaults to OpenAI — so it would say ready and then fail at the first model call.
const AGENTS_PROVIDER_KEYS = {
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY', ollama: null, // ollama is local, no key
};
// Mirror python-dotenv's find_dotenv(usecwd=True) from the bridge's working
// directory: the NEAREST .env walking upward wins, and it stops at the first
// one found. Reading any other file here would let the app and the framework
// disagree about what is configured.
function agentsEnvFile() {
  for (const dir of [AGENTS_DIR, path.dirname(AGENTS_DIR)]) {
    const f = path.join(dir, '.env');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function agentsReady() {
  const venv = fs.existsSync(AGENTS_PY);
  const bridge = fs.existsSync(AGENTS_BRIDGE);
  const envFile = agentsEnvFile();
  let env = {};
  try {
    if (envFile) {
      env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split('\n')
        .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
    }
  } catch { /* unreadable */ }
  const provider = (env.TRADINGAGENTS_LLM_PROVIDER || 'openai').toLowerCase();
  const keyName = provider in AGENTS_PROVIDER_KEYS ? AGENTS_PROVIDER_KEYS[provider] : undefined;
  const v = keyName ? (env[keyName] || '') : '';
  // A placeholder is not a key: shipped example values look real enough to pass
  // a truthiness test and then 401 at runtime.
  const realKey = keyName === null
    || (v.length > 20 && !/^your[_-]|here$|^sk-xxx|^\.\.\.$/i.test(v));
  let reason = null;
  if (!venv) reason = 'Python venv missing — TradingAgents is not installed.';
  else if (!bridge) reason = 'Bridge script missing.';
  else if (!envFile) reason = 'No .env found for TradingAgents.';
  else if (keyName === undefined) reason = `Unknown provider "${provider}" in TRADINGAGENTS_LLM_PROVIDER.`;
  else if (!realKey) reason = `Provider is "${provider}", so ${keyName} must be set in ${envFile} — it is ${v ? 'a placeholder' : 'empty'}.`;
  return {
    venv, bridge, envFile, provider, keyName,
    keyed: realKey,
    models: { deep: env.TRADINGAGENTS_DEEP_THINK_LLM || '(framework default)', quick: env.TRADINGAGENTS_QUICK_THINK_LLM || '(framework default)' },
    ready: venv && bridge && !!envFile && realKey && keyName !== undefined,
    reason,
  };
}

function agentsState() {
  const rows = ledger.signals.filter((r) => r.kind === 'llmdesk');
  const decided = rows.filter((r) => ['win', 'loss'].includes(r.status));
  const wins = decided.filter((r) => r.status === 'win').length;
  const R = 2.0;
  const hit = decided.length ? wins / decided.length : null;
  return {
    setup: agentsReady(),
    running: agentRun ? { symbols: agentRun.symbols, startedAt: agentRun.startedAt,
      dryRun: agentRun.dryRun, done: agentRun.done, output: agentRun.output.slice(-6000),
      error: agentRun.error || null } : null,
    universe: AGENTS_SYMBOLS,
    signals: rows.slice(-40).reverse().map((r) => ({
      time: r.time, symbol: r.symbol, direction: r.direction, status: r.status,
      entry: r.entry, stop: r.stop, target: r.target,
      rationale: (r.rationale || '').slice(-700),
    })),
    stats: decided.length ? {
      n: decided.length, hitRate: +((hit) * 100).toFixed(1),
      breakeven: +(100 / (R + 1)).toFixed(1), rMultiple: R,
      evR: +(hit * R - (1 - hit)).toFixed(3), enough: decided.length >= 20,
    } : null,
    open: rows.filter((r) => r.status === 'open').length,
    comparison: deskComparison(),
  };
}

function runAgents(symbols, dryRun) {
  const clean = symbols.map((x) => String(x).toUpperCase().trim()).filter((x) => AGENTS_SYMBOLS.includes(x));
  if (!clean.length) throw new Error('No valid symbols — pick from the supported list.');
  if (agentRun && !agentRun.done) throw new Error('A run is already in progress.');
  const r = agentsReady();
  if (!r.ready) throw new Error(r.reason || 'TradingAgents is not configured.');

  const args = [AGENTS_BRIDGE, ...clean, ...(dryRun ? ['--dry-run'] : [])];
  agentRun = { symbols: clean, dryRun, startedAt: Date.now(), output: '', done: false, error: null };
  // execFile with an argument array — never a shell string — so a symbol can
  // never become a command. The allowlist above makes that doubly true.
  const child = execFile(AGENTS_PY, args, { cwd: AGENTS_DIR, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    // Output already arrives through the stream listeners below; appending the
    // buffered stdout/stderr here as well printed every line twice.
    (err) => {
      agentRun.done = true;
      if (err) agentRun.error = err.killed ? 'Timed out after 30 minutes.' : err.message;
      ledger.loaded = false; // the bridge appended to signals.json directly
    });
  child.stdout?.on('data', (d) => { agentRun.output += d; });
  child.stderr?.on('data', (d) => { agentRun.output += d; });
  return agentRun;
}

// ---- Trade suggestions, ranked by MEASURED edge ---------------------------
// Deliberately does NOT rank by the confluence score. That score has measured
// no predictive power (correlation +0.0007 over 1,200+ resolved trades) and its
// grade bands do not separate winners from losers. What DOES separate outcomes
// is the track record of the bucket a setup belongs to — its desk, strategy and
// asset class — so that is what ranks the list.
//
// It is also allowed to conclude that nothing is worth trading. As of 25 Sep no
// bucket in the ledger has positive expectancy, and a suggestions panel that
// cannot say so is just a losing signal wearing a recommendation badge.
const CRYPTO_SET = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'LINK']);

// ---- Trading costs --------------------------------------------------------
// Every expectancy in this ledger was scored cost-free until 30 Sep, which
// flattered every desk. For a scalp the omission is not a rounding error: the
// 5m stops sit a median 0.217% from entry, while a Bybit round trip (taker fee
// both sides + ~2bp slippage both sides) costs ~0.15% of notional — so costs
// alone run a median 0.69R per trade. The 5m desk's reported -0.067R was
// -1.031R net: costs were 14x the loss being shown. Gross figures are kept (they
// measure the SIGNAL); net figures measure whether it can be TRADED.
// Per-leg, not a flat round trip (revised 30 Sep when 5m moved to limit
// orders). Each leg pays what its order type actually costs on Bybit USDT
// perpetuals: a resting limit is a maker fill with no slippage; anything that
// crosses the book (a stop-order entry, a stop-loss exit) pays taker plus
// slippage. The take-profit is a resting limit, so a WIN exits at maker. The
// earlier flat model charged taker on every leg, including take-profits nobody
// would market out of, which is why the 5m net read -1.031R under it and about
// -0.77R under this one on the same trades.
const FEE_MAKER = 0.0002, FEE_TAKER = 0.00055, FEE_SLIP = 0.0002;
const COST_RT = 2 * FEE_TAKER + 2 * FEE_SLIP; // all-taker round trip, kept for reference
function legFees(exec, outcome) {
  const entry = exec === 'limit' ? FEE_MAKER : FEE_TAKER + FEE_SLIP;
  const exit = outcome === 'win' ? FEE_MAKER : FEE_TAKER + FEE_SLIP;
  return entry + exit;
}
// Cost of one trade in R. Pass an outcome for a resolved trade; omit it for a
// pre-trade estimate, which averages the winning and losing exits.
function tradeCostR(entry, stop, exec = 'stop', outcome = null) {
  const riskPct = entry > 0 ? Math.abs(entry - stop) / entry : 0;
  if (!(riskPct > 0)) return null;
  const f = outcome ? legFees(exec, outcome) : (legFees(exec, 'win') + legFees(exec, 'loss')) / 2;
  return f / riskPct;
}
// Win-leg and loss-leg costs separately — needed for an honest breakeven,
// because with a maker take-profit the two are no longer equal.
function tradeCostLegsR(entry, stop, exec = 'stop') {
  const riskPct = entry > 0 ? Math.abs(entry - stop) / entry : 0;
  if (!(riskPct > 0)) return null;
  return { win: legFees(exec, 'win') / riskPct, loss: legFees(exec, 'loss') / riskPct };
}
function meanCostR(rows) {
  const c = rows.map((r) => tradeCostR(r.entry, r.stop, r.exec || 'stop', r.status))
    .filter((x) => x != null && Number.isFinite(x));
  return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
}

function bucketEdge(kind, strategy, assetClass) {
  const rows = ledger.signals.filter((r) => ['win', 'loss'].includes(r.status)
    && r.kind === kind && r.strategy === strategy
    && (CRYPTO_SET.has(r.symbol) ? 'crypto' : 'non-crypto') === assetClass);
  if (rows.length < 20) return { n: rows.length, enough: false };
  const wins = rows.filter((r) => r.status === 'win').length;
  const ms = rows.map((r) => r.rMultiple).filter((x) => typeof x === 'number' && x > 0);
  const R = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 1;
  const hit = wins / rows.length;
  const cost = meanCostR(rows);
  const evR = hit * R - (1 - hit);
  return {
    n: rows.length, enough: true,
    hitRate: +(hit * 100).toFixed(1), rMultiple: +R.toFixed(2),
    breakeven: +(100 / (R + 1)).toFixed(1),
    evR: +evR.toFixed(3),
    costR: cost == null ? null : +cost.toFixed(3),
    netEvR: cost == null ? null : +(evR - cost).toFixed(3),
  };
}

async function getSuggestions(riskPct = 1) {
  await loadLedger();
  const [tf5, tf15, acct] = await Promise.all([
    getScalpTf('5m').catch(() => null),
    getScalpTf('15m').catch(() => null),
    getBybitAccount().catch(() => null),
  ]);

  const equity = acct && acct.ok && acct.balance ? acct.balance.equity : 0;
  const held = new Map((acct && acct.ok ? acct.positions || [] : []).map((p) => [p.symbol.replace(/USDT$/, ''), p]));
  const cryptoHeld = [...held.keys()].filter((k) => CRYPTO_SET.has(k)).length;

  // The agent desk's most recent call per symbol (last 7 days), so a scalp
  // setup can be read against an independent LLM view of the same market. The
  // two measure different horizons — a 5m setup vs a daily call — so agreement
  // is context, not confirmation; it is not blended into the ranking.
  const agentBySym = new Map();
  const weekAgo = Date.now() - 7 * 86400000;
  for (const r of ledger.signals) {
    if (r.kind !== 'llmdesk' || r.time < weekAgo) continue;
    const prev = agentBySym.get(r.symbol);
    if (!prev || r.time > prev.time) agentBySym.set(r.symbol, r);
  }

  const cands = [];
  for (const [tf, data] of [['5m', tf5], ['15m', tf15]]) {
    const kind = tf === '5m' ? 'scalp' : 'scalp15';
    for (const it of (data?.items || [])) {
      const st = it.setup;
      if (!st || it.closed) continue;
      if (st.direction === '2-WAY') continue; // no single direction to size or judge
      const assetClass = CRYPTO_SET.has(it.symbol) ? 'crypto' : 'non-crypto';
      const edge = bucketEdge(kind, st.strategy, assetClass);
      const risk = Math.abs(st.entry - st.stop);
      const reward = Math.abs(st.t1 - st.entry);
      cands.push({
        timeframe: tf, symbol: it.symbol, assetClass, strategy: st.strategy,
        direction: st.direction, grade: st.grade, score: st.score,
        entry: st.entry, stop: st.stop, target: st.t1,
        rr: risk > 0 ? +(reward / risk).toFixed(2) : null,
        costR: st.costR ?? (tradeCostR(st.entry, st.stop, st.orderType === 'limit' ? 'limit' : 'stop') == null ? null
          : +tradeCostR(st.entry, st.stop, st.orderType === 'limit' ? 'limit' : 'stop').toFixed(3)),
        exec: st.orderType === 'limit' ? 'limit' : 'stop',
        edge,
        agent: (() => {
          const a = agentBySym.get(it.symbol);
          if (!a) return null;
          return { direction: a.direction, rating: a.rating || null, time: a.time, status: a.status,
            agrees: a.direction === st.direction };
        })(),
        // Size from the account's real equity, not a notional. Risk-per-trade is
        // the only input that reliably controls damage.
        sizing: (equity > 0 && risk > 0) ? (() => {
          const riskAmt = equity * (riskPct / 100);
          const qty = riskAmt / risk;
          return { riskPct, riskAmount: +riskAmt.toFixed(2), qty: +qty.toPrecision(4),
            notional: +(qty * st.entry).toFixed(2) };
        })() : null,
        flags: [
          st.costWarning || null,
          held.has(it.symbol) ? `Already holding ${it.symbol} — this would add to an open position, not diversify it.` : null,
          (assetClass === 'crypto' && cryptoHeld >= 2) ? `You already hold ${cryptoHeld} crypto positions; these move together, so the real risk is larger than one trade's stop suggests.` : null,
          (!edge.enough) ? `Only ${edge.n} resolved trades in this bucket — not enough to judge. Treat as untested.` : null,
          (edge.enough && edge.evR <= -0.15) ? `This bucket has measured ${edge.evR}R over ${edge.n} trades. Taking it has been a losing proposition.` : null,
        ].filter(Boolean),
      });
    }
  }

  // Rank by measured expectancy. Untested buckets sort below anything measured,
  // because "unknown" should not outrank "known and merely mediocre".
  // Rank by NET expectancy — what the setup's bucket has actually made after
  // realistic costs — falling back to gross only if costs could not be priced.
  const rankEv = (c) => (c.edge.enough ? (c.edge.netEvR ?? c.edge.evR) : -99);
  cands.sort((a, b) => rankEv(b) - rankEv(a));

  const best = cands.find((c) => c.edge.enough);
  const netOf = (c) => c.edge.netEvR ?? c.edge.evR;
  const anyPositive = cands.some((c) => c.edge.enough && netOf(c) > 0);
  const allEdges = [...new Set(ledger.signals.filter((r) => ['win', 'loss'].includes(r.status)).map((r) => r.kind))];

  return {
    equity, funded: equity > 0, riskPct,
    suggestions: cands.slice(0, 12),
    verdict: anyPositive
      ? 'At least one setup belongs to a bucket with positive measured expectancy. Those are listed first.'
      : cands.length
        ? `No setup on the board belongs to a bucket with positive expectancy after trading costs. The best available is ${best ? `${best.strategy} on ${best.assetClass} at ${best.edge.evR}R before costs and ${best.edge.netEvR ?? '?'}R after them (${best.edge.n} trades)` : 'untested'}. Scalp stops are tight enough that fees and slippage alone cost a large fraction of 1R, so the highest-expectancy action is to take none of them — or take them on the Paper Desk, which charges those costs, where being wrong is free.`
        : 'No live setups on either scalp desk right now.',
    anyPositive,
    measuredDesks: allEdges,
    basis: 'Ranked by the measured expectancy of each setup\'s (desk × strategy × asset class) bucket, not by its confluence score — that score has measured no predictive power.',
  };
}

// ---- 3Commas v2 (read-only) -----------------------------------------------
// 3Commas v1 and its API were shut down on 11 Sep 2026; v2 (built with
// WunderTrading) exposes an Open API at trade.3commas.io/open_api. Verified from
// the live docs 2 Oct 2026: HMAC-SHA256 over "METHOD\nPATH\nTS\nRECV\nBODY",
// Base64-encoded, sent as X-API-Key / X-Signature / X-Timestamp / X-Recv-Window.
//
// READ-ONLY BY CONSTRUCTION: tcGet() can only issue GET, and only to the three
// read endpoints below. The v2 API also has trade endpoints (POST
// /strategies/trade, market-close, cancel…) — none are implemented here.
const TC_BASE = 'https://trade.3commas.io';
const TC_READ_PATHS = ['/open_api/api_profiles', '/open_api/strategies/live', '/open_api/strategies/history'];

function tcConfigured() {
  const k = SECRETS.THREECOMMAS_KEY || '', sct = SECRETS.THREECOMMAS_SECRET || '';
  return k.length > 8 && sct.length > 8;
}
async function tcGet(pathWithQuery) {
  const pathOnly = pathWithQuery.split('?')[0];
  if (!TC_READ_PATHS.includes(pathOnly)) throw new Error(`refusing non-read 3Commas path ${pathOnly}`);
  if (!tcConfigured()) { const e = new Error('No 3Commas API key configured'); e.code = 'NO_KEY'; throw e; }
  const ts = Date.now().toString(), recv = '30000';
  const payload = `GET\n${pathWithQuery}\n${ts}\n${recv}\n`;
  const sig = crypto.createHmac('sha256', SECRETS.THREECOMMAS_SECRET).update(payload).digest('base64');
  const r = await fetch(TC_BASE + pathWithQuery, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-API-Key': SECRETS.THREECOMMAS_KEY, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Recv-Window': recv },
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((body && body.message) || `3Commas HTTP ${r.status}`);
    e.code = r.status;
    e.hint = r.status === 401 ? 'Key or secret rejected. Check both are pasted exactly, with no spaces, and that the key has not expired (keys without an IP whitelist expire after 3 months).'
      : r.status === 405 || r.status === 403 ? 'The key lacks a permission this needs. Grant api_profile:read and strategy:read.'
        : r.status === 429 ? 'Rate limit reached (1,200 tokens/min per key). The dashboard caches; give it a minute.'
          : null;
    throw e;
  }
  return body;
}

// Unrealised % for one strategy. The docs' `currentPosition` is the platform's
// own figure; we fall back to entry vs last price only when it is missing.
const tcNum = (v) => (Number.isFinite(+v) ? +v : null);

function tcSummarise(s) {
  const entry = tcNum(s.price), last = tcNum(s.lastPrice);
  const cost = tcNum(s.totalEntryCost) || 0;
  const fees = (tcNum(s.totalEntryCommissionCost) || 0) + (tcNum(s.totalExitCommissionCost) || 0);
  const pct = tcNum(s.currentPosition);
  // Direction isn't a named field in the docs; infer it from whether the
  // platform's own unrealised % moves with or against price.
  const priceMove = entry && last ? (last / entry - 1) * 100 : null;
  const side = pct != null && priceMove != null && Math.abs(priceMove) > 0.01
    ? (Math.sign(pct) === Math.sign(priceMove) ? 'LONG' : 'SHORT') : null;
  // Worst point against the position, from the platform's own recorded extremes.
  const lo = tcNum(s.lowestReachedPrice?.price), hi = tcNum(s.highestReachedPrice?.price);
  const mae = entry && side === 'LONG' && lo ? (lo / entry - 1) * 100
    : entry && side === 'SHORT' && hi ? (1 - hi / entry) * 100 : null;
  return {
    id: s.strategyId, pair: s.pair, pairType: s.pairType, exchange: s.exchange?.code || null,
    profile: s.profileStrategies?.[0]?.profile?.name || null,
    status: s.status, paper: !!s.paperTrading, side, leverage: tcNum(s.leverage),
    entry, last, cost: +cost.toFixed(2), fees: +fees.toFixed(4),
    // Exact unrealised dollars from amounts still held — leverage-independent, so
    // no guessing whether "cost" means margin or notional. Falls back to the
    // platform's own % only when direction can't be inferred.
    unrealPct: pct,
    unrealUsd: side && entry && last
      ? +((last - entry) * ((tcNum(s.totalEntryAmount) || 0) - (tcNum(s.totalExitAmount) || 0)) * (side === 'LONG' ? 1 : -1)).toFixed(2)
      : (pct != null ? +((pct / 100) * cost).toFixed(2) : null),
    // Realised P&L from the actual money in and out, minus fees. totalProfitLoss
    // is NOT dollars: on a live deal it read -109.9084 when the only realised
    // P&L was the $0.01099084 entry fee, i.e. dollars x 10,000 (which also explains
    // the docs' -800.98 on a $200 position). Its sign is still used to tell
    // long from short on a closed deal; its size only as a /1e4 last resort.
    pnlPlatform: tcNum(s.totalProfitLoss) != null ? +(tcNum(s.totalProfitLoss) / 1e4).toFixed(4) : null,
    pnl: (() => {
      const inC = tcNum(s.totalEntryCost) || 0, outC = tcNum(s.totalExitCost) || 0;
      if (!(inC > 0 && outC > 0)) return s.status === 'entered' || tcNum(s.totalProfitLoss) == null ? null : +(tcNum(s.totalProfitLoss) / 1e4).toFixed(2);
      const ps = s.profileStrategies?.[0] || {};
      const ep = tcNum(ps.entryPrice) ?? entry, xp = tcNum(ps.exitPrice);
      const plat = tcNum(s.totalProfitLoss);
      let dir = side;
      if (!dir && ep && xp && plat) dir = Math.sign(xp - ep) === Math.sign(plat) ? 'LONG' : 'SHORT';
      if (!dir) return plat != null ? +(plat / 1e4).toFixed(2) : null;
      return +(((dir === 'LONG' ? outC - inC : inC - outC)) - fees).toFixed(2);
    })(),
    safetyUsed: tcNum(s.extraOrderCompletedCount), safetyMax: tcNum(s.extraOrderCount),
    maePct: mae != null ? +mae.toFixed(2) : null,
    stopLoss: s.stopLoss ?? null, takeProfits: (s.takeProfits || []).length,
    source: s.signalBot ? 'signal bot' : s.createdBy || s.creationTrigger?.code || null,
    createdAt: s.createdAt, enteredAt: s.enteredAt, updatedAt: s.updatedAt,
  };
}

async function getThreeCommas() {
  if (!tcConfigured()) return { configured: false };
  const [profiles, live, hist] = await Promise.all([
    cached('3c:profiles', () => tcGet('/open_api/api_profiles'), 10 * 60 * 1000).catch((e) => ({ __err: e })), // weight 50
    cached('3c:live', () => tcGet('/open_api/strategies/live'), 60 * 1000).catch((e) => ({ __err: e })),       // weight 10
    cached('3c:history', () => tcGet('/open_api/strategies/history?page=1&limit=100'), 5 * 60 * 1000).catch((e) => ({ __err: e })),
  ]);
  const firstErr = [profiles, live, hist].find((x) => x && x.__err);
  if (firstErr && profiles.__err && live.__err) {
    return { configured: true, ok: false, error: firstErr.__err.message, code: firstErr.__err.code, hint: firstErr.__err.hint || null };
  }
  const accounts = profiles.__err ? [] : (profiles.items || []).map((p) => ({
    name: p.name, exchange: p.exchange?.name || p.exchange?.code, status: p.status, demo: !!p.demo,
    assets: Object.entries(p.balance?.assets || {}).map(([k, v]) => ({ asset: k, total: tcNum(v.total), free: tcNum(v.free) }))
      .filter((a) => a.total).sort((a, b) => b.total - a.total),
  }));
  // One exchange wallet can appear as several connections (e.g. Bybit spot +
  // futures on a unified account) with identical balances: flag the repeats
  // so nobody adds them up.
  accounts.forEach((a, i) => {
    const sig = a.name + '|' + a.assets.map((x) => x.asset + x.total).join(',');
    const first = accounts.findIndex((b) => b.name + '|' + b.assets.map((x) => x.asset + x.total).join(',') === sig);
    if (first !== i && a.assets.length) a.sameWalletAs = accounts[first].exchange;
  });
  const open = live.__err ? [] : (live.items || []).map(tcSummarise);
  const closed = hist.__err ? [] : (hist.items || []).map(tcSummarise);

  const realOpen = open.filter((x) => !x.paper);
  const deployed = realOpen.reduce((a, x) => a + (x.cost || 0), 0);
  const unreal = realOpen.reduce((a, x) => a + (x.unrealUsd || 0), 0);
  const scored = closed.filter((x) => x.pnl != null && !x.paper);
  const wins = scored.filter((x) => x.pnl > 0), losses = scored.filter((x) => x.pnl <= 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = Math.abs(losses.reduce((a, x) => a + x.pnl, 0));
  // The DCA trap: a high win rate earned by riding deep drawdowns. For each
  // winner, how far did it go against you before it came good?
  const deepWins = wins.filter((x) => x.maePct != null && x.maePct <= -10);
  return {
    configured: true, ok: true, accounts, open, closed: closed.slice(0, 60),
    partial: [['profiles', profiles], ['live', live], ['history', hist]].filter(([, v]) => v && v.__err).map(([k, v]) => `${k}: ${v.__err.message}`),
    summary: {
      openReal: realOpen.length, openPaper: open.length - realOpen.length,
      deployed: +deployed.toFixed(2), unrealised: +unreal.toFixed(2),
      inDrawdown: realOpen.filter((x) => (x.unrealPct || 0) < 0).length,
      deepestOpen: realOpen.reduce((m, x) => Math.min(m, x.unrealPct ?? 0), 0),
      closedN: scored.length, hitRate: scored.length ? +((wins.length / scored.length) * 100).toFixed(1) : null,
      netPnl: +(gw - gl).toFixed(2), profitFactor: gl ? +(gw / gl).toFixed(2) : null,
      avgWin: wins.length ? +(gw / wins.length).toFixed(2) : null, avgLoss: losses.length ? +(gl / losses.length).toFixed(2) : null,
      fees: +scored.reduce((a, x) => a + (x.fees || 0), 0).toFixed(2),
      winsThatWentDeep: deepWins.length, winsWithMae: wins.filter((x) => x.maePct != null).length,
      enough: scored.length >= 20,
    },
  };
}

// ---- Daily research routine (cloud) ---------------------------------------
// The "Daily market mover self improvement" routine runs in the cloud on a
// separate repo, so it can't see this app or its ledger. Its predictor (BTC 5m
// next-candle direction) keeps an out-of-sample scoreboard, already net of its
// own 10 bp round-trip cost, on a public branch. Read it here, no key and
// read-only, so the two measurements sit side by side, and flag any day it
// failed to score (on 13 Oct a run missed the system entirely and rebuilt a
// separate tool from scratch).
const ROUTINE_SCOREBOARD = 'https://raw.githubusercontent.com/joshphillips1119-art/claude-cloud-session/claude/scalper-live/state/scoreboard.jsonl';
const ROUTINE_FIRE_UTC_MIN = 22 * 60 + 25; // routine fires 22:25 UTC, reviewing the previous UTC day
function routinePool(list) {
  const n = list.reduce((a, x) => a + (x?.n || 0), 0), hits = list.reduce((a, x) => a + (x?.hits || 0), 0);
  if (!n) return null;
  const wavg = (k) => list.reduce((a, x) => a + (x?.[k] || 0) * (x?.n || 0), 0) / n;
  const p = hits / n, z = 1.96, den = 1 + z * z / n, ctr = p + z * z / (2 * n);
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { n, hits, acc: +(p * 100).toFixed(1), lo: +(((ctr - half) / den) * 100).toFixed(1), hi: +(((ctr + half) / den) * 100).toFixed(1),
    grossBps: +wavg('gross_bps').toFixed(2), netBps: +wavg('net_bps').toFixed(2) };
}
async function getRoutine() {
  return cached('routine', async () => {
    const r = await fetch(ROUTINE_SCOREBOARD, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`routine scoreboard HTTP ${r.status}`);
    const rows = (await r.text()).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && x.date && x.ensemble).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw new Error('routine scoreboard is empty');
    // Which UTC day should the latest run have scored?
    const now = new Date(), utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (utcMin >= ROUTINE_FIRE_UTC_MIN + 30 ? 1 : 2) * 86400000);
    const latest = rows.at(-1).date;
    const missed = Math.max(0, Math.round((expected - Date.parse(latest + 'T00:00:00Z')) / 86400000));
    const strategies = {};
    for (const d of rows) for (const [k, v] of Object.entries(d.strategies || {})) (strategies[k] ||= []).push(v);
    return {
      ok: true, source: ROUTINE_SCOREBOARD, latest, expected: expected.toISOString().slice(0, 10), missed,
      costBps: 10,
      days: rows.map((d) => ({ date: d.date, version: d.version, regime: d.regime || null,
        calls: d.ensemble.n, acc: +(d.ensemble.acc * 100).toFixed(1), netBps: d.ensemble.net_bps, grossBps: d.ensemble.gross_bps,
        fade: d.baselines?.anti_persistence ? +(d.baselines.anti_persistence.acc * 100).toFixed(1) : null })),
      pooled: {
        filtered: routinePool(rows.map((d) => d.ensemble)),
        everyBar: routinePool(rows.map((d) => d.ensemble_all)),
        fadeLastBar: routinePool(rows.map((d) => d.baselines?.anti_persistence)),
        alwaysUp: routinePool(rows.map((d) => d.baselines?.always_up)),
      },
      strategies: Object.entries(strategies).map(([k, v]) => ({ name: k, ...routinePool(v) }))
        .filter((x) => x.n).sort((a, b) => b.acc - a.acc),
    };
  }, 60 * 60 * 1000);
}

// ---- Autonomous paper scalper (24/7) --------------------------------------
// A complete autonomous scalping bot — scan, select, size, place, manage, exit —
// running on PAPER against live Bybit prices with Bybit's fee schedule. The one
// part deliberately not built is live order placement: this module calls only
// Bybit's public /v5/market endpoints and has no path to the order API.
//
// Why paper: the app's own measurements say 5m scalping is -0.87R per trade
// after costs, with entries below a random walk. A live 24/7 bot would repeat
// that loss around the clock. On paper it answers the question for free, with
// forward data no backtest can fake.
//
// Signals, prices and fills all come from ONE venue (Bybit linear perps), so a
// limit level computed from a chart is exactly the level that fills — unlike
// the scalp desk's commodities, which are read from CNBC futures.
const BOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'bot.json');
const BOT_UNIVERSE = [
  { sym: 'BTCUSDT', label: 'BTC', cls: 'crypto' }, { sym: 'ETHUSDT', label: 'ETH', cls: 'crypto' },
  { sym: 'SOLUSDT', label: 'SOL', cls: 'crypto' }, { sym: 'XRPUSDT', label: 'XRP', cls: 'crypto' },
  { sym: 'DOGEUSDT', label: 'DOGE', cls: 'crypto' }, { sym: 'BNBUSDT', label: 'BNB', cls: 'crypto' },
  { sym: 'AVAXUSDT', label: 'AVAX', cls: 'crypto' }, { sym: 'LINKUSDT', label: 'LINK', cls: 'crypto' },
  { sym: 'XAUUSDT', label: 'Gold', cls: 'commodity' }, { sym: 'XAGUSDT', label: 'Silver', cls: 'commodity' },
  { sym: 'CLUSDT', label: 'WTI oil', cls: 'commodity' }, { sym: 'BZUSDT', label: 'Brent oil', cls: 'commodity' },
];
// Strategy sleeves. Each runs independently with its own position cap and its
// own scoreboard, so one strategy cannot crowd the others out and the results
// show which approach — if any — actually works on forward data.
const BOT_SLEEVES = {
  trend: { label: 'Trend pullback', strategies: ['EMA Pullback', 'VWAP Bounce'],
    how: 'Buys dips in an uptrend / sells rallies in a downtrend, with a resting limit at the pullback.' },
  revert: { label: 'Mean reversion', strategies: ['VWAP Snap-back', 'Reversal Bar'],
    how: 'Fades stretched moves back toward VWAP, with a resting limit.' },
  breakout: { label: 'Breakout', strategies: ['Momentum Breakout', 'Coil Breakout'],
    how: 'Trades range breaks: coils as a two-sided stop bracket (taker), momentum breaks as a limit pullback.' },
  fade: { label: 'Spike fade', strategies: ['Spike Fade'],
    how: 'After a 2x-volume, 2x-range spike, fades it with a resting limit. Built on the one real-time pattern that measured anything: the next bar reversed 56% of 249 times (borderline). This exact trade is untested — the bot is what tests it.' },
};
const BOT_DEFAULTS = {
  startEquity: 10000,   // paper USDT. A $50 book cannot size 0.5% risk above Bybit's minimum order sizes.
  riskPct: 0.5,         // equity risked per trade
  maxPositions: 6,      // open positions + working orders at once, across all sleeves
  sleeves: { trend: { on: true, max: 2 }, revert: { on: true, max: 2 }, breakout: { on: true, max: 2 }, fade: { on: true, max: 2 } },
  dailyLossPct: 3,      // halt for the rest of the UTC day past this drawdown
  maxCostR: 0.5,        // skip setups whose round-trip costs exceed this fraction of the risk
  eventBlackoutMin: 30, // no new entries this close to a high-impact release
  lossCooldownMin: 30,  // after a loss, leave that market alone for this long
  entryWindowMin: 30,   // resting limit cancelled if unfilled (the measured 6-bar window)
  maxHoldMin: 240,      // flatten a position still open after this long (the resolver's 48 bars)
};
let bot = null;
let botBusy = false;

function botFresh(settings = {}) {
  const st = { ...BOT_DEFAULTS, ...settings };
  return {
    enabled: false, createdAt: Date.now(), settings: st,
    equity: st.startEquity, dayKey: new Date().toISOString().slice(0, 10), dayStartEquity: st.startEquity,
    haltedUntil: null, lastScanBucket: 0, orders: [], positions: [], trades: [], journal: [], cooldowns: {}, seq: 1,
  };
}
function botLoad() {
  if (bot) return bot;
  try {
    bot = JSON.parse(fs.readFileSync(BOT_FILE, 'utf8'));
    bot.settings = { ...BOT_DEFAULTS, ...bot.settings, sleeves: { ...BOT_DEFAULTS.sleeves, ...(bot.settings?.sleeves || {}) } };
  }
  catch { bot = botFresh(); }
  return bot;
}
function botSave() {
  fs.mkdirSync(path.dirname(BOT_FILE), { recursive: true });
  fs.writeFileSync(BOT_FILE, JSON.stringify(bot));
}
function botLog(entry) {
  bot.journal.unshift({ time: Date.now(), ...entry });
  bot.journal = bot.journal.slice(0, 300);
}

// Bybit public market data only — the sole external calls this module makes.
async function bybitKlines(sym, interval, limit = 200, start = null) {
  const q = `category=linear&symbol=${sym}&interval=${interval}&limit=${limit}${start ? `&start=${start}` : ''}`;
  const d = await fetchJson(`https://api.bybit.com/v5/market/kline?${q}`);
  if (d.retCode !== 0) throw new Error(`kline ${sym}: ${d.retMsg}`);
  return (d.result?.list || []).map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
}
async function bybitInstrument(sym) {
  return cached(`bybit-inst:${sym}`, async () => {
    const d = await fetchJson(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${sym}`);
    const x = d.result?.list?.[0];
    if (!x) throw new Error(`no instrument ${sym}`);
    return { minQty: +x.lotSizeFilter.minOrderQty, qtyStep: +x.lotSizeFilter.qtyStep, tick: +x.priceFilter.tickSize, status: x.status };
  }, 6 * 3600 * 1000);
}
const floorStep = (x, step) => Math.floor(x / step + 1e-9) * step;
const dp = (step) => Math.max(0, (String(step).split('.')[1] || '').length);
// Round to Bybit's price tick AND to its decimal places, so 118.35 is 118.35,
// not the 118.35000000000001 plain float maths produces.
const roundTick = (x, tick) => +(Math.round(x / tick) * tick).toFixed(dp(tick));

const sleeveOf = (strategy) => Object.keys(BOT_SLEEVES).find((k) => BOT_SLEEVES[k].strategies.includes(strategy)) || null;

// Spike fade: fade a 2x-volume, 2x-range spike on the last CLOSED bar with a
// resting limit on the fade side. Stop beyond the spike's extreme; 1R target.
function spikeFade(c) {
  const n = c.length; if (n < 25) return null;
  const k = c[n - 2], now = c[n - 1];                  // last closed bar, forming bar
  const w = c.slice(n - 22, n - 2);
  const avgV = w.reduce((a, b) => a + b.v, 0) / w.length;
  const atr = w.reduce((a, b) => a + (b.h - b.l), 0) / w.length;
  if (!(avgV > 0 && atr > 0) || k.v < 2 * avgV || (k.h - k.l) < 2 * atr || k.c === k.o) return null;
  const up = k.c > k.o;                                // spike up -> fade SHORT
  const entry = up ? k.c + 0.25 * atr : k.c - 0.25 * atr;
  const stop = up ? k.h + 0.2 * atr : k.l - 0.2 * atr;
  const risk = Math.abs(stop - entry);
  if (!(risk > 0)) return null;
  const passive = up ? entry > now.c : entry < now.c;  // must rest on the passive side
  if (!passive) return null;
  return {
    strategy: 'Spike Fade', direction: up ? 'SHORT' : 'LONG', orderType: 'limit', grade: '—', score: null,
    entry, stop, t1: up ? entry - risk : entry + risk,
    note: `Spike ${up ? 'up' : 'down'}: ${(k.v / avgV).toFixed(1)}x volume, ${((k.h - k.l) / atr).toFixed(1)}x range`,
  };
}

async function botScan() {
  const st = bot.settings;
  const now = Date.now();
  const evs = eventContext(await getEvents().catch(() => []));
  const working = () => bot.positions.length + bot.orders.filter((o) => o.status === 'open').length;
  const sleeveLoad = (k) => bot.positions.filter((p) => p.sleeve === k).length
    + new Set(bot.orders.filter((o) => o.status === 'open' && o.sleeve === k).map((o) => o.ocoId || o.id)).size;

  for (const m of BOT_UNIVERSE) {
    if (bot.orders.some((o) => o.sym === m.sym && o.status === 'open') || bot.positions.some((p) => p.sym === m.sym)) continue;
    if (bot.cooldowns[m.sym] && now < bot.cooldowns[m.sym]) continue;
    let c;
    try { c = await bybitKlines(m.sym, '5', 200); }
    catch (e) { botLog({ sym: m.label, action: 'error', reason: e.message }); continue; }
    if (c.length < 60 || now - c[c.length - 1].t > 15 * 60000) continue; // thin data / venue paused
    const a = analyzeScalp(m.label, m.cls === 'crypto' ? 'crypto' : 'commodity', c, { interval: '5m', ledgerKind: 'scalp' });
    const cands = [...(a?.candidates || [])];
    const sf = spikeFade(c); if (sf) cands.push(sf);
    if (!cands.length) continue;

    // One trade per market per scan. Sleeves with the fewest open trades go
    // first, so every strategy gets a fair share of opportunities.
    const options = cands.map((cd) => ({ cd, sleeve: sleeveOf(cd.strategy) }))
      .filter((x) => x.sleeve && st.sleeves[x.sleeve]?.on)
      .sort((x, y) => sleeveLoad(x.sleeve) - sleeveLoad(y.sleeve) || (y.cd.score || 0) - (x.cd.score || 0));
    let placed = false;
    for (const { cd: s, sleeve } of options) {
      if (placed) break;
      const base = { sym: m.label, strategy: s.strategy, dir: s.direction, grade: s.grade, sleeve };
      const bracket = s.direction === '2-WAY';
      const exec = bracket ? 'stop' : 'limit';
      const costR = tradeCostR(s.entry, s.stop, exec);
      if (sleeveLoad(sleeve) >= (st.sleeves[sleeve]?.max ?? 2)) { botLog({ ...base, action: 'skip', reason: `${BOT_SLEEVES[sleeve].label} sleeve is full` }); continue; }
      if (costR == null || costR >= st.maxCostR) { botLog({ ...base, action: 'skip', reason: `Costs ${costR == null ? '?' : costR.toFixed(2)}R on this stop — above the ${st.maxCostR}R limit, so it cannot make money even when right` }); continue; }
      if (evs.risk) { botLog({ ...base, action: 'skip', reason: `High-impact event within ${st.eventBlackoutMin} min: ${evs.riskEvent?.country || ''} ${evs.riskEvent?.title || ''}` }); break; }
      if (working() >= st.maxPositions) { botLog({ ...base, action: 'skip', reason: `At the ${st.maxPositions}-trade limit` }); break; }
      let inst;
      try { inst = await bybitInstrument(m.sym); } catch (e) { botLog({ ...base, action: 'error', reason: e.message }); break; }
      if (inst.status !== 'Trading') { botLog({ ...base, action: 'skip', reason: `Bybit status ${inst.status}` }); break; }

      const legs = bracket
        ? [{ side: 'LONG', entry: s.entry, target: s.t1 }, { side: 'SHORT', entry: s.entryShort, target: s.entryShort - (s.t1 - s.entry) }]
        : [{ side: s.direction, entry: s.entry, target: s.t1 }];
      const ocoId = bracket ? `oco-${bot.seq}` : null;
      const riskAmt = (bot.equity * st.riskPct) / 100;
      const made = [];
      for (const leg of legs) {
        const entry = roundTick(leg.entry, inst.tick), stop = roundTick(s.stop, inst.tick), target = roundTick(leg.target, inst.tick);
        const risk = Math.abs(entry - stop);
        if (!(risk > 0)) continue;
        const qty = +floorStep(riskAmt / risk, inst.qtyStep).toFixed(dp(inst.qtyStep));
        if (!(qty >= inst.minQty)) continue;
        made.push({
          id: bot.seq++, ocoId, sleeve, sym: m.sym, label: m.label, cls: m.cls, side: leg.side, qty, entry, stop, target,
          type: exec, strategy: s.strategy, grade: s.grade, costR: +costR.toFixed(3), riskAmt: +(risk * qty).toFixed(2),
          placedAt: now, expiresAt: now + st.entryWindowMin * 60000, status: 'open',
          // The forming 1m bar began BEFORE the order existed: only later bars can fill it.
          checkedTo: Math.ceil(now / 60000) * 60000,
        });
      }
      if (!made.length) { botLog({ ...base, action: 'skip', reason: `Size below Bybit's minimum ${inst.minQty} at ${st.riskPct}% risk` }); continue; }
      bot.orders.push(...made);
      placed = true;
      const o = made[0];
      botLog({ ...base, action: 'placed', reason: bracket
        ? `Bracket: buy stop ${made.find((x) => x.side === 'LONG')?.entry} / sell stop ${made.find((x) => x.side === 'SHORT')?.entry} · stop ${o.stop} · one cancels the other · costs ${costR.toFixed(2)}R`
        : `${o.side === 'LONG' ? 'Buy' : 'Sell'} limit ${o.qty} @ ${o.entry} · stop ${o.stop} · target ${o.target} · risk $${o.riskAmt} · costs ${costR.toFixed(2)}R` });
    }
  }
}

function botClose(p, exitPx, liquidity, reason, t) {
  const long = p.side === 'LONG';
  const exitFee = exitPx * p.qty * (liquidity === 'maker' ? FEE_MAKER : FEE_TAKER);
  const gross = (long ? exitPx - p.entry : p.entry - exitPx) * p.qty;
  bot.equity += gross - exitFee; // the entry fee was taken at fill
  const pnl = gross - p.entryFee - exitFee;
  const trade = {
    id: p.id, sym: p.sym, label: p.label, cls: p.cls, side: p.side, qty: p.qty, strategy: p.strategy, grade: p.grade, sleeve: p.sleeve,
    entry: p.entry, exit: +exitPx.toFixed(8), reason, pnl: +pnl.toFixed(4), fees: +(p.entryFee + exitFee).toFixed(4),
    r: +(pnl / p.riskAmt).toFixed(3), riskAmt: p.riskAmt, openedAt: p.openedAt, closedAt: t,
  };
  bot.trades.push(trade);
  p.closed = true;
  if (pnl < 0) bot.cooldowns[p.sym] = Date.now() + bot.settings.lossCooldownMin * 60000;
  botLog({ sym: p.label, strategy: p.strategy, dir: p.side, sleeve: p.sleeve, action: pnl >= 0 ? 'win' : 'loss',
    reason: `${reason}: ${p.side === 'LONG' ? 'sold' : 'bought back'} @ ${trade.exit} · ${pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.r >= 0 ? '+' : ''}${trade.r}R after $${trade.fees.toFixed(2)} fees)` });
}

async function botTick() {
  const now = Date.now();
  const st = bot.settings;
  const syms = [...new Set([...bot.orders.filter((o) => o.status === 'open').map((o) => o.sym), ...bot.positions.map((p) => p.sym)])];
  for (const sym of syms) {
    const from = Math.min(
      ...bot.orders.filter((o) => o.status === 'open' && o.sym === sym).map((o) => o.checkedTo),
      ...bot.positions.filter((p) => p.sym === sym).map((p) => p.checkedTo),
    );
    let bars;
    try { bars = await bybitKlines(sym, '1', 200, from); } catch { continue; }
    bars = bars.filter((b) => b.t >= from && b.t + 60000 <= now); // CLOSED 1m bars only

    for (const o of bot.orders.filter((x) => x.status === 'open' && x.sym === sym)) {
      for (const b of bars) {
        if (b.t < o.checkedTo) continue;
        if (b.t >= o.expiresAt) break;
        // A resting limit fills when price comes BACK to it (maker, no slippage);
        // a stop order fills when price crosses it (taker, and it slips).
        const isStop = o.type === 'stop';
        const touched = isStop
          ? (o.side === 'LONG' ? b.h >= o.entry : b.l <= o.entry)
          : (o.side === 'LONG' ? b.l <= o.entry : b.h >= o.entry);
        if (touched && o.status === 'open') {
          o.status = 'filled';
          const fillPx = isStop ? (o.side === 'LONG' ? o.entry * (1 + FEE_SLIP) : o.entry * (1 - FEE_SLIP)) : o.entry;
          const entryFee = fillPx * o.qty * (isStop ? FEE_TAKER : FEE_MAKER);
          bot.equity -= entryFee;
          bot.positions.push({ ...o, entry: fillPx, entryFee, openedAt: b.t, fillBarT: b.t, checkedTo: b.t }); // re-check the fill bar for the stop
          if (o.ocoId) for (const x of bot.orders) if (x.ocoId === o.ocoId && x.id !== o.id && x.status === 'open') x.status = 'cancelled';
          botLog({ sym: o.label, strategy: o.strategy, dir: o.side, sleeve: o.sleeve, action: 'filled',
            reason: `${isStop ? 'Stop' : 'Limit'} filled @ ${+fillPx.toFixed(8)}${o.ocoId ? ' — other side of the bracket cancelled' : ''}` });
          break;
        }
        o.checkedTo = b.t + 60000;
      }
      if (o.status === 'open' && now >= o.expiresAt) {
        o.status = 'expired';
        botLog({ sym: o.label, strategy: o.strategy, dir: o.side, action: 'expired', reason: `Price never came back to ${o.entry} within ${st.entryWindowMin} min — cancelled, no trade` });
      }
    }

    for (const p of bot.positions.filter((x) => x.sym === sym && !x.closed)) {
      const long = p.side === 'LONG';
      for (const b of bars) {
        if (b.t < p.checkedTo) continue;
        const hitS = long ? b.l <= p.stop : b.h >= p.stop;
        const hitT = long ? b.h >= p.target : b.l <= p.target;
        // Stop first: if one bar touched both we cannot know the order, so we
        // assume the worse one. A target inside the fill bar may have come BEFORE
        // the fill, so it only counts from the next bar.
        if (hitS) { botClose(p, long ? p.stop * (1 - FEE_SLIP) : p.stop * (1 + FEE_SLIP), 'taker', 'Stop hit', b.t); break; }
        if (hitT && b.t > p.fillBarT) { botClose(p, p.target, 'maker', 'Target hit', b.t); break; }
        p.checkedTo = b.t + 60000;
        if (b.t + 60000 - p.openedAt >= st.maxHoldMin * 60000) {
          botClose(p, long ? b.c * (1 - FEE_SLIP) : b.c * (1 + FEE_SLIP), 'taker', `Time exit after ${st.maxHoldMin} min`, b.t);
          break;
        }
      }
    }
  }
  bot.positions = bot.positions.filter((p) => !p.closed);
  bot.orders = bot.orders.filter((o) => o.status === 'open' || now - o.placedAt < 24 * 3600 * 1000).slice(-200);
  bot.trades = bot.trades.slice(-2000);
}

function botRollover() {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== bot.dayKey) { bot.dayKey = key; bot.dayStartEquity = bot.equity; bot.haltedUntil = null; }
  const dd = ((bot.equity - bot.dayStartEquity) / bot.dayStartEquity) * 100;
  if (!bot.haltedUntil && dd <= -bot.settings.dailyLossPct) {
    const mid = new Date(); mid.setUTCHours(24, 0, 0, 0);
    bot.haltedUntil = mid.getTime();
    for (const o of bot.orders) if (o.status === 'open') o.status = 'cancelled';
    botLog({ action: 'halt', reason: `Down ${dd.toFixed(2)}% today — daily loss limit of ${bot.settings.dailyLossPct}% reached. No new trades until 00:00 UTC; open positions keep their stops.` });
  }
}

async function botCycle(force = false) {
  if (botBusy) return;
  botBusy = true;
  try {
    botLoad();
    botRollover();
    // Open positions are managed even while stopped or halted — a stopped bot
    // must not leave paper positions frozen past their stops.
    if (bot.positions.length || bot.orders.some((o) => o.status === 'open')) await botTick();
    botRollover();
    const bucket = Math.floor(Date.now() / 300000);
    const halted = bot.haltedUntil && Date.now() < bot.haltedUntil;
    if (bot.enabled && !halted && (force || (bucket > bot.lastScanBucket && Date.now() - bucket * 300000 > 8000))) {
      bot.lastScanBucket = bucket;
      bot.lastScanAt = Date.now();
      await botScan();
    }
    botSave();
  } catch (e) {
    console.error('[bot]', e.message);
  } finally { botBusy = false; }
}

function botStats() {
  const t = bot.trades;
  const wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl <= 0);
  const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
  const gw = sum(wins, 'pnl'), gl = Math.abs(sum(losses, 'pnl'));
  const byMarket = {}, bySleeve = {};
  for (const x of t) {
    const m = byMarket[x.label] ||= { n: 0, wins: 0, pnl: 0, r: 0 };
    m.n++; if (x.pnl > 0) m.wins++; m.pnl += x.pnl; m.r += x.r;
    const sl = bySleeve[x.sleeve || 'trend'] ||= { n: 0, wins: 0, pnl: 0, r: 0, fees: 0 };
    sl.n++; if (x.pnl > 0) sl.wins++; sl.pnl += x.pnl; sl.r += x.r; sl.fees += x.fees;
  }
  const unreal = 0;
  return {
    n: t.length, wins: wins.length, hitRate: t.length ? +((wins.length / t.length) * 100).toFixed(1) : null,
    netPnl: +(bot.equity - bot.settings.startEquity).toFixed(2), realized: +sum(t, 'pnl').toFixed(2),
    fees: +sum(t, 'fees').toFixed(2), avgR: t.length ? +(sum(t, 'r') / t.length).toFixed(3) : null,
    profitFactor: gl ? +(gw / gl).toFixed(2) : null, enough: t.length >= 20, unreal,
    byMarket: Object.entries(byMarket).map(([k, v]) => ({ market: k, n: v.n, hitRate: +((v.wins / v.n) * 100).toFixed(0), pnl: +v.pnl.toFixed(2), avgR: +(v.r / v.n).toFixed(3) }))
      .sort((a, b) => b.pnl - a.pnl),
    // Each strategy judged on its own record — the point of running sleeves.
    bySleeve: Object.keys(BOT_SLEEVES).map((k) => {
      const v = bySleeve[k] || { n: 0, wins: 0, pnl: 0, r: 0, fees: 0 };
      return { sleeve: k, label: BOT_SLEEVES[k].label, n: v.n, hitRate: v.n ? +((v.wins / v.n) * 100).toFixed(0) : null,
        pnl: +v.pnl.toFixed(2), fees: +v.fees.toFixed(2), avgR: v.n ? +(v.r / v.n).toFixed(3) : null, enough: v.n >= 20 };
    }),
    exits: ['Target hit', 'Stop hit'].map((r) => ({ reason: r, n: t.filter((x) => x.reason === r).length }))
      .concat([{ reason: 'Time exit', n: t.filter((x) => x.reason.startsWith('Time exit')).length }]),
  };
}

// ---- Paper execution desk -------------------------------------------------
// A simulated broker that routes orders against LIVE Bybit prices. Same order
// tickets, fills, slippage, stops and P&L accounting as the real thing, with no
// real money at risk — so the strategy can be proven before any capital is
// committed. Chosen deliberately: as of 25 Sep the app's own ledger shows 1,666
// resolved signals at 42.2%, with every strategy below its breakeven. Wiring
// capital to that would be expected to lose, not merely risk, money.
//
// Written so the execution layer can later be pointed at the real Bybit API by
// swapping placeOrder()'s body — the surrounding position/P&L logic is identical.
const PAPER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'paper.json');
const PAPER_START = 10000; // USDT of notional starting equity
let paper = null;

async function loadPaper() {
  if (paper) return paper;
  try {
    paper = JSON.parse(await fs.promises.readFile(PAPER_FILE, 'utf8'));
  } catch {
    paper = { startedAt: Date.now(), cash: PAPER_START, orders: [], positions: [], trades: [], seq: 1 };
  }
  return paper;
}
async function savePaper() {
  await fs.promises.mkdir(path.dirname(PAPER_FILE), { recursive: true });
  await fs.promises.writeFile(PAPER_FILE, JSON.stringify(paper, null, 2));
}

// Live mark price from Bybit's public tickers — keyless, no account needed.
async function markPrice(symbol) {
  return cached(`mark:${symbol}`, async () => {
    const r = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`);
    const t = (r?.result?.list || [])[0];
    if (!t) throw new Error(`No Bybit market for ${symbol}`);
    return { last: parseFloat(t.lastPrice), bid: parseFloat(t.bid1Price), ask: parseFloat(t.ask1Price) };
  }, 5 * 1000);
}

// Crossing the spread costs money, and pretending otherwise is the single
// biggest way paper results flatter a strategy. Market orders pay the far side
// plus a slippage allowance, and every fill is charged Bybit's taker fee.
const TAKER_FEE = 0.00055;
const SLIP = 0.0002;

async function paperPlace(o) {
  await loadPaper();
  const symbol = String(o.symbol || '').toUpperCase().trim();
  const side = String(o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const qty = Number(o.qty);
  const type = String(o.type || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  if (!symbol) throw new Error('Symbol is required');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be a positive number');
  const mk = await markPrice(symbol); // also validates the symbol exists
  if (type === 'LIMIT' && !(Number(o.price) > 0)) throw new Error('A limit order needs a price');

  const order = {
    id: paper.seq++, symbol, side, type, qty,
    limitPrice: type === 'LIMIT' ? Number(o.price) : null,
    stopLoss: Number(o.stopLoss) > 0 ? Number(o.stopLoss) : null,
    takeProfit: Number(o.takeProfit) > 0 ? Number(o.takeProfit) : null,
    status: 'open', placedAt: Date.now(), note: (o.note || '').slice(0, 120),
    // Optional good-til-time. The 5m limit policy cancels an unfilled entry
    // after its window rather than letting it rest indefinitely.
    expiresAt: type === 'LIMIT' && Number(o.expiresInMin) > 0 ? Date.now() + Number(o.expiresInMin) * 60000 : null,
  };
  if (type === 'MARKET') fillOrder(order, side === 'BUY' ? mk.ask * (1 + SLIP) : mk.bid * (1 - SLIP));
  else if (type === 'LIMIT') {
    // A limit priced through the book is not a resting order: an exchange fills
    // it immediately against the opposite side, as a TAKER. Treating it as a
    // maker fill would hand out the fee saving exactly where it isn't earned.
    const marketable = side === 'BUY' ? order.limitPrice >= mk.ask : order.limitPrice <= mk.bid;
    if (marketable) {
      fillOrder(order, side === 'BUY' ? mk.ask * (1 + SLIP) : mk.bid * (1 - SLIP), 'taker');
      order.note = `${order.note || ''} — limit was marketable on placement, so it filled immediately as taker`.trim();
    }
  }
  paper.orders.push(order);
  await savePaper();
  return order;
}

// liquidity: 'maker' for a resting limit or a limit take-profit (no slippage,
// maker fee); 'taker' for anything that crosses the book. Matches the per-leg
// model the ledger uses, so paper results and ledger results agree on costs.
function fillOrder(order, price, liquidity = 'taker') {
  order.status = 'filled';
  order.fillPrice = +price.toFixed(8);
  order.filledAt = Date.now();
  order.liquidity = liquidity;
  order.fee = +(price * order.qty * (liquidity === 'maker' ? FEE_MAKER : TAKER_FEE)).toFixed(4);

  const dir = order.side === 'BUY' ? 1 : -1;
  let pos = paper.positions.find((p) => p.symbol === order.symbol);
  if (!pos) {
    pos = { symbol: order.symbol, qty: 0, avgEntry: 0, realised: 0, fees: 0, openedAt: Date.now() };
    paper.positions.push(pos);
  }
  const newQty = pos.qty + dir * order.qty;
  // Reducing or flipping: bank the realised P&L on the closed portion.
  if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(newQty) || (pos.qty !== 0 && Math.abs(newQty) < Math.abs(pos.qty))) {
    const closedQty = Math.min(Math.abs(order.qty), Math.abs(pos.qty));
    const pnl = (price - pos.avgEntry) * closedQty * Math.sign(pos.qty);
    pos.realised += pnl;
    paper.cash += pnl;
    paper.trades.push({
      symbol: pos.symbol, side: pos.qty > 0 ? 'LONG' : 'SHORT', qty: closedQty,
      entry: +pos.avgEntry.toFixed(8), exit: +price.toFixed(8),
      pnl: +pnl.toFixed(4), fee: order.fee, closedAt: Date.now(), orderId: order.id,
    });
  } else if (newQty !== 0) {
    // Opening or adding: blend the average entry.
    pos.avgEntry = pos.qty === 0 ? price
      : (pos.avgEntry * Math.abs(pos.qty) + price * order.qty) / (Math.abs(pos.qty) + order.qty);
  }
  pos.qty = +newQty.toFixed(8);
  pos.fees += order.fee;
  paper.cash -= order.fee;
  if (Math.abs(pos.qty) < 1e-12) paper.positions = paper.positions.filter((p) => p !== pos);
  else if (order.stopLoss || order.takeProfit) {
    if (order.stopLoss) pos.stopLoss = order.stopLoss;
    if (order.takeProfit) pos.takeProfit = order.takeProfit;
  }
}

// Advance the simulation: rest limit orders until touched, and honour stops.
async function paperTick() {
  await loadPaper();
  let changed = false;
  const symbols = [...new Set([
    ...paper.orders.filter((o) => o.status === 'open' && o.type === 'LIMIT').map((o) => o.symbol),
    ...paper.positions.map((p) => p.symbol),
  ])];
  const marks = {};
  await Promise.all(symbols.map(async (sym) => { marks[sym] = await markPrice(sym).catch(() => null); }));

  for (const o of paper.orders) {
    if (o.status !== 'open' || o.type !== 'LIMIT') continue;
    if (o.expiresAt && Date.now() > o.expiresAt) {
      o.status = 'expired'; o.note = `${o.note || ''} — cancelled unfilled after its window`.trim();
      changed = true; continue;
    }
    const m = marks[o.symbol]; if (!m) continue;
    const touched = o.side === 'BUY' ? m.last <= o.limitPrice : m.last >= o.limitPrice;
    if (touched) { fillOrder(o, o.limitPrice, 'maker'); changed = true; }
  }
  for (const pos of [...paper.positions]) {
    const m = marks[pos.symbol]; if (!m) continue;
    const long = pos.qty > 0;
    const hitSL = pos.stopLoss && (long ? m.last <= pos.stopLoss : m.last >= pos.stopLoss);
    const hitTP = pos.takeProfit && (long ? m.last >= pos.takeProfit : m.last <= pos.takeProfit);
    if (hitSL || hitTP) {
      // Stop checked first: if one tick satisfies both, assume the worse outcome.
      // A stop-loss triggers a market order and slips past the level; a take-
      // profit is a resting limit that fills exactly at it.
      const exitPx = hitSL
        ? (long ? pos.stopLoss * (1 - SLIP) : pos.stopLoss * (1 + SLIP))
        : pos.takeProfit;
      const closer = { id: paper.seq++, symbol: pos.symbol, side: long ? 'SELL' : 'BUY', type: 'MARKET',
        qty: Math.abs(pos.qty), status: 'open', placedAt: Date.now(), note: hitSL ? 'stop loss' : 'take profit' };
      fillOrder(closer, exitPx, hitSL ? 'taker' : 'maker');
      paper.orders.push(closer);
      changed = true;
    }
  }
  if (changed) await savePaper();
  return marks;
}

async function paperClose(symbol) {
  await loadPaper();
  const pos = paper.positions.find((p) => p.symbol === symbol);
  if (!pos) throw new Error(`No open paper position in ${symbol}`);
  const mk = await markPrice(symbol);
  const long = pos.qty > 0;
  const o = { id: paper.seq++, symbol, side: long ? 'SELL' : 'BUY', type: 'MARKET',
    qty: Math.abs(pos.qty), status: 'open', placedAt: Date.now(), note: 'manual close' };
  fillOrder(o, long ? mk.bid * (1 - SLIP) : mk.ask * (1 + SLIP));
  paper.orders.push(o);
  await savePaper();
  return o;
}

async function paperState() {
  await loadPaper();
  const marks = await paperTick();
  let unreal = 0;
  const positions = paper.positions.map((p) => {
    const m = marks[p.symbol];
    const last = m ? m.last : p.avgEntry;
    const pnl = (last - p.avgEntry) * p.qty;
    unreal += pnl;
    return { ...p, mark: last, unrealised: +pnl.toFixed(4),
      pnlPct: p.avgEntry ? +(((last - p.avgEntry) / p.avgEntry) * 100 * Math.sign(p.qty)).toFixed(3) : 0,
      notional: +(Math.abs(p.qty) * last).toFixed(2) };
  });
  const t = paper.trades;
  const wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl < 0);
  const gw = wins.reduce((a, b) => a + b.pnl, 0), gl = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  const avgW = wins.length ? gw / wins.length : 0, avgL = losses.length ? gl / losses.length : 0;
  return {
    startedAt: paper.startedAt, cash: +paper.cash.toFixed(2),
    equity: +(paper.cash + unreal).toFixed(2), startEquity: PAPER_START,
    unrealised: +unreal.toFixed(4),
    positions,
    openOrders: paper.orders.filter((o) => o.status === 'open'),
    trades: t.slice(-40).reverse(),
    stats: t.length ? {
      n: t.length,
      hitRate: +((wins.length / t.length) * 100).toFixed(1),
      netPnl: +(gw - gl).toFixed(2),
      fees: +paper.orders.reduce((a, b) => a + (b.fee || 0), 0).toFixed(2),
      profitFactor: gl ? +(gw / gl).toFixed(2) : null,
      avgWin: +avgW.toFixed(2), avgLoss: +avgL.toFixed(2),
      expectancyR: avgL ? +(((wins.length / t.length) * avgW - (losses.length / t.length) * avgL) / avgL).toFixed(3) : null,
      enough: t.length >= 20,
    } : null,
    fees: { taker: TAKER_FEE, slippage: SLIP },
    note: 'SIMULATED. Orders fill against live Bybit prices with spread, slippage and taker fees applied. No real funds move and no Bybit order endpoint is ever called.',
  };
}

// ---- Bybit account desk --------------------------------------------------
// READ-ONLY by design. Every path below is a GET against Bybit's query
// endpoints; nothing here can place, amend or cancel an order, and no
// order-entry endpoint is implemented. The app has always been no-custody and
// this section keeps that property.
const BYBIT_HOST = () => (SECRETS.BYBIT_ENV === 'testnet'
  ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com');

// Bybit V5 auth: HMAC-SHA256 over (timestamp + apiKey + recvWindow + queryString).
function bybitSign(ts, recv, qs) {
  return crypto.createHmac('sha256', SECRETS.BYBIT_SECRET)
    .update(ts + SECRETS.BYBIT_KEY + recv + qs).digest('hex');
}

// Turns Bybit's numeric retCodes into something a human can act on. Learned
// this the hard way with the Telegram bot: a raw upstream code tells the user
// nothing about what to actually change.
function bybitHint(code, msg) {
  const map = {
    10010: 'This API key is restricted to specific IP addresses and this machine is not one of them. In Bybit → Profile → API → edit the key → add this machine\'s PUBLIC IP to the bound IP list. Note a home IP usually changes over time, so this can need re-doing.',
    10003: 'API key is invalid, or it belongs to the other environment (mainnet key used against testnet, or vice versa). Check BYBIT_ENV in .env.',
    10004: 'Signature mismatch. Usually the secret is wrong or has trailing whitespace in .env.',
    10005: 'This key lacks permission for that endpoint. A read-only key needs at least "Read" on Wallet, Positions and Orders.',
    10016: 'Bybit reports a server-side error or maintenance. Nothing to fix locally — retry shortly.',
    10018: 'Request rate limit exceeded. The desk caches for 30s; give it a moment.',
    33004: 'This API key has expired. Bybit expires keys that are not bound to an IP after ~90 days — create a new one and update .env.',
  };
  return map[code] || (msg ? `Bybit says: ${msg}` : null);
}

async function bybitGet(pathname, params = {}) {
  if (!SECRETS.BYBIT_KEY || !SECRETS.BYBIT_SECRET) {
    const e = new Error('No Bybit credentials configured — add BYBIT_KEY and BYBIT_SECRET to .env');
    e.hint = 'Create a READ-ONLY key in Bybit → Profile → API, then put it in .env beside server.js.';
    throw e;
  }
  const qs = new URLSearchParams(params).toString();
  const ts = Date.now().toString();
  const recv = '5000';
  const url = `${BYBIT_HOST()}${pathname}${qs ? `?${qs}` : ''}`;
  const r = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': SECRETS.BYBIT_KEY,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': bybitSign(ts, recv, qs),
    },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Bybit returned a non-JSON response (HTTP ${r.status})`);
  if (j.retCode !== 0) {
    const e = new Error(j.retMsg || `Bybit error ${j.retCode}`);
    e.code = j.retCode;
    e.hint = bybitHint(j.retCode, j.retMsg);
    throw e;
  }
  return j.result;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

async function getBybitAccount() {
  return cached('bybit:account', async () => {
    // Each call is independent so one permission gap does not blank the desk.
    const [wallet, positions, closed, executions] = await Promise.all([
      bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }).catch((e) => ({ __err: e })),
      bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 50 }).catch((e) => ({ __err: e })),
      bybitGet('/v5/position/closed-pnl', { category: 'linear', limit: 100 }).catch((e) => ({ __err: e })),
      bybitGet('/v5/execution/list', { category: 'linear', limit: 50 }).catch((e) => ({ __err: e })),
    ]);
    const firstErr = [wallet, positions, closed, executions].find((x) => x && x.__err);
    if (firstErr && wallet.__err) {
      const e = firstErr.__err;
      return { ok: false, error: e.message, code: e.code || null, hint: e.hint || null };
    }

    const acct = wallet.__err ? null : (wallet.list || [])[0];
    const balance = acct ? {
      equity: num(acct.totalEquity),
      available: num(acct.totalAvailableBalance),
      walletBalance: num(acct.totalWalletBalance),
      unrealisedPnl: num(acct.totalPerpUPL),
      marginUsed: num(acct.totalInitialMargin),
      maintMargin: num(acct.totalMaintenanceMargin),
      marginRatio: num(acct.accountMMRate) * 100,
      coins: (acct.coin || []).filter((c) => num(c.walletBalance) > 0).map((c) => ({
        coin: c.coin, balance: num(c.walletBalance), usd: num(c.usdValue), pnl: num(c.unrealisedPnl),
      })).sort((a, b) => b.usd - a.usd),
    } : null;

    const open = positions.__err ? [] : (positions.list || [])
      .filter((p) => num(p.size) > 0)
      .map((p) => {
        const entry = num(p.avgPrice), mark = num(p.markPrice), sizeUsd = num(p.positionValue);
        const long = p.side === 'Buy';
        return {
          symbol: p.symbol, side: long ? 'LONG' : 'SHORT', size: num(p.size), sizeUsd,
          entry, mark, leverage: num(p.leverage),
          liq: num(p.liqPrice) || null,
          unrealised: num(p.unrealisedPnl),
          pnlPct: entry ? ((mark - entry) / entry) * 100 * (long ? 1 : -1) : 0,
          stopLoss: num(p.stopLoss) || null, takeProfit: num(p.takeProfit) || null,
          // Distance to liquidation as a share of current price — the number that
          // actually matters when a position is leveraged.
          liqDistPct: num(p.liqPrice) && mark ? Math.abs((num(p.liqPrice) - mark) / mark) * 100 : null,
          margin: num(p.positionIM),
        };
      }).sort((a, b) => Math.abs(b.sizeUsd) - Math.abs(a.sizeUsd));

    const trades = closed.__err ? [] : (closed.list || []).map((t) => ({
      symbol: t.symbol, side: t.side === 'Buy' ? 'SHORT' : 'LONG', // closing side is the inverse
      pnl: num(t.closedPnl), entry: num(t.avgEntryPrice), exit: num(t.avgExitPrice),
      qty: num(t.qty), leverage: num(t.leverage), closedAt: +t.updatedTime,
    })).sort((a, b) => b.closedAt - a.closedAt);

    // Measured performance — the same honesty the rest of the app applies to
    // its own signals, turned on the account itself.
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
    const sum = (a) => a.reduce((x, y) => x + y.pnl, 0);
    const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
    const stats = trades.length ? {
      n: trades.length,
      hitRate: +((wins.length / (wins.length + losses.length || 1)) * 100).toFixed(1),
      netPnl: +(grossWin - grossLoss).toFixed(2),
      grossWin: +grossWin.toFixed(2), grossLoss: +grossLoss.toFixed(2),
      avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
      avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
      profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
      // Expectancy per trade in R, using the account's own average win/loss.
      expectancyR: (wins.length && losses.length)
        ? +(((wins.length / trades.length) * (grossWin / wins.length)
          - (losses.length / trades.length) * (grossLoss / losses.length)) / (grossLoss / losses.length)).toFixed(3)
        : null,
      best: trades.reduce((a, b) => (b.pnl > (a?.pnl ?? -Infinity) ? b : a), null),
      worst: trades.reduce((a, b) => (b.pnl < (a?.pnl ?? Infinity) ? b : a), null),
      window: trades.length ? { from: trades.at(-1).closedAt, to: trades[0].closedAt } : null,
    } : null;

    const fills = executions.__err ? [] : (executions.list || []).map((e) => ({
      symbol: e.symbol, side: e.side === 'Buy' ? 'BUY' : 'SELL', qty: num(e.execQty),
      price: num(e.execPrice), fee: num(e.execFee), time: +e.execTime, type: e.execType,
    })).sort((a, b) => b.time - a.time).slice(0, 25);

    return {
      ok: true, env: SECRETS.BYBIT_ENV === 'testnet' ? 'testnet' : 'mainnet',
      balance, positions: open, trades: trades.slice(0, 25), stats, fills,
      partial: [wallet, positions, closed, executions]
        .map((x, i) => (x && x.__err ? ['wallet', 'positions', 'closedPnl', 'executions'][i] : null))
        .filter(Boolean),
      readOnlyNote: 'This desk only reads. No order-placement endpoint exists in this app.',
    };
  }, 30 * 1000);
}

async function getPositioning(symbol) {
  return cached(`pos:${symbol}`, async () => {
    const [crowd, top] = await Promise.all([
      fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}USDT&period=1h&limit=12`),
      fetchJson(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol}USDT&period=1h&limit=12`),
    ]);
    if (!Array.isArray(crowd) || !crowd.length || !Array.isArray(top) || !top.length) throw new Error('no positioning data');
    const c = parseFloat(crowd.at(-1).longShortRatio);
    const t = parseFloat(top.at(-1).longShortRatio);
    const c0 = parseFloat(crowd[0].longShortRatio);
    const longPct = parseFloat(crowd.at(-1).longAccount) * 100;
    return {
      crowd: +c.toFixed(2), top: +t.toFixed(2), longPct: +longPct.toFixed(1),
      divergence: +(t - c).toFixed(2),
      trend12h: +(c - c0).toFixed(2),
      state: c >= 2 ? 'crowd heavily long' : c <= 0.75 ? 'crowd heavily short' : 'balanced',
    };
  }, 10 * 60 * 1000);
}

async function getFunding(symbol) {
  return cached(`funding:${symbol}`, async () => {
    const d = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}USDT`);
    const rate = parseFloat(d.lastFundingRate);
    if (isNaN(rate)) throw new Error('no funding');
    return {
      ratePct: +(rate * 100).toFixed(4),
      annualizedPct: +(rate * 3 * 365 * 100).toFixed(1),
      nextFundingTime: d.nextFundingTime,
      state: Math.abs(rate) > 0.0005 ? (rate > 0 ? 'crowded long' : 'crowded short') : 'neutral',
    };
  }, 60 * 1000);
}

// Confluence grading — turns a raw trigger into an accuracy-scored setup.
// Each factor that confirms the trade adds points; the total maps to A–D.
function gradeSetup(type, dir, f) {
  const factors = [];
  let score = 34; // base for a structurally valid, correctly-placed trigger
  // Each factor carries a stable key so outcomes can be attributed to it later.
  // Labels embed live numbers ("R:R 2.1:1") and are useless for grouping.
  const add = (k, label, ok, pts) => { factors.push({ k, label, ok, pts }); if (ok) score += pts; };

  add('rr', `Reward:risk ≥ 2 (${f.rr}:1)`, f.rr >= 2, 12);
  add('atr', `Tradeable volatility (ATR ${f.atrPct.toFixed(2)}%)`, f.atrPct >= 0.04 && f.atrPct <= 3.5, 8);

  if (type === 'revert') {
    const ext = f.rsi == null ? false : dir === 'LONG' ? f.rsi < 30 : f.rsi > 70;
    add('rsiExt', `RSI at extreme (${f.rsi == null ? '—' : f.rsi.toFixed(0)})`, ext, 24);
    add('climaxVol', `Climax volume (RVOL ${f.rvol.toFixed(1)}×)`, f.rvol >= 1.1, 12);
    add('adxRange', `Range / weak trend (ADX ${f.adx ?? '—'})`, f.adx != null && f.adx < 25, 10);
  } else {
    const aligned = dir === 'LONG' ? f.trendUp : dir === 'SHORT' ? f.trendDn : (f.trendUp || f.trendDn);
    add('trend', 'Trend-aligned (EMA stack + VWAP side)', aligned, 16);
    // Volume surge was worth 14, trimmed to 10 on 15 Aug on the theory that a
    // surge at an extended price is climax rather than confirmation. The factor
    // instrumentation added 8 Sep settled it with measurement: over 189 resolved
    // signals, setups WITH the surge hit 29.1% and those without hit 49.1% — a
    // -20 point lift. It survives every control (crypto -33.4, non-crypto -15.5,
    // within EMA Pullback alone -26.0) and is not a composition artefact (the
    // crypto share is 25% when it fires vs 28% when it does not). It was never
    // confirmation; it was a warning sign being paid a bonus. Weight removed.
    // Still surfaced as context so the read is visible, just not rewarded.
    add('volSurge', `Volume surge (RVOL ${f.rvol.toFixed(1)}×) — no measured edge`, f.rvol >= 1.3, 0);
    const rsiOk = f.rsi == null ? false : dir === 'SHORT' ? (f.rsi > 18 && f.rsi < 55) : (f.rsi > 45 && f.rsi < 82);
    add('rsiMom', `Momentum RSI (${f.rsi == null ? '—' : f.rsi.toFixed(0)})`, rsiOk, 9);
    add('adxStrong', `Trend strength (ADX ${f.adx ?? '—'})`, f.adx != null && f.adx >= 22, 9);
    const macdOk = f.macdHist == null ? false : dir === 'SHORT' ? f.macdHist < 0 : dir === 'LONG' ? f.macdHist > 0 : true;
    // MACD alignment measured -14.3 overall, but the effect attenuates under
    // control (crypto -24.9, non-crypto -10.4, within EMA Pullback only -5.9),
    // so it is halved rather than removed — the evidence is consistent in sign
    // but not strong enough to justify zeroing a factor outright.
    add('macd', 'MACD momentum aligned', macdOk, 4);
  }
  // Clamp the confluence total BEFORE any penalty, otherwise a setup that
  // over-scores to 106 simply absorbs the deduction and still grades A.
  score = Math.min(100, score);

  // Chasing penalty. Measured 2026-08-15: grades were INVERTED — A hit 27.8%
  // over 144 trades while C hit 53.8%. Cause: every trend factor rewards
  // momentum, so a "perfect" score described a maximally extended move — the
  // end of the impulse. Distance from EMA9 in ATR is the chase measure.
  if (type !== 'revert' && f.extAtr != null && Math.abs(f.extAtr) > 1.2) {
    const pen = Math.min(40, Math.round((Math.abs(f.extAtr) - 1.2) * 18));
    score -= pen;
    factors.push({ k: 'chase', label: `Extended ${Math.abs(f.extAtr).toFixed(1)}×ATR from EMA9 — chasing (−${pen})`, ok: false, pts: -pen });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 80 ? 'A' : score >= 68 ? 'B' : score >= 56 ? 'C' : 'D';
  // extAtr travels with the grade so each recorded signal can be attributed to
  // how extended it was at entry — the term this grader has repeatedly got wrong.
  return { score, grade, factors, extAtr: f.extAtr == null ? null : +f.extAtr.toFixed(2) };
}

// ---- Live read: what a market is doing RIGHT NOW (descriptive) -----------
// Deliberately NOT a forecast. Measured 30 Sep on 7,739 crypto 5m bars: every
// real-time signal we can compute — last-bar momentum (49.2%), 15-min momentum
// (49.0%), taker order flow (48.7%), strong flow (49.1%), momentum and flow
// agreeing (48.2%) — calls the NEXT 5 minutes no better than a coin flip. So
// this reports the present, labelled as the present. directionStats() keeps
// that measurement live instead of hard-coding it.
function liveRead(c, meta) {
  if (!c || c.length < 25) return null;
  const n = c.length, now = c[n - 1], closed = c[n - 2];
  const hist = c.slice(n - 22, n - 2);                       // 20 closed bars of context
  const atr = hist.reduce((a, b) => a + (b.h - b.l), 0) / hist.length || 1e-9;
  const avgV = hist.reduce((a, b) => a + (b.v || 0), 0) / hist.length || 0;
  const barMove = now.c - now.o;                              // this 5-min bar so far
  const move15 = now.c - c[n - 4].c;                          // ~last 15 minutes
  const barAtr = barMove / atr, m15Atr = move15 / atr;
  // Rising/falling means moving by a meaningful slice of this market's own
  // normal range, so the words carry the same weight on BTC as on copper.
  const state = m15Atr >= 0.3 ? 'RISING' : m15Atr <= -0.3 ? 'FALLING' : 'FLAT';
  const turning = (state === 'RISING' && barAtr <= -0.3) || (state === 'FALLING' && barAtr >= 0.3);
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
  const out = {
    state, turning,
    bar: { pct: +pct(now.c, now.o).toFixed(3), atr: +barAtr.toFixed(2) },
    m15: { pct: +pct(now.c, c[n - 4].c).toFixed(3), atr: +m15Atr.toFixed(2) },
    events: [],
  };
  // Order flow — crypto only (taker-buy volume comes from Binance).
  if (Number.isFinite(now.tb) && now.v > 0) {
    out.flow = { buyPct: +((now.tb / now.v) * 100).toFixed(0),
      prevBuyPct: closed.v > 0 && Number.isFinite(closed.tb) ? +((closed.tb / closed.v) * 100).toFixed(0) : null };
    if (now.v > 0.5 * avgV && (out.flow.buyPct >= 70 || out.flow.buyPct <= 30)) {
      out.events.push({ type: 'flow', dir: out.flow.buyPct >= 70 ? 'up' : 'down',
        text: `${out.flow.buyPct}% of this bar is aggressive ${out.flow.buyPct >= 70 ? 'buying' : 'selling'}`,
        odds: 'One-sided flow called the next 5 min 49% of the time — it tells you who is pushing now, not what happens next.' });
    }
  }
  // Spike: the last CLOSED bar on double volume and double range.
  if (avgV > 0 && closed.v > 2 * avgV && (closed.h - closed.l) > 2 * atr && closed.c !== closed.o) {
    const up = closed.c > closed.o;
    out.events.push({ type: 'spike', dir: up ? 'up' : 'down',
      text: `Spike ${up ? 'up' : 'down'}: ${(closed.v / avgV).toFixed(1)}× volume, ${((closed.h - closed.l) / atr).toFixed(1)}× range`,
      odds: 'After spikes like this the next 5 min REVERSED 56% of the time (249 cases, 5 of 8 coins) — a weak lean toward a pullback, not a reliable signal.' });
  }
  // Volume surge in the bar that is still forming, projected to a full bar.
  const tfMs = 5 * 60000;
  const progress = Math.min(1, Math.max(0.15, (Date.now() - now.t) / tfMs));
  if (avgV > 0 && now.v / progress > 3 * avgV) {
    out.events.push({ type: 'surge', dir: barMove >= 0 ? 'up' : 'down',
      text: `Volume surging: on pace for ${(now.v / progress / avgV).toFixed(1)}× a normal bar`,
      odds: 'Heavy volume shows attention, not direction.' });
  }
  if (turning) out.events.push({ type: 'turn', dir: barAtr > 0 ? 'up' : 'down',
    text: `Turning: the current bar is moving against the last 15 minutes`, odds: null });
  return out;
}

// Live measurement of whether any of this predicts the next 5 minutes, re-run
// on the latest crypto bars so the figure shown is current, not a claim frozen
// at the time it was written.
async function directionStats() {
  return cached('direction-stats', async () => {
    const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'AVAX', 'LINK'];
    const T = { mom: [0, 0], flow: [0, 0], spike: [0, 0] }; // [right, calls]
    for (const sym of syms) {
      let k;
      try { k = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=5m&limit=1000`); }
      catch { continue; }
      const b = k.slice(0, -1).map((x) => ({ o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], tb: +x[9] }));
      for (let i = 20; i < b.length - 1; i++) {
        const nxt = b[i + 1].c - b[i + 1].o; if (!nxt) continue;
        const up = nxt > 0;
        const m = b[i].c > b[i].o ? 1 : -1;
        T.mom[1]++; if ((m > 0) === up) T.mom[0]++;
        const f = b[i].v > 0 ? b[i].tb / b[i].v : 0.5;
        if (f > 0.55 || f < 0.45) { T.flow[1]++; if ((f > 0.55) === up) T.flow[0]++; }
        const w = b.slice(i - 20, i);
        const avgV = w.reduce((a, x) => a + x.v, 0) / 20, ar = w.reduce((a, x) => a + (x.h - x.l), 0) / 20;
        if (b[i].v > 2 * avgV && (b[i].h - b[i].l) > 2 * ar && b[i].c !== b[i].o) {
          T.spike[1]++; if ((b[i].c > b[i].o) !== up) T.spike[0]++;   // counts REVERSALS
        }
      }
    }
    const pct = ([r, n]) => (n ? +((r / n) * 100).toFixed(1) : null);
    return {
      momentumRight: pct(T.mom), momentumCalls: T.mom[1],
      flowRight: pct(T.flow), flowCalls: T.flow[1],
      spikeReversed: pct(T.spike), spikeCount: T.spike[1],
      verdict: 'No real-time signal calls the next 5 minutes better than a coin flip. The Now column shows what IS happening; it is not a prediction.',
      measuredAt: Date.now(),
    };
  }, 30 * 60 * 1000);
}

// Evaluates six scalping strategies on the given candles (any timeframe),
// grades each by confluence, and surfaces the single highest-accuracy setup.
function analyzeScalp(symbol, kind, c, opts = {}) {
  const interval = opts.interval || '5m';
  if (c.length < 60) return null;
  const closes = c.map((x) => x.c);
  const ema9 = emaArr(closes, 9), ema21 = emaArr(closes, 21), ema50 = emaArr(closes, 50);
  const rsi14 = rsiArr(closes, 14), atr14 = atrArr(c, 14);
  const i = c.length - 1, last = c[i], prev = c[i - 1];
  const atr = atr14[i], vwap = sessionVwap(c);
  const volSma = c.slice(-23, -3).reduce((s, x) => s + (x.v || 0), 0) / 20;
  const rvol = volSma ? (c.slice(-3).reduce((s, x) => s + (x.v || 0), 0) / 3) / volSma : 1;
  const atrPct = (atr / last.c) * 100;
  const rsi = rsi14[i];
  const trendUp = ema9[i] > ema21[i] && last.c > vwap;
  const trendDn = ema9[i] < ema21[i] && last.c < vwap;
  const indicators = computeIndicators(c, interval);
  const buf = 0.1 * atr;
  const r2 = (n) => parseFloat(n.toPrecision(5));
  const tfMin = TF_MIN[interval] || 5;
  const coilBars = interval === '1m' ? 15 : 12;
  const coilLabel = `${coilBars * tfMin}-min`;
  const win = c.slice(-(coilBars + 1), -1);
  const hh = Math.max(...win.map((x) => x.h));
  const ll = Math.min(...win.map((x) => x.l));

  const cand = [];

  // 1) EMA 9/21 pullback — trend continuation.
  // Measured 2026-08-20 over 2,020 backfilled trades: 43.5% against a 1:1
  // target, i.e. -0.13R and genuinely losing. The confluence score turned out
  // to carry no information at all (42.8/43.7/43.3% across score bands), but
  // two conditions did: relative volume was cleanly monotonic (41.3% at
  // RVOL<0.8 rising to 48.0% above 1.8) and ADX had dead zones at both ends
  // (37.5% below 15, 40.8% above 30 — no trend, or a trend already spent).
  // Gate on the two that actually discriminate.
  // Scoped to crypto (24 Aug). These thresholds came from the backfill, which
  // can only replay the 8 Binance symbols — non-crypto markets have no deep
  // intraday history. Applying a crypto-derived filter to stocks, metals and
  // commodities was unjustified extrapolation, and the live ledger shows the
  // cost: ungated, non-crypto EMA Pullback ran 61.1% / +0.219R over 131 trades
  // while crypto ran 48.5% / -0.035R over 132. The gate belongs where it was
  // measured. It also throttled the whole desk to ~1 setup per scan, starving
  // the evidence loop that the rest of this system depends on.
  const gateCrypto = kind === 'crypto';
  const epRvolOk = !gateCrypto || rvol >= 1.0;
  const epAdxOk = !gateCrypto || (indicators.adx.adx != null && indicators.adx.adx >= 15 && indicators.adx.adx <= 32);
  if (trendUp && epRvolOk && epAdxOk && last.l <= ema9[i] + 0.25 * atr && last.c > ema21[i]) {
    const entry = last.h + buf, stop = Math.min(last.l, prev.l) - 0.3 * atr, risk = entry - stop;
    cand.push({ strategy: 'EMA Pullback', direction: 'LONG', type: 'trend', entry, stop, t1: entry + risk, t2: entry + 2 * risk, rr: 2,
      note: 'Uptrend (EMA9>EMA21, price>VWAP) pulled back to EMA9. Buy the break of the setup-candle high.' });
  } else if (trendDn && epRvolOk && epAdxOk && last.h >= ema9[i] - 0.25 * atr && last.c < ema21[i]) {
    const entry = last.l - buf, stop = Math.max(last.h, prev.h) + 0.3 * atr, risk = stop - entry;
    cand.push({ strategy: 'EMA Pullback', direction: 'SHORT', type: 'trend', entry, stop, t1: entry - risk, t2: entry - 2 * risk, rr: 2,
      note: 'Downtrend (EMA9<EMA21, price<VWAP) rallied to EMA9. Sell the break of the setup-candle low.' });
  }

  // 2) VWAP bounce — trend continuation off the session anchor.
  // Measured 2026-08-19: 7.1% over 28 resolved trades, identical pre- and
  // post-fix, so this was a real defect rather than stale data. The trigger
  // only asked whether price *touched* VWAP, never whether VWAP was
  // *defended* — in an uptrend, price falling all the way back to VWAP means
  // momentum has already stalled, so with no evidence of active buying this
  // was systematically buying failing trends. Now requires a genuine rejection
  // wick, a strong close, and intact trend structure (price still over EMA9).
  const vbRange = (last.h - last.l) || 1e-9;
  const vbLowWick = Math.min(last.o, last.c) - last.l;
  const vbUpWick = last.h - Math.max(last.o, last.c);
  const vbClosePos = (last.c - last.l) / vbRange; // 1 = closed on the high
  if (trendUp && last.l <= vwap + 0.2 * atr && last.c > vwap && last.c > ema21[i]
      && last.c > ema9[i] && vbLowWick >= 0.35 * vbRange && vbClosePos >= 0.6) {
    const entry = last.h + buf, stop = Math.min(last.l, vwap - 0.4 * atr), risk = entry - stop;
    cand.push({ strategy: 'VWAP Bounce', direction: 'LONG', type: 'trend', entry, stop, t1: entry + risk, t2: entry + 2 * risk, rr: 2,
      note: 'Uptrend holding above session VWAP; price tagged VWAP and bounced. Long the reclaim — VWAP is the line in the sand.' });
  } else if (trendDn && last.h >= vwap - 0.2 * atr && last.c < vwap && last.c < ema21[i]
      && last.c < ema9[i] && vbUpWick >= 0.35 * vbRange && vbClosePos <= 0.4) {
    const entry = last.l - buf, stop = Math.max(last.h, vwap + 0.4 * atr), risk = stop - entry;
    cand.push({ strategy: 'VWAP Bounce', direction: 'SHORT', type: 'trend', entry, stop, t1: entry - risk, t2: entry - 2 * risk, rr: 2,
      note: 'Downtrend capped by session VWAP; price tagged VWAP and rejected. Short the failure — VWAP is the line in the sand.' });
  }

  // 3) Momentum breakout — new range extreme on volume.
  // Measured 2026-08-15: 15.6% over 32 resolved trades, the worst actionable
  // strategy. It was firing on vertical moves that had already travelled, so
  // the breakout was the exhaustion bar. Now requires the break to happen while
  // price is still near EMA9 (a coiled break, not a chase).
  const notExtended = !atr || Math.abs(last.c - ema9[i]) <= 2 * atr;
  if (trendUp && rvol >= 1.3 && last.c >= hh * 0.999 && notExtended) {
    const entry = Math.max(hh, last.h) + buf, stop = Math.min(last.l, prev.l) - 0.2 * atr, risk = entry - stop;
    cand.push({ strategy: 'Momentum Breakout', direction: 'LONG', type: 'trend', entry, stop, t1: entry + risk, t2: entry + 2 * risk, rr: 2,
      note: `New ${coilLabel} high on ${rvol.toFixed(1)}× volume in an uptrend. Buy the breakout; trail under EMA9.` });
  } else if (interval !== '5m' && trendDn && rvol >= 1.3 && last.c <= ll * 1.001 && notExtended) {
    // SHORT side disabled on the 5-minute desk (30 Sep). It is the one 5m
    // finding that survived the three-period stability test: 29.1% over 103
    // resolved trades, -0.417R, and negative in EVERY period (-0.699 / -0.064 /
    // -0.722). Not a composition artefact — it loses on crypto (-0.600R) and
    // non-crypto (-0.324R) alike, across 18 symbols with no symbol above 16%.
    // The LONG side of the identical trigger runs 49.5% / -0.011R, so this is
    // the direction, not the pattern: a high-volume new low in a rising tape is
    // often capitulation that snaps back.
    // Why a trigger change rather than the tuner: the tuner judges strategies
    // without direction on the scalp desks, so these shorts were suppressed only
    // incidentally, by being averaged with the long side. Scoping the tuner by
    // direction was impact-checked and rejected — it would have LOOSENED two
    // known losers on the 15m desk.
    // Trade-off stated plainly: disabling stops this setup being measured. The
    // evidence (103 trades, 3 stable periods) is enough to act on; re-enabling
    // is removing the interval check above. 15m is left as-is — it has its own
    // record and was not in this pass's scope.
    const entry = Math.min(ll, last.l) - buf, stop = Math.max(last.h, prev.h) + 0.2 * atr, risk = stop - entry;
    cand.push({ strategy: 'Momentum Breakout', direction: 'SHORT', type: 'trend', entry, stop, t1: entry - risk, t2: entry - 2 * risk, rr: 2,
      note: `New ${coilLabel} low on ${rvol.toFixed(1)}× volume in a downtrend. Sell the breakdown; trail above EMA9.` });
  }

  // 4) VWAP snap-back — mean reversion on an overextension
  const stretch = vwap - last.c;
  if (stretch >= 1.5 * atr && rsi != null && rsi < 32) {
    const entry = last.h + buf, stop = Math.min(...c.slice(-3).map((x) => x.l)) - 0.5 * atr;
    const t1 = last.c + stretch / 2, t2 = vwap, rr = (t1 - entry) / (entry - stop);
    if (t1 > entry && rr >= 1.2) cand.push({ strategy: 'VWAP Snap-back', direction: 'LONG', type: 'revert', entry, stop, t1, t2, rr: parseFloat(rr.toFixed(1)),
      note: `Stretched ${(stretch / atr).toFixed(1)}×ATR below VWAP with RSI ${rsi.toFixed(0)}. Buy the reclaim, exit into VWAP.` });
  } else if (-stretch >= 1.5 * atr && rsi != null && rsi > 68) {
    const entry = last.l - buf, stop = Math.max(...c.slice(-3).map((x) => x.h)) + 0.5 * atr;
    const t1 = last.c + stretch / 2, t2 = vwap, rr = (entry - t1) / (stop - entry);
    if (t1 < entry && rr >= 1.2) cand.push({ strategy: 'VWAP Snap-back', direction: 'SHORT', type: 'revert', entry, stop, t1, t2, rr: parseFloat(rr.toFixed(1)),
      note: `Stretched ${(-stretch / atr).toFixed(1)}×ATR above VWAP with RSI ${rsi.toFixed(0)}. Short the rejection, cover into VWAP.` });
  }

  // 5) Reversal bar — engulfing candle at an RSI extreme
  const bullEngulf = last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
  const bearEngulf = last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c;
  if (bullEngulf && rsi != null && rsi < 38) {
    const entry = last.h + buf, stop = last.l - 0.3 * atr, risk = entry - stop;
    cand.push({ strategy: 'Reversal Bar', direction: 'LONG', type: 'revert', entry, stop, t1: entry + 1.5 * risk, t2: entry + 3 * risk, rr: 1.5,
      note: `Bullish engulfing at oversold RSI ${rsi.toFixed(0)}. Reversal scalp with a tight stop under the low.` });
  } else if (bearEngulf && rsi != null && rsi > 62) {
    const entry = last.l - buf, stop = last.h + 0.3 * atr, risk = stop - entry;
    cand.push({ strategy: 'Reversal Bar', direction: 'SHORT', type: 'revert', entry, stop, t1: entry - 1.5 * risk, t2: entry - 3 * risk, rr: 1.5,
      note: `Bearish engulfing at overbought RSI ${rsi.toFixed(0)}. Reversal scalp with a tight stop above the high.` });
  }

  // 6) Coil breakout — range compression, two-sided.
  // Measured 2026-08-21 over 210 backfilled trades (the first time this setup
  // was ever scored — two-sided brackets had always been skipped): 26.7%
  // against a 35.5% breakeven, i.e. -0.25R and the worst strategy in the app.
  // Breaking out of a coil on no participation is a fakeout: at RVOL below 0.8
  // it won only 20.2% (n=124), and once ADX exceeded 32 — a "coil" inside an
  // already-extended move — just 13.2% (n=53). The one healthy pocket was
  // ADX 20-25 at 45.2%. Require participation and a trend that is live but not
  // spent.
  const height = hh - ll;
  const cbRvolOk = !gateCrypto || rvol >= 0.8;
  const cbAdxOk = !gateCrypto || (indicators.adx.adx != null && indicators.adx.adx >= 20 && indicators.adx.adx <= 32);
  if (cbRvolOk && cbAdxOk && height <= 2.2 * atr && height > 0) {
    const entry = hh + buf, entryShort = ll - buf;
    cand.push({ strategy: 'Coil Breakout', direction: '2-WAY', type: 'trend', entry, entryShort, stop: ll + height / 2,
      t1: entry + height, t2: entry + 2 * height, rr: 2,
      note: `${coilLabel} range is tight (${(height / atr).toFixed(1)}×ATR). Bracket it: long above ${r2(entry)} or short below ${r2(entryShort)}; stop at the midpoint; targets 1× and 2× the range height.` });
  }

  // Precise entry mechanics: where on the trigger candle the order actually
  // sits, what the wick is telling you, where a better fill lives, and the
  // price beyond which chasing destroys the reward:risk you were promised.
  const buildEntryPlan = (s) => {
    const k = last;
    // A thin futures bar can print high === low; fall back to ATR so the plan
    // still renders (percentages become approximate, the levels stay exact).
    const rng = (k.h - k.l) > 0 ? (k.h - k.l) : (atr || Math.abs(s.entry - s.stop) || 1);
    const isLong = s.direction === 'LONG';
    const twoWay = s.direction === '2-WAY';
    const body = Math.abs(k.c - k.o);
    const upperWick = k.h - Math.max(k.o, k.c);
    const lowerWick = Math.min(k.o, k.c) - k.l;
    const pctOf = (v) => +((v / rng) * 100).toFixed(0);
    const entry = s.entry;
    const risk = Math.abs(entry - s.stop);

    // Where the trigger sits relative to the candle it was derived from
    const abovePct = +(((entry - k.h) / rng) * 100).toFixed(0);
    const belowPct = +(((k.l - entry) / rng) * 100).toFixed(0);

    // Wick read — rejection in your favour is the tell most people skip
    let wickRead;
    if (isLong || twoWay) {
      wickRead = lowerWick > body * 0.8 && lowerWick > upperWick
        ? `Long lower wick (${pctOf(lowerWick)}% of the candle) — buyers rejected the low. Supportive.`
        : upperWick > body * 1.2
          ? `Heavy upper wick (${pctOf(upperWick)}% of range) — sellers are still capping it. Weaker long; demand a decisive break.`
          : `Body-dominant candle (${pctOf(body)}% body) — clean directional close, little rejection either way.`;
    } else {
      wickRead = upperWick > body * 0.8 && upperWick > lowerWick
        ? `Long upper wick (${pctOf(upperWick)}% of the candle) — sellers rejected the high. Supportive.`
        : lowerWick > body * 1.2
          ? `Heavy lower wick (${pctOf(lowerWick)}% of range) — buyers keep defending. Weaker short; demand a decisive break.`
          : `Body-dominant candle (${pctOf(body)}% body) — clean directional close, little rejection either way.`;
    }

    // Chasing past this point pushes reward:risk under ~1.3 — the trade stops
    // being worth taking even if the direction is right.
    const maxChase = isLong ? entry + 0.5 * risk : entry - 0.5 * risk;
    const dist = ((entry - last.c) / last.c) * 100;
    const distAtr = atr ? Math.abs(entry - last.c) / atr : 0;
    const triggered = isLong ? last.c >= entry : last.c <= entry;
    const ranAway = isLong ? last.c > maxChase : last.c < maxChase;
    const status = twoWay ? 'pending' : ranAway ? 'ran' : triggered ? 'triggered' : distAtr <= 1.2 ? 'armed' : 'far';

    // Better fill = wait for a pullback into the candle rather than paying the break
    const midBody = (Math.max(k.o, k.c) + Math.min(k.o, k.c)) / 2;
    const betterFill = isLong
      ? { price: r2(Math.max(midBody, ema9[i])), desc: 'a limit order back at the candle mid-body / EMA9 retest' }
      : { price: r2(Math.min(midBody, ema9[i])), desc: 'a limit order back at the candle mid-body / EMA9 retest' };
    const betterRisk = Math.abs(betterFill.price - s.stop);
    betterFill.rr = betterRisk > 0 ? +(Math.abs(s.t1 - betterFill.price) / betterRisk).toFixed(1) : null;

    return {
      orderType: s.orderType === 'limit'
        ? (isLong ? 'Buy limit (pullback order, maker)' : 'Sell limit (pullback order, maker)')
        : twoWay ? 'Two-sided stop bracket' : isLong ? 'Buy stop (breakout order)' : 'Sell stop (breakdown order)',
      ...(s.orderType === 'limit' ? {
        limitNote: `Rest this limit for up to ${s.fillWindowBars || 6} bars and cancel if unfilled. Waiting for price to come to you is what earns the maker fee — chasing a missed fill turns it back into a taker trade.`,
        replacedStopOrder: s.stopOrderEntry,
      } : {}),
      where: twoWay
        ? `Above the ${coilLabel} range high for the long, below its low for the short`
        : isLong
          ? `${abovePct}% of a candle-height above the trigger candle's HIGH (${r2(k.h)})`
          : `${belowPct}% of a candle-height below the trigger candle's LOW (${r2(k.l)})`,
      anatomy: {
        o: r2(k.o), h: r2(k.h), l: r2(k.l), c: r2(k.c),
        bodyPct: pctOf(body), upperWickPct: pctOf(upperWick), lowerWickPct: pctOf(lowerWick),
        green: k.c >= k.o, entry: r2(entry), stop: r2(s.stop), t1: r2(s.t1), t2: r2(s.t2),
        maxChase: r2(maxChase), betterFill: betterFill.price,
      },
      wickRead,
      betterFill,
      maxChase: r2(maxChase),
      distancePct: +dist.toFixed(2), distanceAtr: +distAtr.toFixed(2),
      status,
      statusNote: {
        armed: 'Live — price is within striking distance of the trigger. Rest the order and let it come to you.',
        far: `Price is ${distAtr.toFixed(1)}×ATR away from the trigger — the setup is valid but not imminent.`,
        triggered: 'Already through the trigger — only take it if you can still enter under the max-chase price.',
        ran: 'Price has run past the max-chase level. The edge is gone; wait for the next pullback.',
        pending: 'Bracket both sides and let the market pick a direction. Cancel the unfilled side on the fill.',
      }[status],
      invalidation: twoWay
        ? 'If the range simply drifts sideways and volatility keeps falling, cancel both orders.'
        : isLong
          ? `Setup dies if a candle closes back below EMA21 (${r2(ema21[i])}) before the trigger fires.`
          : `Setup dies if a candle closes back above EMA21 (${r2(ema21[i])}) before the trigger fires.`,
    };
  };

  // grade every candidate and surface the highest-confluence one
  const graded = cand
    .filter((s) => isFinite(s.rr) && s.rr > 0)
    .map((s) => {
      const g = gradeSetup(s.type, s.direction, {
        rr: s.rr, rvol, atrPct, rsi, trendUp, trendDn,
        adx: indicators.adx.adx, macdHist: indicators.macd.hist,
        extAtr: atr ? (last.c - ema9[i]) / atr : null, // how far the move has already run
      });
      const rnd = (v) => (v == null ? v : r2(v));
      const out = { ...s, entry: rnd(s.entry), entryShort: s.entryShort != null ? rnd(s.entryShort) : undefined,
        stop: rnd(s.stop), t1: rnd(s.t1), t2: rnd(s.t2), score: g.score, grade: g.grade, factors: g.factors, extAtr: g.extAtr };
      out.entryPlan = buildEntryPlan(out);
      return out;
    })
    .sort((a, b) => b.score - a.score);

  // Timing + track-record adjustments — variables the grader used to ignore.
  // Skipped during backfill: both depend on "now" (the current UTC hour) and on
  // today's live stats, so applying them to a historical replay would score old
  // bars with present-day context and quietly invalidate the simulation.
  const utcHr = opts.backfill ? -1 : new Date().getUTCHours();
  graded.forEach((s) => {
    const adjs = [];
    if (opts.backfill) {
      // grade straight off the raw confluence score
      s.grade = s.score >= 80 ? 'A' : s.score >= 68 ? 'B' : s.score >= 56 ? 'C' : 'D';
      return;
    }
    if (opts.chop?.avoid?.includes(utcHr)) {
      s.score = Math.max(0, s.score - 12);
      adjs.push(`${String(utcHr).padStart(2, '0')}:00 UTC is historically a chop hour for this asset class (−12)`);
    } else if (opts.chop?.best?.includes(utcHr)) {
      s.score = Math.min(100, s.score + 6);
      adjs.push(`${String(utcHr).padStart(2, '0')}:00 UTC is one of its most directional hours (+6)`);
    }
    const rel = reliabilityAdj(s.strategy, s.grade, opts.ledgerKind);
    if (rel.adj) {
      s.score = Math.max(0, Math.min(100, s.score + rel.adj));
      adjs.push(`Track record: ${rel.note} (${rel.adj > 0 ? '+' : ''}${rel.adj})`);
    }
    s.grade = s.score >= 80 ? 'A' : s.score >= 68 ? 'B' : s.score >= 56 ? 'C' : 'D';
    if (adjs.length) s.adjustments = adjs;
  });
  graded.sort((a, b) => b.score - a.score);

  let setup = null, watch = null;
  if (graded.length && graded[0].score >= 56) setup = graded[0];

  // ---- Limit-order execution on the 5-minute desk (30 Sep) ----------------
  // User decision: execute 5m scalps with limit orders. Entries were stop
  // orders (buy above the trigger candle), which can only fill as taker. A
  // maker entry has to REST on the passive side, so the entry becomes a
  // pullback limit: long at max(mid-body, EMA9) of the last CLOSED candle,
  // short at min(...). The stop MOVES WITH the entry to keep the original stop
  // distance — keeping the old absolute stop instead shrank the distance to a
  // third and doubled costs-in-R (measured -0.937R/signal vs -0.772R).
  //
  // Measured on 467 live crypto 5m signals replayed against Binance candles,
  // with lookahead removed (only bars CLOSED before the signal inform the
  // level): net per trade taken -0.772R -> -0.496R, beating stop entries in all
  // three periods and on both sides. What that is and is not: the gain is the
  // fee saving (~0.27R/trade: maker entry, no entry slippage, maker take-
  // profit). Win rate is unchanged (44.9% vs 44.1%) — an earlier reading of
  // 51% was a lookahead artefact. It is still net negative.
  //
  // Only the last CLOSED candle is used: the final bar from Binance is still
  // forming, and reading it is exactly the lookahead the measurement removed.
  // Resting-limit conversion (5m, single-direction). Returns a converted COPY,
  // or null when price is already through the pullback level — a "limit" there
  // would fill instantly as taker, the very cost this policy exists to avoid.
  // A function rather than inline so every candidate can be converted, not just
  // the winner: the autonomous bot runs each strategy as its own sleeve.
  const limitize = (g) => {
    if (!(interval === '5m' && (g.direction === 'LONG' || g.direction === 'SHORT') && i >= 1)) return g;
    const kc = c[i - 1];
    const e9 = ema9[i - 1];
    const long = g.direction === 'LONG';
    const mid = (Math.max(kc.o, kc.c) + Math.min(kc.o, kc.c)) / 2;
    const pull = long ? Math.max(mid, e9) : Math.min(mid, e9);
    const risk = Math.abs(g.entry - g.stop);
    const passive = long ? pull < last.c : pull > last.c;
    if (!(risk > 0 && Number.isFinite(pull) && passive)) return null;
    const x = {
      ...g,
      stopOrderEntry: r2(g.entry), // what the old breakout order would have been
      orderType: 'limit', fillWindowBars: 6,
      entry: r2(pull),
      stop: r2(long ? pull - risk : pull + risk),
      t1: r2(long ? pull + risk : pull - risk),
      t2: r2(long ? pull + 2 * risk : pull - 2 * risk),
      rr: 1,
      note: `${g.note} Limit entry: rest a ${long ? 'buy' : 'sell'} limit at the pullback level (last closed candle's mid-body / EMA9) for up to 6 bars (30 min); cancel if unfilled. Stop keeps the setup's original distance.`,
    };
    x.entryPlan = buildEntryPlan(x);
    return x;
  };
  // Every setup that clears the quality bar, each converted — not just the best.
  const candidates = graded.filter((g) => g.score >= 56).map(limitize).filter(Boolean);

  if (setup && interval === '5m' && (setup.direction === 'LONG' || setup.direction === 'SHORT') && i >= 1) {
    const conv = limitize(setup);
    if (conv) setup = conv;
    else {
      watch = `${setup.strategy} ${setup.direction} qualified, but price is already at/through its pullback level, so no resting limit is available. Limit-order policy: stand aside rather than pay taker.`;
      setup = null;
    }
  }

  if (setup) { /* setup stands */ }
  else if (watch) { /* limit policy set the watch message */ }
  else if (graded.length) {
    const g = graded[0];
    watch = `Low-confluence ${g.strategy} ${g.direction} forming (grade ${g.grade}, ${g.score}/100) — wait for volume/trend confirmation.`;
  } else {
    watch = trendUp ? 'Uptrend intact — wait for a pullback to EMA9/VWAP before entering.'
      : trendDn ? 'Downtrend intact — wait for a rally to EMA9/VWAP before entering.'
        : 'No edge: price chopping around VWAP with EMAs flat. Stand aside.';
  }

  return {
    symbol, kind, interval,
    last: r2(last.c), vwap: r2(vwap), ema9: r2(ema9[i]), ema21: r2(ema21[i]), ema50: r2(ema50[i]),
    atr: r2(atr), atrPct: parseFloat(atrPct.toFixed(3)), rvol: parseFloat(rvol.toFixed(2)),
    rsi: rsi != null ? parseFloat(rsi.toFixed(1)) : null,
    trend: trendUp ? 'up' : trendDn ? 'down' : 'flat',
    barTime: last.t,
    indicators,
    setup, watch,
    candidates,
  };
}

function usMarketOpen() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return !['Sat', 'Sun'].includes(parts.weekday) && mins >= 570 && mins < 960; // 9:30–16:00 ET
}

// CNBC serves live 1-min OHLCV bars for stocks AND futures; bucket them to
// the requested timeframe (60s for 1m — effectively a passthrough — or 300s).
function aggregateBars(bars, tfMs) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.tradeTimeinMills / tfMs) * tfMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 };
    } else {
      cur.h = Math.max(cur.h, +b.high);
      cur.l = Math.min(cur.l, +b.low);
      cur.c = +b.close;
      cur.v += +b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function cnbcBars(symbol, tfMs, maxBars = 220) {
  const data = await fetchJson(
    `https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=${encodeURIComponent(symbol)}`
  );
  const bars = data?.barData?.priceBars || [];
  if (!bars.length) throw new Error(`no CNBC bars for ${symbol}`);
  return aggregateBars(bars, tfMs).slice(-maxBars);
}

async function yahooIntraday(symbol, interval) {
  const range = interval === '1m' ? '1d' : interval === '15m' ? '5d' : '2d';
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
  );
  const result = data?.chart?.result?.[0];
  if (!result?.timestamp) throw new Error(`no ${interval} data for ${symbol}`);
  const q = result.indicators.quote[0];
  return result.timestamp
    .map((t, j) => ({ t: t * 1000, o: q.open[j], h: q.high[j], l: q.low[j], c: q.close[j], v: q.volume[j] }))
    .filter((x) => x.c != null && x.o != null)
    .slice(-220);
}

async function fetchScalpCandles(meta, interval = '5m') {
  const tfMs = TF_MS_MAP[interval] || 300000;
  return cached(
    `s5:${meta.display}:${interval}`,
    async () => {
      if (meta.kind === 'crypto') {
        const raw = await fetchJson(
          `https://api.binance.com/api/v3/klines?symbol=${meta.fetch}USDT&interval=${interval}&limit=240`
        );
        // tb = taker-buy base volume: how much of the bar traded as aggressive
        // buying. Lets the desk read live order flow from data it already pulls.
        return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] }));
      }
      try {
        return await cnbcBars(meta.cnbc, tfMs);
      } catch (err) {
        // With the scanner now on a heartbeat, an empty CNBC feed for a closed
        // equity market would send 6 symbols to Yahoo every 5 minutes and keep
        // its circuit breaker permanently tripped. Closed market = no fallback.
        if (meta.group === 'stock' && !usMarketOpen()) {
          throw new Error(`${meta.display}: US market closed, no intraday data`);
        }
        console.error(`[scalp] CNBC failed for ${meta.display}, trying Yahoo:`, err.message);
        return yahooIntraday(meta.fetch, interval);
      }
    },
    interval === '1m' ? (meta.kind === 'crypto' ? 20 * 1000 : 60 * 1000)
      : interval === '15m' ? (meta.kind === 'crypto' ? 90 * 1000 : 180 * 1000)
        : (meta.kind === 'crypto' ? 45 * 1000 : 120 * 1000)
  );
}

// Markets that close (stocks, futures pauses) shouldn't show "live" setups
// computed from stale bars — demote to a closed notice instead.
function applyStaleness(meta, analysis, candles) {
  if (!analysis || meta.kind === 'crypto') return analysis;
  const age = Date.now() - candles.at(-1).t;
  if (age > STALE_AFTER_MS) {
    analysis.closed = true;
    analysis.setup = null;
    analysis.watch = `Market closed — last ${analysis.interval} bar ${new Date(candles.at(-1).t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}. Levels are from the last session.`;
  }
  return analysis;
}

async function analyzeOne(meta, interval = '5m', opts = {}) {
  const candles = await fetchScalpCandles(meta, interval);
  const chop = opts.chop || await chopHours(meta.group).catch(() => null);
  const a = analyzeScalp(meta.display, meta.group, candles, {
    interval, chop,
    ledgerKind: opts.ledgerKind || SCALP_TF[interval]?.kind,
  });
  if (!a) return null;
  a.name = meta.name;
  a.group = meta.group;
  return { analysis: applyStaleness(meta, a, candles), candles };
}

// One scanner engine for every scalp timeframe. Each timeframe records its
// signals under its own ledger kind, so their hit rates are measured separately
// and can be compared head-to-head (is 5m or 15m actually working for you?).
const SCALP_TF = {
  '5m': { kind: 'scalp', maxBars: 48, ttl: 45 * 1000 },   // ~4h to resolve
  '15m': { kind: 'scalp15', maxBars: 32, ttl: 120 * 1000 }, // ~8h to resolve
};

// ---------------------------------------------------------------------------
// Strategy backfill. The live ledger only records while the server is running,
// and the server's life is tied to a session — four consecutive improvement
// passes have been blocked by too few resolved trades. This replays real
// historical candles bar by bar, asking at each step "would a setup have fired
// here, and what did price do next?", which produces hundreds of honest
// outcomes in seconds. It deliberately writes NOTHING to the live ledger: these
// are simulated fills, and mixing them into the measured record would let the
// auto-tuner learn from a simulation. Read-only evidence for judgement calls.
// ---------------------------------------------------------------------------
async function backfillScalp(interval = '5m', opts = {}) {
  const cfg = SCALP_TF[interval];
  const window = opts.window || 200;                 // matches the live scan's history depth
  const horizon = opts.maxBars || cfg.maxBars;       // same resolution horizon as live
  const syms = SCALP_UNIVERSE.filter((m) => m.kind === 'crypto'); // 1000-bar history, always open
  const byStrategy = {}, byGrade = {};
  const features = [];
  let tested = 0, fired = 0;

  for (const meta of syms) {
    let candles;
    try {
      const raw = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${meta.fetch}USDT&interval=${interval}&limit=1000`);
      candles = raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) { console.error('[backfill]', meta.display, e.message); continue; }
    if (candles.length < window + horizon + 5) continue;

    for (let i = window; i < candles.length - horizon; i++) {
      tested++;
      const hist = candles.slice(i - window, i);
      let a;
      try { a = analyzeScalp(meta.display, meta.group, hist, { interval, backfill: true }); } catch { continue; }
      const st = a && a.setup;
      if (!st) continue;
      fired++;
      // Replay forward exactly like the live resolver: fill first, then target vs stop.
      const fwd = candles.slice(i, i + horizon);
      let long = st.direction === 'LONG';
      let entry = st.entry, target = st.t1;
      if (st.direction === '2-WAY' && st.entryShort != null) {
        const iL = fwd.findIndex((k) => k.h >= st.entry);
        const iS = fwd.findIndex((k) => k.l <= st.entryShort);
        if (iL < 0 && iS < 0) { byStrategy[st.strategy] = byStrategy[st.strategy] || { win: 0, loss: 0, noFill: 0 }; byStrategy[st.strategy].noFill++; continue; }
        const shortFirst = iL < 0 || (iS >= 0 && iS < iL);
        long = !shortFirst;
        if (shortFirst) { entry = st.entryShort; target = st.entryShort - (st.t1 - st.entry); }
      }
      let filled = false, outcome = null;
      // Same fill rule as the live resolver: resting limits fill when price comes
      // back to them and only inside their window; stop orders fill on a cross.
      const isLimit = st.orderType === 'limit';
      const fillWindow = isLimit ? (st.fillWindowBars || 6) : fwd.length;
      for (let fi = 0; fi < fwd.length; fi++) {
        const k = fwd[fi];
        if (!filled) {
          if (fi >= fillWindow) break;                  // limit cancelled unfilled
          const hit = isLimit ? (long ? k.l <= entry : k.h >= entry) : (long ? k.h >= entry : k.l <= entry);
          if (!hit) continue;
          filled = true;
          // Far level inside the fill bar: the order of events is unknown (see
          // fillBarFromMinutes). A backfill has no 1-minute bars, so skip it.
          const farT = long ? k.h >= target : k.l <= target, farS = long ? k.l <= st.stop : k.h >= st.stop;
          if (isLimit ? farT : farS) { outcome = 'ambiguous'; break; }
        }
        const hitT = long ? k.h >= target : k.l <= target;
        const hitS = long ? k.l <= st.stop : k.h >= st.stop;
        if (hitT && hitS) { outcome = 'ambiguous'; break; }
        if (hitT) { outcome = 'win'; break; }
        if (hitS) { outcome = 'loss'; break; }
      }
      if (!filled) outcome = 'no-fill';
      if (!outcome || outcome === 'ambiguous') continue;
      // Capture the context each setup fired in, so we can measure which
      // conditions actually separate winners from losers instead of guessing.
      if (outcome !== 'no-fill') {
        features.push({
          strategy: st.strategy, win: outcome === 'win',
          adx: a.indicators?.adx?.adx ?? null,
          rvol: a.rvol, rsi: a.rsi, atrPct: a.atrPct,
          score: st.score,
          extAtr: a.atr ? (a.last - a.ema9) / a.atr : null,
          htf: a.indicators?.htf?.trend ?? null,
          dir: st.direction,
        });
      }
      const rMult = Math.abs(entry - st.stop) > 0 ? Math.abs(target - entry) / Math.abs(entry - st.stop) : 1;
      for (const [bucket, key] of [[byStrategy, st.strategy], [byGrade, st.grade]]) {
        const b = (bucket[key] ||= { win: 0, loss: 0, noFill: 0, rSum: 0, rN: 0 });
        if (outcome === 'no-fill') b.noFill++; else { b[outcome]++; b.rSum += rMult; b.rN++; }
      }
    }
  }
  const summarise = (bucket) => Object.fromEntries(Object.entries(bucket).map(([k, v]) => {
    const dec = v.win + v.loss;
    const hit = dec ? v.win / dec : 0;
    // Payoff differs by strategy, so expectancy — not hit rate — is the honest
    // yardstick. R is the reward multiple actually used by that strategy.
    const R = v.rN ? v.rSum / v.rN : 1;
    return [k, { decided: dec, wins: v.win, losses: v.loss, noFill: v.noFill,
      hitRate: dec >= 20 ? +(hit * 100).toFixed(1) : null,
      rMultiple: +R.toFixed(2),
      breakevenPct: +(100 / (R + 1)).toFixed(1),
      evR: dec >= 20 ? +(hit * R - (1 - hit)).toFixed(3) : null }];
  }));
  const all = Object.values(byStrategy).reduce((a, v) => ({ w: a.w + v.win, l: a.l + v.loss, nf: a.nf + v.noFill }), { w: 0, l: 0, nf: 0 });
  return {
    interval, symbols: syms.length, barsTested: tested, setupsFired: fired,
    overall: { decided: all.w + all.l, wins: all.w, losses: all.l, noFill: all.nf,
      hitRate: (all.w + all.l) ? +((all.w / (all.w + all.l)) * 100).toFixed(1) : null },
    byStrategy: summarise(byStrategy), byGrade: summarise(byGrade),
    features,
    scope: 'CRYPTO ONLY — the 8 Binance symbols. Non-crypto markets have no deep intraday history (CNBC serves ~1 session), so they cannot be replayed.',
    note: 'Simulated fills on historical candles. Never written to the live ledger. '
      + 'Where this disagrees with the live ledger, trust the ledger: it covers all 21 markets. '
      + 'Measured 23 Aug: the same strategy ran -0.14R on crypto and +0.17R on everything else, '
      + 'so crypto-only results must not be generalised to the whole desk.',
  };
}

async function getScalpTf(interval) {
  const cfg = SCALP_TF[interval];
  return cached(
    `scalp:${interval}`,
    async () => {
      const items = [];
      let activity = null;
      // Session-timing context is per asset class — fetch the three proxies once
      // instead of per symbol (each is a 6h-cached seasonality computation).
      const chopByGroup = {};
      await Promise.all(['crypto', 'stock', 'metal'].map(async (g) => { chopByGroup[g] = await chopHours(g).catch(() => null); }));
      chopByGroup.commodity = chopByGroup.metal;
      // Binance + CNBC handle a 21-request burst fine (Yahoo is only a rare
      // per-symbol fallback, guarded by its circuit breaker) — go fully parallel.
      const settled = await Promise.allSettled(SCALP_UNIVERSE.map((m) => analyzeOne(m, interval, { chop: chopByGroup[m.group], ledgerKind: cfg.kind })));
      settled.forEach((s, j) => {
        if (s.status !== 'fulfilled' || !s.value) {
          if (s.status === 'rejected') console.error(`[scalp${interval}]`, SCALP_UNIVERSE[j].display, s.reason.message);
          return;
        }
        const { analysis, candles } = s.value;
        // Live, descriptive read of the present — 5m desk only.
        if (interval === '5m' && analysis && !analysis.closed) analysis.now = liveRead(candles, SCALP_UNIVERSE[j]);
        if (SCALP_UNIVERSE[j].display === 'BTC') {
          // market activity meter: current ATR vs median ATR over the window
          const atrs = atrArr(candles, 14);
          const sorted = [...atrs].sort((x, y) => x - y);
          activity = parseFloat((atrs.at(-1) / sorted[Math.floor(sorted.length / 2)]).toFixed(2));
        }
        items.push(analysis);
      });
      // Relative strength for the equity names, attached before recording so it
      // travels with the signal. Stocks only — a metal has no QQQ relationship
      // worth reading, and inventing a benchmark for it would be noise.
      await Promise.all(items.map(async (it) => {
        const meta = SCALP_UNIVERSE.find((m) => m.display === it.symbol);
        if (!meta || meta.group !== 'stock' || meta.display === 'QQQ') return;
        it.relStrength = await getRelStrength(meta.cnbc || meta.display).catch(() => null);
      }));

      // Record every live setup so its outcome can be measured later.
      await loadLedger();
      let recorded = 0;
      for (const it of items) {
        const s = it.setup;
        if (!s || it.closed) continue;
        // Two-sided brackets used to be skipped entirely "because they have no
        // single direction" — which meant Coil Breakout, the most frequently
        // firing setup, was NEVER measured. It is perfectly scoreable: whichever
        // leg the market triggers first becomes the trade. Record both legs and
        // let the resolver decide which one happened.
        const twoWay = s.direction === '2-WAY';
        if (recordSignal({
          kind: cfg.kind, symbol: it.symbol, direction: s.direction, strategy: s.strategy,
          grade: s.grade, score: s.score, entry: s.entry, stop: s.stop, target: s.t1,
          ...(twoWay ? { entryShort: s.entryShort, targetShort: s.entryShort - (s.t1 - s.entry) } : {}),
          // Reward multiple of THIS setup. Strategies do not share a payoff:
          // EMA Pullback targets 1R while Coil Breakout targets ~2R, so a flat
          // hit-rate comparison silently mis-ranks them.
          rMultiple: Math.abs(s.entry - s.stop) > 0
            ? +(Math.abs(s.t1 - s.entry) / Math.abs(s.entry - s.stop)).toFixed(2) : 1,
          // Grader instrumentation. The score has carried ZERO predictive power
          // (correlation +0.0007 over 1,202 resolved trades) and the grade bands
          // keep re-inverting, but nothing recorded WHICH factors fired — so no
          // pass could ever tell which weight was wrong, only that something was.
          // Store the factors that contributed and how extended the entry was.
          // How the order executes. Resolution and cost both depend on it: a
          // limit long fills on a trade DOWN to the level, a stop long on a trade
          // UP through it, and only the limit earns the maker fee.
          exec: s.orderType === 'limit' ? 'limit' : 'stop',
          ...(s.orderType === 'limit' ? { fillWindowBars: s.fillWindowBars || 6 } : {}),
          fk: (s.factors || []).filter((x) => x.ok && x.k).map((x) => x.k),
          ext: s.extAtr,
          rs: it.relStrength ? it.relStrength.rs5 : undefined,
          res: interval, maxBars: cfg.maxBars,
        })) recorded++;
      }
      if (recorded) { console.log(`[ledger] recorded ${recorded} new ${interval} scalp signals`); await saveLedger(); }

      // Attach each setup's MEASURED edge — the track record of the bucket it
      // belongs to (desk × strategy × asset class). Added 25 Sep after the
      // stability test showed that no grading factor holds its sign across
      // periods, which means the confluence score cannot rank setups and never
      // could. The bucket record is the only ranking input in this app that has
      // survived being checked out-of-sample.
      for (const it of items) {
        if (!it.setup) continue;
        it.setup.edge = bucketEdge(cfg.kind, it.setup.strategy,
          CRYPTO_SET.has(it.symbol) ? 'crypto' : 'non-crypto');
        // What THIS setup's stop distance costs to trade, in R. A setup whose
        // costs eat half its reward cannot be profitable however good the
        // read — at a 1R target and 0.5R of costs, breakeven is a 75% win rate.
        const exec = it.setup.orderType === 'limit' ? 'limit' : 'stop';
        const c = tradeCostR(it.setup.entry, it.setup.stop, exec);
        const legs = tradeCostLegsR(it.setup.entry, it.setup.stop, exec);
        it.setup.exec = exec;
        it.setup.costR = c == null ? null : +c.toFixed(3);
        // Breakeven with asymmetric legs at a 1R target: win nets (1 - cw), loss
        // costs (1 + cl), so h = (1 + cl) / (2 - cw + cl).
        const be = legs ? (1 + legs.loss) / (2 - legs.win + legs.loss) : null;
        it.setup.breakevenNet = be == null ? null : +(be * 100).toFixed(1);
        it.setup.costWarning = !legs ? null
          : legs.win >= 1 ? `Even a winning trade costs ${legs.win.toFixed(2)}R to exit on this stop — more than the 1R it earns. No win rate breaks even.`
          : be >= 0.75 ? `Costs are ${c.toFixed(2)}R on this stop — breakeven needs a ${(be * 100).toFixed(0)}% win rate. Not realistically tradeable.`
            : be >= 0.6 ? `Costs are ${c.toFixed(2)}R on this stop — a large drag; needs ${(be * 100).toFixed(0)}% to break even.`
              : null;
      }

      // Setups first, then by measured edge, and only then by the old
      // volatility × volume heuristic as a tiebreak for anything unmeasured.
      items.sort((a, b) => {
        const rank = (x) => (x.closed ? -1 : x.setup ? (x.setup.direction === '2-WAY' ? 1 : 2) : 0);
        const edge = (x) => (x.setup && x.setup.edge && x.setup.edge.enough ? x.setup.edge.evR : -99);
        return rank(b) - rank(a)
          || edge(b) - edge(a)
          || b.atrPct * Math.min(b.rvol, 3) - a.atrPct * Math.min(a.rvol, 3);
      });
      // Quick-events context for the 5m desk: the live accuracy measurement and
      // the economic calendar (a high-impact release moves every market at once).
      let live = null;
      if (interval === '5m') {
        const [stats, evs] = await Promise.all([directionStats().catch(() => null), getEvents().catch(() => [])]);
        live = { stats, econ: eventContext(evs) };
      }
      return {
        interval, stocksOpen: usMarketOpen(), activity, items,
        track: scalpTrackRecord(cfg.kind),
        live,
      };
    },
    cfg.ttl
  );
}
const getScalp = () => getScalpTf('5m');

// The self-improvement core, surfaced: measured hit rates for this timeframe,
// plus a head-to-head against the other timeframe so the edge is comparable.
function scalpTrackRecord(kind) {
  const st = ledger.stats || ledgerStats();
  const of = (k) => {
    const rows = ledger.signals.filter((s) => s.kind === k && ['win', 'loss'].includes(s.status));
    const wins = rows.filter((s) => s.status === 'win').length;
    return { decided: rows.length, wins, hitRate: rows.length >= 5 ? +((wins / rows.length) * 100).toFixed(1) : null };
  };
  const byStrategy = {};
  ledger.signals.filter((s) => s.kind === kind && ['win', 'loss'].includes(s.status)).forEach((s) => {
    const b = (byStrategy[s.strategy] ||= { decided: 0, wins: 0 });
    b.decided++; if (s.status === 'win') b.wins++;
  });
  Object.values(byStrategy).forEach((b) => { b.hitRate = b.decided >= 5 ? +((b.wins / b.decided) * 100).toFixed(1) : null; b.tuned = b.decided >= 20; });
  return {
    kind, overall: of(kind), byStrategy,
    compare: { '5m': of('scalp'), '15m': of('scalp15') },
    open: ledger.signals.filter((s) => s.kind === kind && s.status === 'open').length,
  };
}

async function getScalpChart(display, interval = '5m') {
  const meta = SCALP_UNIVERSE.find((m) => m.display === display);
  if (!meta) throw new Error(`unknown scalp symbol: ${display}`);
  const out = await analyzeOne(meta, interval);
  if (!out) throw new Error(`not enough ${interval} data for ${display}`);

  // Real-time context that lives outside the candles: macro calendar + funding.
  let events = null, funding = null;
  try { events = eventContext(await getEvents()); } catch (e) { console.error('[events]', e.message); }
  if (meta.kind === 'crypto') { try { funding = await getFunding(meta.fetch); } catch (e) { /* perp may not exist */ } }

  const ind = out.analysis.indicators;
  const warnings = [];
  if (events?.risk) {
    const e = events.riskEvent;
    const when = e.minsUntil >= 0 ? `in ${e.minsUntil} min` : `${Math.abs(e.minsUntil)} min ago`;
    warnings.push(`High-impact ${e.country} event "${e.title}" ${when} — expect erratic moves; scalps are coin-flips around news.`);
  }
  if (funding && funding.state !== 'neutral')
    warnings.push(`Funding ${funding.ratePct}%/8h (${funding.state}, ${funding.annualizedPct}%/yr) — over-leveraged one way; watch for a snap-back squeeze.`);
  if (ind?.bb?.bandwidth != null && ind.bb.bandwidth < 0.35)
    warnings.push(`Bollinger bandwidth ${ind.bb.bandwidth}% — volatility squeeze; expect an expansion/breakout soon.`);
  if (ind?.adx?.state === 'choppy')
    warnings.push(`ADX ${ind.adx.adx} (choppy) — no trend; favor fades/ranges over breakouts, or stand aside.`);
  out.analysis.warnings = warnings;

  return { item: out.analysis, candles: out.candles, events, funding };
}

// ---------------------------------------------------------------------------
// Live Chart — interactive multi-timeframe candles for all 21 markets, plus
// order book and order flow (crypto only: Binance depth & aggTrades are the
// only keyless sources of real book/tape data; stocks/futures have none).
// ---------------------------------------------------------------------------
const LIVE_TF = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000 };

async function getLiveCandles(display, tf) {
  const meta = SCALP_UNIVERSE.find((m) => m.display === display);
  if (!meta) throw new Error(`unknown symbol: ${display}`);
  const ttl = Math.max(10 * 1000, Math.min(LIVE_TF[tf] / 6, 60 * 1000));
  const candles = await cached(
    `live:${display}:${tf}`,
    async () => {
      if (meta.kind === 'crypto') {
        const raw = await fetchJson(
          `https://api.binance.com/api/v3/klines?symbol=${meta.fetch}USDT&interval=${tf}&limit=500`
        );
        return raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      }
      try {
        return await cnbcBars(meta.cnbc, LIVE_TF[tf], 500);
      } catch (err) {
        console.error(`[live] CNBC failed for ${display}, trying Yahoo:`, err.message);
        const [yi, range] = { '1m': ['1m', '1d'], '5m': ['5m', '5d'], '15m': ['15m', '5d'], '1h': ['60m', '1mo'] }[tf];
        const data = await fetchJson(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(meta.fetch)}?range=${range}&interval=${yi}`
        );
        const result = data?.chart?.result?.[0];
        if (!result?.timestamp) throw new Error(`no ${tf} data for ${display}`);
        const q = result.indicators.quote[0];
        return result.timestamp
          .map((t, j) => ({ t: t * 1000, o: q.open[j], h: q.high[j], l: q.low[j], c: q.close[j], v: q.volume[j] }))
          .filter((x) => x.c != null && x.o != null)
          .slice(-500);
      }
    },
    ttl
  );
  return {
    symbol: display, name: meta.name, group: meta.group, kind: meta.kind, tf,
    candles,
  };
}

async function getOrderBook(display) {
  const meta = SCALP_UNIVERSE.find((m) => m.display === display);
  if (!meta || meta.kind !== 'crypto') throw new Error('order book data exists only for crypto (Binance)');
  return cached(
    `book:${display}`,
    async () => {
      const d = await fetchJson(`https://api.binance.com/api/v3/depth?symbol=${meta.fetch}USDT&limit=100`);
      const lvl = (a) => a.map(([p, q]) => ({ p: +p, q: +q }));
      const bids = lvl(d.bids), asks = lvl(d.asks);
      const bidVol = bids.reduce((s, x) => s + x.q, 0);
      const askVol = asks.reduce((s, x) => s + x.q, 0);
      return {
        bids: bids.slice(0, 14), asks: asks.slice(0, 14),
        heat: { bids, asks }, // full 100 levels each side for the chart heat overlay
        spread: +(asks[0].p - bids[0].p).toPrecision(4),
        mid: (asks[0].p + bids[0].p) / 2,
        imbalance: +(((bidVol - askVol) / (bidVol + askVol)) * 100).toFixed(1),
        bidVol: +bidVol.toFixed(3), askVol: +askVol.toFixed(3),
      };
    },
    3 * 1000
  );
}

async function getOrderFlow(display) {
  const meta = SCALP_UNIVERSE.find((m) => m.display === display);
  if (!meta || meta.kind !== 'crypto') throw new Error('order flow data exists only for crypto (Binance)');
  return cached(
    `flow:${display}`,
    async () => {
      const trades = await fetchJson(`https://api.binance.com/api/v3/aggTrades?symbol=${meta.fetch}USDT&limit=1000`);
      if (!trades.length) throw new Error('no trades');
      let buy = 0, sell = 0;
      const buckets = new Map(); // minute -> signed notional (delta)
      const prints = [];
      for (const t of trades) {
        const notional = +t.p * +t.q;
        const isBuy = !t.m; // m=true → buyer was maker → aggressive SELL
        if (isBuy) buy += notional; else sell += notional;
        const mb = Math.floor(t.T / 60000) * 60000;
        buckets.set(mb, (buckets.get(mb) || 0) + (isBuy ? notional : -notional));
        prints.push({ t: t.T, p: +t.p, notional: Math.round(notional), side: isBuy ? 'buy' : 'sell' });
      }
      let run = 0;
      const cvd = [...buckets.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, dlt]) => { run += dlt; return { t, v: Math.round(run) }; });
      const top = prints.sort((a, b) => b.notional - a.notional).slice(0, 8).sort((a, b) => b.t - a.t);
      const spanMin = Math.max((trades.at(-1).T - trades[0].T) / 60000, 0.1);
      return {
        buyUsd: Math.round(buy), sellUsd: Math.round(sell), deltaUsd: Math.round(buy - sell),
        buyPct: +((buy / (buy + sell)) * 100).toFixed(1),
        tradesPerMin: Math.round(trades.length / spanMin),
        spanMin: +spanMin.toFixed(1),
        cvd, top,
      };
    },
    5 * 1000
  );
}

// ---------------------------------------------------------------------------
// AI Copy-Trade Bot — mirrors the top-win-rate wallets' moves into a PAPER
// ledger and relays actionable signals to Telegram via the Bot API. By design
// it never holds funds, never sees a private key, and never auto-executes a
// real order: live execution stays with the user, prompted by the Telegram
// signal. This keeps the feature genuinely useful but safe.
// ---------------------------------------------------------------------------
const copyBot = {
  running: false,
  config: {
    accountSize: 10000,  // paper account, USD
    sizePct: 5,          // % of account notional per copied entry
    maxPositions: 6,
    minWinRate: 60,      // only follow wallets at/above this win rate
    followCount: 3,      // copy the top N wallets by win rate
    telegramToken: '',
    telegramChatId: '',
    alerts: true,
    alertMode: 'entries', // 'entries' = every wallet entry, 'copied' = only copied, 'all' = entries+exits
  },
  seenTids: {},          // addr -> Set of fill trade-ids already processed
  signals: [],           // ring buffer of recent signals (newest first)
  positions: {},         // key "coin|side" -> { entryPx, sizeUsd, ... }
  paper: { realized: 0, wins: 0, losses: 0, copied: 0 },
  followed: [],
  timer: null,
  lastError: null,
  lastPoll: null,
};

async function hlFills(address) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ type: 'userFills', user: address, aggregateByTime: true }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`userFills ${address} -> HTTP ${res.status}`);
  const fills = await res.json();
  return fills.sort((a, b) => b.time - a.time); // newest first
}

async function telegramSend(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error(`Telegram HTTP ${res.status}`); }
  if (!data.ok) throw new Error(data.description || `Telegram error ${res.status}`);
  return data;
}

// Translate common Telegram API errors into a plain-English fix.
function telegramHint(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes("send messages to bots"))
    return "That Chat ID belongs to a bot. Use YOUR personal numeric ID from @userinfobot — not the number before the colon in your token (that's the bot's own ID).";
  if (m.includes('chat not found'))
    return "Chat not found. Open your bot in Telegram and press Start (send it any message) first, then use your personal numeric ID from @userinfobot.";
  if (m.includes('initiate conversation') || m.includes('blocked') || m.includes('deactivated'))
    return "Open your bot in Telegram and press Start / send it any message first — a bot can't message you until you've started a chat with it.";
  if (m.includes('unauthorized'))
    return "Bot token looks wrong. Re-copy the FULL token from @BotFather (it looks like 123456789:AAH...).";
  if (m.includes('chat_id'))
    return "Chat ID is missing or malformed — paste your numeric ID from @userinfobot (digits only).";
  return null;
}

// Map a Hyperliquid fill's `dir` to an entry/exit + side (perps + spot Buy/Sell).
function classifyFill(fill) {
  const dir = fill.dir || '';
  if (/Open Long/.test(dir) || dir === 'Buy') return { kind: 'open', side: 'long' };
  if (/Open Short/.test(dir)) return { kind: 'open', side: 'short' };
  if (/Close Long/.test(dir) || dir === 'Sell') return { kind: 'close', side: 'long' };
  if (/Close Short/.test(dir)) return { kind: 'close', side: 'short' };
  return { kind: 'other', side: fill.side === 'B' ? 'long' : 'short' };
}

function copyDecision(fill, wallet) {
  const cls = classifyFill(fill);
  const openCount = Object.keys(copyBot.positions).length;
  if (cls.kind !== 'open') return { action: 'SKIP', reason: 'Position exit — tracked to close the paper trade, not copied as a new entry.', cls };
  if (wallet.winRate * 100 < copyBot.config.minWinRate)
    return { action: 'SKIP', reason: `Wallet win rate ${(wallet.winRate * 100).toFixed(0)}% is below the ${copyBot.config.minWinRate}% follow threshold.`, cls };
  if (openCount >= copyBot.config.maxPositions)
    return { action: 'SKIP', reason: `Max ${copyBot.config.maxPositions} open paper positions reached — holding off.`, cls };
  const sizeUsd = copyBot.config.accountSize * (copyBot.config.sizePct / 100);
  return { action: 'COPY', reason: `Top wallet (${(wallet.winRate * 100).toFixed(0)}% win) opened ${cls.side} ${fill.coin}; sized to ${copyBot.config.sizePct}% of the paper account.`, sizeUsd, cls };
}

function applyPaperFill(fill, cls, sizeUsd, action) {
  const key = `${fill.coin}|${cls.side}`;
  const px = parseFloat(fill.px);
  if (cls.kind === 'open' && action === 'COPY') {
    copyBot.positions[key] = { coin: fill.coin, side: cls.side, entryPx: px, sizeUsd, opened: fill.time };
    copyBot.paper.copied++;
    return null;
  }
  if (cls.kind === 'close' && copyBot.positions[key]) {
    const p = copyBot.positions[key];
    const move = (px / p.entryPx - 1) * (p.side === 'long' ? 1 : -1);
    const pnl = p.sizeUsd * move;
    copyBot.paper.realized += pnl;
    if (pnl >= 0) copyBot.paper.wins++; else copyBot.paper.losses++;
    delete copyBot.positions[key];
    return pnl;
  }
  return null;
}

// Decide whether a detected fill should fire a Telegram alert.
function shouldAlert(cls, action) {
  const m = copyBot.config.alertMode;
  if (m === 'all') return true;
  if (m === 'copied') return action === 'COPY';
  return cls.kind === 'open'; // 'entries' (default) — every wallet entry
}

function formatAlert(sig, w) {
  const cls = classifyFill({ dir: sig.dir, side: sig.side });
  const head = cls.kind === 'open' ? '🔔 ENTRY' : cls.kind === 'close' ? '🔻 EXIT' : '↔️ MOVE';
  const sideEmoji = cls.side === 'long' ? '🟢' : '🔴';
  const name = sig.displayName || (sig.wallet.slice(0, 10) + '…');
  const copyTxt = sig.action === 'COPY'
    ? `✅ Copied to paper — $${(sig.sizeUsd || 0).toFixed(0)} (${copyBot.config.sizePct}% of $${copyBot.config.accountSize})`
    : `⚪ Not auto-copied — ${sig.reason}`;
  return `${head} ${sideEmoji} <b>${name}</b> (win ${(w.winRate * 100).toFixed(0)}%)\n` +
    `<b>${sig.dir}</b> ${sig.coin} @ ${sig.px}\n` +
    `${copyTxt}\n` +
    `📊 Track: https://hypurrscan.io/address/${sig.wallet}\n` +
    `\n⚠️ Alert only — verify before trading. Not financial advice.`;
}

async function copyPoll() {
  copyBot.lastPoll = Date.now();
  try {
    const wallets = await getWallets();
    const followed = wallets
      .filter((w) => w.winRate * 100 >= copyBot.config.minWinRate)
      .slice(0, copyBot.config.followCount);
    copyBot.followed = followed.map((w) => ({ address: w.address, displayName: w.displayName, winRate: w.winRate, monthPnl: w.monthPnl }));
    for (const w of followed) {
      let fills;
      try { fills = await hlFills(w.address); } catch (e) { copyBot.lastError = e.message; continue; }
      if (!fills.length) continue;
      // Dedup by trade-id (tid) — these wallets fire many fills per timestamp,
      // so time-based dedup misses trades. First sight emits only the 2 newest.
      const prev = copyBot.seenTids[w.address];
      let fresh = prev ? fills.filter((f) => !prev.has(f.tid)) : fills.slice(0, 2);
      copyBot.seenTids[w.address] = new Set(fills.map((f) => f.tid)); // bounded by the 2000-fill window
      fresh = fresh.slice(0, 6).sort((a, b) => a.time - b.time);
      let alertsThisWallet = 0;
      for (const f of fresh) {
        const decision = copyDecision(f, w);
        const pnl = applyPaperFill(f, decision.cls, decision.sizeUsd || 0, decision.action);
        const sig = {
          time: f.time, wallet: w.address, displayName: w.displayName, side: f.side,
          coin: f.coin, dir: f.dir, px: parseFloat(f.px), sz: parseFloat(f.sz),
          action: decision.action, reason: decision.reason, sizeUsd: decision.sizeUsd || null, realizedPnl: pnl,
        };
        // Cap Telegram pings at 3 per wallet per poll — MM wallets can fire
        // dozens of fills a minute and a flood helps no one.
        if (copyBot.config.alerts && copyBot.config.telegramToken && copyBot.config.telegramChatId &&
            shouldAlert(decision.cls, decision.action) && alertsThisWallet < 3) {
          alertsThisWallet++;
          telegramSend(copyBot.config.telegramToken, copyBot.config.telegramChatId, formatAlert(sig, w))
            .catch((e) => { copyBot.lastError = 'Telegram: ' + e.message; });
          sig.alerted = true;
          copyBot.alertCount = (copyBot.alertCount || 0) + 1;
        }
        copyBot.signals.unshift(sig);
      }
      await sleep(400);
    }
    copyBot.signals = copyBot.signals.slice(0, 60);
  } catch (e) {
    copyBot.lastError = e.message;
  }
}

function copyStatus() {
  const c = copyBot.config;
  const openUsd = Object.values(copyBot.positions).reduce((s, p) => s + p.sizeUsd, 0);
  const equity = c.accountSize + copyBot.paper.realized;
  const closed = copyBot.paper.wins + copyBot.paper.losses;
  return {
    running: copyBot.running,
    config: {
      accountSize: c.accountSize, sizePct: c.sizePct, maxPositions: c.maxPositions,
      minWinRate: c.minWinRate, followCount: c.followCount,
      alerts: c.alerts, alertMode: c.alertMode,
      telegramChatId: c.telegramChatId,
      telegramTokenMask: c.telegramToken ? '••••••' + c.telegramToken.slice(-4) : '',
      telegramConnected: !!(c.telegramToken && c.telegramChatId),
    },
    alertCount: copyBot.alertCount || 0,
    paper: {
      startEquity: c.accountSize, equity, realized: copyBot.paper.realized,
      openPositions: Object.keys(copyBot.positions).length, openUsd,
      copied: copyBot.paper.copied, wins: copyBot.paper.wins, losses: copyBot.paper.losses,
      winRate: closed ? copyBot.paper.wins / closed : null,
    },
    positions: Object.values(copyBot.positions),
    followed: copyBot.followed,
    signals: copyBot.signals.slice(0, 40),
    lastPoll: copyBot.lastPoll, lastError: copyBot.lastError,
  };
}

function startCopyBot() {
  if (copyBot.running) return;
  copyBot.running = true;
  copyBot.lastError = null;
  copyPoll();
  copyBot.timer = setInterval(copyPoll, 90 * 1000);
}
function stopCopyBot() {
  copyBot.running = false;
  if (copyBot.timer) clearInterval(copyBot.timer);
  copyBot.timer = null;
}

// ---------------------------------------------------------------------------
// Meme Sniper — real-time new-token launch radar (GeckoTerminal new pools +
// DexScreener boosts), rug-risk scoring, whale-wallet buy tracking via Solana
// RPC, and a PAPER sniping ledger with Telegram alerts. Same safety design as
// the copy bot: no custody, no keys, no real buys — launch sniping is the most
// rug/honeypot-dense corner of crypto, so the risk scoring is the real value.
// ---------------------------------------------------------------------------
const memeBot = {
  // community-documented active trader wallets (verified on-chain activity);
  // the user should replace these with wallets they trust from kolscan/gmgn.
  watchlist: [
    { address: 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm', label: 'Pump.fun early sniper' },
    { address: '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', label: 'Raydium flipper' },
    { address: '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', label: 'Insider signals' },
  ],
  seenSigs: {},   // addr -> Set of processed tx signatures
  whaleBuys: [],  // detected buys, newest first (ring buffer)
  positions: [],  // paper snipes
  nextPosId: 1,
  paper: { realized: 0, wins: 0, losses: 0 },
  alerts: { enabled: false, minScore: 80 }, // Telegram creds shared with copyBot.config
  alertedPools: new Set(),
};

const SOL_RPC = 'https://api.mainnet-beta.solana.com';
const STABLE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

async function solRpc(method, params) {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} -> HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Solana RPC ${method}: ${data.error.message}`);
  return data.result;
}

// Rug-risk scoring for a fresh pool — more ✓ = safer (nothing here is "safe").
function scoreLaunch(p) {
  const factors = [];
  let score = 20;
  const add = (label, ok, pts) => { factors.push({ label, ok }); if (ok) score += pts; };
  const liq = p.liq || 0, m5 = p.m5 || {};
  add(`Liquidity ≥ $10k ($${Math.round(liq).toLocaleString()})`, liq >= 10_000, 20);
  add('Liquidity ≥ $50k (thick exit)', liq >= 50_000, 8);
  const sellsWork = (m5.sells || 0) > 0 || (p.h1sells || 0) > 0;
  add('Sells going through (honeypot check)', sellsWork, 18);
  add(`Unique buyers ≥ 10 (${m5.buyers ?? 0} in 5m)`, (m5.buyers || 0) >= 10, 12);
  add(`FDV/liquidity < 30 (${p.fdv && liq ? (p.fdv / liq).toFixed(0) : '—'}×)`, p.fdv > 0 && liq > 0 && p.fdv / liq < 30, 12);
  add(`Not vertical yet (5m ${p.chg5m ?? 0}%)`, Math.abs(p.chg5m || 0) < 200, 6);
  add(`Past deploy window (${p.ageMin}min old)`, p.ageMin >= 15, 4);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const flags = [];
  if (liq < 3000) { score = Math.min(score, 35); flags.push('Liquidity under $3k — one seller empties the pool.'); }
  if (liq > 5_000_000 && (p.ageMin ?? 0) < 60) { score = Math.min(score, 30); flags.push('Implausible liquidity for a brand-new pool — likely spoofed/fake reserves.'); }
  if ((m5.buys || 0) >= 5 && !sellsWork) { score = Math.min(score, 30); flags.push('Buys but ZERO sells recorded — possible honeypot (buyers may be unable to sell).'); }
  if ((p.chg5m || 0) > 300) flags.push('Up ' + Math.round(p.chg5m) + '% in 5min — you would be exit liquidity.');
  const grade = score >= 80 ? 'A' : score >= 68 ? 'B' : score >= 56 ? 'C' : 'D';
  return { score, grade, factors, flags };
}

function normalizePool(d, chain) {
  const a = d.attributes || {};
  const [symbol] = (a.name || '?').split(' / ');
  const mint = (d.relationships?.base_token?.data?.id || '').replace(`${chain}_`, '');
  const ageMin = a.pool_created_at ? Math.max(0, Math.round((Date.now() - new Date(a.pool_created_at).getTime()) / 60000)) : null;
  const p = {
    chain, pool: a.address, symbol: symbol.trim(), name: a.name, mint,
    priceUsd: parseFloat(a.base_token_price_usd),
    fdv: parseFloat(a.fdv_usd) || 0,
    liq: parseFloat(a.reserve_in_usd) || 0,
    ageMin,
    m5: a.transactions?.m5 || {},
    h1sells: a.transactions?.h1?.sells || 0,
    chg5m: parseFloat(a.price_change_percentage?.m5) || 0,
    chg1h: parseFloat(a.price_change_percentage?.h1) || 0,
    vol1h: parseFloat(a.volume_usd?.h1) || 0,
    url: `https://www.geckoterminal.com/${chain}/pools/${a.address}`,
  };
  return { ...p, ...scoreLaunch(p) };
}

async function getMemeLaunches() {
  return cached('meme:launches', async () => {
    const nets = ['solana', 'base'];
    const settled = await Promise.allSettled(nets.map((n) =>
      fetchJson(`https://api.geckoterminal.com/api/v2/networks/${n}/new_pools?page=1`)
    ));
    const items = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') return console.error('[meme]', nets[i], s.reason.message);
      (s.value.data || []).forEach((d) => items.push(normalizePool(d, nets[i])));
    });
    items.sort((x, y) => y.score - x.score || (x.ageMin ?? 1e9) - (y.ageMin ?? 1e9));
    // Telegram alert on fresh high-grade launches (uses copy bot's saved creds)
    const c = copyBot.config;
    if (memeBot.alerts.enabled && c.telegramToken && c.telegramChatId) {
      for (const p of items.filter((x) => x.score >= memeBot.alerts.minScore && !memeBot.alertedPools.has(x.pool)).slice(0, 3)) {
        memeBot.alertedPools.add(p.pool);
        telegramSend(c.telegramToken, c.telegramChatId,
          `🎯 <b>LAUNCH RADAR — grade ${p.grade} (${p.score}/100)</b>\n` +
          `<b>${p.symbol}</b> on ${p.chain} · ${p.ageMin}min old\n` +
          `Price ${p.priceUsd} · Liq $${Math.round(p.liq).toLocaleString()} · FDV $${Math.round(p.fdv).toLocaleString()}\n` +
          `5m: ${p.m5.buys || 0} buys / ${p.m5.sells || 0} sells\n${p.url}\n` +
          `\n⚠️ New launches rug constantly. Paper radar — not a buy recommendation.`
        ).catch((e) => console.error('[meme] telegram:', e.message));
      }
      if (memeBot.alertedPools.size > 500) memeBot.alertedPools = new Set([...memeBot.alertedPools].slice(-250));
    }
    return items;
  }, 30 * 1000);
}

async function getMemeTrending() {
  return cached('meme:trending', async () => {
    const [gt, boosts] = await Promise.allSettled([
      fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools'),
      fetchJson('https://api.dexscreener.com/token-boosts/latest/v1'),
    ]);
    const trending = gt.status === 'fulfilled'
      ? (gt.value.data || []).slice(0, 12).map((d) => normalizePool(d, 'solana'))
      : [];
    const boosted = boosts.status === 'fulfilled' && Array.isArray(boosts.value)
      ? boosts.value.slice(0, 12).map((b) => ({ chain: b.chainId, mint: b.tokenAddress, boost: b.amount, url: b.url }))
      : [];
    return { trending, boosted };
  }, 60 * 1000);
}

// Resolve a mint to symbol/price via DexScreener (cached — used by whale feed)
async function resolveMint(mint) {
  return cached(`meme:tok:${mint}`, async () => {
    const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pair = (d.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!pair) return { symbol: mint.slice(0, 6) + '…', priceUsd: null, url: null };
    return {
      symbol: pair.baseToken?.symbol || '?', name: pair.baseToken?.name || '',
      priceUsd: parseFloat(pair.priceUsd) || null, liq: pair.liquidity?.usd || 0,
      chain: pair.chainId, pool: pair.pairAddress, url: pair.url,
    };
  }, 10 * 60 * 1000);
}

// Detect fresh token BUYS by watched wallets: new signatures → parse balance
// deltas → any non-stable mint that increased is a buy.
async function getWhaleBuys() {
  return cached('meme:whales', async () => {
    for (const w of memeBot.watchlist) {
      try {
        const sigs = await solRpc('getSignaturesForAddress', [w.address, { limit: 8 }]);
        const seen = memeBot.seenSigs[w.address] || new Set();
        const fresh = sigs.filter((s) => !s.err && !seen.has(s.signature)).slice(0, 3);
        memeBot.seenSigs[w.address] = new Set(sigs.map((s) => s.signature));
        const firstSight = seen.size === 0;
        for (const s of fresh.slice(0, firstSight ? 1 : 3)) {
          await sleep(250); // public RPC 429s on bursts
          let tx;
          try {
            tx = await solRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          } catch { continue; }
          if (!tx?.meta) continue;
          const deltas = {};
          (tx.meta.postTokenBalances || []).forEach((b) => {
            if (b.owner !== w.address || STABLE_MINTS.has(b.mint)) return;
            deltas[b.mint] = (b.uiTokenAmount?.uiAmount || 0);
          });
          (tx.meta.preTokenBalances || []).forEach((b) => {
            if (b.owner !== w.address || STABLE_MINTS.has(b.mint)) return;
            deltas[b.mint] = (deltas[b.mint] || 0) - (b.uiTokenAmount?.uiAmount || 0);
          });
          for (const [mint, delta] of Object.entries(deltas)) {
            if (delta <= 0) continue; // only buys
            let tok = { symbol: mint.slice(0, 6) + '…' };
            try { tok = await resolveMint(mint); } catch { /* unresolvable */ }
            memeBot.whaleBuys.unshift({
              time: (s.blockTime || 0) * 1000, wallet: w.address, label: w.label,
              mint, amount: delta, ...tok,
            });
          }
        }
        await sleep(300);
      } catch (e) {
        console.error('[meme] whale', w.label, e.message);
      }
    }
    memeBot.whaleBuys = memeBot.whaleBuys.slice(0, 40);
    return { watchlist: memeBot.watchlist, buys: memeBot.whaleBuys };
  }, 45 * 1000);
}

async function memePortfolio() {
  // refresh open position prices (per-pool cache keeps this cheap)
  for (const pos of memeBot.positions.filter((p) => !p.closed)) {
    try {
      const tok = await resolveMint(pos.mint);
      if (tok.priceUsd) pos.lastPx = tok.priceUsd;
    } catch { /* keep last */ }
  }
  const open = memeBot.positions.filter((p) => !p.closed);
  const unrealized = open.reduce((s, p) => s + (p.lastPx ? p.usd * (p.lastPx / p.entryPx - 1) : 0), 0);
  return {
    positions: memeBot.positions.slice(0, 30),
    paper: { ...memeBot.paper, openCount: open.length, openUsd: open.reduce((s, p) => s + p.usd, 0), unrealized },
    alerts: memeBot.alerts,
    telegramConnected: !!(copyBot.config.telegramToken && copyBot.config.telegramChatId),
  };
}

// ---------------------------------------------------------------------------
// Macro context — variables the models were previously blind to. The dollar
// index drives gold/commodities inversely, real yields drive gold and growth
// stocks, and VIX sets the risk regime for equities. All from CNBC dailies.
// ---------------------------------------------------------------------------
const MACRO_SYMS = { dxy: '.DXY', us10y: 'US10Y', vix: '.VIX' };

async function getMacro() {
  return cached('macro', async () => {
    const out = {};
    const settled = await Promise.allSettled(
      Object.entries(MACRO_SYMS).map(async ([k, sym]) => [k, await cnbcDaily(sym)])
    );
    settled.forEach((s) => {
      if (s.status !== 'fulfilled') return;
      const [k, bars] = s.value;
      const c = bars.map((b) => b.c);
      const i = c.length - 1;
      const chg5 = i >= 5 ? (c[i] / c[i - 5] - 1) * 100 : 0;
      const chg20 = i >= 20 ? (c[i] / c[i - 20] - 1) * 100 : 0;
      const sma50 = smaArr(c, 50)[i];
      out[k] = {
        last: +c[i].toFixed(2),
        chg5: +chg5.toFixed(2),
        chg20: +chg20.toFixed(2),
        trend: sma50 ? (c[i] > sma50 ? 'up' : 'down') : 'flat',
        rising: chg5 > 0.4, falling: chg5 < -0.4,
      };
    });
    if (out.vix) out.vix.regime = out.vix.last >= 25 ? 'fear' : out.vix.last <= 15 ? 'complacent' : 'normal';
    return out;
  }, 15 * 60 * 1000);
}

// Macro factors for a given asset group — returns [{label, side, pts}]
function macroFactors(group, macro) {
  const f = [];
  if (!macro) return f;
  const { dxy, us10y, vix } = macro;
  if (group === 'commodity' || group === 'metal') {
    if (dxy?.rising) f.push({ label: `Dollar index rising (+${dxy.chg5}% 5d) — headwind for commodities`, side: 'bear', pts: 10 });
    else if (dxy?.falling) f.push({ label: `Dollar index falling (${dxy.chg5}% 5d) — tailwind for commodities`, side: 'bull', pts: 10 });
    if (us10y?.rising) f.push({ label: `10Y yield rising (+${us10y.chg5}% 5d) — raises the cost of holding metals`, side: 'bear', pts: 6 });
    else if (us10y?.falling) f.push({ label: `10Y yield falling (${us10y.chg5}% 5d) — supports metals`, side: 'bull', pts: 6 });
  } else {
    if (vix?.regime === 'fear') f.push({ label: `VIX ${vix.last} — fear regime, equities fragile`, side: 'bear', pts: 8 });
    else if (vix?.regime === 'complacent' && vix?.falling) f.push({ label: `VIX ${vix.last} and falling — risk-on backdrop`, side: 'bull', pts: 6 });
    if (us10y?.rising && us10y.chg5 > 2) f.push({ label: `10Y yield spiking (+${us10y.chg5}% 5d) — pressure on growth multiples`, side: 'bear', pts: 6 });
    if (dxy?.rising && dxy.chg5 > 1) f.push({ label: `Dollar surging (+${dxy.chg5}% 5d) — hits multinational earnings`, side: 'bear', pts: 4 });
  }
  return f;
}

// Crypto open-interest trend: price up + OI up = real money entering (trend
// confirmation); price up + OI down = short covering (weaker, fades faster).
async function getOiTrend(sym) {
  return cached(`oi:${sym}`, async () => {
    const d = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}USDT&period=1h&limit=24`);
    if (!Array.isArray(d) || d.length < 6) throw new Error('no OI history');
    const first = parseFloat(d[0].sumOpenInterest), last = parseFloat(d.at(-1).sumOpenInterest);
    const chgPct = ((last / first) - 1) * 100;
    return { chgPct: +chgPct.toFixed(2), rising: chgPct > 1, falling: chgPct < -1 };
  }, 10 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Signal Ledger — the app grades its own predictions. Every signal is recorded
// with its levels, then resolved against real subsequent price action (did the
// target hit before the stop?). This turns "accuracy" from an assertion into a
// measured number, and lets the models be tuned by evidence instead of taste.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'signals.json');
const ledger = { signals: [], stats: null, loaded: false, dirty: false };

async function loadLedger() {
  if (ledger.loaded) return;
  ledger.loaded = true;
  try {
    const raw = await fs.promises.readFile(LEDGER_FILE, 'utf8');
    const d = JSON.parse(raw);
    ledger.signals = Array.isArray(d.signals) ? d.signals : [];
    console.log(`[ledger] loaded ${ledger.signals.length} signals`);
    // v2: outcomes before this were scored with an unbounded replay window, so
    // a target touched long after the signal's horizon counted as a win. Those
    // verdicts are not trustworthy — reopen them for honest re-scoring.
    if ((d.schema || 1) < 3) {
      let reopened = 0;
      for (const s of ledger.signals) {
        if (['win', 'loss', 'expired-favourable', 'expired-adverse', 'no-fill'].includes(s.status)) {
          s.status = 'open'; delete s.resolvedAt; delete s.exitPx; delete s.filledAt;
          s.note = 're-scored: bounded window + entry-fill required'; reopened++;
        }
      }
      ledger.dirty = true;
      console.log(`[ledger] schema v3: reopened ${reopened} outcomes — now require the entry to actually fill before scoring`);
    }
  } catch {
    await fs.promises.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    console.log('[ledger] starting a fresh signal ledger');
  }
}

// Saves are serialised. The resolver, the scalp recorder and the picks recorder
// each save on their own timers, and when two overlapped they shared one .tmp
// path: the first rename moved it, the second hit ENOENT (22× in err.log by
// 2026-10-16), and the second writer could still be rewriting the inode that
// had just been renamed into place as signals.json. Chaining means each save
// waits for the one in flight; a queued save with nothing new is a no-op.
let ledgerSaveChain = Promise.resolve();
function saveLedger() {
  ledgerSaveChain = ledgerSaveChain.then(writeLedger);
  return ledgerSaveChain;
}

async function writeLedger() {
  if (!ledger.dirty) return;
  ledger.dirty = false;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = LEDGER_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ schema: 3, signals: ledger.signals.slice(-4000) }));
    await fs.promises.rename(tmp, LEDGER_FILE); // atomic — never leaves a half-written ledger
  } catch (e) {
    ledger.dirty = true; // retry on the next save rather than silently dropping it
    console.error('[ledger] save failed:', e.message);
  }
}

// Dedupe key: the same live setup re-appears every poll; record it once.
// Per-factor attribution. For each grading factor, compare the hit rate of
// signals where it fired against those where it did not. A factor worth points
// should show a positive lift; one with a negative lift is actively costing
// accuracy and its weight is wrong. This is what makes the grader diagnosable
// instead of merely observable — every previous pass could see that the grades
// were inverted but had no way to tell which term caused it.
// Head-to-head: the app's own signal engine against the TradingAgents LLM desk,
// scored by the identical resolver on identical rules. The comparison is only
// meaningful because neither side gets to mark its own homework — both are
// replayed against real candles with fill-then-target-vs-stop.
function deskComparison() {
  const by = {};
  for (const r of ledger.signals) {
    if (!['win', 'loss'].includes(r.status)) continue;
    const desk = r.kind === 'llmdesk' ? 'TradingAgents (LLM debate)'
      : r.kind === 'pick' ? 'Position Picks'
        : r.kind === 'scalp15' ? '15-min scalps' : '5-min scalps';
    (by[desk] ||= []).push(r);
  }
  return Object.entries(by).map(([desk, rows]) => {
    const wins = rows.filter((r) => r.status === 'win').length;
    const ms = rows.map((r) => r.rMultiple).filter((x) => typeof x === 'number' && x > 0);
    const R = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 1;
    const hit = wins / rows.length;
    const cost = meanCostR(rows);
    const ev = hit * R - (1 - hit);
    return {
      desk, n: rows.length, hitRate: +(hit * 100).toFixed(1),
      rMultiple: +R.toFixed(2), breakeven: +(100 / (R + 1)).toFixed(1),
      evR: +ev.toFixed(3),
      costR: cost == null ? null : +cost.toFixed(3),
      netEvR: cost == null ? null : +(ev - cost).toFixed(3),
      enough: rows.length >= 20,
    };
  }).sort((a, b) => b.evR - a.evR);
}

// Factor stability. A single-window lift is not evidence — it is one sample of a
// noisy quantity, and this project has now twice changed weights on one that
// reversed: the RVOL/ADX gates in August (fine on 5m, -0.116R out-of-sample on
// 15m) and volSurge on 14 Sep (measured -20.0 lift, then +6.3 in the period
// that followed). Splitting the instrumented history into thirds and demanding
// a factor keep its SIGN across them is a much harder test, and as of 25 Sep
// only one factor passes it. Anything that fails should not have its weight
// tuned on the strength of a fresh measurement — its honest weight is near zero,
// because you cannot predict which sign it will show next.
function factorStability() {
  const rows = ledger.signals
    .filter((r) => ['win', 'loss'].includes(r.status) && Array.isArray(r.fk))
    .sort((a, b) => (a.resolvedAt || a.time) - (b.resolvedAt || b.time));
  if (rows.length < 90) return { samples: rows.length, note: 'Needs ~90 instrumented signals to split into three testable periods.' , factors: [] };
  const t = Math.floor(rows.length / 3);
  const parts = [rows.slice(0, t), rows.slice(t, 2 * t), rows.slice(2 * t)];
  const hit = (z) => (z.length ? (z.filter((r) => r.status === 'win').length / z.length) * 100 : null);
  const keys = [...new Set(rows.flatMap((r) => r.fk))];
  const out = [];
  for (const k of keys) {
    const lifts = parts.map((p) => {
      const on = p.filter((r) => r.fk.includes(k)), off = p.filter((r) => !r.fk.includes(k));
      return (on.length >= 12 && off.length >= 12) ? +(hit(on) - hit(off)).toFixed(1) : null;
    });
    const valid = lifts.filter((x) => x !== null);
    if (valid.length < 2) { out.push({ factor: k, lifts, verdict: 'insufficient data', stable: null }); continue; }
    const sameSign = valid.every((x) => x > 0) || valid.every((x) => x < 0);
    const material = valid.every((x) => Math.abs(x) >= 3);
    const stable = sameSign && material;
    out.push({
      factor: k, lifts, stable,
      verdict: stable ? `STABLE ${valid[0] > 0 ? 'positive' : 'negative'} across ${valid.length} periods`
        : 'unstable — sign flips between periods, so no weight change is justified by a fresh reading',
    });
  }
  out.sort((a, b) => (b.stable === true) - (a.stable === true));
  return {
    samples: rows.length, periods: parts.map((p) => p.length),
    factors: out,
    stableCount: out.filter((f) => f.stable).length,
    rule: 'Only a factor that holds its sign across periods has earned a weight. A one-window lift, however large, is one sample of a noisy quantity — this project has twice tuned on one that later reversed.',
  };
}

function factorAttribution(kind) {
  const rows = ledger.signals.filter((s) => (s.status === 'win' || s.status === 'loss')
    && Array.isArray(s.fk) && (!kind || s.kind === kind));
  const out = { samples: rows.length, factors: [], extension: [] };
  if (rows.length < 20) {
    out.note = `Only ${rows.length} instrumented signals so far — needs 20+ per side before any weight should be touched. Instrumentation added 2026-09-08; earlier signals predate it.`;
    return out;
  }
  const keys = [...new Set(rows.flatMap((s) => s.fk))];
  const rate = (rs) => (rs.length ? (rs.filter((r) => r.status === 'win').length / rs.length) * 100 : null);
  for (const k of keys) {
    const on = rows.filter((s) => s.fk.includes(k));
    const off = rows.filter((s) => !s.fk.includes(k));
    if (on.length < 20 || off.length < 20) continue;
    const a = rate(on), b = rate(off);
    out.factors.push({
      factor: k, firedN: on.length, firedHit: +a.toFixed(1),
      notFiredN: off.length, notFiredHit: +b.toFixed(1), lift: +(a - b).toFixed(1),
      verdict: a - b >= 3 ? 'earns its weight' : a - b <= -3 ? 'ANTI-PREDICTIVE — weight is wrong' : 'no measurable effect',
    });
  }
  out.factors.sort((x, y) => x.lift - y.lift);
  // Whether the grade letter currently means anything at all. Measured 14 Sep:
  // no reweighting of the existing factors produced a predictive score, so the
  // honest thing is to publish that rather than let an "A" imply quality it has
  // not earned.
  const byGrade = {};
  for (const g of ['A', 'B', 'C', 'D']) {
    const rs = rows.filter((r) => r.grade === g);
    if (rs.length >= 20) byGrade[g] = { n: rs.length, hit: +rate(rs).toFixed(1) };
  }
  const ordered = Object.keys(byGrade);
  out.gradeMeaning = {
    bands: byGrade,
    discriminating: ordered.length >= 2
      ? ordered.every((g, i) => i === 0 || byGrade[ordered[i - 1]].hit >= byGrade[g].hit)
      : null,
    note: 'Grades are ranked by confluence score, which has measured no predictive power. Treat the letter as a description of the setup, not a forecast — strategy and asset class are the terms that actually separate winners from losers.',
  };
  const buckets = [[0, 0.6], [0.6, 1.2], [1.2, 2], [2, 99]];
  for (const [lo, hi] of buckets) {
    const rs = rows.filter((s) => typeof s.ext === 'number' && Math.abs(s.ext) >= lo && Math.abs(s.ext) < hi);
    if (rs.length >= 20) out.extension.push({ band: `${lo}-${hi === 99 ? 'inf' : hi}xATR`, n: rs.length, hit: +rate(rs).toFixed(1) });
  }
  // Relative strength is recorded but deliberately unweighted until it shows a
  // measured lift here — the point of this instrumentation is to stop assigning
  // weights by intuition.
  out.relStrength = [];
  for (const [lo, hi, lab] of [[-99, -2, 'lagging'], [-2, 2, 'in line'], [2, 99, 'leading']]) {
    const rs = rows.filter((s) => typeof s.rs === 'number' && s.rs >= lo && s.rs < hi);
    if (rs.length >= 20) out.relStrength.push({ band: lab, n: rs.length, hit: +rate(rs).toFixed(1) });
  }
  if (!out.relStrength.length) out.relStrength = { note: 'Recorded on stock signals since 2026-09-08; not yet 20 resolved per band, so it carries no weight.' };
  return out;
}

function recordSignal(sig) {
  const key = `${sig.kind}|${sig.symbol}|${sig.direction}|${sig.strategy || ''}|${Math.round((sig.entry || 0) * 1e6)}`;
  const cutoff = Date.now() - 6 * 3600 * 1000;
  if (ledger.signals.some((s) => s.key === key && s.time > cutoff)) return false;
  ledger.signals.push({
    key, id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    time: Date.now(), status: 'open', ...sig,
  });
  ledger.dirty = true;
  return true;
}

// Resolve level-based signals by replaying candles after the signal fired.
// Binance serves any past window by startTime, so a crypto signal can be scored
// on the bars that actually followed it however long the app was offline. The
// scanner's own feed is the latest 240 bars (~20h of 5m), which a sleeping Mac
// outlives: the resolver then scored signals on whatever bars came later.
async function binanceRange(sym, interval, startMs, endMs) {
  const out = [];
  let from = startMs;
  for (let page = 0; page < 40 && from < endMs; page++) {
    const raw = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`);
    if (!Array.isArray(raw) || !raw.length) break;
    for (const k of raw) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    from = raw.at(-1)[0] + 1;
    if (raw.length < 1000) break;
  }
  return out;
}

// CNBC's "1D" chart actually serves ~48h of 1-minute bars, but cnbcBars keeps
// only the newest 220 by default: ~18h of 5m bars and under 4h of 1m. The
// scanner needs no more, but the resolver does, to score a signal after the app
// was offline (measured 15 Oct: 1,881-2,594 1m bars back to 48h, on NVDA, PL, NG).
function cnbcFull(meta, tfMs) {
  return cached(`cnbc-full:${meta.cnbc}:${tfMs}`, () => cnbcBars(meta.cnbc, tfMs, Infinity), 60 * 1000);
}

// Inside the bar that filled an order, only the level on the SAME side as the
// fill can be ordered after it. A buy limit fills on the way down, so a stop
// below can follow it in that bar, but a target above may have printed before
// the dip ever reached the entry; a buy stop is the mirror image (its target
// follows the fill, its stop may have come first). One-minute bars settle the
// order. Measured 14 Oct on 122 crypto limit signals: 11 of 50 "wins" were
// decided inside the fill bar, and 1-minute data showed 4 of them were losses.
// Returns win | loss | ambiguous | open (filled, nothing hit after it in the
// bar) | nodata.
async function fillBarFromMinutes(meta, barT, barMs, lv) {
  let mins;
  try {
    mins = meta.kind === 'crypto'
      ? await binanceRange(meta.fetch, '1m', barT, barT + barMs - 1)
      : (await cnbcFull(meta, 60000)).filter((m) => m.t >= barT && m.t < barT + barMs);
  } catch { return 'nodata'; }
  if (!mins?.length) return 'nodata';
  let filled = false;
  for (const m of mins) {
    const tgt = lv.long ? m.h >= lv.target : m.l <= lv.target;
    const stp = lv.long ? m.l <= lv.stop : m.h >= lv.stop;
    if (!filled) {
      const touch = lv.isLimit ? (lv.long ? m.l <= lv.entry : m.h >= lv.entry) : (lv.long ? m.h >= lv.entry : m.l <= lv.entry);
      if (!touch) continue;
      filled = true;
      // Same rule one level down: inside the fill minute, only the near level counts.
      if (lv.isLimit ? tgt : stp) return 'ambiguous';
      if (lv.isLimit ? stp : tgt) return lv.isLimit ? 'loss' : 'win';
      continue;
    }
    if (tgt && stp) return 'ambiguous';
    if (tgt) return 'win';
    if (stp) return 'loss';
  }
  return filled ? 'open' : 'nodata';
}

async function resolveSignals() {
  await loadLedger();
  const now = Date.now();
  const open = ledger.signals.filter((s) => s.status === 'open');
  if (!open.length) return;
  const bySym = {};
  for (const s of open) (bySym[`${s.symbol}|${s.res || '5m'}`] ||= []).push(s);
  for (const [k, sigs] of Object.entries(bySym)) {
    const [symbol, res] = k.split('|');
    const meta = SCALP_UNIVERSE.find((m) => m.display === symbol) || PICKS_UNIVERSE.find((m) => m.symbol === symbol);
    if (!meta) { sigs.forEach((s) => { s.status = 'void'; s.note = 'symbol no longer tracked'; }); ledger.dirty = true; continue; }
    let candles;
    try {
      // Daily bars come from CNBC for stocks and futures — but CNBC carries no
      // crypto, so a daily crypto call (the agent desk scoring what the Bybit
      // account trades) would sit "open" forever. Crypto dailies come from
      // Binance instead. Affects only res='1d' signals on crypto symbols, of
      // which none existed before 30 Sep, so no prior result can change.
      const tf = TF_MS_MAP[res] ? res : '5m', tfMs = TF_MS_MAP[tf] || 300000;
      candles = res === '1d'
        ? (meta.kind === 'crypto' ? await binanceDaily(meta.fetch) : await cnbcDaily(meta.cnbc))
        : meta.kind === 'crypto'
          // Exactly the window these signals need, from the bar they fired in.
          ? await binanceRange(meta.fetch, tf, Math.min(...sigs.map((s) => s.time)) - tfMs,
            Math.min(now, Math.max(...sigs.map((s) => s.time + (s.maxBars || 48) * tfMs)) + tfMs))
          : await (async () => {
            const sm = SCALP_UNIVERSE.find((m) => m.display === symbol) || meta;
            // The full ~48h, not the scanner's 220-bar slice; Yahoo if CNBC fails.
            if (sm.cnbc) { try { return await cnbcFull(sm, tfMs); } catch { /* fall through */ } }
            return fetchScalpCandles(sm, tf);
          })();
    } catch { continue; }
    for (const s of sigs) {
      const barMs = res === '1d' ? 86400000 : (TF_MS_MAP[res] || 300000);
      const maxBars = s.maxBars || (res === '1d' ? 10 : 48);
      const maxAgeMs = maxBars * barMs;
      // Replay ONLY the bars inside the signal's intended horizon. Without this
      // bound, a 4-hour scalp could be scored a "win" because its target was
      // grazed 18 hours later — given enough time almost any target is touched,
      // which would make every hit rate meaningless.
      // The bars must reach back to the signal itself. CNBC serves one session
      // and can't be asked for older bars, so a signal still open when its
      // history rolls off (the app was offline) can't be scored honestly. Before
      // this, 16 limit orders were "filled" 34-42 bars into a 6-bar window.
      if (!candles.length || candles[0].t > s.time) {
        s.status = 'void'; s.resolvedAt = now;
        s.note = 'candle history no longer reaches back to the signal (app was offline), so it cannot be scored';
        ledger.dirty = true;
        continue;
      }
      const after = candles.filter((c) => c.t > s.time && c.t <= s.time + maxAgeMs);
      if (!after.length) {
        if (now - s.time > maxAgeMs * 2) { s.status = 'void'; s.note = 'no candle coverage inside the signal window'; ledger.dirty = true; }
        continue;
      }
      let long = s.direction === 'LONG' || s.direction === 'BULLISH';
      let legEntry = s.entry, legTarget = s.target;
      // A bracket resolves to whichever side the market actually triggered
      // first; from that point it is an ordinary directional trade.
      if (s.direction === '2-WAY' && s.entryShort != null) {
        const iLong = after.findIndex((c) => c.h >= s.entry);
        const iShort = after.findIndex((c) => c.l <= s.entryShort);
        if (iLong < 0 && iShort < 0) {
          if (now - s.time > maxAgeMs) {
            s.status = 'no-fill'; s.resolvedAt = now;
            s.note = 'neither side of the bracket triggered'; ledger.dirty = true;
          }
          continue;
        }
        const shortFirst = iLong < 0 || (iShort >= 0 && iShort < iLong);
        long = !shortFirst;
        s.filledLeg = shortFirst ? 'SHORT' : 'LONG';
        // Use locals — mutating s.entry/s.target would overwrite the recorded
        // setup with the leg that happened to trigger, corrupting the ledger
        // and making any re-resolution read the wrong levels.
        if (shortFirst) { legEntry = s.entryShort; legTarget = s.targetShort; }
      }
      // Two-phase simulation of a resting stop order. Phase 1: the entry must
      // actually be REACHED. Previously the resolver checked target/stop from
      // the signal instant, so a buy-stop that never filled still recorded a
      // loss when price fell to the (lower) stop level — a trade that was never
      // taken. That manufactured losses and destroyed every hit rate.
      // Stop orders fill when price crosses the level in the trade's direction;
      // resting limits fill when price comes BACK to it, and only while the
      // order is live — a limit cancelled after its window never fills later.
      const isLimit = s.exec === 'limit';
      const window = isLimit ? (s.fillWindowBars || 6) : after.length;
      const fillIdx = after.slice(0, window).findIndex((c) => (isLimit
        ? (long ? c.l <= legEntry : c.h >= legEntry)
        : (long ? c.h >= legEntry : c.l <= legEntry)));
      let outcome = null;
      if (fillIdx >= 0) {
        s.filledAt = after[fillIdx].t;
        let j0 = fillIdx;
        const fb = after[fillIdx];
        const farInFillBar = isLimit
          ? (long ? fb.h >= legTarget : fb.l <= legTarget)
          : (long ? fb.l <= s.stop : fb.h >= s.stop);
        if (res !== '1d' && farInFillBar) {
          const r = await fillBarFromMinutes(meta, fb.t, barMs, { long, isLimit, entry: legEntry, target: legTarget, stop: s.stop });
          if (r === 'nodata') outcome = 'unordered';
          else if (r === 'open') j0 = fillIdx + 1;
          else outcome = r;
        }
        if (!outcome) for (let j = j0; j < after.length; j++) {
          const c = after[j];
          const hitTarget = long ? c.h >= legTarget : c.l <= legTarget;
          const hitStop = long ? c.l <= s.stop : c.h >= s.stop;
          if (hitTarget && hitStop) { outcome = 'ambiguous'; break; } // same bar — can't tell order
          if (hitTarget) { outcome = 'win'; break; }
          if (hitStop) { outcome = 'loss'; break; }
        }
      }
      if (outcome) {
        s.status = outcome === 'ambiguous' || outcome === 'unordered' ? 'void' : outcome;
        s.resolvedAt = now;
        if (outcome === 'ambiguous') s.note = 'target and stop hit in the same bar';
        if (outcome === 'unordered') s.note = 'filled and reached the far level in the same bar, with no 1-minute data to tell which came first';
        ledger.dirty = true;
      } else if (fillIdx < 0 && now - s.time > maxAgeMs) {
        // Never triggered inside its window — no trade happened. Not a loss.
        s.status = 'no-fill';
        s.resolvedAt = now;
        s.note = 'entry never reached within the signal window';
        ledger.dirty = true;
      } else if (now - s.time > maxAgeMs) {
        // Expired without resolution — score at the END OF ITS WINDOW, not at
        // whatever price happens to be printing today.
        const lastPx = after.at(-1).c;
        const moved = long ? lastPx - s.entry : s.entry - lastPx;
        s.status = moved > 0 ? 'expired-favourable' : 'expired-adverse';
        s.resolvedAt = now;
        s.exitPx = lastPx;
        ledger.dirty = true;
      }
    }
  }
  await saveLedger();
}

function ledgerStats() {
  const resolved = ledger.signals.filter((s) => ['win', 'loss', 'expired-favourable', 'expired-adverse'].includes(s.status));
  const bucket = (arr) => {
    const wins = arr.filter((s) => s.status === 'win').length;
    const losses = arr.filter((s) => s.status === 'loss').length;
    const decided = wins + losses;
    const fav = arr.filter((s) => s.status === 'expired-favourable').length;
    return {
      n: arr.length, wins, losses, decided,
      hitRate: decided >= 5 ? +((wins / decided) * 100).toFixed(1) : null,
      driftRate: arr.length >= 5 ? +(((wins + fav) / arr.length) * 100).toFixed(1) : null,
    };
  };
  const groupBy = (keyFn) => {
    const m = {};
    resolved.forEach((s) => { const k = keyFn(s); if (k) (m[k] ||= []).push(s); });
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, bucket(v)]));
  };
  // How often the trigger actually fires is itself a signal-quality metric: a
  // setup that rarely fills is describing a move that mostly never happened.
  const noFill = ledger.signals.filter((s) => s.status === 'no-fill').length;
  const attempted = resolved.length + noFill;
  return {
    overall: bucket(resolved),
    fill: { noFill, attempted, fillRate: attempted >= 10 ? +((resolved.length / attempted) * 100).toFixed(1) : null },
    open: ledger.signals.filter((s) => s.status === 'open').length,
    total: ledger.signals.length,
    byKind: groupBy((s) => s.kind),
    byStrategy: groupBy((s) => s.strategy),
    byGrade: groupBy((s) => s.grade),
    byDirection: groupBy((s) => s.direction),
    bySymbol: groupBy((s) => s.symbol),
    recent: ledger.signals.slice(-25).reverse().map((s) => ({
      time: s.time, kind: s.kind, symbol: s.symbol, direction: s.direction,
      strategy: s.strategy, grade: s.grade, status: s.status, entry: s.entry, target: s.target, stop: s.stop,
    })),
  };
}

// Evidence-based reliability: once a strategy or grade has a real track record,
// nudge new signals of that type up or down. Small samples are ignored on
// purpose — the model should not chase noise.
// Scoped to a ledger kind so each timeframe tunes on its own evidence — a
// strategy that works on 15m candles shouldn't be penalised by its 5m record.
function reliabilityAdj(strategy, grade, kind, direction) {
  if (!ledger.signals.length) return { adj: 0, note: null };
  const decided = ledger.signals.filter((s) => ['win', 'loss'].includes(s.status) && (!kind || s.kind === kind));
  if (decided.length < 20) return { adj: 0, note: null };
  // Judge each strategy on its RECENT record, not its whole history. The models
  // get fixed over time, so a blended lifetime rate anchors the tuner to a
  // version that no longer exists — and the longer the ledger grows, the harder
  // it becomes for a genuine improvement to move the number. (Measured 17 Aug:
  // EMA Pullback was running 75% since the 15 Aug fixes but its lifetime rate
  // of 46% was still driving the adjustment.) Rolling window, newest first.
  const RECENT_WINDOW = 50;
  const rate = (rows) => {
    const recent = rows
      .slice()
      .sort((a, b) => (b.resolvedAt || b.time) - (a.resolvedAt || a.time))
      .slice(0, RECENT_WINDOW);
    if (recent.length < 20) return null;
    return { n: recent.length, hit: (recent.filter((r) => r.status === 'win').length / recent.length) * 100 };
  };
  let adj = 0; const notes = [];
  // Each strategy is judged against ITS OWN breakeven. Measured 21 Aug: the
  // tuner compared every hit rate to a flat 50%, but that is only correct for
  // 1R targets. Coil Breakout aims at ~2R, so it breaks even at 33% — a
  // profitable 40% version was being penalised as if it were failing.
  const breakevenFor = (rows) => {
    const rs = rows.map((r) => r.rMultiple).filter((x) => typeof x === 'number' && x > 0);
    const R = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1;
    return 100 / (R + 1);
  };
  // Direction scoping. The picks desk runs one strategy ('multi-factor'), so
  // per-strategy scoping tells it nothing — yet its longs and shorts have
  // completely different records (measured 14 Sep: longs 23.7% over 38, shorts
  // 0% over 22). Where a direction has its own track record, judge it on that.
  const stratRows = decided.filter((r) => r.strategy === strategy
    && (!direction || r.direction === direction));
  const s = rate(stratRows);
  if (s) {
    const be = breakevenFor(stratRows);
    const d = Math.max(-8, Math.min(8, Math.round((s.hit - be) / 4)));
    if (d) { adj += d; notes.push(`${strategy} has hit ${s.hit.toFixed(0)}% over its last ${s.n} (breakeven ${be.toFixed(0)}%)`); }
    // Evidence penalty. The ±8 band was calibrated when the ledger was small,
    // and it is far too gentle once a strategy has a real track record of
    // losing money: the 15-minute EMA Pullback measured -0.38R over 55 trades
    // and was still surfacing as a grade-A setup after its -5 nudge. Once the
    // sample is large enough to trust (40+) and the expectancy is clearly
    // negative, scale the penalty by how much it loses, enough to drop it out
    // of the actionable band rather than merely rank it lower. Self-correcting:
    // as expectancy recovers toward breakeven the penalty fades to nothing.
    const R = (() => { const rs = stratRows.map((r) => r.rMultiple).filter((x) => typeof x === 'number' && x > 0);
      return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1; })();
    const hit = s.hit / 100;
    const evR = hit * R - (1 - hit);
    // Second trigger for records that are conclusive before they are large.
    // The n>=40 bar assumes the doubt is sample size, but some records are
    // decisive sooner: the picks desk went 0 for 22 on shorts, which under a 33%
    // breakeven has probability ~0.0001. Waiting for 40 would keep surfacing a
    // book that has never once worked. Fire when even the optimistic end of a
    // 95% Wilson interval still sits below breakeven — i.e. the best defensible
    // reading of this record still loses money. Verified 14 Sep against every
    // strategy in the ledger: this changes exactly one group (picks shorts) and
    // leaves every scalp adjustment identical.
    const wilsonUpper = (wins, n, z = 1.96) => {
      if (!n) return 1;
      const p = wins / n, den = 1 + (z * z) / n;
      const centre = (p + (z * z) / (2 * n)) / den;
      const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
      return centre + margin;
    };
    const winsRecent = Math.round((s.hit / 100) * s.n);
    const conclusive = wilsonUpper(winsRecent, s.n) * 100 < be;
    if (evR <= -0.15 && (s.n >= 40 || conclusive)) {
      const extra = Math.max(-30, Math.round(evR * 80));
      adj += extra;
      notes.push(conclusive && s.n < 40
        ? `${s.hit.toFixed(0)}% over ${s.n} — conclusively below the ${be.toFixed(0)}% breakeven — demoted (${extra})`
        : `expectancy ${evR.toFixed(2)}R over ${s.n} trades — demoted (${extra})`);
    }
  } else {
    // Desk-level fallback. A strategy with too few trades of its own is
    // invisible to the tuner, even when the whole timeframe is demonstrably
    // failing. (Measured 19 Aug: the 15-minute desk ran 13.6% post-fix over 22
    // resolutions vs 46.6% for 5-minute, but 20 of its 61 resolved trades came
    // from strategies below the per-strategy threshold.) Judge those on the
    // desk's own record instead, with a gentler bound since it is a coarser
    // signal — and it fades automatically if the timeframe recovers.
    const deskRate = rate(decided);
    if (deskRate) {
      const d = Math.max(-5, Math.min(5, Math.round((deskRate.hit - 50) / 6)));
      if (d) { adj += d; notes.push(`this timeframe has hit ${deskRate.hit.toFixed(0)}% over its last ${deskRate.n} trades`); }
    }
  }
  const g = rate(decided.filter((r) => r.grade === grade));
  if (g) {
    const d = Math.max(-6, Math.min(6, Math.round((g.hit - 55) / 5)));
    if (d) { adj += d; notes.push(`grade ${grade} has hit ${g.hit.toFixed(0)}% over its last ${g.n}`); }
  }
  return { adj, note: notes.join(' · ') || null };
}

// Which UTC hours are historically choppy for this asset class? Setups fired
// in a known chop hour get penalised — timing was previously ignored entirely.
async function chopHours(group) {
  const proxy = group === 'crypto' ? 'BTC' : group === 'stock' ? 'QQQ' : 'XAUUSD';
  try {
    const s = await getSeasonality(proxy);
    return { avoid: s.avoid, best: s.best, proxy };
  } catch {
    return { avoid: [], best: [], proxy };
  }
}

// ---------------------------------------------------------------------------
// Session Seasonality — empirical hour-by-hour stats: when do candles actually
// trend vs chop, per symbol. XAUUSD (gold) is first-class: Yahoo GC=F hourly
// (~92 days) with Binance PAXG (tokenized gold) as fallback, weekends excluded.
// ---------------------------------------------------------------------------
const SEASON_SYMBOLS = ['XAUUSD', 'BTC', 'ETH', 'SOL', 'QQQ'];

async function seasonCandles(sym) {
  if (['BTC', 'ETH', 'SOL'].includes(sym)) {
    const raw = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=1000`);
    return { candles: raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })), excludeWeekends: false, source: 'Binance 1h' };
  }
  const ySym = sym === 'XAUUSD' ? 'GC=F' : sym;
  try {
    const d = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=3mo&interval=1h`);
    const r = d?.chart?.result?.[0];
    if (!r?.timestamp) throw new Error('no data');
    const q = r.indicators.quote[0];
    const candles = r.timestamp.map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
      .filter((x) => x.o != null && x.c != null && x.h != null && x.l != null);
    return { candles, excludeWeekends: false, source: (sym === 'XAUUSD' ? 'COMEX gold futures' : ySym) + ' hourly, 3mo (Yahoo)' };
  } catch (err) {
    if (sym !== 'XAUUSD') throw err;
    // fallback: tokenized gold trades 24/7 — drop the synthetic weekend candles
    const raw = await fetchJson('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1h&limit=1000');
    return { candles: raw.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })), excludeWeekends: true, source: 'PAXG tokenized gold (Binance)' };
  }
}

async function getSeasonality(sym) {
  return cached(`season:${sym}`, async () => {
    const { candles, excludeWeekends, source } = await seasonCandles(sym);
    const byHour = {}, byDow = {};
    for (const k of candles) {
      const d = new Date(k.t);
      const dow = d.getUTCDay();
      if (excludeWeekends && (dow === 0 || dow === 6)) continue;
      const rng = k.h - k.l;
      if (rng <= 0 || !k.o) continue;
      const rec = { dir: Math.abs(k.c - k.o) / rng, move: (k.c / k.o - 1) * 100, range: (rng / k.o) * 100 };
      (byHour[d.getUTCHours()] ||= []).push(rec);
      (byDow[dow] ||= []).push(rec);
    }
    const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
    const hours = [];
    for (let hr = 0; hr < 24; hr++) {
      const v = byHour[hr];
      if (!v || v.length < 15) continue; // not enough samples (e.g. market closed)
      hours.push({
        hr, n: v.length,
        dir: +mean(v, (x) => x.dir).toFixed(3),
        range: +mean(v, (x) => x.range).toFixed(3),
        move: +mean(v, (x) => x.move).toFixed(3),
        green: +((v.filter((x) => x.move > 0).length / v.length) * 100).toFixed(0),
      });
    }
    if (hours.length < 6) throw new Error('not enough hourly coverage for ' + sym);
    // "best" = directional AND moving: rank by dir × range; "avoid" = lowest dir
    const ranked = [...hours].sort((a, b) => b.dir * b.range - a.dir * a.range);
    const best = ranked.slice(0, 4).map((h) => h.hr).sort((a, b) => a - b);
    const avoid = [...hours].sort((a, b) => a.dir - b.dir).slice(0, 3).map((h) => h.hr).sort((a, b) => a - b);
    const DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = Object.entries(byDow).map(([d, v]) => ({
      day: DOWN[+d], move: +v.reduce((s, x) => s + x.move, 0).toFixed(2),
      green: +((v.filter((x) => x.move > 0).length / v.length) * 100).toFixed(0),
    }));
    const spanDays = Math.round((candles.at(-1).t - candles[0].t) / 86400000);
    return { symbol: sym, source, days: spanDays, bars: candles.length, hours, best, avoid, dow };
  }, 6 * 60 * 60 * 1000); // hourly seasonality shifts slowly — recompute every 6h
}

// ---------------------------------------------------------------------------
// Options Desk — crypto options judgment for USDT pairs (BTC/ETH). Real data:
// Deribit public chains (per-strike IV + open interest), the DVOL implied-vol
// index, realized vol from Binance daily candles, plus the app's live funding
// and order-flow feeds. Direction × volatility-pricing → concrete strategy.
// ---------------------------------------------------------------------------
const OPTIONS_UNIVERSE = ['BTC', 'ETH'];
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseOptName(name) {
  // e.g. BTC-29AUG26-60000-C
  const m = name.match(/^\w+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/);
  if (!m) return null;
  const expiry = Date.UTC(2000 + +m[3], MONTHS[m[2]], +m[1], 8, 0, 0); // Deribit expires 08:00 UTC
  return { expiry, strike: parseFloat(m[4].replace('d', '.')), type: m[5] };
}

async function deribitChain(cur) {
  return cached(`opt:chain:${cur}`, async () => {
    const d = await fetchJson(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${cur}&kind=option`);
    return (d.result || []).map((o) => {
      const p = parseOptName(o.instrument_name);
      if (!p) return null;
      return { name: o.instrument_name, ...p, mark: o.mark_price || 0, iv: o.mark_iv, oi: o.open_interest || 0 };
    }).filter(Boolean);
  }, 3 * 60 * 1000);
}

async function deribitDvol(cur) {
  return cached(`opt:dvol:${cur}`, async () => {
    const now = Date.now();
    const d = await fetchJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${cur}&start_timestamp=${now - 86400000}&end_timestamp=${now}&resolution=3600`);
    const data = d.result?.data || [];
    if (!data.length) throw new Error('no DVOL data');
    return data.at(-1)[4]; // close of latest hourly bar
  }, 5 * 60 * 1000);
}

function realizedVol(closes, days) {
  const rets = [];
  for (let i = closes.length - days; i < closes.length; i++) {
    if (i > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  return sd * Math.sqrt(365) * 100;
}

async function analyzeOptions(cur) {
  const [chain, dvol, klines, funding, positioning, correlation, flow] = await Promise.all([
    deribitChain(cur),
    deribitDvol(cur).catch(() => null),
    fetchJson(`https://api.binance.com/api/v3/klines?symbol=${cur}USDT&interval=1d&limit=220`),
    getFunding(cur).catch(() => null),
    getPositioning(cur).catch(() => null),
    getCorrelation(cur).catch(() => null),
    getOrderFlow(cur).catch(() => null),
  ]);
  const daily = klines.map((k) => ({ t: k[0], c: +k[4] }));
  const closes = daily.map((x) => x.c);
  const spot = closes.at(-1);
  const i = closes.length - 1;

  // ---- direction score (same playbook as Position Picks + crypto-native feeds)
  const sma50 = smaArr(closes, 50), sma200 = smaArr(closes, 200);
  const rsi = rsiArr(closes, 14)[i];
  const macd = macdLast(closes);
  const roc20 = (spot / closes[i - 20] - 1) * 100;
  const factors = [];
  let score = 0;
  const add = (label, side, pts) => { factors.push({ label, side }); score += side === 'bull' ? pts : side === 'bear' ? -pts : 0; };
  if (spot > sma50[i] && sma50[i] > sma200[i]) add('Uptrend regime — price > 50d > 200d', 'bull', 25);
  else if (spot < sma50[i] && sma50[i] < sma200[i]) add('Downtrend regime — price < 50d < 200d', 'bear', 25);
  else add('Mixed trend — averages tangled', 'neut', 0);
  if (rsi >= 55 && rsi <= 75) add(`Momentum RSI ${rsi.toFixed(0)}`, 'bull', 8);
  else if (rsi <= 45 && rsi >= 25) add(`Weak RSI ${rsi.toFixed(0)}`, 'bear', 8);
  if (macd.hist > 0) add('MACD momentum positive', 'bull', 10); else if (macd.hist < 0) add('MACD momentum negative', 'bear', 10);
  if (roc20 > 8) add(`+${roc20.toFixed(0)}% in 20 days`, 'bull', 8); else if (roc20 < -8) add(`${roc20.toFixed(0)}% in 20 days`, 'bear', 8);
  // Crowd positioning — contrarian. Retail piled into one side is fuel for the
  // other; a divergence from the top cohort is the sharper version of the tell.
  if (positioning) {
    if (positioning.state === 'crowd heavily long') add(`${positioning.longPct}% of accounts are long (ratio ${positioning.crowd}) — crowded, squeeze fuel`, 'bear', 8);
    else if (positioning.state === 'crowd heavily short') add(`Only ${positioning.longPct}% of accounts are long (ratio ${positioning.crowd}) — crowded short`, 'bull', 8);
    if (positioning.divergence <= -0.35) add(`Top traders are less long than the crowd (${positioning.top} vs ${positioning.crowd}) — retail is the exit liquidity`, 'bear', 7);
    else if (positioning.divergence >= 0.35) add(`Top traders are more long than the crowd (${positioning.top} vs ${positioning.crowd}) — smart money leaning up`, 'bull', 7);
  }
  if (funding && funding.state === 'crowded long') add(`Funding ${funding.ratePct}%/8h — longs crowded, squeeze risk`, 'bear', 6);
  else if (funding && funding.state === 'crowded short') add(`Funding ${funding.ratePct}%/8h — shorts crowded, squeeze fuel`, 'bull', 6);
  if (flow && flow.buyPct >= 55) add(`Live tape ${flow.buyPct}% buy-side`, 'bull', 6);
  else if (flow && flow.buyPct <= 45) add(`Live tape ${flow.buyPct}% sell-side`, 'bear', 6);
  score = Math.max(-100, Math.min(100, Math.round(score)));
  const view = score >= 20 ? 'BULLISH' : score <= -20 ? 'BEARISH' : 'NEUTRAL';

  // ---- volatility pricing
  const rv30 = realizedVol(closes, 30), rv7 = realizedVol(closes, 7);
  const iv = dvol; // 30d IV index
  const ivPrem = iv != null ? iv - rv30 : null;
  const volVerdict = ivPrem == null ? 'unknown' : ivPrem > 8 ? 'rich' : ivPrem < -4 ? 'cheap' : 'fair';

  // ---- chain internals: front expiry (>= 24h out, most strikes), max pain, walls
  const now = Date.now();
  const byExpiry = {};
  chain.forEach((o) => { if (o.expiry > now + 24 * 3600000) (byExpiry[o.expiry] ||= []).push(o); });
  const expiries = Object.keys(byExpiry).map(Number).sort((a, b) => a - b);
  // prefer a weekly-ish expiry — dailies are too gamma/theta-heavy for these strategies
  const front = expiries.find((e) => byExpiry[e].length >= 10 && e > now + 2.5 * 86400000)
    || expiries.find((e) => byExpiry[e].length >= 10) || expiries[0];
  let frontData = null;
  if (front) {
    const opts = byExpiry[front];
    const strikes = [...new Set(opts.map((o) => o.strike))].sort((a, b) => a - b);
    const pair = (K) => ({ c: opts.find((o) => o.strike === K && o.type === 'C'), p: opts.find((o) => o.strike === K && o.type === 'P') });
    const atmStrike = strikes.reduce((best, K) => Math.abs(K - spot) < Math.abs(best - spot) ? K : best, strikes[0]);
    const atm = pair(atmStrike);
    const straddleUsd = atm.c && atm.p ? (atm.c.mark + atm.p.mark) * spot : null;
    // max pain: expiry price minimizing total option payout
    let maxPain = null, minPay = Infinity;
    for (const S of strikes) {
      let pay = 0;
      opts.forEach((o) => { pay += o.oi * (o.type === 'C' ? Math.max(0, S - o.strike) : Math.max(0, o.strike - S)); });
      if (pay < minPay) { minPay = pay; maxPain = S; }
    }
    const dte = Math.max(0.5, (front - now) / 86400000);
    frontData = {
      label: new Date(front).toISOString().slice(0, 10), dte: +dte.toFixed(1),
      atmStrike, atmIv: atm.c?.iv ?? atm.p?.iv ?? null, straddleUsd: straddleUsd ? Math.round(straddleUsd) : null,
      expectedMovePct: straddleUsd ? +((straddleUsd / spot) * 100).toFixed(2) : null,
      rangeLo: straddleUsd ? Math.round(spot - straddleUsd) : null,
      rangeHi: straddleUsd ? Math.round(spot + straddleUsd) : null,
      maxPain,
      otmCall: strikes.find((K) => K >= spot * 1.05) ?? atmStrike,
      otmPut: [...strikes].reverse().find((K) => K <= spot * 0.95) ?? atmStrike,
    };
  }
  const totC = chain.filter((o) => o.type === 'C').reduce((s, o) => s + o.oi, 0);
  const totP = chain.filter((o) => o.type === 'P').reduce((s, o) => s + o.oi, 0);
  const wall = (type) => chain.filter((o) => o.type === type && o.expiry > now)
    .sort((a, b) => b.oi - a.oi).slice(0, 3)
    .map((o) => ({ strike: o.strike, oi: Math.round(o.oi), expiry: new Date(o.expiry).toISOString().slice(5, 10) }));

  // ---- the judgment: direction × vol pricing → strategy with real strikes
  const f = frontData || {};
  const K = (v) => '$' + (v || 0).toLocaleString();
  let strategy;
  if (view === 'BULLISH' && volVerdict !== 'rich') strategy = {
    stance: 'Buy premium, bullish', primary: `Buy the ${f.label} ${K(f.atmStrike)} call (ATM IV ${f.atmIv ?? '—'}%)`,
    alt: `Cheaper: call debit spread ${K(f.atmStrike)} / ${K(f.otmCall)} — caps cost and theta`,
    rationale: `Direction score ${score > 0 ? '+' : ''}${score} with IV ${volVerdict} vs realized (${iv ?? '—'} vs ${rv30.toFixed(0)}) — paying premium is justified when vol is not overpriced.`,
  };
  else if (view === 'BULLISH') strategy = {
    stance: 'Sell premium, bullish', primary: `Sell the ${f.label} ${K(f.otmPut)} put (collect rich IV; assignment = buying the dip)`,
    alt: `Defined-risk: put credit spread ${K(f.otmPut)} short / next strike down long`,
    rationale: `Bullish (score +${score}) but IV is rich (${iv} vs RV ${rv30.toFixed(0)}) — selling overpriced downside premium beats overpaying for calls.`,
  };
  else if (view === 'BEARISH' && volVerdict !== 'rich') strategy = {
    stance: 'Buy premium, bearish', primary: `Buy the ${f.label} ${K(f.atmStrike)} put (ATM IV ${f.atmIv ?? '—'}%)`,
    alt: `Cheaper: put debit spread ${K(f.atmStrike)} / ${K(f.otmPut)}`,
    rationale: `Direction score ${score} with IV ${volVerdict} — downside exposure at a fair vol price.`,
  };
  else if (view === 'BEARISH') strategy = {
    stance: 'Sell premium, bearish', primary: `Call credit spread: sell ${K(f.atmStrike)} call / buy ${K(f.otmCall)} call, ${f.label}`,
    alt: `Wider: sell the ${K(f.otmCall)} call only if you accept undefined risk (not advised)`,
    rationale: `Bearish (score ${score}) and IV rich (${iv} vs RV ${rv30.toFixed(0)}) — get paid to fade strength instead of buying expensive puts.`,
  };
  else if (volVerdict === 'rich') strategy = {
    stance: 'Sell premium, neutral', primary: `Iron condor ${f.label}: sell ${K(f.otmPut)} put + ${K(f.otmCall)} call, buy wings beyond`,
    alt: `Simplest: stay flat and let the rich premium decay without you — no trade is a position`,
    rationale: `No directional edge (score ${score}) but IV ${iv} trades ${ivPrem?.toFixed(0)} pts over realized ${rv30.toFixed(0)} — the priced move is bigger than the market is delivering.`,
  };
  else strategy = {
    stance: 'No edge', primary: `Stand aside — direction is mixed (score ${score}) and IV is ${volVerdict}, so neither buying nor selling premium has an edge`,
    alt: `If you expect a catalyst: long straddle ${K(f.atmStrike)} (${f.label}) costs ~${K(f.straddleUsd)}, breakevens ${K(f.rangeLo)} / ${K(f.rangeHi)}`,
    rationale: 'Options need either a directional edge or a vol mispricing; right now this market shows neither.',
  };
  strategy.riskNote = 'Options decay daily (theta) and can expire worthless; short options can lose more than the premium collected. Defined-risk spreads over naked positions. Analysis, not advice.';

  return {
    cur, spot: Math.round(spot), score, view, factors,
    vol: { iv, rv30: +rv30.toFixed(1), rv7: +rv7.toFixed(1), ivPremium: ivPrem != null ? +ivPrem.toFixed(1) : null, verdict: volVerdict },
    front: frontData,
    pcRatio: totC ? +(totP / totC).toFixed(2) : null,
    walls: { calls: wall('C'), puts: wall('P') },
    strategy,
    funding: funding ? { ratePct: funding.ratePct, state: funding.state } : null,
    positioning, correlation,
  };
}

async function getOptionsDesk() {
  return cached('options', async () => {
    const settled = await Promise.allSettled(OPTIONS_UNIVERSE.map((c) => analyzeOptions(c)));
    const items = [];
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') items.push(s.value);
      else console.error('[options]', OPTIONS_UNIVERSE[j], s.reason.message);
    });
    return items;
  }, 3 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Position Picks — multi-factor long/short analysis for Nasdaq stocks and
// commodities. Combines daily trend/momentum/structure with the latest bar and
// macro-event context into a transparent score; every factor is shown to the
// user. Probabilistic analysis, not prophecy — framed accordingly in the UI.
// ---------------------------------------------------------------------------
const PICKS_UNIVERSE = [
  ...['NVDA', 'TSLA', 'AAPL', 'AMD', 'MSFT', 'QQQ', 'GOOGL', 'AMZN', 'META', 'AVGO', 'NFLX', 'INTC', 'MU', 'PLTR']
    .map((s) => ({ symbol: s, cnbc: s, group: 'stock', name: s })),
  { symbol: 'GOLD', cnbc: '@GC.1', group: 'commodity', name: 'Gold futures' },
  { symbol: 'SILVER', cnbc: '@SI.1', group: 'commodity', name: 'Silver futures' },
  { symbol: 'COPPER', cnbc: '@HG.1', group: 'commodity', name: 'Copper futures' },
  { symbol: 'PLAT', cnbc: '@PL.1', group: 'commodity', name: 'Platinum futures' },
  { symbol: 'OIL', cnbc: '@CL.1', group: 'commodity', name: 'WTI Crude futures' },
  { symbol: 'NATGAS', cnbc: '@NG.1', group: 'commodity', name: 'Natural Gas futures' },
  { symbol: 'WHEAT', cnbc: '@W.1', group: 'commodity', name: 'Wheat futures' },
];

// Crypto daily bars for resolving daily-horizon calls. Same {t,o,h,l,c,v} shape
// as cnbcDaily so the resolver treats both identically.
async function binanceDaily(sym) {
  return cached(`bdaily:${sym}`, async () => {
    const k = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=120`);
    if (!Array.isArray(k) || k.length < 20) throw new Error(`only ${k?.length || 0} daily bars for ${sym}`);
    return k.map((b) => ({ t: b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] }));
  }, 10 * 60 * 1000);
}

// CNBC "1Y" actually serves ~2 years of daily OHLCV — one source for everything.
async function cnbcDaily(cnbcSym) {
  return cached(`daily:${cnbcSym}`, async () => {
    const d = await fetchJson(`https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol=${encodeURIComponent(cnbcSym)}`);
    const bars = d?.barData?.priceBars || [];
    if (bars.length < 120) throw new Error(`only ${bars.length} daily bars for ${cnbcSym}`);
    return bars.map((b) => ({ t: b.tradeTimeinMills, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume || 0 }));
  }, 10 * 60 * 1000);
}

// Market breadth — the share of the universe trading above its own 50-day
// average, split by asset class. Measures participation, which no per-symbol
// indicator can see: the same setup means different things in a broad advance
// than in a narrow one carried by two names.
function computeBreadth(settledBars) {
  const tally = { stock: { up: 0, n: 0 }, commodity: { up: 0, n: 0 } };
  settledBars.forEach((b, j) => {
    if (b.status !== 'fulfilled') return;
    const meta = PICKS_UNIVERSE[j];
    const closes = b.value.map((x) => x.c);
    const sma50 = smaArr(closes, 50).at(-1);
    if (sma50 == null) return;
    const t = tally[meta.group];
    if (!t) return;
    t.n++; if (closes.at(-1) > sma50) t.up++;
  });
  const pct = (t) => (t.n ? Math.round((t.up / t.n) * 100) : null);
  const stock = pct(tally.stock), commodity = pct(tally.commodity);
  const label = (p) => p == null ? 'unknown'
    : p >= 70 ? 'broad advance' : p >= 55 ? 'healthy' : p >= 45 ? 'mixed' : p >= 30 ? 'narrow' : 'broad decline';
  return {
    stock, commodity,
    stockLabel: label(stock), commodityLabel: label(commodity),
    counts: { stock: tally.stock, commodity: tally.commodity },
  };
}

function analyzePick(meta, daily, macro, breadth) {
  const n = daily.length, i = n - 1;
  const closes = daily.map((x) => x.c);
  const last = daily[i], prev = daily[i - 1];
  const sma20 = smaArr(closes, 20), sma50 = smaArr(closes, 50), sma200 = smaArr(closes, 200);
  const rsi = rsiArr(closes, 14)[i];
  const atr = atrArr(daily, 14)[i];
  const macd = macdLast(closes);
  const yearHi = Math.max(...daily.slice(-252).map((x) => x.h));
  const yearLo = Math.min(...daily.slice(-252).map((x) => x.l));
  const roc20 = i >= 20 ? (last.c / closes[i - 20] - 1) * 100 : 0;
  const vol5 = daily.slice(-5).reduce((s, x) => s + x.v, 0) / 5;
  const vol60 = daily.slice(-60).reduce((s, x) => s + x.v, 0) / 60;
  const extAtr = atr ? (last.c - sma20[i]) / atr : 0;
  const dayChg = (last.c / prev.c - 1) * 100;

  const factors = [];
  let score = 0;
  const add = (label, side, pts) => { factors.push({ label, side }); score += side === 'bull' ? pts : side === 'bear' ? -pts : 0; };

  // 1. Trend regime (the heavyweight)
  if (last.c > sma50[i] && sma50[i] > sma200[i]) add(`Uptrend regime — price > 50d > 200d avg`, 'bull', 25);
  else if (last.c < sma50[i] && sma50[i] < sma200[i]) add(`Downtrend regime — price < 50d < 200d avg`, 'bear', 25);
  else add('Mixed trend — moving averages tangled', 'neut', 0);
  // 2. 50d slope
  const slope50 = sma50[i] && sma50[i - 10] ? (sma50[i] / sma50[i - 10] - 1) * 100 : 0;
  if (slope50 > 0.5) add(`50d average rising (${slope50.toFixed(1)}%/10d)`, 'bull', 10);
  else if (slope50 < -0.5) add(`50d average falling (${slope50.toFixed(1)}%/10d)`, 'bear', 10);
  // 3. RSI momentum
  if (rsi != null) {
    if (rsi >= 55 && rsi <= 75) add(`Momentum RSI ${rsi.toFixed(0)}`, 'bull', 8);
    else if (rsi <= 45 && rsi >= 25) add(`Weak RSI ${rsi.toFixed(0)}`, 'bear', 8);
    else if (rsi > 78) add(`RSI ${rsi.toFixed(0)} — overbought, chase risk`, 'bear', 6);
    else if (rsi < 22) add(`RSI ${rsi.toFixed(0)} — washed out, bounce risk for shorts`, 'bull', 6);
  }
  // 4. MACD
  if (macd.hist > 0) add('MACD momentum positive', 'bull', 10);
  else if (macd.hist < 0) add('MACD momentum negative', 'bear', 10);
  // 5. 20-day rate of change
  if (roc20 > 8) add(`+${roc20.toFixed(0)}% in 20 days`, 'bull', 8);
  else if (roc20 < -8) add(`${roc20.toFixed(0)}% in 20 days`, 'bear', 8);
  // 6. 52-week structure
  if (last.c >= yearHi * 0.97) add('Pressing 52-week highs', 'bull', 10);
  else if (last.c <= yearLo * 1.03) add('Sitting on 52-week lows', 'bear', 10);
  // 7. Volume confirmation (futures vol can be 0 in CNBC data — skip then)
  if (vol60 > 0 && vol5 / vol60 > 1.3) {
    const dir = roc20 >= 0 ? 'bull' : 'bear';
    add(`Volume expanding (${(vol5 / vol60).toFixed(1)}× normal) with the move`, dir, 6);
  }
  // 8. Latest session confirmation
  if (Math.abs(dayChg) >= 0.8) add(`Last session ${dayChg > 0 ? '+' : ''}${dayChg.toFixed(1)}%`, dayChg > 0 ? 'bull' : 'bear', 4);

  // 9. Macro backdrop — dollar, yields and volatility regime
  macroFactors(meta.group, macro).forEach((m) => add(m.label, m.side, m.pts));

  // 10. Market breadth — is the move participated in, or narrow? (added 16 Aug)
  const bp = breadth ? (meta.group === 'stock' ? breadth.stock : breadth.commodity) : null;
  if (bp != null) {
    const grp = meta.group === 'stock' ? 'Nasdaq names' : 'commodities';
    if (bp >= 70) add(`Broad advance — ${bp}% of ${grp} above their 50d average`, 'bull', 10);
    else if (bp <= 30) add(`Broad decline — only ${bp}% of ${grp} above their 50d average`, 'bear', 10);
    else if (bp >= 55) add(`Healthy participation (${bp}% of ${grp} above 50d)`, 'bull', 5);
    else if (bp <= 45) add(`Narrow tape — just ${bp}% of ${grp} above 50d`, 'bear', 5);
  }

  // Extension guard: deep stretch beyond the 20d avg argues against chasing
  const flags = [];
  if (extAtr > 3) { score -= 8; flags.push(`Extended ${extAtr.toFixed(1)}×ATR above the 20d average — poor long entry, wait for a pullback.`); }
  if (extAtr < -3) { score += 8; flags.push(`Stretched ${Math.abs(extAtr).toFixed(1)}×ATR below the 20d average — shorts risk a snapback.`); }

  score = Math.max(-100, Math.min(100, Math.round(score)));
  let signal = score >= 25 ? 'LONG' : score <= -25 ? 'SHORT' : 'NEUTRAL';

  // Feed the picks desk its own track record. Until now this desk had NO
  // feedback loop at all — reliabilityAdj was wired only into the scalp path —
  // which is how a book running -0.55R over 60 trades, including 22 consecutive
  // losing shorts, kept surfacing at full conviction. Scoped by direction
  // because this desk runs a single strategy: its longs and shorts are
  // effectively different models and only the shorts are broken.
  const relPick = signal === 'NEUTRAL' ? { adj: 0, note: null }
    : reliabilityAdj('multi-factor', null, 'pick', signal);
  let relNote = null;
  if (relPick.adj) {
    const before = Math.abs(score);
    const after = Math.max(0, before + relPick.adj);
    relNote = `${relPick.note} → conviction ${before} → ${after}`;
    score = Math.sign(score) * after;
    if (Math.abs(score) < 25) signal = 'NEUTRAL';
  }
  const conviction = Math.abs(score) >= 55 ? 'STRONG' : Math.abs(score) >= 40 ? 'SOLID' : Math.abs(score) >= 25 ? 'MODERATE' : '—';
  const dir = score >= 0 ? 1 : -1;
  const r2 = (v) => parseFloat(v.toPrecision(5));
  const levels = signal === 'NEUTRAL' ? null : {
    entry: r2(last.c),
    stop: r2(last.c - dir * 2 * atr),
    target: r2(last.c + dir * 4 * atr),
    rr: 2,
    horizon: 'swing (days–weeks)',
  };
  return {
    symbol: meta.symbol, name: meta.name, group: meta.group,
    price: r2(last.c), dayChg: parseFloat(dayChg.toFixed(2)),
    score, signal, conviction, factors, flags, levels, relNote,
    stats: {
      rsi: rsi != null ? +rsi.toFixed(0) : null,
      trend: last.c > sma50[i] && sma50[i] > sma200[i] ? 'up' : last.c < sma50[i] && sma50[i] < sma200[i] ? 'down' : 'mixed',
      atrPct: atr ? +((atr / last.c) * 100).toFixed(2) : null,
      roc20: +roc20.toFixed(1),
      off52wHi: +(((last.c / yearHi) - 1) * 100).toFixed(1),
    },
    asOf: last.t,
  };
}

async function getPicks() {
  return cached('picks', async () => {
    const macro = await getMacro().catch(() => null);
    // Fetch dailies once, then derive MARKET BREADTH before scoring anything.
    // A long signal when 15 of 21 markets are trending up is participation; the
    // same signal when only 3 are is a narrow move that usually gets sold.
    const bars = await Promise.allSettled(PICKS_UNIVERSE.map((m) => cnbcDaily(m.cnbc)));
    const breadth = computeBreadth(bars);
    const settled = await Promise.allSettled(PICKS_UNIVERSE.map(async (m, j) => {
      if (bars[j].status !== 'fulfilled') throw bars[j].reason;
      return analyzePick(m, bars[j].value, macro, breadth);
    }));
    const items = [];
    settled.forEach((s, j) => {
      if (s.status === 'fulfilled') items.push(s.value);
      else console.error('[picks]', PICKS_UNIVERSE[j].symbol, s.reason.message);
    });
    items.sort((a, b) => b.score - a.score);
    const longs = items.filter((x) => x.signal === 'LONG').slice(0, 6);
    const shorts = items.filter((x) => x.signal === 'SHORT').sort((a, b) => a.score - b.score).slice(0, 6);
    const qqq = items.find((x) => x.symbol === 'QQQ');
    let events = null;
    try { events = eventContext(await getEvents()); } catch { /* non-critical */ }

    // Record directional calls (10-day horizon) for later scoring.
    await loadLedger();
    let rec = 0;
    for (const p of [...longs, ...shorts]) {
      if (!p.levels) continue;
      if (recordSignal({
        kind: 'pick', symbol: p.symbol, direction: p.signal, strategy: 'multi-factor',
        grade: p.conviction, score: p.score, entry: p.levels.entry, stop: p.levels.stop,
        target: p.levels.target, res: '1d', maxBars: 10,
        // Picks are built at a fixed 2:1 but never recorded it, so every
        // consumer judged them against a 50% breakeven when the true figure is
        // 33%. Same defect fixed for the scalp desks on 21 Aug; picks were
        // missed because they record on a separate path.
        rMultiple: Math.abs(p.levels.entry - p.levels.stop) > 0
          ? +(Math.abs(p.levels.target - p.levels.entry) / Math.abs(p.levels.entry - p.levels.stop)).toFixed(2)
          : 1,
      })) rec++;
    }
    if (rec) { console.log(`[ledger] recorded ${rec} new position picks`); await saveLedger(); }

    return {
      longs, shorts, all: items, macro, breadth,
      regime: qqq ? { score: qqq.score, trend: qqq.stats.trend, label: qqq.stats.trend === 'up' ? 'Risk-on — index in an uptrend, longs have the tailwind' : qqq.stats.trend === 'down' ? 'Risk-off — index in a downtrend, shorts have the tailwind' : 'Chop — index trend is mixed, take only the strongest signals' } : null,
      events,
    };
  }, 5 * 60 * 1000);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// gzip everything worth compressing; JSON payloads and index.html shrink ~5-8×.
const GZIP_MIN = 1024;
function send(res, status, body, type, extraHeaders = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, ...extraHeaders };
  if ((res.req?.headers['accept-encoding'] || '').includes('gzip') && buf.length >= GZIP_MIN) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json');
}

// Static files: cache in memory (with pre-built gzip), invalidated by mtime so
// live edits to index.html still show up on refresh.
const staticCache = {}; // filePath -> { mtimeMs, raw, gz, type }
async function serveStatic(res, filePath) {
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch { res.writeHead(404); return res.end('Not found'); }
  const type = MIME[path.extname(filePath)] || 'application/octet-stream';
  let entry = staticCache[filePath];
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const raw = await fs.promises.readFile(filePath);
    entry = { mtimeMs: stat.mtimeMs, raw, gz: raw.length >= GZIP_MIN ? zlib.gzipSync(raw) : null, type };
    staticCache[filePath] = entry;
  }
  const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' };
  if (entry.gz && (res.req?.headers['accept-encoding'] || '').includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(entry.gz);
  }
  res.writeHead(200, headers);
  res.end(entry.raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/crypto') {
      return sendJson(res, 200, { updated: cache.crypto?.ts || Date.now(), items: await getCrypto() });
    }
    if (url.pathname === '/api/nasdaq') {
      return sendJson(res, 200, { updated: cache.nasdaq?.ts || Date.now(), items: await getNasdaq() });
    }
    if (url.pathname === '/api/wallets') {
      return sendJson(res, 200, {
        updated: cache.wallets?.ts || Date.now(),
        minTrades: MIN_TRADES,
        items: await getWallets(),
      });
    }
    if (url.pathname === '/api/scalp') {
      return sendJson(res, 200, { updated: cache['scalp:5m']?.ts || Date.now(), ...(await getScalp()) });
    }
    if (url.pathname === '/api/backfill') {
      const iv = url.searchParams.get('interval') === '15m' ? '15m' : '5m';
      return sendJson(res, 200, await cached(`bt:${iv}`, () => backfillScalp(iv), 30 * 60 * 1000));
    }
    if (url.pathname === '/api/scalp15') {
      return sendJson(res, 200, { updated: cache['scalp:15m']?.ts || Date.now(), ...(await getScalpTf('15m')) });
    }
    if (url.pathname === '/api/scalpchart') {
      const sym = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
      const reqTf = url.searchParams.get('interval');
      const interval = ['1m', '5m', '15m'].includes(reqTf) ? reqTf : '5m';
      if (!SYMBOL_RE.test(sym)) return sendJson(res, 400, { error: 'invalid symbol' });
      return sendJson(res, 200, await getScalpChart(sym, interval));
    }
    if (url.pathname === '/api/candles') {
      const market = url.searchParams.get('market') === 'stock' ? 'stock' : 'crypto';
      const symbol = url.searchParams.get('symbol') || (market === 'crypto' ? 'BTC' : 'NVDA');
      const interval = url.searchParams.get('interval') === '1d' ? '1d' : '1h';
      if (!SYMBOL_RE.test(symbol)) return sendJson(res, 400, { error: 'invalid symbol' });
      return sendJson(res, 200, { market, symbol, interval, candles: await getCandles(market, symbol, interval) });
    }
    // ---- Live Chart ----
    if (url.pathname === '/api/livechart') {
      const sym = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
      const tf = LIVE_TF[url.searchParams.get('tf')] ? url.searchParams.get('tf') : '1m';
      if (!SYMBOL_RE.test(sym)) return sendJson(res, 400, { error: 'invalid symbol' });
      return sendJson(res, 200, await getLiveCandles(sym, tf));
    }
    if (url.pathname === '/api/orderbook') {
      const sym = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
      if (!SYMBOL_RE.test(sym)) return sendJson(res, 400, { error: 'invalid symbol' });
      return sendJson(res, 200, await getOrderBook(sym));
    }
    if (url.pathname === '/api/orderflow') {
      const sym = (url.searchParams.get('symbol') || 'BTC').toUpperCase();
      if (!SYMBOL_RE.test(sym)) return sendJson(res, 400, { error: 'invalid symbol' });
      return sendJson(res, 200, await getOrderFlow(sym));
    }
    // ---- Smart Wallets (Axiom-style) ----
    if (url.pathname === '/api/smartwallets') {
      const chain = (url.searchParams.get('chain') || 'sol').toLowerCase();
      try {
        if (chain === 'hl') return sendJson(res, 200, { updated: Date.now(), chain: 'hl', ...(await smartWalletsHyperliquid()) });
        if (!SW_CHAINS[chain]) return sendJson(res, 400, { error: `Unknown chain. Use one of: ${Object.keys(SW_CHAINS).join(', ')}, hl` });
        return sendJson(res, 200, { updated: Date.now(), ...(await smartWalletsChain(chain)) });
      } catch (e) { return sendJson(res, 200, { error: e.message, chain }); }
    }
    if (url.pathname === '/api/smartwallets/watch' && req.method === 'GET') {
      try { return sendJson(res, 200, { updated: Date.now(), ...(await smartWalletsWatch()) }); }
      catch (e) { return sendJson(res, 200, { error: e.message, wallets: [] }); }
    }
    if (url.pathname === '/api/smartwallets/watch' && req.method === 'POST') {
      const b = await readBody(req);
      const list = swLoad();
      if (typeof b.remove === 'string') {
        swWatch = list.filter((w) => w.address !== b.remove);
      } else {
        const chain = String(b.chain || '').toLowerCase();
        const address = String(b.address || '').trim();
        if (!SW_CHAINS[chain]) return sendJson(res, 400, { ok: false, error: 'Pick a chain.' });
        const valid = chain === 'sol' ? isSolAddr(address) : isEvmAddr(address);
        if (!valid) return sendJson(res, 400, { ok: false, error: chain === 'sol' ? 'That is not a valid Solana address (base58, 32–44 characters).' : 'That is not a valid EVM address (0x followed by 40 hex characters).' });
        if (list.some((w) => w.address.toLowerCase() === address.toLowerCase())) return sendJson(res, 400, { ok: false, error: 'Already on the watchlist.' });
        if (list.length >= SW_MAX) return sendJson(res, 400, { ok: false, error: `Watchlist is full (${SW_MAX}). The public Solana RPC rate-limits beyond this.` });
        list.push({ address, chain, label: String(b.label || '').slice(0, 30) || `${SW_CHAINS[chain].label} wallet`, addedAt: Date.now() });
        swWatch = list;
      }
      swSave();
      delete cache['sw:watch'];
      return sendJson(res, 200, { ok: true, count: swWatch.length });
    }
    if (url.pathname === '/api/agents') {
      await loadLedger();
      return sendJson(res, 200, { updated: Date.now(), ...agentsState() });
    }
    if (url.pathname === '/api/agents/run' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const r = runAgents(Array.isArray(b.symbols) ? b.symbols : [], Boolean(b.dryRun));
        return sendJson(res, 200, { ok: true, started: r.symbols, dryRun: r.dryRun });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/bybit/suggestions') {
      try {
        const risk = Math.min(5, Math.max(0.1, parseFloat(url.searchParams.get('risk')) || 1));
        return sendJson(res, 200, { updated: Date.now(), ...(await getSuggestions(risk)) });
      } catch (e) { return sendJson(res, 200, { error: e.message }); }
    }
    // ---- 3Commas v2 (READ-ONLY: GET to three read endpoints, nothing else) ----
    if (url.pathname === '/api/routine') {
      try { return sendJson(res, 200, { updated: Date.now(), ...(await getRoutine()) }); }
      catch (e) { return sendJson(res, 200, { ok: false, error: e.message, source: ROUTINE_SCOREBOARD }); }
    }
    if (url.pathname === '/api/3commas') {
      try { return sendJson(res, 200, { updated: Date.now(), ...(await getThreeCommas()) }); }
      catch (e) { return sendJson(res, 200, { configured: tcConfigured(), ok: false, error: e.message, code: e.code || null, hint: e.hint || null }); }
    }
    // ---- Autonomous paper scalper (PAPER ONLY — no order-API path exists) ----
    if (url.pathname === '/api/bot') {
      botLoad();
      const halted = bot.haltedUntil && Date.now() < bot.haltedUntil;
      return sendJson(res, 200, {
        updated: Date.now(), enabled: bot.enabled, halted, haltedUntil: bot.haltedUntil,
        mode: 'PAPER', settings: bot.settings, equity: +bot.equity.toFixed(2), startEquity: bot.settings.startEquity,
        dayPnlPct: +(((bot.equity - bot.dayStartEquity) / bot.dayStartEquity) * 100).toFixed(2),
        lastScanAt: bot.lastScanAt || null, nextScanIn: 300000 - (Date.now() % 300000) + 8000,
        universe: BOT_UNIVERSE.map((m) => ({ sym: m.sym, label: m.label, cls: m.cls })),
        sleeves: Object.entries(BOT_SLEEVES).map(([k, v]) => ({ key: k, ...v, ...(bot.settings.sleeves[k] || {}),
          open: bot.positions.filter((p) => p.sleeve === k).length })),
        positions: bot.positions, orders: bot.orders.filter((o) => o.status === 'open'),
        trades: bot.trades.slice(-60).reverse(), journal: bot.journal.slice(0, 80), stats: botStats(),
      });
    }
    if (url.pathname === '/api/bot/control' && req.method === 'POST') {
      const b = await readBody(req);
      botLoad();
      if (b.action === 'start') { bot.enabled = true; botLog({ action: 'start', reason: 'Bot started (paper)' }); }
      else if (b.action === 'stop') {
        bot.enabled = false;
        for (const o of bot.orders) if (o.status === 'open') o.status = 'cancelled';
        botLog({ action: 'stop', reason: 'Bot stopped — resting orders cancelled; open positions keep their stops until they exit' });
      } else if (b.action === 'reset') {
        const keep = bot.settings;
        bot = botFresh(keep);
        botLog({ action: 'reset', reason: `Paper book reset to $${keep.startEquity}` });
      } else if (b.action === 'scan') {
        botSave(); await botCycle(true); // manual scan now (used for verification)
      } else return sendJson(res, 400, { ok: false, error: 'action must be start | stop | reset | scan' });
      botSave();
      return sendJson(res, 200, { ok: true, enabled: bot.enabled });
    }
    if (url.pathname === '/api/bot/settings' && req.method === 'POST') {
      const b = await readBody(req);
      botLoad();
      const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
      bot.settings.riskPct = clamp(b.riskPct, 0.1, 2, bot.settings.riskPct);
      bot.settings.maxPositions = Math.round(clamp(b.maxPositions, 1, 12, bot.settings.maxPositions));
      bot.settings.dailyLossPct = clamp(b.dailyLossPct, 1, 10, bot.settings.dailyLossPct);
      bot.settings.maxCostR = clamp(b.maxCostR, 0.1, 1, bot.settings.maxCostR);
      if (b.sleeves && typeof b.sleeves === 'object') {
        for (const k of Object.keys(BOT_SLEEVES)) {
          const v = b.sleeves[k]; if (!v) continue;
          bot.settings.sleeves[k] = { on: v.on !== undefined ? !!v.on : bot.settings.sleeves[k].on,
            max: Math.round(clamp(v.max, 0, 4, bot.settings.sleeves[k].max)) };
        }
      }
      botLog({ action: 'settings', reason: `Risk ${bot.settings.riskPct}% · max ${bot.settings.maxPositions} trades · daily stop ${bot.settings.dailyLossPct}% · max costs ${bot.settings.maxCostR}R · sleeves ${Object.entries(bot.settings.sleeves).map(([k, v]) => `${k}:${v.on ? v.max : 'off'}`).join(' ')}` });
      botSave();
      return sendJson(res, 200, { ok: true, settings: bot.settings });
    }
    // ---- Paper execution desk (SIMULATED — never calls a Bybit order endpoint) ----
    if (url.pathname === '/api/paper') {
      try { return sendJson(res, 200, { updated: Date.now(), ...(await paperState()) }); }
      catch (e) { return sendJson(res, 200, { error: e.message }); }
    }
    if (url.pathname === '/api/paper/order' && req.method === 'POST') {
      try {
        const o = await paperPlace(await readBody(req));
        return sendJson(res, 200, { ok: true, order: o, ...(await paperState()) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/paper/close' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const o = await paperClose(String(b.symbol || '').toUpperCase().trim());
        return sendJson(res, 200, { ok: true, order: o, ...(await paperState()) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/paper/cancel' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        await loadPaper();
        const o = paper.orders.find((x) => x.id === Number(b.id) && x.status === 'open');
        if (!o) return sendJson(res, 400, { ok: false, error: 'No open order with that id' });
        o.status = 'cancelled'; await savePaper();
        return sendJson(res, 200, { ok: true, ...(await paperState()) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/paper/reset' && req.method === 'POST') {
      paper = { startedAt: Date.now(), cash: PAPER_START, orders: [], positions: [], trades: [], seq: 1 };
      await savePaper();
      return sendJson(res, 200, { ok: true, ...(await paperState()) });
    }
    // ---- Bybit account (READ-ONLY) ----
    if (url.pathname === '/api/bybit') {
      try {
        return sendJson(res, 200, { updated: Date.now(), ...(await getBybitAccount()) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message, code: e.code || null, hint: e.hint || null });
      }
    }
    // Diagnostic: does the key work, what can it do, and which IP does Bybit see?
    // Deliberately reports only metadata — never the key or secret itself.
    if (url.pathname === '/api/bybit/status') {
      const out = { configured: Boolean(SECRETS.BYBIT_KEY && SECRETS.BYBIT_SECRET),
        env: SECRETS.BYBIT_ENV === 'testnet' ? 'testnet' : 'mainnet',
        keyPreview: SECRETS.BYBIT_KEY ? `${SECRETS.BYBIT_KEY.slice(0, 4)}…${SECRETS.BYBIT_KEY.slice(-2)}` : null };
      try {
        const r = await bybitGet('/v5/user/query-api');
        out.ok = true;
        out.readOnly = r.readOnly === 1;
        out.permissions = Object.entries(r.permissions || {}).filter(([, v]) => v && v.length).map(([k, v]) => `${k}: ${v.join(', ')}`);
        out.boundIps = r.ips && r.ips.length && r.ips[0] !== '*' ? r.ips : null;
        out.expiresAt = r.expiredAt || null;
      } catch (e) {
        out.ok = false; out.error = e.message; out.code = e.code || null; out.hint = e.hint || null;
      }
      // The public IP Bybit sees — the one that must be whitelisted. Fetched
      // only for this diagnostic, and only on request.
      try {
        const ipr = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) });
        out.publicIp = (await ipr.text()).trim();
      } catch { out.publicIp = null; }
      return sendJson(res, 200, out);
    }
    // ---- Model Accuracy (self-scoring ledger) ----
    if (url.pathname === '/api/accuracy') {
      await loadLedger();
      const stats = ledgerStats();
      ledger.stats = stats;
      return sendJson(res, 200, {
        updated: Date.now(), ...stats,
        attribution: factorAttribution(null),
        deskComparison: deskComparison(),
        factorStability: factorStability(),
        macro: await getMacro().catch(() => null),
      });
    }
    // ---- Session Seasonality ----
    if (url.pathname === '/api/seasonality') {
      const sym = (url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
      if (!SEASON_SYMBOLS.includes(sym)) return sendJson(res, 400, { error: 'symbol must be one of ' + SEASON_SYMBOLS.join(', ') });
      return sendJson(res, 200, await getSeasonality(sym));
    }
    // ---- Options Desk ----
    if (url.pathname === '/api/options') {
      return sendJson(res, 200, { updated: cache.options?.ts || Date.now(), items: await getOptionsDesk() });
    }
    // ---- Position Picks ----
    if (url.pathname === '/api/picks') {
      return sendJson(res, 200, { updated: cache.picks?.ts || Date.now(), ...(await getPicks()) });
    }
    // ---- Meme Sniper ----
    if (url.pathname === '/api/meme/launches') {
      return sendJson(res, 200, { updated: cache['meme:launches']?.ts || Date.now(), items: await getMemeLaunches() });
    }
    if (url.pathname === '/api/meme/trending') {
      return sendJson(res, 200, await getMemeTrending());
    }
    if (url.pathname === '/api/meme/whales') {
      return sendJson(res, 200, { updated: cache['meme:whales']?.ts || Date.now(), ...(await getWhaleBuys()) });
    }
    if (url.pathname === '/api/meme/portfolio') {
      return sendJson(res, 200, await memePortfolio());
    }
    if (url.pathname === '/api/meme/watch' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.remove === 'string') {
        memeBot.watchlist = memeBot.watchlist.filter((w) => w.address !== body.remove);
        delete memeBot.seenSigs[body.remove];
      } else if (typeof body.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.address.trim())) {
        if (memeBot.watchlist.length >= 8) return sendJson(res, 400, { error: 'Max 8 wallets — the public Solana RPC rate-limits harder beyond that.' });
        if (!memeBot.watchlist.some((w) => w.address === body.address.trim())) {
          memeBot.watchlist.push({ address: body.address.trim(), label: (body.label || 'Custom wallet').slice(0, 30) });
        }
      } else {
        return sendJson(res, 400, { error: 'Invalid Solana address.' });
      }
      delete cache['meme:whales']; // re-scan on next poll
      return sendJson(res, 200, { watchlist: memeBot.watchlist });
    }
    if (url.pathname === '/api/meme/snipe' && req.method === 'POST') {
      const body = await readBody(req);
      const usd = Math.max(1, Math.min(1e6, parseFloat(body.usd) || 100));
      const entryPx = parseFloat(body.price);
      if (!body.mint || !entryPx || entryPx <= 0) return sendJson(res, 400, { error: 'Need a token mint and a valid price.' });
      memeBot.positions.unshift({
        id: memeBot.nextPosId++, time: Date.now(),
        symbol: (body.symbol || '?').slice(0, 20), mint: body.mint, chain: body.chain || 'solana',
        entryPx, lastPx: entryPx, usd, closed: false,
      });
      return sendJson(res, 200, await memePortfolio());
    }
    if (url.pathname === '/api/meme/sell' && req.method === 'POST') {
      const body = await readBody(req);
      const pos = memeBot.positions.find((p) => p.id === body.id && !p.closed);
      if (!pos) return sendJson(res, 400, { error: 'position not found' });
      try { const tok = await resolveMint(pos.mint); if (tok.priceUsd) pos.lastPx = tok.priceUsd; } catch { /* last known */ }
      pos.closed = true;
      pos.exitPx = pos.lastPx;
      pos.pnl = pos.usd * (pos.exitPx / pos.entryPx - 1);
      memeBot.paper.realized += pos.pnl;
      if (pos.pnl >= 0) memeBot.paper.wins++; else memeBot.paper.losses++;
      return sendJson(res, 200, await memePortfolio());
    }
    if (url.pathname === '/api/meme/alerts' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.enabled === 'boolean') memeBot.alerts.enabled = body.enabled;
      if ([80, 68].includes(body.minScore)) memeBot.alerts.minScore = body.minScore;
      return sendJson(res, 200, { alerts: memeBot.alerts, telegramConnected: !!(copyBot.config.telegramToken && copyBot.config.telegramChatId) });
    }
    // ---- Copy-Trade Bot ----
    if (url.pathname === '/api/copy/status') {
      return sendJson(res, 200, copyStatus());
    }
    if (url.pathname === '/api/copy/config' && req.method === 'POST') {
      const body = await readBody(req);
      const c = copyBot.config;
      const num = (v, d, min, max) => { const n = parseFloat(v); return isNaN(n) ? d : Math.max(min, Math.min(max, n)); };
      if (body.accountSize != null) c.accountSize = num(body.accountSize, c.accountSize, 100, 1e9);
      if (body.sizePct != null) c.sizePct = num(body.sizePct, c.sizePct, 0.1, 100);
      if (body.maxPositions != null) c.maxPositions = num(body.maxPositions, c.maxPositions, 1, 50);
      if (body.minWinRate != null) c.minWinRate = num(body.minWinRate, c.minWinRate, 0, 100);
      if (body.followCount != null) c.followCount = num(body.followCount, c.followCount, 1, 15);
      if (typeof body.telegramToken === 'string' && !body.telegramToken.startsWith('•')) c.telegramToken = body.telegramToken.trim();
      if (typeof body.telegramChatId === 'string') c.telegramChatId = body.telegramChatId.trim();
      if (typeof body.alerts === 'boolean') c.alerts = body.alerts;
      if (['entries', 'copied', 'all'].includes(body.alertMode)) c.alertMode = body.alertMode;
      return sendJson(res, 200, copyStatus());
    }
    if (url.pathname === '/api/copy/alert-test' && req.method === 'POST') {
      const body = await readBody(req);
      const c = copyBot.config;
      const token = (typeof body.telegramToken === 'string' && body.telegramToken && !body.telegramToken.startsWith('•')) ? body.telegramToken.trim() : c.telegramToken;
      const chatId = (body.telegramChatId != null && body.telegramChatId !== '' ? body.telegramChatId : c.telegramChatId).toString().trim();
      if (!token || !chatId) return sendJson(res, 400, { error: 'Enter a bot token and chat ID (or connect Telegram above) first.' });
      // Prefer a real recent entry from the followed wallets; fall back to a sample.
      const real = copyBot.signals.find((s) => /Open|Buy/.test(s.dir));
      const w0 = copyBot.followed[0];
      const sample = real || {
        wallet: w0?.address || '0x0ddf9bae2af4b874b96d287a5ad42eb47138a902',
        displayName: w0?.displayName || 'Top wallet', coin: 'BTC', dir: 'Open Long', side: 'B',
        px: 64700, action: 'COPY', sizeUsd: c.accountSize * c.sizePct / 100, reason: 'sample',
      };
      const w = copyBot.followed.find((f) => f.address === sample.wallet) || { winRate: w0?.winRate ?? 1 };
      try {
        await telegramSend(token, chatId, '<i>Sample entry alert preview:</i>\n\n' + formatAlert(sample, w));
        return sendJson(res, 200, { ok: true, sample: !real });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message, hint: telegramHint(e.message) });
      }
    }
    if (url.pathname === '/api/copy/telegram-test' && req.method === 'POST') {
      const body = await readBody(req);
      const token = (typeof body.telegramToken === 'string' && body.telegramToken && !body.telegramToken.startsWith('•'))
        ? body.telegramToken.trim() : copyBot.config.telegramToken;
      const chatId = (body.telegramChatId != null ? body.telegramChatId : copyBot.config.telegramChatId).toString().trim();
      if (!token || !chatId) return sendJson(res, 400, { error: 'Need both a bot token and a chat ID.' });
      try {
        await telegramSend(token, chatId, '✅ Market Movers copy-bot connected. Copy-trade signals from the top wallets will arrive here.');
        copyBot.config.telegramToken = token;
        copyBot.config.telegramChatId = chatId;
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message, hint: telegramHint(e.message) });
      }
    }
    if (url.pathname === '/api/copy/start' && req.method === 'POST') { startCopyBot(); return sendJson(res, 200, copyStatus()); }
    if (url.pathname === '/api/copy/stop' && req.method === 'POST') { stopCopyBot(); return sendJson(res, 200, copyStatus()); }
    if (url.pathname === '/api/copy/reset' && req.method === 'POST') {
      copyBot.positions = {}; copyBot.signals = []; copyBot.seenTids = {};
      copyBot.paper = { realized: 0, wins: 0, losses: 0, copied: 0 };
      copyBot.alertCount = 0;
      return sendJson(res, 200, copyStatus());
    }
  } catch (err) {
    console.error(`[api] ${url.pathname} failed:`, err.message);
    return sendJson(res, 502, { error: err.message });
  }

  // Static files
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  return serveStatic(res, filePath);
});

// A long-running local server should log upstream hiccups, not die from them.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message || err));
process.on('uncaughtException', (err) => console.error('[uncaught]', err?.message || err));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is another Market Movers instance running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  // Autonomous paper scalper: evaluates every 20s, scans once per closed 5m bar.
  setInterval(() => { botCycle().catch(() => {}); }, 20 * 1000);
  console.log(`Market Movers running at http://localhost:${PORT}`);
  // Warm the cheap caches in the background so the first page load is instant.
  // (Wallets is intentionally excluded: 32MB — the frontend warms it on load.)
  setTimeout(() => {
    for (const warm of [getCrypto, getNasdaq, getScalp, getEvents, getMacro]) {
      warm().catch((e) => console.error('[warmup]', e.message));
    }
  }, 200);

  // Scanner heartbeat. The scanners were demand-driven — they only ran when a
  // browser hit /api/scalp — so with nobody watching, no signals were recorded
  // and the ledger starved. (Measured 17 Aug: server up 22h, zero signals in
  // the last 12h.) The models can only improve on evidence they actually
  // collect, so the desks now scan on their own schedule, matched to each
  // timeframe. Recording dedupes per setup, so this adds rows, not noise.
  const beat = (label, fn, everyMs) => {
    const run = async () => {
      try { await fn(); } catch (e) { console.error(`[heartbeat] ${label}:`, e.message); }
    };
    setTimeout(run, 15 * 1000);
    setInterval(run, everyMs);
  };
  beat('scalp-5m', () => getScalpTf('5m'), 5 * 60 * 1000);
  beat('scalp-15m', () => getScalpTf('15m'), 15 * 60 * 1000);
  beat('picks', () => getPicks(), 30 * 60 * 1000);

  // Self-improvement loop: score past signals against what price actually did,
  // refresh the stats the models use to weight themselves, and persist.
  const improve = async () => {
    try {
      await resolveSignals();
      ledger.stats = ledgerStats();
      const o = ledger.stats.overall;
      if (o.decided >= 5) console.log(`[ledger] ${o.decided} resolved · hit rate ${o.hitRate}% · ${ledger.stats.open} open`);
    } catch (e) {
      console.error('[ledger] resolve failed:', e.message);
    }
  };
  setTimeout(improve, 20 * 1000);
  setInterval(improve, 10 * 60 * 1000);
});

// Never lose the ledger on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await saveLedger(); process.exit(0); });
}
