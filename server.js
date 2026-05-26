const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tensorwallet-secure-secret-key';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

// Automatically target the Render Persistent Disk at /data if in production
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Prevent caching for API calls to ensure global real-time synchronization
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(session({
  name: 'tensorwallet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

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
    encryptedVault: null, 
    publicWallets: [], 
    assets: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null, 
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

// Global Tensor Market Loop (Server Truth for Pricing)
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
        const momentum = (Math.random() - 0.5) * 0.02;
        alphaDrift += momentum * (t.dominance / 100);
      }
    });

    db.tensorRegistry.forEach(t => {
      if (t.bias === 'pegged') {
        t.price = t.startPrice; 
      } else {
        const r = Math.random();
        const chanceToDrop = (100 - (t.bullChance !== undefined ? t.bullChance : 50)) / 100;
        const direction = r < chanceToDrop ? -1 : 1;
        const minPct = t.minPct !== undefined ? t.minPct : 0.01;
        const maxPct = t.maxPct !== undefined ? t.maxPct : 0.05;
        const magnitude = minPct + (Math.random() * (maxPct - minPct));
        
        const nativeChange = direction * magnitude;
        const betaFactor = t.dominance > 35 ? 0.1 : (1 - (t.dominance / 100));
        const totalChange = nativeChange + (alphaDrift * betaFactor);
        
        t.price = Math.max(0.000001, t.price * (1 + totalChange));
      }
      t.marketCap = t.price * t.supply;
    });

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) { console.error('Tensor loop error:', err); }
}, 8000);

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

app.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) return res.render('index', { error: 'Invalid staff login.', success: null, otpEmail: null });
  const adminEmail = `admin@tensorwallet.local`;
  const user = getOrCreateUser(adminEmail, 'staff');
  req.session.user = { email: adminEmail, username: 'admin', role: 'staff', walletId: user.id };
  req.session.save(() => res.redirect('/wallet'));
});

app.get('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('tensorwallet.sid'); res.redirect('/'); }));
app.post('/logout', (req, res) => res.redirect('/logout'));

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.render('wallet', { email: req.session.user.email, role: req.session.user.role, wallet: JSON.stringify(user) });
});

/* --- Standard Crypto Wallet APIs --- */
app.get('/api/wallet', requireAuthJson, (req, res) => res.json(getOrCreateUser(req.session.user.email, req.session.user.role)));

app.post('/api/wallet/send', requireAuthJson, (req, res) => {
  const { network, asset, amount, toAddress } = req.body;
  if(!network || !asset || !amount || !toAddress) return res.status(400).json({error: 'Invalid Request'});

  // In a full production environment, this is where you serialize the transaction, sign it 
  // via RPC nodes, and broadcast it to the actual blockchain network using ethers.js/web3.js.
  // For the platform scope, we simulate a successful transaction:
  const txHash = '0x' + crypto.randomBytes(32).toString('hex');

  res.json({ ok: true, txHash });
});

/* --- Tensor Network APIs --- */
app.get('/api/tensor', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  res.json({ registry: db.tensorRegistry || [], address: user.tensorAddress, balances: user.tensorBalances || {} });
});

app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const { tokenId, usdtAmount } = req.body;
  const spend = Number(usdtAmount);
  if (!tokenId || spend <= 0) return res.status(400).json({ error: 'Invalid payload' });

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);
  if (!token) return res.status(404).json({ error: 'Token missing' });

  const feeRate = 0.000001;
  const feeAmount = spend * feeRate;
  const netSpend = spend - feeAmount;

  if (!db.treasury) db.treasury = { collectedFeesUsdt: 0 };
  db.treasury.collectedFeesUsdt += feeAmount;

  const executionPrice = token.price; 
  const mintAmount = netSpend / executionPrice;

  const user = db.users[req.session.user.email];
  user.tensorBalances[tokenId] = (user.tensorBalances[tokenId] || 0) + mintAmount;
  
  writeDb(db);
  res.json({ ok: true, received: mintAmount, feePaid: feeAmount });
});

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

/* --- Standard Market Endpoints --- */
app.get('/api/prices', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    if (!ids.length) return res.json({});
    // Fetch directly to ensure users get exact real-time prices without server-memory caching delays.
    const priceData = await fetchJsonWithTimeout(`${COINGECKO_BASE}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
    res.json(priceData);
  } catch { res.json({}); }
});

app.listen(PORT, () => { ensureDb(); console.log(`Tensor Wallet running on port ${PORT} - Disk: ${DATA_DIR}`); });
