// Bybit Agent Connect (OAuth + PKCE) — local authorization helper.
//
// Written natively rather than running Bybit's modules/oauth.js, which ships a
// self-update routine that downloads and overwrites .js files from GitHub on
// every session. Endpoints and URL shape were read from Bybit's own published
// skill source; nothing here is fetched or executed at runtime.
//
// This script ONLY authorizes. It contains no order-placement code.
//
//   node tools/bybit-oauth.mjs start    -> prints the URL for YOU to open
//   node tools/bybit-oauth.mjs finish   -> exchanges the code, lists sub-accounts
//   node tools/bybit-oauth.mjs save <n> -> writes chosen sub-account creds to .env

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_FILE = path.join(ROOT, '.bybit-oauth-state.json');
const ENV_FILE = path.join(ROOT, '.env');
const PORT = 9876;

const HOSTS = {
  mainnet: { authorize: 'https://www.bybit.com/oauth', api: 'https://api2.bybit.com' },
  testnet: { authorize: 'https://testnet.bybit.com/oauth', api: 'https://api2-testnet.bybit.com' },
};
const ENV = process.env.BYBIT_ENV === 'testnet' ? 'testnet' : 'mainnet';
const HOST = HOSTS[ENV];

const b64url = (b) => b.toString('base64url');
const mask = (v) => (v ? `${v.slice(0, 5)}…${v.slice(-4)}` : '—');

async function start() {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = crypto.randomBytes(8).toString('hex');
  const redirectUri = `http://127.0.0.1:${PORT}/callback`;

  const url = `${HOST.authorize}?client_id=ai-agent&response_type=code&scope=ai-account`
    + `&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  // code_verifier is written to disk (0600) and never printed.
  fs.writeFileSync(STATE_FILE, JSON.stringify({ codeVerifier, state, env: ENV, ts: Date.now() }), { mode: 0o600 });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (!u.pathname.startsWith('/callback')) { res.writeHead(404).end(); return; }
    const code = u.searchParams.get('code');
    const gotState = u.searchParams.get('state');
    const ok = code && gotState === state;           // CSRF check
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="font:16px system-ui;padding:40px;background:#0f1115;color:#e8ecf3">
      <h2>${ok ? '✅ Authorization received' : '❌ Authorization failed'}</h2>
      <p>${ok ? 'You can close this tab and return to Claude Code.' : 'State mismatch or no code returned — start again.'}</p></body>`);
    if (ok) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      s.code = code;
      fs.writeFileSync(STATE_FILE, JSON.stringify(s), { mode: 0o600 });
      console.log('\n✅ Authorization code received. Run:  node tools/bybit-oauth.mjs finish');
    } else {
      console.log('\n❌ State mismatch or missing code — start again.');
    }
    setTimeout(() => { server.close(); process.exit(ok ? 0 : 1); }, 400);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n[${ENV.toUpperCase()}] Listening on 127.0.0.1:${PORT} for the callback.\n`);
    console.log('Open this link and click Authorize:\n');
    console.log(url + '\n');
    console.log('(The code expires in 10 minutes and is single-use.)');
  });
  setTimeout(() => { console.log('\n⌛ Timed out after 5 minutes.'); server.close(); process.exit(1); }, 5 * 60 * 1000);
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return r.json();
}

async function finish() {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  // The authorization code is SINGLE-USE. If we already exchanged it, reuse the
  // stored access token instead of burning the code again (which returns
  // code_verify_err). Makes "finish" safe to re-run while you create a
  // sub-account on Bybit.
  if (s.accessToken) {
    const fresh = !s.expiresIn || (Date.now() - s.ts) / 1000 < s.expiresIn;
    if (fresh) return listAccounts(s, s.accessToken);
    throw new Error('Stored access token has expired — run "start" again to re-authorize.');
  }
  if (!s.code) throw new Error('No authorization code yet — run "start" and click Authorize first.');
  // Bybit accepts ONLY client_id, code, code_verifier here.
  const tok = await post(`${HOSTS[s.env].api}/oauth/v1/public/access_token`,
    { client_id: 'ai-agent', code: s.code, code_verifier: s.codeVerifier });
  if (tok.retCode !== 0 && tok.retCode !== undefined && tok.retCode !== null) {
    throw new Error(`Token exchange failed (retCode ${tok.retCode}): ${tok.retMsg || JSON.stringify(tok)}`);
  }
  const result = tok.result || tok;
  const accessToken = result.access_token || result.accessToken;
  if (!accessToken) throw new Error(`No access token in response: ${JSON.stringify(tok).slice(0, 300)}`);
  s.accessToken = accessToken;
  s.refreshToken = result.refresh_token || result.refreshToken || null;
  s.expiresIn = result.expires_in || result.expiresIn || null;
  fs.writeFileSync(STATE_FILE, JSON.stringify(s), { mode: 0o600 });

  return listAccounts(s, accessToken);
}

// Creates a NEW AI sub-account. Run ONLY on the user's explicit instruction —
// Bybit's own guidance is that an agent must never auto-create one, and this
// provisions a real sub-account on mainnet.
async function createAccount() {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!s.accessToken) throw new Error('No access token — run "start" first.');
  const r = await fetch(`${HOSTS[s.env].api}/oauth/v1/resource/restrict/ai_accounts?is_create=true`,
    { headers: { Authorization: `Bearer ${s.accessToken}` } });
  const j = await r.json();
  const code = j.retCode ?? j.ret_code;
  if (code !== 0) throw new Error(`Create failed (retCode ${code}): ${j.retMsg || j.ret_msg || JSON.stringify(j)}`);
  console.log(`\n[${s.env.toUpperCase()}] ✅ AI sub-account created.`);
  return listAccounts(s, s.accessToken);
}

async function listAccounts(s, accessToken) {
  const r = await fetch(`${HOSTS[s.env].api}/oauth/v1/resource/restrict/ai_accounts`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const acc = await r.json();
  const list = acc.result?.list || acc.result?.accounts || acc.list || [];
  console.log(`\n[${s.env.toUpperCase()}] Access token obtained.\n`);
  if (!list.length) {
    console.log('No AI sub-accounts exist yet. Create one on Bybit (up to 5), then re-run "finish".');
    console.log('Raw response:', JSON.stringify(acc).slice(0, 400));
    return;
  }
  console.log('AI sub-accounts found — choose ONE (nothing is auto-selected):\n');
  list.forEach((a, i) => {
    console.log(`  [${i + 1}] uid=${a.sub_member_id || a.uid || a.subUid || a.memberId || '?'}  name=${a.nickname || a.accountName || a.name || '—'}`
      + `  key=${mask(a.api_key || a.apiKey)}`);
  });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, accounts: list }), { mode: 0o600 });
  console.log('\nThen run:  node tools/bybit-oauth.mjs save <number>');
}

function save(n) {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const a = (s.accounts || [])[Number(n) - 1];
  if (!a) throw new Error(`No sub-account #${n}. Run "finish" first.`);
  const key = a.api_key || a.apiKey, sec = a.api_secret || a.apiSecret;
  if (!key || !sec) throw new Error('That sub-account did not include API credentials.');
  let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const set = (k, v) => {
    env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  };
  set('BYBIT_KEY', key); set('BYBIT_SECRET', sec); set('BYBIT_ENV', s.env);
  fs.writeFileSync(ENV_FILE, env, { mode: 0o600 });
  console.log(`\n✅ Wrote sub-account #${n} to .env  (key ${mask(key)}, secret …${sec.slice(-5)})`);
  console.log('Restart the server, then open the "My Bybit" tab.');
  fs.unlinkSync(STATE_FILE);
  console.log('🧹 Deleted the temporary OAuth state file.');
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'start') await start();
  else if (cmd === 'finish') await finish();
  else if (cmd === 'create') await createAccount();
  else if (cmd === 'save') save(arg);
  else console.log('Usage: node tools/bybit-oauth.mjs start | finish | create | save <n>');
} catch (e) { console.error('\n❌', e.message); process.exit(1); }
