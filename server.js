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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, safeNumber(value, min)));
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

function defaultCopyProfiles() {
  return {
    copy_default_alpha: {
      id: 'copy_default_alpha',
      publicId: 'copy_default_alpha',
      ownerEmail: 'admin@tensorwallet.local',
      ownerWalletId: 'system',
      name: 'Tensor Alpha Copy',
      tag: 'Public strategy',
      description: 'Demo public copy trading profile. Admin can create new profiles from the trading page.',
      roi: 14.85,
      pnl: 2840.25,
      followers: 128,
      risk: 'Medium',
      minCopyUsdt: 50,
      status: 'active',
      positions: [],
      createdAt: Date.now(),
      createdAtIso: nowIso(),
      updatedAt: Date.now(),
      updatedAtIso: nowIso()
    }
  };
}

function defaultDb() {
  return {
    users: {},
    otps: {},
    tensorRegistry: defaultTensorAssets(),
    treasury: {
      collectedFeesUsdt: 0,
      tradeDeposits: [],
      copyDeposits: []
    },
    publicTradeCards: {},
    copyProfiles: defaultCopyProfiles()
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
      tradeDeposits: [],
      copyDeposits: []
    };
  }

  if (!Array.isArray(db.treasury.tradeDeposits)) db.treasury.tradeDeposits = [];
  if (!Array.isArray(db.treasury.copyDeposits)) db.treasury.copyDeposits = [];
  if (db.treasury.collectedFeesUsdt === undefined) db.treasury.collectedFeesUsdt = 0;

  if (!db.publicTradeCards) db.publicTradeCards = {};
  if (!db.copyProfiles || typeof db.copyProfiles !== 'object') {
    db.copyProfiles = defaultCopyProfiles();
  }

  if (db.tensorRegistry.length === 0) {
    db.tensorRegistry = defaultTensorAssets();
  }

  Object.values(db.users).forEach(migrateUser);
  db.tensorRegistry.forEach(migrateToken);
  Object.values(db.copyProfiles).forEach(migrateCopyProfile);
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

  if (!user.tensorAddress && user.email) {
    user.tensorAddress = `T0x${sha(user.email).slice(0, 40)}`;
  }

  if (!user.tensorVault) user.tensorVault = null;
  if (!user.tensorBalances) user.tensorBalances = {};
  if (!Array.isArray(user.positions)) user.positions = [];
  if (!Array.isArray(user.orderHistory)) user.orderHistory = [];
  if (!Array.isArray(user.tradeDeposits)) user.tradeDeposits = [];
  if (!Array.isArray(user.publicTradeCards)) user.publicTradeCards = [];
  if (!Array.isArray(user.copyTrades)) user.copyTrades = [];
  if (!Array.isArray(user.copyDeposits)) user.copyDeposits = [];

  if (user.usdtBalance === undefined) {
    user.usdtBalance = user.role === 'staff' ? 1000000 : 15000;
  }

  user.usdtBalance = safeNumber(user.usdtBalance, user.role === 'staff' ? 1000000 : 15000);
  user.usdtNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

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

  user.copyTrades.forEach(copy => {
    if (!copy.id) copy.id = makeId('copytrade');
    copy.amountUsdt = safeNumber(copy.amountUsdt, 0);
    copy.pnl = safeNumber(copy.pnl, 0);
    copy.roi = safeNumber(copy.roi, 0);
    copy.status = copy.status || 'active';
    copy.startedAt = safeNumber(copy.startedAt, Date.now());
    if (!copy.startedAtIso) copy.startedAtIso = nowIso();
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

function migrateCopyProfile(profile) {
  if (!profile) return;

  if (!profile.id) profile.id = makePublicId('copy');
  if (!profile.publicId) profile.publicId = profile.id;
  if (!profile.name) profile.name = 'Copy Trading Profile';
  if (!profile.tag) profile.tag = 'Public strategy';
  if (!profile.description) profile.description = '';

  profile.roi = safeNumber(profile.roi ?? profile.currentRoi, 0);
  profile.pnl = safeNumber(profile.pnl ?? profile.currentPnl, 0);
  profile.followers = Math.max(0, Math.floor(safeNumber(profile.followers ?? profile.copiers, 0)));
  profile.risk = ['Low', 'Medium', 'High'].includes(profile.risk) ? profile.risk : 'Medium';
  profile.minCopyUsdt = Math.max(1, safeNumber(profile.minCopyUsdt, 50));
  profile.status = profile.status === 'paused' ? 'paused' : 'active';

  if (!Array.isArray(profile.positions)) profile.positions = [];
  if (!profile.createdAt) profile.createdAt = Date.now();
  if (!profile.createdAtIso) profile.createdAtIso = nowIso();

  profile.updatedAt = safeNumber(profile.updatedAt, Date.now());
  if (!profile.updatedAtIso) profile.updatedAtIso = nowIso();
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
    usdtNetwork: 'eth',
    positions: [],
    orderHistory: [],
    tradeDeposits: [],
    publicTradeCards: [],
    copyTrades: [],
    copyDeposits: []
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
    }

    writeDb(db);
  }

  return db.users[normEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/index.html');
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

  if (!record) {
    return { ok: false, reason: 'No OTP found. Please request a new code.' };
  }

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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cachedJson(key, ttlMs, fetcher) {
  const hit = cache.get(key);

  if (hit && Date.now() - hit.time < ttlMs) {
    return hit.data;
  }

  const data = await fetcher();

  cache.set(key, {
    time: Date.now(),
    data
  });

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
      data = await fetchJsonWithTimeout(
        `${BINANCE_BASE}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
        {},
        4500
      );
    } catch {
      data = await fetchJsonWithTimeout(
        `${BINANCE_FALLBACK}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
        {},
        4500
      );
    }

    if (!Array.isArray(data)) {
      return latestRealPrices;
    }

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

/* -------------------- Candle / Trading Engine -------------------- */

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId] && tensorCandleHistory[tokenId].length) {
    return;
  }

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
      close
    });

    price = close;
    timeCursor += BASE_CANDLE_MS;
  }

  tensorCandleHistory[tokenId] = candles;
}

function hydrateAllCandles() {
  const db = readDb();

  db.tensorRegistry.forEach(token => {
    initializeCandlesForToken(token.id, token.price);
  });
}

function pushLiveCandle(token, oldPrice) {
  initializeCandlesForToken(token.id, oldPrice);

  const history = tensorCandleHistory[token.id];
  const now = Date.now();
  const fiveMinuteBucket = Math.floor(now / BASE_CANDLE_MS) * BASE_CANDLE_MS;
  const last = history[history.length - 1];

  if (last && last.time === fiveMinuteBucket) {
    last.close = token.price;
    last.high = Math.max(last.high, token.price);
    last.low = Math.min(last.low, token.price);
  } else {
    history.push({
      time: fiveMinuteBucket,
      open: oldPrice,
      high: Math.max(oldPrice, token.price),
      low: Math.min(oldPrice, token.price),
      close: token.price
    });

    while (history.length > MAX_CANDLES) {
      history.shift();
    }
  }
}

function getLiquidationPrice(pos, availableBalance = 0) {
  const entry = safeNumber(pos.entryPrice, 0);
  const size = safeNumber(pos.size, 0);
  const margin = safeNumber(pos.margin, 0);
  const side = pos.side === 'short' ? 'short' : 'long';
  const mode = pos.marginMode || 'cross';

  if (entry <= 0 || size <= 0 || margin <= 0) return 0;

  const usableMargin = mode === 'cross'
    ? margin + Math.max(0, safeNumber(availableBalance, 0))
    : margin;

  const priceMove = (usableMargin / size) * entry;

  if (side === 'long') {
    return Math.max(0, entry - priceMove);
  }

  return entry + priceMove;
}

function calculatePnl(pos, currentPrice) {
  const entry = safeNumber(pos.entryPrice, 0);
  const size = safeNumber(pos.size, 0);

  if (entry <= 0 || size <= 0) return 0;

  const priceDiff = pos.side === 'long'
    ? currentPrice - entry
    : entry - currentPrice;

  return (priceDiff / entry) * size;
}

function buildTreasuryDeposit({ user, token, margin, leverage, side, marginMode, network }) {
  const selectedNetwork = normalizeNetwork(network || user.usdtNetwork || inferUserUsdtNetwork(user));
  const destination = getTreasuryDestination(selectedNetwork);
  const id = makeId('deposit');
  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;

  return {
    id,
    txHash,
    type: 'USDT_TRADE_MARGIN_DEPOSIT',
    status: 'recorded',
    note: 'Demo ledger transfer recorded by Tensor Wallet. No on-chain broadcast is performed without wallet signing infrastructure.',
    userEmail: user.email,
    userWalletId: user.id,
    amountUsdt: margin,
    tokenId: token.id,
    symbol: token.symbol,
    side,
    leverage,
    marginMode,
    sourceUsdtNetwork: selectedNetwork,
    destinationNetworkKey: destination.key,
    destinationNetwork: destination.network,
    destinationSymbol: destination.symbol,
    destinationAddress: destination.address,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };
}

function buildCopyDeposit({ user, profile, amountUsdt, network }) {
  const selectedNetwork = normalizeNetwork(network || user.usdtNetwork || inferUserUsdtNetwork(user));
  const destination = getTreasuryDestination(selectedNetwork);

  return {
    id: makeId('copydep'),
    txHash: `0x${crypto.randomBytes(32).toString('hex')}`,
    type: 'USDT_COPY_TRADING_DEPOSIT',
    status: 'recorded',
    note: 'Demo copy-trading allocation recorded in the Tensor Wallet ledger. No on-chain broadcast is performed without wallet signing infrastructure.',
    userEmail: user.email,
    userWalletId: user.id,
    profileId: profile.id,
    profileName: profile.name,
    amountUsdt,
    sourceUsdtNetwork: selectedNetwork,
    destinationNetworkKey: destination.key,
    destinationNetwork: destination.network,
    destinationSymbol: destination.symbol,
    destinationAddress: destination.address,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };
}

function updateCopyTradePerformance(db, user) {
  if (!Array.isArray(user.copyTrades) || user.copyTrades.length === 0) return;

  user.copyTrades.forEach(copy => {
    if (copy.status !== 'active') return;

    const profile = db.copyProfiles[copy.profileId];
    if (!profile) return;

    const targetRoi = safeNumber(profile.roi, 0);
    const startedAt = safeNumber(copy.startedAt, Date.now());
    const ageHours = Math.max(0, (Date.now() - startedAt) / (1000 * 60 * 60));
    const ramp = Math.min(1, ageHours / 24);
    const drift = Math.sin((Date.now() / 60000) + safeNumber(copy.amountUsdt, 0)) * 0.18;
    const roi = targetRoi * ramp + drift;
    const pnl = safeNumber(copy.amountUsdt, 0) * (roi / 100);

    copy.roi = Number(roi.toFixed(4));
    copy.pnl = Number(pnl.toFixed(6));
    copy.markValueUsdt = Number((safeNumber(copy.amountUsdt, 0) + pnl).toFixed(6));
    copy.updatedAt = Date.now();
    copy.updatedAtIso = nowIso();
  });
}

async function runMarketLoop() {
  try {
    await syncRealCryptoPrices();

    if (!fs.existsSync(DB_PATH)) return;

    const db = readDb();

    if (!db.tensorRegistry.length) {
      db.tensorRegistry = defaultTensorAssets();
    }

    let totalMarketCap = 0;

    db.tensorRegistry.forEach(token => {
      migrateToken(token);
      token.marketCap = token.price * token.supply;
      totalMarketCap += token.marketCap;
    });

    let alphaDrift = 0;

    db.tensorRegistry.forEach(token => {
      token.dominance = totalMarketCap > 0 ? (token.marketCap / totalMarketCap) * 100 : 0;

      if (token.dominance > 30 && token.bias !== 'pegged' && token.bias !== 'real') {
        alphaDrift += (Math.random() - 0.5) * 0.003 * (token.dominance / 100);
      }
    });

    db.tensorRegistry.forEach(token => {
      const oldPrice = token.price;
      const mappedSymbol = REAL_SYMBOL_MAP[String(token.symbol || '').toUpperCase()];
      const real = mappedSymbol ? latestRealPrices[mappedSymbol] : null;

      if (real && real.price > 0) {
        token.bias = 'real';
        token.price = real.price;
        token.volume = real.volume || token.volume || 0;
        token.changePercent24h = real.changePercent || 0;
        token.high24h = real.high || token.price;
        token.low24h = real.low || token.price;
        token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price, token.high24h);
        token.marketCap = token.price * token.supply;

        pushLiveCandle(token, oldPrice);
        return;
      }

      if (token.bias === 'pegged') {
        token.price = token.startPrice || 1;
      } else {
        const bullChance = clamp(token.bullChance, 0, 100);
        const direction = Math.random() * 100 <= bullChance ? 1 : -1;

        const minPct = Math.max(0, safeNumber(token.minPct, 0.0005));
        const maxPct = Math.max(minPct, safeNumber(token.maxPct, 0.004));
        const magnitude = minPct + Math.random() * (maxPct - minPct);

        const dominanceDampener = token.dominance > 35
          ? 0.25
          : Math.max(0.35, 1 - token.dominance / 100);

        const randomMove = direction * magnitude * dominanceDampener;
        const totalMove = randomMove + alphaDrift;

        token.price = Math.max(0.000001, oldPrice * (1 + totalMove));
      }

      token.marketCap = token.price * token.supply;
      token.volume = safeNumber(token.volume, 0) * 0.96 + Math.abs(token.price - oldPrice) * token.supply * 0.04;
      token.high24h = Math.max(safeNumber(token.high24h, token.price), token.price);
      token.low24h = Math.min(safeNumber(token.low24h, token.price), token.price);
      token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price, token.high24h);
      token.changePercent24h = token.startPrice > 0
        ? ((token.price - token.startPrice) / token.startPrice) * 100
        : 0;

      pushLiveCandle(token, oldPrice);
    });

    Object.keys(db.users).forEach(email => {
      const user = db.users[email];
      migrateUser(user);
      updateCopyTradePerformance(db, user);

      if (!Array.isArray(user.positions) || user.positions.length === 0) {
        user.updatedAt = nowIso();
        return;
      }

      const keptPositions = [];

      user.positions.forEach(pos => {
        const token = db.tensorRegistry.find(t => t.id === pos.tokenId);

        if (!token) {
          keptPositions.push(pos);
          return;
        }

        pos.markPrice = token.price;

        const currentPrice = token.price;
        const liqPrice = getLiquidationPrice(pos, user.usdtBalance);

        const isLiquidated = pos.side === 'long'
          ? currentPrice <= liqPrice
          : currentPrice >= liqPrice;

        if (isLiquidated) {
          const pnl = -Math.abs(safeNumber(pos.margin, 0));
          const roi = pos.margin > 0 ? (pnl / pos.margin) * 100 : -100;

          user.orderHistory.unshift({
            ...pos,
            closePrice: currentPrice,
            markPrice: currentPrice,
            pnl,
            roi,
            closedAt: Date.now(),
            closedAtIso: nowIso(),
            closeReason: 'Liquidation'
          });
        } else {
          keptPositions.push(pos);
        }
      });

      user.positions = keptPositions;
      user.orderHistory = user.orderHistory.slice(0, 100);
      user.updatedAt = nowIso();
    });

    writeDb(db);
  } catch (err) {
    console.error('Market loop error:', err);
  }
}

/* -------------------- Public Trade Cards -------------------- */

function buildTradeCardPayload({ req, db, user, trade }) {
  const publicId = makePublicId('trade');
  const baseUrl = getBaseUrl(req);
  const side = trade.side === 'short' ? 'SHORT' : 'LONG';
  const pnl = safeNumber(trade.pnl, 0);
  const roi = safeNumber(trade.roi, trade.margin > 0 ? (pnl / trade.margin) * 100 : 0);
  const isProfit = pnl >= 0;

  const payload = {
    id: publicId,
    createdAt: Date.now(),
    createdAtIso: nowIso(),
    brand: 'bluecrypto.ink',
    verifiedBy: 'Tensor Wallet',
    verificationText: 'Verified by Tensor Wallet',
    ownerWalletId: user.id,
    ownerEmailHash: sha(user.email).slice(0, 16),
    trade: {
      id: trade.id,
      symbol: trade.symbol,
      tokenId: trade.tokenId,
      side,
      leverage: safeNumber(trade.leverage, 1),
      margin: safeNumber(trade.margin, 0),
      size: safeNumber(trade.size, 0),
      entryPrice: safeNumber(trade.entryPrice, 0),
      closePrice: safeNumber(trade.closePrice, trade.markPrice || 0),
      markPrice: safeNumber(trade.markPrice, trade.closePrice || 0),
      pnl,
      roi,
      closeReason: trade.closeReason || 'Market Close',
      openedAt: trade.openedAt || null,
      closedAt: trade.closedAt || Date.now()
    },
    style: {
      isProfit,
      resultText: isProfit ? 'PROFIT' : 'LOSS',
      color: isProfit ? '#0ecb81' : '#f6465d'
    },
    links: {
      page: `${baseUrl}/trade/${publicId}`,
      image: `${baseUrl}/trade/${publicId}/image.svg`,
      download: `${baseUrl}/trade/${publicId}/download`
    }
  };

  db.publicTradeCards[publicId] = payload;

  user.publicTradeCards.unshift({
    id: publicId,
    tradeId: trade.id,
    page: payload.links.page,
    image: payload.links.image,
    createdAt: payload.createdAt
  });

  user.publicTradeCards = user.publicTradeCards.slice(0, 100);

  return payload;
}

function renderTradeCardSvg(card) {
  const t = card.trade;
  const color = card.style.color;
  const bg = '#070a0f';
  const panel = '#111827';
  const panel2 = '#0b1220';
  const muted = '#94a3b8';
  const white = '#f8fafc';
  const grid = '#1f2937';
  const watermark = 'bluecrypto.ink';
  const isProfit = t.pnl >= 0;
  const pnlText = `${isProfit ? '+' : '-'}$${formatMoney(Math.abs(t.pnl), 2)}`;
  const roiText = `${t.roi >= 0 ? '+' : ''}${formatMoney(t.roi, 2)}%`;
  const sideText = `${t.side} ${t.leverage}x`;

  const candles = Array.from({ length: 18 }).map((_, i) => {
    const x = 70 + i * 62;
    const open = 360 + Math.sin(i * 1.7) * 70;
    const close = open + Math.cos(i * 1.2) * 85;
    const high = Math.min(open, close) - 55;
    const low = Math.max(open, close) + 55;
    const candleColor = close < open ? '#0ecb81' : '#f6465d';
    const y = Math.min(open, close);
    const h = Math.max(8, Math.abs(close - open));

    return `<line x1="${x}" y1="${high}" x2="${x}" y2="${low}" stroke="${candleColor}" stroke-width="4"/><rect x="${x - 12}" y="${y}" width="24" height="${h}" rx="4" fill="${candleColor}"/>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="675" viewBox="0 0 1200 675" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="55%" stop-color="#0b1020"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.85"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="20" stdDeviation="22" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="1200" height="675" fill="url(#bgGrad)"/>

  <g opacity="0.12">
    <path d="M0 520 C180 460 280 570 440 500 S720 370 900 430 S1070 580 1200 500" fill="none" stroke="${color}" stroke-width="4"/>
    <path d="M0 560 C220 480 310 625 520 530 S780 405 960 470 S1110 610 1200 555" fill="none" stroke="#8b5cf6" stroke-width="3"/>
  </g>

  <g opacity="0.16">${candles}</g>

  <rect x="55" y="45" width="1090" height="585" rx="34" fill="${panel}" opacity="0.94" filter="url(#softShadow)"/>
  <rect x="55" y="45" width="1090" height="585" rx="34" fill="none" stroke="${grid}" stroke-width="2"/>

  <rect x="55" y="45" width="1090" height="116" rx="34" fill="${panel2}"/>
  <rect x="55" y="127" width="1090" height="34" fill="${panel2}"/>

  <text x="92" y="103" font-family="Inter, Arial, sans-serif" font-size="34" font-weight="900" fill="${white}">bluecrypto.ink</text>
  <text x="92" y="134" font-family="Inter, Arial, sans-serif" font-size="17" font-weight="800" fill="${muted}">Verified by Tensor Wallet</text>

  <rect x="848" y="76" width="245" height="52" rx="18" fill="url(#accentGrad)"/>
  <text x="970" y="110" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="900" fill="#fff">${escapeHtml(card.style.resultText)}</text>

  <text x="92" y="230" font-family="Inter, Arial, sans-serif" font-size="72" font-weight="950" fill="${white}">${escapeHtml(t.symbol)} / USDT</text>
  <text x="96" y="272" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="900" fill="${color}">${escapeHtml(sideText)}</text>

  <text x="92" y="377" font-family="Inter, Arial, sans-serif" font-size="90" font-weight="950" fill="${color}">${escapeHtml(roiText)}</text>
  <text x="96" y="418" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="850" fill="${muted}">Return on Investment</text>

  <rect x="685" y="205" width="410" height="295" rx="26" fill="#0b1220" stroke="${grid}" stroke-width="2"/>

  <text x="725" y="262" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="850" fill="${muted}">PNL</text>
  <text x="1070" y="262" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="29" font-weight="950" fill="${color}">${escapeHtml(pnlText)}</text>

  <text x="725" y="322" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="850" fill="${muted}">Margin</text>
  <text x="1070" y="322" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900"