const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'bluecrypto-secure-secret-key';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

// Automatically target the Render Persistent Disk at /data if in production
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_ENDPOINTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

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
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const cache = new Map();

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, otps: {}, tensorRegistry: [] }, null, 2));
}

function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw || '{}');
    if (!db.users) db.users = {};
    if (!db.otps) db.otps = {};
    if (!db.tensorRegistry) db.tensorRegistry = [];
    return db;
  } catch (error) { return { users: {}, otps: {}, tensorRegistry: [] }; }
}

function writeDb(db) {
  ensureDb();
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
  fs.renameSync(tempPath, DB_PATH);
}

function sha(input) { return crypto.createHash('sha256').update(String(input)).digest('hex'); }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function nowIso() { return new Date().toISOString(); }

function createWalletRecord(email, role = 'user') {
  const hash = sha(email);
  return { 
    id: `wallet_${hash.slice(0, 20)}`, 
    email, role, 
    createdAt: nowIso(), 
    updatedAt: nowIso(), 
    encryptedVault: null, 
    publicWallets: [], 
    assets: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`, // Deterministic Tensor Address
    tensorBalances: {}
  };
}

function getOrCreateUser(email, role = 'user') {
  const normEmail = normalizeEmail(email);
  const db = readDb();
  if (!db.users[normEmail]) {
    db.users[normEmail] = createWalletRecord(normEmail, role);
    writeDb(db);
  }
  return db.users[normEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}

function requireAdminJson(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function generateOtp() { return String(crypto.randomInt(100000, 999999)); }

function saveOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();
  db.otps[normEmail] = { otpHash: sha(otp), expiresAt: Date.now() + 600000, attempts: 0 };
  writeDb(db);
}

function verifyOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();
  const record = db.otps[normEmail];

  if (!record) return { ok: false, reason: 'No OTP found.' };
  if (Date.now() > record.expiresAt) { delete db.otps[normEmail]; writeDb(db); return { ok: false, reason: 'OTP expired.' }; }
  if (record.attempts >= 5) { delete db.otps[normEmail]; writeDb(db); return { ok: false, reason: 'Too many attempts.' }; }
  if (sha(otp) !== record.otpHash) { record.attempts++; db.otps[normEmail] = record; writeDb(db); return { ok: false, reason: 'Invalid code.' }; }

  delete db.otps[normEmail]; writeDb(db);
  return { ok: true };
}

async function sendOtpEmail(email, otp) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) { console.log(`DEV OTP for ${email}: ${otp}`); return false; }
  
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPass } });
  await transporter.sendMail({
    from: `"BlueCrypto" <${gmailUser}>`, to: email, subject: 'Your BlueCrypto login code',
    text: `Your login code is ${otp}. It expires in 10 minutes.`, html: `<h3>Your BlueCrypto login code is <b>${otp}</b>.</h3>`
  });
  return true;
}

// Global Tensor Market Loop (Runs every 8 seconds to update AI token prices)
setInterval(() => {
  const db = readDb();
  let updated = false;
  
  if (db.tensorRegistry && db.tensorRegistry.length > 0) {
    db.tensorRegistry.forEach(t => {
      const r = Math.random(); 
      let change = 0;
      
      if (t.vol === 'bull') change = r < 0.65 ? (Math.random() * 0.03) : -(Math.random() * 0.015);
      else if (t.vol === 'bear') change = r < 0.65 ? -(Math.random() * 0.03) : (Math.random() * 0.015);
      else if (t.vol === 'stable') change = r < 0.5 ? (Math.random() * 0.002) : -(Math.random() * 0.002);
      else if (t.vol === 'hyper') change = r < 0.5 ? (Math.random() * 0.15) : -(Math.random() * 0.15);
      
      t.price = Math.max(0.000001, t.price * (1 + change));
      updated = true;
    });
    
    if (updated) writeDb(db);
  }
}, 8000);

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
  } finally { clearTimeout(timer); }
}

/* --- Auth Routes --- */
app.get('/', (req, res) => res.render('index', { error: null, success: null, otpEmail: null }));

app.post('/send-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email || !email.includes('@')) return res.render('index', { error: 'Enter a valid email.', success: null, otpEmail: null });
  const otp = generateOtp();
  saveOtp(email, otp);
  const sent = await sendOtpEmail(email, otp);
  res.render('index', { error: null, success: sent ? 'OTP sent. Check your inbox.' : 'OTP generated (Check console). Gmail missing.', otpEmail: email });
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
  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) return res.render('index', { error: 'Invalid staff login.', success: null, otpEmail: null });

  const adminEmail = `admin@bluecrypto.local`;
  const user = getOrCreateUser(adminEmail, 'staff');
  req.session.user = { email: adminEmail, username: 'admin', role: 'staff', walletId: user.id };
  req.session.save(() => res.redirect('/wallet'));
});

app.get('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('bluecrypto.sid'); res.redirect('/'); }));
app.post('/logout', (req, res) => res.redirect('/logout'));

/* --- App Routes --- */
app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.render('wallet', { email: req.session.user.email, role: req.session.user.role, wallet: JSON.stringify(user) });
});

/* --- API Routes: Standard Wallet --- */
app.get('/api/wallet', requireAuthJson, (req, res) => res.json(getOrCreateUser(req.session.user.email, req.session.user.role)));

app.post('/api/wallet/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  if (req.body.encryptedVault) {
    db.users[req.session.user.email].encryptedVault = req.body.encryptedVault;
    db.users[req.session.user.email].publicWallets = req.body.publicWallets || [];
    db.users[req.session.user.email].updatedAt = nowIso();
    writeDb(db);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'No vault data provided.' });
});

app.delete('/api/wallet/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  db.users[req.session.user.email].encryptedVault = null;
  db.users[req.session.user.email].publicWallets = [];
  db.users[req.session.user.email].updatedAt = nowIso();
  writeDb(db);
  res.json({ ok: true });
});

/* --- API Routes: Tensor Network Ecosystem --- */

// Fetch the current global registry and the active user's balances
app.get('/api/tensor', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  res.json({
    registry: db.tensorRegistry || [],
    address: user.tensorAddress,
    balances: user.tensorBalances || {}
  });
});

// Admin Only: Deploy a new Tensor Token to the global market
app.post('/api/tensor/deploy', requireAdminJson, (req, res) => {
  const { name, symbol, price, vol, icon } = req.body;
  if (!name || !symbol || !price || !vol || !icon) return res.status(400).json({ error: 'Missing token parameters.' });

  const db = readDb();
  const cAddr = "T0x" + crypto.randomBytes(20).toString('hex');
  
  db.tensorRegistry.push({
    id: cAddr,
    name,
    symbol: symbol.toUpperCase(),
    price: Number(price),
    startPrice: Number(price),
    vol,
    icon
  });
  
  writeDb(db);
  res.json({ ok: true, id: cAddr });
});

// Swap USDT for Tensor Tokens
app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const { tokenId, usdtAmount } = req.body;
  if (!tokenId || !usdtAmount || Number(usdtAmount) <= 0) return res.status(400).json({ error: 'Invalid swap details.' });

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);
  if (!token) return res.status(404).json({ error: 'Tensor token not found.' });

  const user = db.users[req.session.user.email];
  
  // Assuming frontend Web3 wallet confirmed the USDT burn/transfer already.
  // In a fully strictly enforced system, the backend would verify the transaction hash here.
  const receiveAmount = Number(usdtAmount) / token.price;
  
  user.tensorBalances[tokenId] = (user.tensorBalances[tokenId] || 0) + receiveAmount;
  writeDb(db);
  
  res.json({ ok: true, newBalance: user.tensorBalances[tokenId], received: receiveAmount });
});

// P2P Send Tensor Tokens
app.post('/api/tensor/send', requireAuthJson, (req, res) => {
  const { tokenId, amount, toAddress } = req.body;
  const sendAmt = Number(amount);
  
  if (!tokenId || !sendAmt || sendAmt <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid send parameters.' });
  }

  const db = readDb();
  const sender = db.users[req.session.user.email];
  
  if ((sender.tensorBalances[tokenId] || 0) < sendAmt) {
    return res.status(400).json({ error: 'Insufficient Tensor token balance.' });
  }

  // Find recipient by T0x address
  const recipientEmail = Object.keys(db.users).find(email => db.users[email].tensorAddress === toAddress);
  
  if (!recipientEmail) {
    return res.status(404).json({ error: 'Recipient address not found on the Tensor network.' });
  }

  const recipient = db.users[recipientEmail];

  // Execute transfer
  sender.tensorBalances[tokenId] -= sendAmt;
  recipient.tensorBalances[tokenId] = (recipient.tensorBalances[tokenId] || 0) + sendAmt;
  
  writeDb(db);
  res.json({ ok: true });
});

/* --- Crypto Price APIs --- */
app.get('/api/prices', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    if (!ids.length) return res.json({});
    res.json(await cachedJson(`cg-prices:${ids.join(',')}`, 15000, () => fetchJsonWithTimeout(`${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`)));
  } catch { res.json({}); }
});

app.get('/api/binance-prices', requireAuthJson, async (req, res) => {
  try {
    const symbols = new Set(String(req.query.symbols || '').split(',').filter(Boolean));
    if (!symbols.size) return res.json({});
    res.json(await cachedJson(`binance-prices`, 4000, async () => {
      const rows = await fetchJsonWithTimeout(`${BINANCE_ENDPOINTS[0]}/api/v3/ticker/24hr`);
      const output = {};
      for (const row of rows || []) if (symbols.has(row.symbol)) output[row.symbol] = { lastPrice: Number(row.lastPrice), priceChangePercent: Number(row.priceChangePercent) };
      return output;
    }));
  } catch { res.json({}); }
});

app.get('/api/chart', requireAuthJson, async (req, res) => {
  try {
    const { id, symbol, tf = '5m' } = req.query;
    if (symbol) {
      const data = await cachedJson(`binance-chart:${symbol}:${tf}`, 4000, async () => {
        const rows = await fetchJsonWithTimeout(`${BINANCE_ENDPOINTS[0]}/api/v3/klines?symbol=${symbol}USDT&interval=${tf}&limit=80`);
        return { candles: rows.map(k => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]) })) };
      });
      return res.json(data);
    }
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.listen(PORT, () => { ensureDb(); console.log(`BlueCrypto running on port ${PORT} - Disk: ${DATA_DIR}`); });
