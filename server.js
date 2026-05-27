'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tensorwallet-secure-secret-key-change-this';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_BASE = 'https://api.binance.com';
const BINANCE_FALLBACK = 'https://data-api.binance.vision';

const PRICE_SYNC_MS = 2000;
const MARKET_LOOP_MS = 2500;
const BASE_CANDLE_MS = 5 * 60 * 1000;
const MAX_CANDLES = 5000;

const cache = new Map();
const tensorCandleHistory = {};

let latestRealPrices = {};
let lastRealPriceSync = 0;

const REAL_SYMBOL_MAP = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BNB: 'BNBUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT',
  TRX: 'TRXUSDT',
  LTC: 'LTCUSDT',
  TON: 'TONUSDT',
  SUI: 'SUIUSDT',
  PEPE: 'PEPEUSDT'
};

const TREASURY_USDT_ADDRESSES = {
  eth: {
    network: 'Ethereum',
    symbol: 'ETH',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  arbitrum: {
    network: 'Arbitrum',
    symbol: 'ARB',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  sol: {
    network: 'Solana',
    symbol: 'SOL',
    address: '9prrQtQxzdt5Kt7nPHUxwWAVQLZATrj2bjU27k5Xkt5i'
  },
  trx: {
    network: 'TRON',
    symbol: 'TRX',
    address: 'TPwY7YfXuufmgfCLF7ie9E2nyo6KhT4fn2'
  }
};

/* -------------------- App Setup -------------------- */

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(session({
  name: 'tensorwallet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

/* -------------------- Helpers -------------------- */

function nowIso() {
  return new Date().toISOString();
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function makePublicId(prefix = 'share') {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function safeJsonForEjs(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function ensureDataFolderOnly() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (envBase) {
    return envBase.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function formatMoney(n, decimals = 2) {
  const num = safeNumber(n, 0);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatPrice(n) {
  const num = safeNumber(n, 0);
  if (num >= 1000) return formatMoney(num, 2);
  if (num >= 1) return formatMoney(num, 4);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6
  });
}

function normalizeNetwork(network) {
  const raw = String(network || '').trim().toLowerCase();
  if (raw.includes('arb')) return 'arbitrum';
  if (raw.includes('sol')) return 'sol';
  if (raw.includes('tron') || raw.includes('trc') || raw.includes('trx')) return 'trx';
  if (raw.includes('eth') || raw.includes('erc')) return 'eth';
  return 'eth';
}

function inferUserUsdtNetwork(user) {
  const candidates = [];
  if (Array.isArray(user.assets)) candidates.push(...user.assets);
  if (Array.isArray(user.publicWallets)) candidates.push(...user.publicWallets);
  if (Array.isArray(user.wallets)) candidates.push(...user.wallets);
  if (Array.isArray(user.balances)) candidates.push(...user.balances);

  const usdtItem = candidates.find(item => {
    const text = JSON.stringify(item || {}).toLowerCase();
    return text.includes('usdt') || text.includes('tether');
  });

  const text = JSON.stringify(usdtItem || user || {}).toLowerCase();
  if (text.includes('arbitrum') || text.includes('arb')) return 'arbitrum';
  if (text.includes('solana') || text.includes('sol')) return 'sol';
  if (text.includes('tron') || text.includes('trc') || text.includes('trx')) return 'trx';
  if (text.includes('ethereum') || text.includes('erc') || text.includes('eth')) return 'eth';

  return 'eth';
}

function getTreasuryDestination(network) {
  const key = normalizeNetwork(network);
  return {
    key,
    ...TREASURY_USDT_ADDRESSES[key]
  };
}

/* -------------------- Defaults -------------------- */

function defaultTensorAssets() {
  return [
    {
      id: 'real_btc', name: 'Bitcoin', symbol: 'BTC', price: 68000, startPrice: 68000, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.004, icon: '₿', supply: 21000000, marketCap: 68000 * 21000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 68000, low24h: 68000, lifetimeHigh: 68000
    },
    {
      id: 'real_eth', name: 'Ethereum', symbol: 'ETH', price: 3800, startPrice: 3800, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.004, icon: 'Ξ', supply: 120000000, marketCap: 3800 * 120000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 3800, low24h: 3800, lifetimeHigh: 3800
    },
    {
      id: 'real_sol', name: 'Solana', symbol: 'SOL', price: 170, startPrice: 170, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.006, icon: '◎', supply: 580000000, marketCap: 170 * 580000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 170, low24h: 170, lifetimeHigh: 170
    },
    {
      id: 'real_bnb', name: 'BNB', symbol: 'BNB', price: 600, startPrice: 600, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.004, icon: 'B', supply: 150000000, marketCap: 600 * 150000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 600, low24h: 600, lifetimeHigh: 600
    },
    {
      id: 'real_xrp', name: 'XRP', symbol: 'XRP', price: 0.55, startPrice: 0.55, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.006, icon: 'X', supply: 99980000000, marketCap: 0.55 * 99980000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 0.55, low24h: 0.55, lifetimeHigh: 0.55
    },
    {
      id: 'real_doge', name: 'Dogecoin', symbol: 'DOGE', price: 0.16, startPrice: 0.16, bias: 'real',
      bullChance: 50, minPct: 0.001, maxPct: 0.008, icon: 'D', supply: 145000000000, marketCap: 0.16 * 145000000000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 0.16, low24h: 0.16, lifetimeHigh: 0.16
    },
    {
      id: 'tensor_ai', name: 'Tensor AI', symbol: 'TAI', price: 1.25, startPrice: 1.25, bias: 'balanced',
      bullChance: 54, minPct: 0.002, maxPct: 0.012, icon: 'T', supply: 10000000, marketCap: 12500000,
      volume: 0, dominance: 0, changePercent24h: 0, high24h: 1.25, low24h: 1.25, lifetimeHigh: 1.25
    }
  ];
}

function defaultDb() {
  return {
    users: {},
    otps: {},
    tensorRegistry: defaultTensorAssets(),
    treasury: {
      collectedFeesUsdt: 0,
      tradeDeposits: []
    },
    publicTradeCards: {},
    copyProfiles: {}
  };
}

/* -------------------- Database -------------------- */

function readDbRaw() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return defaultDb();
  }
}

function writeDb(db) {
  ensureDataFolderOnly();
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
  fs.renameSync(tempPath, DB_PATH);
}

function ensureDb() {
  ensureDataFolderOnly();
  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
    return;
  }
  const db = readDbRaw();
  migrateDb(db);
  writeDb(db);
}

function readDb() {
  ensureDataFolderOnly();
  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
  }
  const db = readDbRaw();
  migrateDb(db);
  return db;
}

function migrateDb(db) {
  if (!db.users) db.users = {};
  if (!db.otps) db.otps = {};
  if (!Array.isArray(db.tensorRegistry)) db.tensorRegistry = [];

  if (!db.treasury) {
    db.treasury = {
      collectedFeesUsdt: 0,
      tradeDeposits: []
    };
  }
  if (!Array.isArray(db.treasury.tradeDeposits)) db.treasury.tradeDeposits = [];
  if (!db.publicTradeCards) db.publicTradeCards = {};
  if (!db.copyProfiles) db.copyProfiles = {};

  if (db.tensorRegistry.length === 0) {
    db.tensorRegistry = defaultTensorAssets();
  }

  Object.values(db.users).forEach(migrateUser);
  db.tensorRegistry.forEach(migrateToken);
}

function migrateUser(user) {
  if (!user) return;

  if (!user.email) user.email = '';
  if (!user.id && user.email) user.id = `wallet_${sha(user.email).slice(0, 20)}`;
  if (!user.role) user.role = 'user';
  if (!user.createdAt) user.createdAt = nowIso();
  if (!user.updatedAt) user.updatedAt = nowIso();

  if (!Array.isArray(user.publicWallets)) user.publicWallets = [];
  if (!Array.isArray(user.assets)) user.assets = [];
  if (!Array.isArray(user.wallets)) user.wallets = [];
  if (!Array.isArray(user.balances)) user.balances = [];

  if (!user.tensorAddress && user.email) user.tensorAddress = `T0x${sha(user.email).slice(0, 40)}`;
  if (!user.tensorVault) user.tensorVault = null;
  if (!user.tensorBalances) user.tensorBalances = {};
  
  if (!Array.isArray(user.positions)) user.positions = [];
  if (!Array.isArray(user.orderHistory)) user.orderHistory = [];
  if (!Array.isArray(user.tradeDeposits)) user.tradeDeposits = [];
  if (!Array.isArray(user.publicTradeCards)) user.publicTradeCards = [];

  user.ousdBalance = safeNumber(user.ousdBalance, 0);
  user.usdtBalance = safeNumber(user.usdtBalance, user.role === 'staff' ? 1000000 : 15000);
  user.usdtNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  user.isCopyTrader = user.isCopyTrader || false;
  user.copyingTarget = user.copyingTarget || null;
  user.copyBalance = safeNumber(user.copyBalance, 0);
  if (!Array.isArray(user.activeCopyTrades)) user.activeCopyTrades = [];

  user.positions.forEach(pos => {
    if (!pos.id) pos.id = makeId('pos');
    if (!pos.marginMode) pos.marginMode = 'cross';

    pos.margin = safeNumber(pos.margin, 0);
    pos.leverage = safeNumber(pos.leverage, 1);
    pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
    pos.entryPrice = safeNumber(pos.entryPrice, 1);
    pos.markPrice = safeNumber(pos.markPrice, pos.entryPrice);
    pos.side = pos.side === 'short' ? 'short' : 'long';
  });
}

function migrateToken(token) {
  if (!token.id) token.id = `T0x${crypto.randomBytes(20).toString('hex')}`;
  if (!token.name) token.name = token.symbol || 'Tensor Asset';
  if (!token.symbol) token.symbol = 'TENSOR';

  token.symbol = String(token.symbol).toUpperCase();
  token.price = Math.max(0.000001, safeNumber(token.price, 1));
  token.startPrice = Math.max(0.000001, safeNumber(token.startPrice, token.price));
  token.bias = token.bias || 'balanced';
  token.bullChance = safeNumber(token.bullChance, 50);
  token.minPct = safeNumber(token.minPct, 0.001);
  token.maxPct = safeNumber(token.maxPct, 0.005);
  token.icon = token.icon || token.symbol.slice(0, 1);
  token.supply = Math.max(1, safeNumber(token.supply, 10000000));
  token.marketCap = token.price * token.supply;
  token.volume = safeNumber(token.volume, 0);
  token.dominance = safeNumber(token.dominance, 0);
  token.changePercent24h = safeNumber(token.changePercent24h, 0);
  token.high24h = safeNumber(token.high24h, token.price);
  token.low24h = safeNumber(token.low24h, token.price);
  token.lifetimeHigh = Math.max(
    safeNumber(token.lifetimeHigh, token.price),
    token.price,
    safeNumber(token.high24h, token.price)
  );
}

/* -------------------- Users/Auth Helpers -------------------- */

function createWalletRecord(email, role = 'user') {
  const hash = sha(email);

  return {
    id: `wallet_${hash.slice(0, 20)}`,
    email,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    encryptedVault: null,
    publicWallets: [],
    assets: [],
    wallets: [],
    balances: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null,
    tensorBalances: {},
    usdtBalance: role === 'staff' ? 1000000 : 15000,
    ousdBalance: 0,
    usdtNetwork: 'eth',
    positions: [],
    orderHistory: [],
    tradeDeposits: [],
    publicTradeCards: [],
    isCopyTrader: false,
    copyingTarget: null,
    copyBalance: 0,
    activeCopyTrades: []
  };
}

function getOrCreateUser(email, role = 'user') {
  const normEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normEmail]) {
    db.users[normEmail] = createWalletRecord(normEmail, role);
    writeDb(db);
  } else {
    migrateUser(db.users[normEmail]);
    if (role === 'staff' && db.users[normEmail].role !== 'staff') {
      db.users[normEmail].role = 'staff';
      writeDb(db);
    }
  }

  return db.users[normEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
}

function requireAdminJson(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();

  db.otps[normEmail] = {
    otpHash: sha(otp),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0
  };

  writeDb(db);
}

function verifyOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();
  const record = db.otps[normEmail];

  if (!record) return { ok: false, reason: 'No OTP found. Please request a new code.' };
  if (Date.now() > record.expiresAt) {
    delete db.otps[normEmail];
    writeDb(db);
    return { ok: false, reason: 'OTP expired. Please request a new code.' };
  }
  if (record.attempts >= 5) {
    delete db.otps[normEmail];
    writeDb(db);
    return { ok: false, reason: 'Too many attempts. Please request a new code.' };
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    db.otps[normEmail] = record;
    writeDb(db);
    return { ok: false, reason: 'Invalid code.' };
  }

  delete db.otps[normEmail];
  writeDb(db);
  return { ok: true };
}

async function sendOtpEmail(email, otp) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.log(`DEV OTP for ${email}: ${otp}`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass }
  });

  await transporter.sendMail({
    from: `"Tensor Wallet" <${gmailUser}>`,
    to: email,
    subject: 'Your Tensor Wallet login code',
    text: `Your Tensor Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0b0e11;color:#fff;padding:24px;border-radius:12px">
        <h2>Tensor Wallet</h2>
        <p>Your login code is:</p>
        <h1 style="letter-spacing:4px">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
      </div>
    `
  });

  return true;
}

/* -------------------- Network / Price Helpers -------------------- */

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  if (typeof fetch !== 'function') throw new Error('Global fetch is unavailable. Use Node 18+.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'TensorWallet/1.0',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function syncRealCryptoPrices(force = false) {
  try {
    if (!force && Date.now() - lastRealPriceSync < PRICE_SYNC_MS) return latestRealPrices;

    const symbols = Object.values(REAL_SYMBOL_MAP);
    const symbolsParam = encodeURIComponent(JSON.stringify(symbols));
    let data;

    try {
      data = await fetchJsonWithTimeout(`${BINANCE_BASE}/api/v3/ticker/24hr?symbols=${symbolsParam}`, {}, 4500);
    } catch {
      data = await fetchJsonWithTimeout(`${BINANCE_FALLBACK}/api/v3/ticker/24hr?symbols=${symbolsParam}`, {}, 4500);
    }

    if (!Array.isArray(data)) return latestRealPrices;

    const nextPrices = { ...latestRealPrices };
    data.forEach(item => {
      if (!item || !item.symbol) return;
      const price = Number(item.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;

      nextPrices[item.symbol] = {
        symbol: item.symbol, price,
        changePercent: safeNumber(item.priceChangePercent, 0),
        high: safeNumber(item.highPrice, price), low: safeNumber(item.lowPrice, price),
        volume: safeNumber(item.quoteVolume, 0), syncedAt: Date.now()
      };
    });

    latestRealPrices = nextPrices;
    lastRealPriceSync = Date.now();
    return latestRealPrices;
  } catch (err) {
    console.error('Real crypto price sync failed:', err.message);
    return latestRealPrices;
  }
}

/* -------------------- Candle / Trading Engine -------------------- */

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId] && tensorCandleHistory[tokenId].length) return;

  const candles = [];
  let price = Math.max(0.000001, safeNumber(startPrice, 1));
  let timeCursor = Date.now() - 14 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < 4032; i++) {
    const open = price;
    const close = Math.max(0.000001, open * (1 + (Math.random() - 0.5) * 0.0035));
    const high = Math.max(open, close) * (1 + Math.random() * 0.0018);
    const low = Math.max(0.000001, Math.min(open, close) * (1 - Math.random() * 0.0018));

    candles.push({ time: timeCursor, open, high, low, close });
    price = close;
    timeCursor += BASE_CANDLE_MS;
  }
  
  tensorCandleHistory[tokenId] = candles;
}

function updateCandles(tokenId, currentPrice) {
  let candles = tensorCandleHistory[tokenId];
  if (!candles) {
    initializeCandlesForToken(tokenId, currentPrice);
    candles = tensorCandleHistory[tokenId];
  }
  if (!candles || candles.length === 0) return;

  const now = Date.now();
  const lastCandle = candles[candles.length - 1];

  if (now - lastCandle.time >= BASE_CANDLE_MS) {
    candles.push({ time: now, open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice });
    if (candles.length > MAX_CANDLES) candles.shift();
  } else {
    lastCandle.close = currentPrice;
    lastCandle.high = Math.max(lastCandle.high, currentPrice);
    lastCandle.low = Math.min(lastCandle.low, currentPrice);
  }
}

async function runMarketLoop() {
  await syncRealCryptoPrices();
  const db = readDb();
  let dbChanged = false;

  db.tensorRegistry.forEach(token => {
    if (token.bias === 'real') {
      const symbolMap = REAL_SYMBOL_MAP[token.symbol];
      if (symbolMap && latestRealPrices[symbolMap]) {
        const rp = latestRealPrices[symbolMap];
        token.price = rp.price;
        token.changePercent24h = rp.changePercent;
        token.high24h = rp.high;
        token.low24h = rp.low;
      }
    } else {
      const isBull = Math.random() * 100 < token.bullChance;
      const change = (Math.random() * (token.maxPct - token.minPct) + token.minPct);
      token.price = Math.max(0.000001, token.price * (1 + (isBull ? change : -change)));
    }
    
    token.lifetimeHigh = Math.max(token.lifetimeHigh || 0, token.price, token.high24h || 0);
    updateCandles(token.id, token.price);
    dbChanged = true;
  });

  if (dbChanged) writeDb(db);
  setTimeout(runMarketLoop, MARKET_LOOP_MS);
}

// Start Engine
ensureDb();
const initialDb = readDb();
initialDb.tensorRegistry.forEach(t => initializeCandlesForToken(t.id, t.price));
runMarketLoop();

/* -------------------- Express Routes -------------------- */

// Auth Routes
app.post('/api/auth/request-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  
  const otp = generateOtp();
  saveOtp(email, otp);
  const emailed = await sendOtpEmail(email, otp);
  
  res.json({ ok: true, message: emailed ? 'OTP sent via email' : 'OTP generated (Check console in dev)' });
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp, adminOverride } = req.body;
  
  if (adminOverride === STAFF_PASSWORD && email === STAFF_USERNAME) {
    const user = getOrCreateUser(email, 'staff');
    req.session.user = user;
    return res.json({ ok: true });
  }

  const result = verifyOtp(email, otp);
  if (!result.ok) return res.status(400).json({ error: result.reason });

  const user = getOrCreateUser(email, 'user');
  req.session.user = user;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// View Routes
app.get('/', (req, res) => {
  // If the user is logged in, redirect straight to the dashboard
  if (req.session.user) return res.redirect('/trading');
  
  // If not logged in, cleanly serve your own index.html from the public directory
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/trading', requireAuth, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  res.render('trading', { 
    wallet: safeJsonForEjs(user),
    treasury: safeJsonForEjs(TREASURY_USDT_ADDRESSES)
  });
});

app.get('/wallet', requireAuth, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  
  const profiles = Object.values(db.copyProfiles).filter(p => p.active);
  const copyProfiles = profiles.map(p => ({
    traderName: p.traderName || 'Pro Trader',
    roi: p.roi || 0,
    winRate: p.winRate || 0,
    copierCount: p.copierCount || 0,
    strategyDesc: p.strategyDesc || 'Algorithmic Trading'
  }));

  res.render('wallet', { 
    user,
    copyProfiles,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance
  });
});

// API Routes
app.get('/api/tensor', (req, res) => {
  const db = readDb();
  res.json({
    registry: db.tensorRegistry,
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.get('/api/tensor/chart', (req, res) => {
  const { tokenId } = req.query;
  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);
  const candles = tensorCandleHistory[tokenId] || [];
  
  res.json({
    candles,
    stats: token ? {
      high24h: token.high24h,
      low24h: token.low24h,
      lifetimeHigh: token.lifetimeHigh,
      changePercent24h: token.changePercent24h
    } : null
  });
});

app.get('/api/trading/state', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  
  res.json({
    role: user.role,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    usdtNetwork: user.usdtNetwork,
    positions: user.positions,
    orderHistory: user.orderHistory,
    tradeDeposits: user.tradeDeposits,
    publicTradeCards: user.publicTradeCards,
    copyState: {
      isCopyTrader: user.isCopyTrader,
      copyingTarget: user.copyingTarget,
      copyBalance: user.copyBalance,
      activeCopyTrades: user.activeCopyTrades
    },
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/trading/execute', requireAuthJson, (req, res) => {
  const { tokenId, side, margin, leverage, marginMode, currency } = req.body;
  const db = readDb();
  const user = db.users[req.session.user.email];
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) return res.status(404).json({ error: 'Asset not found' });
  if (!margin || margin <= 0) return res.status(400).json({ error: 'Invalid margin' });
  
  const mgn = Number(margin);
  const lev = Number(leverage || 1);
  const size = mgn * lev;
  const curr = currency === 'OUSD' ? 'OUSD' : 'USDT';

  if (curr === 'OUSD' && user.ousdBalance < mgn) return res.status(400).json({ error: 'Insufficient OUSD balance' });
  if (curr === 'USDT' && user.usdtBalance < mgn) return res.status(400).json({ error: 'Insufficient USDT balance' });

  if (curr === 'OUSD') {
    user.ousdBalance -= mgn;
  } else {
    user.usdtBalance -= mgn;
  }

  const dest = getTreasuryDestination(user.usdtNetwork);
  const depositRecord = {
    id: makeId('dep'),
    amount: mgn,
    currency: curr,
    network: dest.network,
    destinationAddress: dest.address,
    status: 'routed',
    createdAt: nowIso()
  };
  
  user.tradeDeposits.unshift(depositRecord);
  db.treasury.tradeDeposits.push({ userEmail: user.email, ...depositRecord });
  db.treasury.collectedFeesUsdt += (mgn * 0.001);

  const position = {
    id: makeId('pos'),
    tokenId: token.id,
    symbol: token.symbol,
    side,
    margin: mgn,
    leverage: lev,
    size,
    entryPrice: token.price,
    markPrice: token.price,
    marginMode: marginMode || 'cross',
    currency: curr,
    treasuryNetwork: dest.network,
    treasuryAddress: dest.address,
    openedAt: nowIso()
  };

  user.positions.unshift(position);
  writeDb(db);

  res.json({
    ok: true,
    position,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    usdtNetwork: dest.key,
    treasuryDeposit: depositRecord
  });
});

app.post('/api/trading/close', requireAuthJson, (req, res) => {
  const { positionId } = req.body;
  const db = readDb();
  const user = db.users[req.session.user.email];
  
  const posIndex = user.positions.findIndex(p => p.id === positionId);
  if (posIndex === -1) return res.status(404).json({ error: 'Position not found' });
  
  const pos = user.positions[posIndex];
  const token = db.tensorRegistry.find(t => t.id === pos.tokenId);
  const currentPrice = token ? token.price : pos.entryPrice;
  
  const pnlRaw = pos.side === 'long' ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
  const pnl = (pnlRaw / pos.entryPrice) * pos.size;
  const roi = (pnl / pos.margin) * 100;
  
  const returnAmt = Math.max(0, pos.margin + pnl);

  if (pos.currency === 'OUSD') {
    user.ousdBalance += returnAmt;
  } else if (pos.currency === 'COPY') {
    user.copyBalance += returnAmt;
  } else {
    user.usdtBalance += returnAmt;
  }

  user.positions.splice(posIndex, 1);
  
  const historyRecord = {
    ...pos,
    closePrice: currentPrice,
    markPrice: currentPrice,
    pnl,
    roi,
    closeReason: 'Market Close',
    closedAt: nowIso()
  };
  
  user.orderHistory.unshift(historyRecord);
  writeDb(db);
  
  res.json({
    ok: true,
    historyRecord,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance
  });
});

app.post('/api/trading/share', requireAuthJson, (req, res) => {
  const { historyId } = req.body;
  const db = readDb();
  const user = db.users[req.session.user.email];
  
  const history = user.orderHistory.find(h => h.id === historyId);
  if (!history) return res.status(404).json({ error: 'Trade not found' });

  const shareId = makePublicId();
  const shareRecord = {
    id: shareId,
    tradeId: history.id,
    page: `${getBaseUrl(req)}/t/${shareId}`,
    image: `${getBaseUrl(req)}/api/og/${shareId}`,
    createdAt: Date.now()
  };

  user.publicTradeCards.unshift(shareRecord);
  db.publicTradeCards[shareId] = { ...shareRecord, data: history, userEmail: user.email };
  writeDb(db);

  res.json({ ok: true, ...shareRecord });
});

// Copy Trading Routes
app.get('/api/trading/copy-profiles', requireAuthJson, (req, res) => {
  const db = readDb();
  const profiles = Object.values(db.copyProfiles).filter(p => p.active).map(p => ({
    walletId: p.walletId,
    traderName: p.traderName,
    followers: p.copierCount,
    totalPnl: p.roi * 100,
    link: `/u/${p.walletId}`
  }));
  res.json({ ok: true, profiles });
});

app.post('/api/trading/copy-profile/toggle', requireAdminJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];
  
  user.isCopyTrader = !user.isCopyTrader;
  
  if (user.isCopyTrader) {
    db.copyProfiles[user.id] = {
      walletId: user.id,
      traderName: 'Admin Master Profile',
      roi: 142.50,
      winRate: 71.2,
      copierCount: 1204,
      strategyDesc: "Momentum & Volatility Arbitrage",
      active: true
    };
  } else {
    if (db.copyProfiles[user.id]) db.copyProfiles[user.id].active = false;
  }
  
  writeDb(db);
  res.json({ ok: true, isCopyTrader: user.isCopyTrader });
});

app.post('/api/trading/copy/start', requireAuthJson, (req, res) => {
  const { targetWalletId, amount, currency } = req.body;
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (user.copyingTarget) return res.status(400).json({ error: 'Already copying a trader' });
  if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const curr = currency === 'OUSD' ? 'OUSD' : 'USDT';
  if (curr === 'OUSD' && user.ousdBalance < amount) return res.status(400).json({ error: 'Insufficient OUSD' });
  if (curr === 'USDT' && user.usdtBalance < amount) return res.status(400).json({ error: 'Insufficient USDT' });

  if (curr === 'OUSD') user.ousdBalance -= amount;
  else user.usdtBalance -= amount;

  user.copyingTarget = targetWalletId;
  user.copyBalance = amount;
  user.activeCopyTrades = [];

  if (db.copyProfiles[targetWalletId]) {
    db.copyProfiles[targetWalletId].copierCount += 1;
  }

  writeDb(db);
  res.json({ ok: true, copyBalance: user.copyBalance });
});

app.post('/api/trading/copy/stop', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user.copyingTarget) return res.status(400).json({ error: 'Not currently copying' });

  if (db.copyProfiles[user.copyingTarget]) {
    db.copyProfiles[user.copyingTarget].copierCount = Math.max(0, db.copyProfiles[user.copyingTarget].copierCount - 1);
  }

  user.usdtBalance += user.copyBalance;
  user.copyBalance = 0;
  user.copyingTarget = null;
  user.activeCopyTrades = [];

  writeDb(db);
  res.json({ ok: true, usdtBalance: user.usdtBalance });
});

/* -------------------- Boot -------------------- */

app.use((req, res) => {
  res.status(404).send('404: Route not found');
});

app.listen(PORT, () => {
  console.log(`🚀 Tensor Engine running on port ${PORT}`);
  console.log(`📂 Data directory: ${DATA_DIR}`);
});
