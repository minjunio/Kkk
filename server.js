'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');
const zlib = require('zlib');

const app = express();

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tensorwallet-secure-secret-key-change-this';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const BINANCE_BASE = 'https://api.binance.com';
const BINANCE_FALLBACK = 'https://data-api.binance.vision';

const PRICE_SYNC_MS = 5000;
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

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    tensorAddress: user.tensorAddress,
    usdtBalance: safeNumber(user.usdtBalance, 0),
    ousdBalance: safeNumber(user.ousdBalance, 0),
    usdtNetwork: user.usdtNetwork,
    positions: user.positions || [],
    orderHistory: user.orderHistory || [],
    tradeDeposits: user.tradeDeposits || [],
    publicTradeCards: user.publicTradeCards || [],
    isCopyTrader: !!user.isCopyTrader,
    copyingTarget: user.copyingTarget || null,
    copyBalance: safeNumber(user.copyBalance, 0),
    activeCopyTrades: user.activeCopyTrades || []
  };
}

/* -------------------- Defaults -------------------- */

function defaultTensorAssets() {
  return [
    {
      id: 'real_btc',
      name: 'Bitcoin',
      symbol: 'BTC',
      price: 68000,
      startPrice: 68000,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: '₿',
      supply: 21000000,
      marketCap: 68000 * 21000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 68000,
      low24h: 68000,
      lifetimeHigh: 68000
    },
    {
      id: 'real_eth',
      name: 'Ethereum',
      symbol: 'ETH',
      price: 3800,
      startPrice: 3800,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: 'Ξ',
      supply: 120000000,
      marketCap: 3800 * 120000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 3800,
      low24h: 3800,
      lifetimeHigh: 3800
    },
    {
      id: 'real_sol',
      name: 'Solana',
      symbol: 'SOL',
      price: 170,
      startPrice: 170,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.006,
      icon: '◎',
      supply: 580000000,
      marketCap: 170 * 580000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 170,
      low24h: 170,
      lifetimeHigh: 170
    },
    {
      id: 'real_bnb',
      name: 'BNB',
      symbol: 'BNB',
      price: 600,
      startPrice: 600,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: 'B',
      supply: 150000000,
      marketCap: 600 * 150000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 600,
      low24h: 600,
      lifetimeHigh: 600
    },
    {
      id: 'real_xrp',
      name: 'XRP',
      symbol: 'XRP',
      price: 0.55,
      startPrice: 0.55,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.006,
      icon: 'X',
      supply: 99980000000,
      marketCap: 0.55 * 99980000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 0.55,
      low24h: 0.55,
      lifetimeHigh: 0.55
    },
    {
      id: 'real_doge',
      name: 'Dogecoin',
      symbol: 'DOGE',
      price: 0.16,
      startPrice: 0.16,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.008,
      icon: 'D',
      supply: 145000000000,
      marketCap: 0.16 * 145000000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 0.16,
      low24h: 0.16,
      lifetimeHigh: 0.16
    },
    {
      id: 'tensor_ai',
      name: 'Tensor AI',
      symbol: 'TAI',
      price: 1.25,
      startPrice: 1.25,
      bias: 'balanced',
      bullChance: 54,
      minPct: 0.002,
      maxPct: 0.012,
      icon: 'T',
      supply: 10000000,
      marketCap: 12500000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 1.25,
      low24h: 1.25,
      lifetimeHigh: 1.25
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

  user.isCopyTrader = !!user.isCopyTrader;
  user.copyingTarget = user.copyingTarget || null;
  user.copyBalance = safeNumber(user.copyBalance, 0);

  if (!Array.isArray(user.activeCopyTrades)) user.activeCopyTrades = [];

  user.positions.forEach(pos => {
    if (!pos.id) pos.id = makeId('pos');
    if (!pos.marginMode) pos.marginMode = 'cross';

    pos.margin = safeNumber(pos.margin, 0);
    pos.leverage = Math.max(1, safeNumber(pos.leverage, 1));
    pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
    pos.entryPrice = Math.max(0.000001, safeNumber(pos.entryPrice, 1));
    pos.markPrice = Math.max(0.000001, safeNumber(pos.markPrice, pos.entryPrice));
    pos.side = pos.side === 'short' ? 'short' : 'long';
    pos.symbol = String(pos.symbol || 'BTC').toUpperCase();
    pos.status = pos.status || 'open';
    pos.openedAt = pos.openedAt || nowIso();
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
  if (!req.session.user || !req.session.user.email) {
    return res.redirect('/');
  }

  next();
}

function requireStaff(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.redirect('/');
  }

  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user || !req.session.user.email) {
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
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
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
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Use Node 18+.');
  }

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

async function cachedJson(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.data;

  const data = await fetcher();
  cache.set(key, { time: Date.now(), data });

  return data;
}

async function syncRealCryptoPrices(force = false) {
  try {
    if (!force && Date.now() - lastRealPriceSync < PRICE_SYNC_MS) {
      return latestRealPrices;
    }

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
        symbol: item.symbol,
        price,
        changePercent: safeNumber(item.priceChangePercent, 0),
        high: safeNumber(item.highPrice, price),
        low: safeNumber(item.lowPrice, price),
        volume: safeNumber(item.quoteVolume, 0),
        syncedAt: Date.now()
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

function getMarketPrice(symbol, registry = null) {
  const clean = String(symbol || '').toUpperCase();
  const pair = REAL_SYMBOL_MAP[clean];

  if (pair && latestRealPrices[pair]?.price) {
    return latestRealPrices[pair].price;
  }

  const db = registry ? null : readDb();
  const tokens = registry || db.tensorRegistry || [];
  const token = tokens.find(t => String(t.symbol).toUpperCase() === clean);

  return Math.max(0.000001, safeNumber(token?.price, 1));
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

    candles.push({
      time: timeCursor,
      open,
      high,
      low,
      close,
      volume: Math.round(50000 + Math.random() * 750000)
    });

    price = close;
    timeCursor += BASE_CANDLE_MS;
  }

  tensorCandleHistory[tokenId] = candles.slice(-MAX_CANDLES);
}

function appendCandle(token) {
  const id = token.id || token.symbol;
  initializeCandlesForToken(id, token.price);

  const candles = tensorCandleHistory[id];
  const last = candles[candles.length - 1];

  const now = Date.now();
  const price = Math.max(0.000001, safeNumber(token.price, 1));

  if (!last || now - last.time >= BASE_CANDLE_MS) {
    candles.push({
      time: now,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Math.round(50000 + Math.random() * 500000)
    });
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += Math.round(1000 + Math.random() * 25000);
  }

  if (candles.length > MAX_CANDLES) {
    candles.splice(0, candles.length - MAX_CANDLES);
  }
}

function moveSyntheticToken(token) {
  if (token.bias === 'real') return;

  const chance = Math.max(1, Math.min(99, safeNumber(token.bullChance, 50)));
  const direction = Math.random() * 100 <= chance ? 1 : -1;
  const minPct = Math.max(0, safeNumber(token.minPct, 0.001));
  const maxPct = Math.max(minPct, safeNumber(token.maxPct, 0.006));
  const pct = minPct + Math.random() * (maxPct - minPct);

  token.price = Math.max(0.000001, token.price * (1 + direction * pct));
}

function syncRegistryWithRealPrices(db) {
  const totalMarketCap = db.tensorRegistry.reduce((sum, token) => {
    const symbol = String(token.symbol || '').toUpperCase();
    const pair = REAL_SYMBOL_MAP[symbol];

    if (pair && latestRealPrices[pair]) {
      const live = latestRealPrices[pair];

      token.price = live.price;
      token.changePercent24h = live.changePercent;
      token.high24h = live.high;
      token.low24h = live.low;
      token.volume = live.volume;
      token.marketCap = token.price * safeNumber(token.supply, 1);
      token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price, live.high);
    } else {
      moveSyntheticToken(token);
      token.marketCap = token.price * safeNumber(token.supply, 1);
      token.high24h = Math.max(safeNumber(token.high24h, token.price), token.price);
      token.low24h = Math.min(safeNumber(token.low24h, token.price), token.price);
      token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);
      token.changePercent24h = ((token.price - safeNumber(token.startPrice, token.price)) / safeNumber(token.startPrice, token.price)) * 100;
      token.volume = safeNumber(token.volume, 0) + Math.round(Math.random() * 25000);
    }

    appendCandle(token);
    return sum + safeNumber(token.marketCap, 0);
  }, 0);

  db.tensorRegistry.forEach(token => {
    token.dominance = totalMarketCap > 0 ? token.marketCap / totalMarketCap * 100 : 0;
  });
}

function calculatePosition(pos, markPrice) {
  const entry = Math.max(0.000001, safeNumber(pos.entryPrice, 1));
  const size = safeNumber(pos.size, 0);
  const margin = Math.max(0.000001, safeNumber(pos.margin, 0));
  const side = pos.side === 'short' ? 'short' : 'long';

  const priceMovePct = side === 'long'
    ? (markPrice - entry) / entry
    : (entry - markPrice) / entry;

  const pnl = size * priceMovePct;
  const roi = pnl / margin * 100;

  return {
    markPrice,
    pnl,
    roi,
    value: size + pnl
  };
}

function updateUserPositions(user, registry) {
  user.positions.forEach(pos => {
    if (pos.status !== 'open') return;

    const markPrice = getMarketPrice(pos.symbol, registry);
    const calc = calculatePosition(pos, markPrice);

    pos.markPrice = calc.markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.value = calc.value;
    pos.updatedAt = nowIso();
  });

  user.activeCopyTrades.forEach(pos => {
    if (pos.status !== 'open') return;

    const markPrice = getMarketPrice(pos.symbol, registry);
    const calc = calculatePosition(pos, markPrice);

    pos.markPrice = calc.markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.value = calc.value;
    pos.updatedAt = nowIso();
  });
}

function updateAllOpenPositions(db) {
  Object.values(db.users || {}).forEach(user => {
    migrateUser(user);
    updateUserPositions(user, db.tensorRegistry);
  });
}

async function marketLoop() {
  try {
    await syncRealCryptoPrices(false);

    const db = readDb();
    syncRegistryWithRealPrices(db);
    updateAllOpenPositions(db);

    writeDb(db);
  } catch (err) {
    console.error('Market loop failed:', err.message);
  }
}

/* -------------------- PNG Export Helper -------------------- */

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const arr = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
      let c = i;

      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }

      arr[i] = c >>> 0;
    }

    return arr;
  })());

  let crc = -1;

  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSimpleTradeHistoryPng(user) {
  const width = 1000;
  const height = 520;
  const channels = 4;
  const raw = Buffer.alloc((width * channels + 1) * height, 255);

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const rowStart = y * (width * channels + 1);
    const idx = rowStart + 1 + x * channels;

    raw[idx] = r;
    raw[idx + 1] = g;
    raw[idx + 2] = b;
    raw[idx + 3] = a;
  }

  function rect(x, y, w, h, r, g, b, a = 255) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        setPixel(xx, yy, r, g, b, a);
      }
    }
  }

  function line(x0, y0, x1, y1, r, g, b) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;

    let err = dx + dy;

    while (true) {
      rect(x0 - 1, y0 - 1, 3, 3, r, g, b);

      if (x0 === x1 && y0 === y1) break;

      const e2 = 2 * err;

      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }

      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  rect(0, 0, width, height, 12, 16, 24);
  rect(30, 30, width - 60, height - 60, 18, 24, 36);
  rect(60, 90, width - 120, 1, 80, 90, 110);
  rect(60, height - 90, width - 120, 1, 80, 90, 110);

  const trades = [...(user.orderHistory || [])].slice(-40);
  const values = trades.map(t => safeNumber(t.pnl, 0));

  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const span = Math.max(1, max - min);

  const chartX = 70;
  const chartY = 120;
  const chartW = width - 140;
  const chartH = 280;

  for (let i = 0; i <= 5; i++) {
    const y = chartY + Math.round(i * chartH / 5);
    rect(chartX, y, chartW, 1, 42, 52, 72);
  }

  if (values.length > 1) {
    const points = values.map((v, i) => {
      const x = chartX + Math.round(i * chartW / Math.max(1, values.length - 1));
      const y = chartY + chartH - Math.round((v - min) / span * chartH);

      return { x, y, v };
    });

    for (let i = 1; i < points.length; i++) {
      const color = points[i].v >= 0 ? [22, 200, 130] : [240, 70, 90];
      line(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, ...color);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------- Page Rendering -------------------- */

function renderIndex(req, res, extra = {}) {
  return res.render('index', {
    error: null,
    message: null,
    email: '',
    user: req.session.user || null,
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice,
    ...extra
  });
}

/* -------------------- Page Routes -------------------- */

/*
  Important:
  Opening your website loads views/index.ejs first.
  It does NOT auto-redirect to /trading anymore.
*/

app.get('/', (req, res) => {
  return renderIndex(req, res);
});

app.get('/index.ejs', (req, res) => {
  return renderIndex(req, res);
});

app.get('/index.html', (req, res) => {
  return res.redirect('/');
});

app.get('/trading', requireAuth, (req, res) => {
  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) {
    req.session.destroy(() => {});
    return res.redirect('/');
  }

  migrateUser(user);

  return res.render('trading', {
    user: publicUser(user),
    registry: db.tensorRegistry || [],
    treasuryAddresses: TREASURY_USDT_ADDRESSES,
    copyProfiles: db.copyProfiles || {},
    publicTradeCards: db.publicTradeCards || {},
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

app.get('/staff', requireStaff, (req, res) => {
  const db = readDb();
  const users = Object.values(db.users || {}).map(publicUser);

  return res.render('staff', {
    user: req.session.user,
    users,
    registry: db.tensorRegistry || [],
    treasury: db.treasury || { collectedFeesUsdt: 0, tradeDeposits: [] },
    copyProfiles: db.copyProfiles || {},
    publicTradeCards: db.publicTradeCards || {},
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

app.get('/copy/:publicId', (req, res) => {
  const db = readDb();
  const profile = db.copyProfiles[req.params.publicId];

  if (!profile || profile.status === 'disabled') {
    return res.status(404).send('Copy trading profile not found.');
  }

  return res.render('copy-profile', {
    profile,
    registry: db.tensorRegistry || [],
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

app.get('/share/trade/:publicId', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.publicId];

  if (!card) {
    return res.status(404).send('Trade card not found.');
  }

  return res.render('trade-card', {
    card,
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

/* -------------------- Auth Routes -------------------- */

app.post('/auth/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !email.includes('@')) {
      return res.status(400).render('index', {
        error: 'Enter a valid email.',
        message: null,
        email,
        user: req.session.user || null,
        safeJsonForEjs,
        escapeHtml,
        formatMoney,
        formatPrice
      });
    }

    const otp = generateOtp();
    saveOtp(email, otp);

    const sent = await sendOtpEmail(email, otp);

    return res.render('index', {
      error: null,
      message: sent
        ? 'Verification code sent. Check your email.'
        : `Development mode: your verification code is ${otp}`,
      email,
      user: req.session.user || null,
      safeJsonForEjs,
      escapeHtml,
      formatMoney,
      formatPrice
    });
  } catch (err) {
    console.error(err);

    return res.status(500).render('index', {
      error: IS_PROD ? 'Could not send verification code.' : err.message,
      message: null,
      email: normalizeEmail(req.body.email),
      user: req.session.user || null,
      safeJsonForEjs,
      escapeHtml,
      formatMoney,
      formatPrice
    });
  }
});

app.post('/auth/verify', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const result = verifyOtp(email, otp);

  if (!result.ok) {
    return res.status(400).render('index', {
      error: result.reason,
      message: null,
      email,
      user: req.session.user || null,
      safeJsonForEjs,
      escapeHtml,
      formatMoney,
      formatPrice
    });
  }

  const user = getOrCreateUser(email, 'user');

  req.session.user = {
    email: user.email,
    role: user.role,
    id: user.id
  };

  return res.redirect('/trading');
});

app.post('/staff/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return res.status(401).render('index', {
      error: 'Invalid staff login.',
      message: null,
      email: '',
      user: req.session.user || null,
      safeJsonForEjs,
      escapeHtml,
      formatMoney,
      formatPrice
    });
  }

  const staffEmail = normalizeEmail(process.env.STAFF_EMAIL || 'staff@tensor.local');
  const user = getOrCreateUser(staffEmail, 'staff');

  req.session.user = {
    email: user.email,
    role: 'staff',
    id: user.id
  };

  return res.redirect('/staff');
});

/* -------------------- API: Session/User -------------------- */

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null
  });
});

app.get('/api/me', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  migrateUser(user);

  res.json({
    user: publicUser(user)
  });
});

app.post('/api/me/network', requireAuthJson, (req, res) => {
  const network = normalizeNetwork(req.body.network);
  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  user.usdtNetwork = network;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    network,
    destination: getTreasuryDestination(network)
  });
});

/* -------------------- API: Market -------------------- */

app.get('/api/prices', async (req, res) => {
  await syncRealCryptoPrices(false);

  const db = readDb();

  res.json({
    syncedAt: Date.now(),
    prices: latestRealPrices,
    registry: db.tensorRegistry || []
  });
});

app.get('/api/registry', (req, res) => {
  const db = readDb();

  res.json({
    registry: db.tensorRegistry || []
  });
});

app.get('/api/candles/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const db = readDb();

  const token = db.tensorRegistry.find(t => {
    return String(t.symbol).toUpperCase() === symbol || String(t.id) === req.params.symbol;
  });

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  initializeCandlesForToken(token.id, token.price);

  res.json({
    symbol: token.symbol,
    candles: tensorCandleHistory[token.id] || []
  });
});

/* -------------------- API: Wallet / Deposit -------------------- */

app.get('/api/deposit-address/:network?', requireAuthJson, (req, res) => {
  const network = normalizeNetwork(req.params.network || req.query.network || 'eth');
  const destination = getTreasuryDestination(network);

  res.json({
    ok: true,
    destination
  });
});

app.post('/api/deposit/record', requireAuthJson, (req, res) => {
  const amount = Math.max(0, safeNumber(req.body.amount, 0));
  const asset = String(req.body.asset || 'USDT').toUpperCase();
  const network = normalizeNetwork(req.body.network || 'eth');
  const txid = String(req.body.txid || '').trim();

  if (amount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0.' });
  }

  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  const destination = getTreasuryDestination(network);

  const deposit = {
    id: makeId('deposit'),
    userEmail: email,
    amount,
    asset,
    network,
    destination,
    txid,
    status: 'pending',
    createdAt: nowIso()
  };

  user.tradeDeposits.push(deposit);
  db.treasury.tradeDeposits.push(deposit);

  writeDb(db);

  res.json({
    ok: true,
    deposit,
    destination
  });
});

app.post('/api/admin/deposit/approve', requireAdminJson, (req, res) => {
  const depositId = String(req.body.depositId || '').trim();

  const db = readDb();
  let found = null;
  let owner = null;

  Object.values(db.users).forEach(user => {
    const deposit = (user.tradeDeposits || []).find(d => d.id === depositId);

    if (deposit) {
      found = deposit;
      owner = user;
    }
  });

  if (!found || !owner) {
    return res.status(404).json({ error: 'Deposit not found.' });
  }

  if (found.status !== 'approved') {
    found.status = 'approved';
    found.approvedAt = nowIso();

    if (found.asset === 'OUSD') {
      owner.ousdBalance = safeNumber(owner.ousdBalance, 0) + safeNumber(found.amount, 0);
    } else {
      owner.usdtBalance = safeNumber(owner.usdtBalance, 0) + safeNumber(found.amount, 0);
    }
  }

  db.treasury.tradeDeposits.forEach(d => {
    if (d.id === depositId) {
      d.status = found.status;
      d.approvedAt = found.approvedAt;
    }
  });

  writeDb(db);

  res.json({
    ok: true,
    deposit: found,
    user: publicUser(owner)
  });
});

/* -------------------- API: Trading -------------------- */

app.post('/api/trade/open', requireAuthJson, (req, res) => {
  const symbol = String(req.body.symbol || 'BTC').toUpperCase();
  const side = req.body.side === 'short' ? 'short' : 'long';
  const margin = Math.max(1, safeNumber(req.body.margin, 0));
  const leverage = Math.max(1, Math.min(150, safeNumber(req.body.leverage, 1)));
  const wallet = String(req.body.wallet || 'USDT').toUpperCase();

  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  const available = wallet === 'OUSD'
    ? safeNumber(user.ousdBalance, 0)
    : safeNumber(user.usdtBalance, 0);

  if (margin > available) {
    return res.status(400).json({ error: `Not enough ${wallet} balance.` });
  }

  const entryPrice = getMarketPrice(symbol, db.tensorRegistry);
  const size = margin * leverage;

  const pos = {
    id: makeId('pos'),
    symbol,
    side,
    wallet,
    margin,
    leverage,
    size,
    entryPrice,
    markPrice: entryPrice,
    pnl: 0,
    roi: 0,
    value: size,
    marginMode: 'cross',
    status: 'open',
    openedAt: nowIso(),
    updatedAt: nowIso()
  };

  if (wallet === 'OUSD') {
    user.ousdBalance -= margin;
  } else {
    user.usdtBalance -= margin;
  }

  user.positions.push(pos);
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    position: pos,
    user: publicUser(user)
  });
});

app.post('/api/trade/close', requireAuthJson, (req, res) => {
  const positionId = String(req.body.positionId || '').trim();

  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  const pos = user.positions.find(p => p.id === positionId && p.status === 'open');

  if (!pos) {
    return res.status(404).json({ error: 'Open position not found.' });
  }

  const markPrice = getMarketPrice(pos.symbol, db.tensorRegistry);
  const calc = calculatePosition(pos, markPrice);

  pos.markPrice = calc.markPrice;
  pos.pnl = calc.pnl;
  pos.roi = calc.roi;
  pos.value = calc.value;
  pos.status = 'closed';
  pos.closedAt = nowIso();

  const returned = Math.max(0, safeNumber(pos.margin, 0) + safeNumber(pos.pnl, 0));

  if (pos.wallet === 'OUSD') {
    user.ousdBalance += returned;
  } else {
    user.usdtBalance += returned;
  }

  user.orderHistory.push({
    ...pos,
    closedAt: pos.closedAt,
    finalReturn: returned
  });

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    closed: pos,
    returned,
    user: publicUser(user)
  });
});

app.get('/api/trades/history', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  res.json({
    orderHistory: user.orderHistory || []
  });
});

app.get('/api/trades/history.png', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) return res.status(404).send('User not found.');

  const png = makeSimpleTradeHistoryPng(user);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename="trade-history.png"');
  res.send(png);
});

/* -------------------- API: Public Trade Cards -------------------- */

app.post('/api/trades/share', requireAuthJson, (req, res) => {
  const positionId = String(req.body.positionId || '').trim();

  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  const trade = [...(user.positions || []), ...(user.orderHistory || [])].find(t => t.id === positionId);

  if (!trade) {
    return res.status(404).json({ error: 'Trade not found.' });
  }

  const publicId = makePublicId('trade');

  const card = {
    publicId,
    userEmail: email,
    symbol: trade.symbol,
    side: trade.side,
    leverage: trade.leverage,
    entryPrice: trade.entryPrice,
    markPrice: trade.markPrice,
    pnl: trade.pnl,
    roi: trade.roi,
    status: trade.status,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt || null,
    createdAt: nowIso()
  };

  db.publicTradeCards[publicId] = card;
  user.publicTradeCards.push(publicId);

  writeDb(db);

  res.json({
    ok: true,
    card,
    url: `${getBaseUrl(req)}/share/trade/${publicId}`
  });
});

/* -------------------- API: Copy Trading -------------------- */

function calculateCopyProfileStats(profile) {
  const positions = profile.positions || [];
  const closed = positions.filter(p => p.status === 'closed');
  const active = positions.filter(p => p.status === 'open');

  const pnl = positions.reduce((sum, p) => sum + safeNumber(p.pnl, 0), 0);
  const margin = positions.reduce((sum, p) => sum + safeNumber(p.margin, 0), 0);
  const roi = margin > 0 ? pnl / margin * 100 : 0;

  return {
    pnl,
    roi,
    totalTrades: positions.length,
    closedTrades: closed.length,
    activeTrades: active.length,
    winRate: closed.length
      ? closed.filter(p => safeNumber(p.pnl, 0) >= 0).length / closed.length * 100
      : 0
  };
}

app.get('/api/copy-profiles', (req, res) => {
  const db = readDb();

  const profiles = Object.values(db.copyProfiles || {}).map(profile => ({
    ...profile,
    stats: calculateCopyProfileStats(profile)
  }));

  res.json({
    profiles
  });
});

app.post('/api/admin/copy-profiles/create', requireAdminJson, (req, res) => {
  const db = readDb();
  const publicId = makePublicId('copy');

  const profile = {
    publicId,
    name: String(req.body.name || 'Tensor Copy Trader').trim(),
    description: String(req.body.description || '').trim(),
    ownerEmail: normalizeEmail(req.session.user.email),
    status: 'active',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    followers: 0,
    totalCopiedUsdt: 0,
    positions: []
  };

  db.copyProfiles[publicId] = profile;

  writeDb(db);

  res.json({
    ok: true,
    profile,
    url: `${getBaseUrl(req)}/copy/${publicId}`
  });
});

app.post('/api/admin/copy-profiles/update', requireAdminJson, (req, res) => {
  const publicId = String(req.body.publicId || '').trim();

  const db = readDb();
  const profile = db.copyProfiles[publicId];

  if (!profile) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  if (req.body.name !== undefined) profile.name = String(req.body.name || '').trim();
  if (req.body.description !== undefined) profile.description = String(req.body.description || '').trim();
  if (req.body.status !== undefined) profile.status = req.body.status === 'disabled' ? 'disabled' : 'active';

  profile.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    profile,
    url: `${getBaseUrl(req)}/copy/${publicId}`
  });
});

app.post('/api/admin/copy-profiles/add-position', requireAdminJson, (req, res) => {
  const publicId = String(req.body.publicId || '').trim();
  const symbol = String(req.body.symbol || 'BTC').toUpperCase();
  const side = req.body.side === 'short' ? 'short' : 'long';
  const margin = Math.max(1, safeNumber(req.body.margin, 100));
  const leverage = Math.max(1, Math.min(150, safeNumber(req.body.leverage, 10)));

  const db = readDb();
  const profile = db.copyProfiles[publicId];

  if (!profile) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  const entryPrice = getMarketPrice(symbol, db.tensorRegistry);

  const position = {
    id: makeId('copypos'),
    symbol,
    side,
    margin,
    leverage,
    size: margin * leverage,
    entryPrice,
    markPrice: entryPrice,
    pnl: 0,
    roi: 0,
    status: 'open',
    openedAt: nowIso(),
    updatedAt: nowIso()
  };

  profile.positions.push(position);
  profile.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    profile,
    position
  });
});

app.post('/api/copy/start', requireAuthJson, (req, res) => {
  const publicId = String(req.body.publicId || '').trim();
  const amount = Math.max(1, safeNumber(req.body.amount, 0));
  const wallet = String(req.body.wallet || 'USDT').toUpperCase();

  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];
  const profile = db.copyProfiles[publicId];

  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!profile || profile.status === 'disabled') {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  const balance = wallet === 'OUSD'
    ? safeNumber(user.ousdBalance, 0)
    : safeNumber(user.usdtBalance, 0);

  if (amount > balance) {
    return res.status(400).json({ error: `Not enough ${wallet} balance.` });
  }

  if (wallet === 'OUSD') {
    user.ousdBalance -= amount;
  } else {
    user.usdtBalance -= amount;
  }

  user.isCopyTrader = true;
  user.copyingTarget = publicId;
  user.copyBalance += amount;

  const openPositions = (profile.positions || []).filter(p => p.status === 'open');
  const perPosition = openPositions.length ? amount / openPositions.length : amount;

  openPositions.forEach(src => {
    const ratio = safeNumber(src.margin, 1) > 0 ? perPosition / safeNumber(src.margin, 1) : 1;

    user.activeCopyTrades.push({
      id: makeId('usercopy'),
      sourceProfileId: publicId,
      sourcePositionId: src.id,
      symbol: src.symbol,
      side: src.side,
      wallet,
      margin: perPosition,
      leverage: src.leverage,
      size: perPosition * src.leverage,
      entryPrice: src.entryPrice,
      markPrice: src.markPrice,
      pnl: safeNumber(src.pnl, 0) * ratio,
      roi: safeNumber(src.roi, 0),
      status: 'open',
      openedAt: nowIso(),
      updatedAt: nowIso()
    });
  });

  profile.followers = safeNumber(profile.followers, 0) + 1;
  profile.totalCopiedUsdt = safeNumber(profile.totalCopiedUsdt, 0) + amount;

  writeDb(db);

  res.json({
    ok: true,
    user: publicUser(user),
    profile
  });
});

app.post('/api/copy/stop', requireAuthJson, (req, res) => {
  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) return res.status(404).json({ error: 'User not found.' });

  let returned = 0;

  user.activeCopyTrades.forEach(pos => {
    if (pos.status !== 'open') return;

    const markPrice = getMarketPrice(pos.symbol, db.tensorRegistry);
    const calc = calculatePosition(pos, markPrice);
    const finalReturn = Math.max(0, safeNumber(pos.margin, 0) + calc.pnl);

    pos.markPrice = calc.markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.status = 'closed';
    pos.closedAt = nowIso();
    pos.finalReturn = finalReturn;

    returned += finalReturn;
  });

  user.usdtBalance += returned;
  user.copyBalance = 0;
  user.copyingTarget = null;
  user.isCopyTrader = false;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    returned,
    user: publicUser(user)
  });
});

/* -------------------- API: Admin -------------------- */

app.get('/api/admin/users', requireAdminJson, (req, res) => {
  const db = readDb();

  res.json({
    users: Object.values(db.users || {}).map(publicUser)
  });
});

app.post('/api/admin/user/balance', requireAdminJson, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const usdtBalance = req.body.usdtBalance === undefined ? null : safeNumber(req.body.usdtBalance, 0);
  const ousdBalance = req.body.ousdBalance === undefined ? null : safeNumber(req.body.ousdBalance, 0);

  const db = readDb();
  const user = db.users[email];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (usdtBalance !== null) user.usdtBalance = usdtBalance;
  if (ousdBalance !== null) user.ousdBalance = ousdBalance;

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    user: publicUser(user)
  });
});

app.post('/api/admin/asset/create', requireAdminJson, (req, res) => {
  const db = readDb();
  const symbol = String(req.body.symbol || '').trim().toUpperCase();

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required.' });
  }

  if (db.tensorRegistry.some(t => String(t.symbol).toUpperCase() === symbol)) {
    return res.status(400).json({ error: 'Asset already exists.' });
  }

  const price = Math.max(0.000001, safeNumber(req.body.price, 1));
  const supply = Math.max(1, safeNumber(req.body.supply, 10000000));

  const token = {
    id: makeId('asset'),
    name: String(req.body.name || symbol).trim(),
    symbol,
    price,
    startPrice: price,
    bias: String(req.body.bias || 'balanced'),
    bullChance: safeNumber(req.body.bullChance, 50),
    minPct: safeNumber(req.body.minPct, 0.001),
    maxPct: safeNumber(req.body.maxPct, 0.006),
    icon: String(req.body.icon || symbol[0]).trim(),
    supply,
    marketCap: price * supply,
    volume: 0,
    dominance: 0,
    changePercent24h: 0,
    high24h: price,
    low24h: price,
    lifetimeHigh: price
  };

  db.tensorRegistry.push(token);

  writeDb(db);

  res.json({
    ok: true,
    token
  });
});

app.post('/api/admin/asset/update', requireAdminJson, (req, res) => {
  const id = String(req.body.id || '').trim();
  const symbol = String(req.body.symbol || '').trim().toUpperCase();

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === id || String(t.symbol).toUpperCase() === symbol);

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  if (req.body.name !== undefined) token.name = String(req.body.name || token.name).trim();
  if (req.body.price !== undefined) token.price = Math.max(0.000001, safeNumber(req.body.price, token.price));
  if (req.body.bias !== undefined) token.bias = String(req.body.bias || token.bias);
  if (req.body.bullChance !== undefined) token.bullChance = safeNumber(req.body.bullChance, token.bullChance);
  if (req.body.minPct !== undefined) token.minPct = safeNumber(req.body.minPct, token.minPct);
  if (req.body.maxPct !== undefined) token.maxPct = safeNumber(req.body.maxPct, token.maxPct);
  if (req.body.icon !== undefined) token.icon = String(req.body.icon || token.icon).trim();
  if (req.body.supply !== undefined) token.supply = Math.max(1, safeNumber(req.body.supply, token.supply));

  migrateToken(token);

  writeDb(db);

  res.json({
    ok: true,
    token
  });
});

/* -------------------- 404 / Error Handling -------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  return res.status(404).render('index', {
    error: 'Page not found.',
    message: null,
    email: '',
    user: req.session.user || null,
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err);

  if (req.path.startsWith('/api')) {
    return res.status(500).json({
      error: 'Server error.',
      details: IS_PROD ? undefined : err.message
    });
  }

  return res.status(500).render('index', {
    error: IS_PROD ? 'Server error.' : err.message,
    message: null,
    email: '',
    user: req.session.user || null,
    safeJsonForEjs,
    escapeHtml,
    formatMoney,
    formatPrice
  });
});

/* -------------------- Start -------------------- */

ensureDb();

syncRealCryptoPrices(true)
  .catch(err => console.error('Initial price sync failed:', err.message));

setInterval(marketLoop, MARKET_LOOP_MS);

app.listen(PORT, () => {
  console.log(`Tensor Wallet running on port ${PORT}`);
  console.log(`Main page renders: views/index.ejs`);
});