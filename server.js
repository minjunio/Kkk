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
app.use(express.json({ limit: '5mb' }));
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
const tensorCandleHistory = {}; 

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, otps: {}, tensorRegistry: [], treasury: { collectedFeesUsdt: 0 } }, null, 2));
}

function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw || '{}');
    if (!db.users) db.users = {};
    if (!db.otps) db.otps = {};
    if (!db.tensorRegistry) db.tensorRegistry = [];
    if (!db.treasury) db.treasury = { collectedFeesUsdt: 0 };
    return db;
  } catch (error) { return { users: {}, otps: {}, tensorRegistry: [], treasury: { collectedFeesUsdt: 0 } }; }
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
    encryptedVault: null, // Standard Crypto Wallet Seed
    publicWallets: [], 
    assets: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null, // Dedicated Tensor Network Seed
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

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId]) return;
  tensorCandleHistory[tokenId] = [];
  let currentBase = startPrice;
  let timeCursor = Date.now() - (80 * 60 * 1000); 

  for (let i = 0; i < 80; i++) {
    const open = currentBase;
    const close = currentBase * (1 + (Math.random() - 0.5) * 0.02);
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    
    tensorCandleHistory[tokenId].push({ time: timeCursor, open, high, low, close });
    currentBase = close;
    timeCursor += 60 * 1000;
  }
}

// Global Tensor Market Loop
setInterval(() => {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
    if (!db.tensorRegistry || !db.tensorRegistry.length) return;

    let totalMarketCap = 0;
    db.tensorRegistry.forEach(t => {
      if (!t.supply) t.supply = 10000000;
      t.marketCap = t.price * t.supply;
      totalMarketCap += t.marketCap;
    });

    let alphaDrift = 0;
    db.tensorRegistry.forEach(t => {
      t.dominance = totalMarketCap > 0 ? (t.marketCap / totalMarketCap) * 100 : 0;
      if (t.dominance > 30 && t.bias !== 'pegged') {
        const momentum = (Math.random() - 0.5) * (t.bias === 'random' ? 0.04 : 0.01);
        alphaDrift += momentum * (t.dominance / 100);
      }
    });

    db.tensorRegistry.forEach(t => {
      const oldPrice = t.price;
      
      if (t.bias === 'pegged') {
        t.price = t.startPrice; 
      } else {
        const r = Math.random();
        let direction = 1; // 1 = up, -1 = down
        
        if (t.bias === 'bull') direction = r < 0.65 ? 1 : -1;
        else if (t.bias === 'bear') direction = r < 0.65 ? -1 : 1;
        else direction = r < 0.5 ? 1 : -1; // random

        // Enforce the custom percentage interval (e.g., 3% to 6%)
        const minPct = t.minPct || 0.01;
        const maxPct = t.maxPct || 0.05;
        const magnitude = minPct + (Math.random() * (maxPct - minPct));
        
        const nativeChange = direction * magnitude;

        // Apply Market Dominance Beta Drag
        const betaFactor = t.dominance > 35 ? 0.1 : (1 - (t.dominance / 100));
        const totalChange = nativeChange + (alphaDrift * betaFactor);
        
        t.price = Math.max(0.000001, t.price * (1 + totalChange));
      }

      t.marketCap = t.price * t.supply;
      if (!t.volume) t.volume = 0;
      t.volume = t.volume * 0.95 + (Math.abs(t.price - oldPrice) * t.supply * 0.05);

      initializeCandlesForToken(t.id, oldPrice);
      const history = tensorCandleHistory[t.id];
      const now = Date.now();
      const lastCandle = history[history.length - 1];

      if (lastCandle && now - lastCandle.time < 60000) {
        lastCandle.close = t.price;
        if (t.price > lastCandle.high) lastCandle.high = t.price;
        if (t.price < lastCandle.low) lastCandle.low = t.price;
      } else {
        history.push({ time: now, open: oldPrice, high: Math.max(oldPrice, t.price), low: Math.min(oldPrice, t.price), close: t.price });
        if (history.length > 150) history.shift();
      }
    });

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) { console.error('Tensor loop error:', err); }
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

/* --- Auth & Views --- */
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

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  // Do not expose raw unencrypted server data to the frontend template, only basic configs
  res.render('wallet', { email: req.session.user.email, role: req.session.user.role, wallet: JSON.stringify(user) });
});

/* --- Crypto Wallet APIs --- */
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

/* --- Tensor Network APIs --- */
app.get('/api/tensor', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  res.json({ registry: db.tensorRegistry || [], address: user.tensorAddress, balances: user.tensorBalances || {} });
});

// Tensor Network Seed Phrase Vault
app.post('/api/tensor/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  if (req.body.tensorVault) {
    db.users[req.session.user.email].tensorVault = req.body.tensorVault;
    db.users[req.session.user.email].updatedAt = nowIso();
    writeDb(db);
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'No Tensor vault data provided.' });
});

// Admin: Deploy a new token
app.post('/api/tensor/deploy', requireAdminJson, (req, res) => {
  const { name, symbol, price, bias, minPct, maxPct, icon, supply } = req.body;
  if (!name || !symbol || !price || !bias || !icon || !supply) return res.status(400).json({ error: 'Missing parameters' });

  const db = readDb();
  const id = "T0x" + crypto.randomBytes(20).toString('hex');
  
  db.tensorRegistry.push({
    id, name, symbol: symbol.toUpperCase(),
    price: Number(price), startPrice: Number(price),
    bias, // 'bull', 'bear', 'random', 'pegged'
    minPct: Number(minPct) / 100, // Convert whole number % to decimal
    maxPct: Number(maxPct) / 100,
    icon, supply: Number(supply), marketCap: Number(price) * Number(supply),
    volume: 0, dominance: 0
  });
  
  writeDb(db);
  initializeCandlesForToken(id, Number(price));
  res.json({ ok: true, id });
});

// Admin: Update existing token configuration
app.put('/api/tensor/update/:id', requireAdminJson, (req, res) => {
  const { bias, minPct, maxPct, supply } = req.body;
  const db = readDb();
  
  const token = db.tensorRegistry.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: 'Token not found.' });

  if (bias) token.bias = bias;
  if (minPct !== undefined) token.minPct = Number(minPct) / 100;
  if (maxPct !== undefined) token.maxPct = Number(maxPct) / 100;
  if (supply) {
    token.supply = Number(supply);
    token.marketCap = token.price * token.supply;
  }

  writeDb(db);
  res.json({ ok: true, token });
});

// Admin: Delete a Tensor Token
app.delete('/api/tensor/delete/:id', requireAdminJson, (req, res) => {
  const db = readDb();
  const index = db.tensorRegistry.findIndex(t => t.id === req.params.id);
  
  if (index === -1) return res.status(404).json({ error: 'Token not found.' });
  
  db.tensorRegistry.splice(index, 1);
  delete tensorCandleHistory[req.params.id]; // Free up memory
  
  writeDb(db);
  res.json({ ok: true });
});

// User: Tensor Network AMM Swap Execution
app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const { tokenId, usdtAmount } = req.body;
  const spend = Number(usdtAmount);
  if (!tokenId || spend <= 0) return res.status(400).json({ error: 'Invalid payload' });

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);
  if (!token) return res.status(404).json({ error: 'Token missing' });

  // Deduct 0.0001% Swap Fee from input
  const feeRate = 0.000001;
  const feeAmount = spend * feeRate;
  const netSpend = spend - feeAmount;

  if (!db.treasury) db.treasury = { collectedFeesUsdt: 0 };
  db.treasury.collectedFeesUsdt += feeAmount;

  // Compute Slippage / Impact (Ignore if Pegged Stablecoin)
  let priceImpact = 0;
  if (token.bias !== 'pegged') {
    const impactMultiplier = netSpend / (token.marketCap + 100);
    priceImpact = Math.min(0.5, impactMultiplier * (token.bias === 'random' ? 2.5 : 0.8));
  }
  
  const originalPrice = token.price;
  const executionPrice = originalPrice * (1 + (priceImpact / 2)); 
  const mintAmount = netSpend / executionPrice;

  if (token.bias !== 'pegged') {
    token.price = originalPrice * (1 + priceImpact);
    token.marketCap = token.price * token.supply;
  }
  token.volume = (token.volume || 0) + spend;

  initializeCandlesForToken(tokenId, originalPrice);
  const history = tensorCandleHistory[tokenId];
  if (history && history.length) {
    const last = history[history.length - 1];
    last.close = token.price;
    if (token.price > last.high) last.high = token.price;
  }

  const user = db.users[req.session.user.email];
  user.tensorBalances[tokenId] = (user.tensorBalances[tokenId] || 0) + mintAmount;
  
  writeDb(db);
  res.json({ ok: true, received: mintAmount, impactPercent: (priceImpact * 100).toFixed(2), feePaid: feeAmount });
});

// User: Tensor P2P Transfer
app.post('/api/tensor/send', requireAuthJson, (req, res) => {
  const { tokenId, amount, toAddress } = req.body;
  const sendAmt = Number(amount);
  if (!tokenId || !sendAmt || sendAmt <= 0 || !toAddress) return res.status(400).json({ error: 'Invalid parameters.' });

  const db = readDb();
  const sender = db.users[req.session.user.email];
  if ((sender.tensorBalances[tokenId] || 0) < sendAmt) return res.status(400).json({ error: 'Insufficient balance.' });

  const recipientEmail = Object.keys(db.users).find(email => db.users[email].tensorAddress === toAddress);
  if (!recipientEmail) return res.status(404).json({ error: 'Recipient not found.' });

  const recipient = db.users[recipientEmail];
  sender.tensorBalances[tokenId] -= sendAmt;
  recipient.tensorBalances[tokenId] = (recipient.tensorBalances[tokenId] || 0) + sendAmt;
  
  writeDb(db);
  res.json({ ok: true });
});

// Global: Tensor Chart Data Source
app.get('/api/tensor/chart', (req, res) => {
  const { tokenId } = req.query;
  if (!tokenId || !tensorCandleHistory[tokenId]) return res.json({ candles: [] });
  res.json({ candles: tensorCandleHistory[tokenId] });
});

/* --- Standard Market Endpoints --- */
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

app.listen(PORT, () => { ensureDb(); console.log(`BlueCrypto running on port ${PORT} - Disk: ${DATA_DIR}`); });
