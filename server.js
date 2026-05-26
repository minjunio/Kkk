const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-now';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com'
];

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  name: 'bluecrypto.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

const cache = new Map();

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, otps: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw || '{}');
    if (!db.users || typeof db.users !== 'object') db.users = {};
    if (!db.otps || typeof db.otps !== 'object') db.otps = {};
    return db;
  } catch (error) {
    return { users: {}, otps: {} };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function createWalletRecord(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);
  return {
    id: `wallet_${sha(normalizedEmail).slice(0, 20)}`,
    email: normalizedEmail,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    encryptedVault: null,
    publicWallets: [],
    assets: []
  };
}

function getOrCreateUser(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail, role);
    writeDb(db);
    return db.users[normalizedEmail];
  }

  if (role === 'staff' && db.users[normalizedEmail].role !== 'staff') {
    db.users[normalizedEmail].role = 'staff';
    db.users[normalizedEmail].updatedAt = nowIso();
    writeDb(db);
  }

  return db.users[normalizedEmail];
}

function updateUserWallet(email, patch) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();
  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail);
  }
  db.users[normalizedEmail] = { ...db.users[normalizedEmail], ...patch, updatedAt: nowIso() };
  writeDb(db);
  return db.users[normalizedEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();
  db.otps[normalizedEmail] = {
    otpHash: sha(otp),
    expiresAt: Date.now() + 1000 * 60 * 10,
    attempts: 0
  };
  writeDb(db);
}

function verifyOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();
  const record = db.otps[normalizedEmail];

  if (!record) return { ok: false, reason: 'No OTP found. Request a new code.' };
  if (Date.now() > record.expiresAt) {
    delete db.otps[normalizedEmail]; writeDb(db);
    return { ok: false, reason: 'OTP expired. Request a new code.' };
  }
  if (record.attempts >= 5) {
    delete db.otps[normalizedEmail]; writeDb(db);
    return { ok: false, reason: 'Too many attempts. Request a new code.' };
  }
  if (sha(otp) !== record.otpHash) {
    record.attempts += 1; db.otps[normalizedEmail] = record; writeDb(db);
    return { ok: false, reason: 'Invalid OTP code.' };
  }

  delete db.otps[normalizedEmail]; writeDb(db);
  return { ok: true };
}

async function sendOtpEmail(email, otp) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.log(`DEV OTP for ${email}: ${otp}`);
    return false;
  }

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPass } });
  
  await transporter.sendMail({
    from: `"BlueCrypto" <${gmailUser}>`,
    to: email,
    subject: 'Your BlueCrypto login code',
    text: `Your login code is ${otp}. It expires in 10 minutes.`,
    html: `<h3>Your BlueCrypto login code is <b>${otp}</b>.</h3><p>It expires in 10 minutes.</p>`
  });
  return true;
}

async function cachedJson(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;
  const data = await fetcher();
  cache.set(key, { time: Date.now(), data });
  return data;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Pages */

app.get('/', (req, res) => {
  res.render('index', { error: null, success: null, otpEmail: null });
});

app.post('/send-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !email.includes('@')) return res.render('index', { error: 'Enter a valid email.', success: null, otpEmail: null });

    const otp = generateOtp();
    saveOtp(email, otp);
    const sent = await sendOtpEmail(email, otp);

    res.render('index', {
      error: null,
      success: sent ? 'OTP sent. Check your inbox.' : 'OTP generated (Check console). Gmail missing.',
      otpEmail: email
    });
  } catch (error) {
    res.render('index', { error: 'Failed to send OTP.', success: null, otpEmail: req.body.email });
  }
});

app.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const result = verifyOtp(email, otp);
  if (!result.ok) return res.render('index', { error: result.reason, success: null, otpEmail: email });

  const user = getOrCreateUser(email, 'user');
  req.session.user = { email, username: email.split('@')[0], role: user.role, walletId: user.id };
  req.session.save(() => res.redirect('/wallet'));
});

app.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return res.render('index', { error: 'Invalid staff login.', success: null, otpEmail: null });
  }

  // FORCE FRESH WALLET: Give the admin a unique email modifier based on timestamp
  const uniqueAdminEmail = `admin+${Date.now()}@bluecrypto.local`;
  const user = getOrCreateUser(uniqueAdminEmail, 'staff');

  req.session.user = { email: uniqueAdminEmail, username: 'admin', role: 'staff', walletId: user.id };
  req.session.save(() => res.redirect('/wallet'));
});

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.render('wallet', { username: req.session.user.username, email: req.session.user.email, role: req.session.user.role, wallet: JSON.stringify(user) });
});

app.get('/trading', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.render('trading', { username: req.session.user.username, email: req.session.user.email, role: req.session.user.role, wallet: JSON.stringify(user) });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('bluecrypto.sid');
    res.redirect('/');
  });
});
app.post('/logout', (req, res) => res.redirect('/logout'));

/* APIs */

app.get('/api/wallet', requireAuthJson, (req, res) => {
  res.json(getOrCreateUser(req.session.user.email, req.session.user.role));
});

app.post('/api/wallet/vault', requireAuthJson, (req, res) => {
  const { encryptedVault, publicWallets } = req.body;
  const user = updateUserWallet(req.session.user.email, { encryptedVault, publicWallets });
  res.json({ ok: true, wallet: user });
});

app.delete('/api/wallet/vault', requireAuthJson, (req, res) => {
  const user = updateUserWallet(req.session.user.email, { encryptedVault: null, publicWallets: [] });
  res.json({ ok: true, wallet: user });
});

/* Prices API */
app.get('/api/prices', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    if (!ids.length) return res.json({});
    const data = await cachedJson(`cg-prices:${ids.join(',')}`, 15000, () => fetchJsonWithTimeout(`${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`));
    res.json(data);
  } catch { res.json({}); }
});

app.get('/api/market-meta', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    if (!ids.length) return res.json({});
    const data = await cachedJson(`cg-meta:${ids.join(',')}`, 30000, async () => {
      const rows = await fetchJsonWithTimeout(`${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&per_page=100&page=1&sparkline=false`);
      const output = {};
      for (const row of rows || []) output[row.id] = { id: row.id, symbol: String(row.symbol).toUpperCase(), marketCap: Number(row.market_cap || 0) };
      return output;
    });
    res.json(data);
  } catch { res.json({}); }
});

app.get('/api/binance-prices', requireAuthJson, async (req, res) => {
  try {
    const symbols = new Set(String(req.query.symbols || '').split(',').filter(Boolean));
    if (!symbols.size) return res.json({});
    const data = await cachedJson(`binance-prices`, 4000, async () => {
      const output = {};
      const rows = await fetchJsonWithTimeout(`${BINANCE_ENDPOINTS[0]}/api/v3/ticker/24hr`);
      for (const row of rows || []) if (symbols.has(row.symbol)) output[row.symbol] = { lastPrice: Number(row.lastPrice), priceChangePercent: Number(row.priceChangePercent) };
      return output;
    });
    res.json(data);
  } catch { res.json({}); }
});

app.get('/api/chart', requireAuthJson, async (req, res) => {
  try {
    const { id, symbol, tf = '5m' } = req.query;
    if (symbol) {
      const binanceSymbol = `${symbol}USDT`;
      const data = await cachedJson(`binance-chart:${binanceSymbol}:${tf}`, 4000, async () => {
        const rows = await fetchJsonWithTimeout(`${BINANCE_ENDPOINTS[0]}/api/v3/klines?symbol=${binanceSymbol}&interval=${tf}&limit=80`);
        return { candles: rows.map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) })) };
      });
      return res.json(data);
    }
    const data = await cachedJson(`cg-chart:${id}`, 20000, async () => {
      const body = await fetchJsonWithTimeout(`${COINGECKO_BASE}/coins/${id}/market_chart?vs_currency=usd&days=1`);
      return { prices: body.prices || [] };
    });
    res.json(data);
  } catch { res.status(500).json({ error: 'Failed to load chart' }); }
});

app.post('/api/swap/quote', requireAuthJson, (req, res) => {
  try {
    const { sellAmount, sellToken } = req.body;
    res.json({
      sellAmount, buyAmount: (BigInt(sellAmount) * 98n / 100n).toString(), gas: '150000',
      transaction: { to: '0xdef1c0ded9bec7f1a1670819833240f027b25eff', data: '0x', value: sellToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? sellAmount : '0' }
    });
  } catch { res.status(500).json({ error: 'Quote failed' }); }
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`BlueCrypto running on port ${PORT}`);
});
