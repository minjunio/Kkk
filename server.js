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
      tradeDeposits: [],
      copyDeposits: []
    };
  }

  if (!Array.isArray(db.treasury.tradeDeposits)) db.treasury.tradeDeposits = [];
  if (!Array.isArray(db.treasury.copyDeposits)) db.treasury.copyDeposits = [];
  if (db.treasury.collectedFeesUsdt === undefined) db.treasury.collectedFeesUsdt = 0;

  if (!db.publicTradeCards) db.publicTradeCards = {};
  if (!db.copyProfiles || typeof db.copyProfiles !== 'object') db.copyProfiles = {};

  if (db.tensorRegistry.length === 0) db.tensorRegistry = defaultTensorAssets();

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

  user.positions.forEach(pos => migratePosition(pos));

  user.copyTrades.forEach(copy => {
    if (!copy.id) copy.id = makeId('copytrade');
    copy.amountUsdt = safeNumber(copy.amountUsdt, 0);
    copy.pnl = safeNumber(copy.pnl, 0);
    copy.roi = safeNumber(copy.roi, 0);
    copy.markValueUsdt = safeNumber(copy.markValueUsdt, copy.amountUsdt + copy.pnl);
    copy.status = copy.status || 'active';
    copy.startedAt = safeNumber(copy.startedAt, Date.now());
    if (!copy.startedAtIso) copy.startedAtIso = nowIso();
    if (!Array.isArray(copy.copiedPositions)) copy.copiedPositions = [];
    if (copy.followsNewAdminTrades === undefined) copy.followsNewAdminTrades = true;
    copy.copiedPositions.forEach(pos => migrateCopiedPosition(pos));
  });
}

function migratePosition(pos) {
  if (!pos.id) pos.id = makeId('pos');
  if (!pos.marginMode) pos.marginMode = 'cross';

  pos.margin = safeNumber(pos.margin, 0);
  pos.leverage = safeNumber(pos.leverage, 1);
  pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
  pos.entryPrice = safeNumber(pos.entryPrice, 1);
  pos.markPrice = safeNumber(pos.markPrice, pos.entryPrice);
  pos.side = pos.side === 'short' ? 'short' : 'long';

  if (!pos.openedAt) pos.openedAt = Date.now();
  if (!pos.openedAtIso) pos.openedAtIso = nowIso();
}

function migrateCopiedPosition(pos) {
  if (!pos.id) pos.id = makeId('copypos');
  if (!pos.adminPositionId) pos.adminPositionId = pos.sourcePositionId || '';
  if (!pos.status) pos.status = 'open';
  if (!pos.side) pos.side = 'long';

  pos.side = pos.side === 'short' ? 'short' : 'long';
  pos.margin = safeNumber(pos.margin, 0);
  pos.leverage = safeNumber(pos.leverage, 1);
  pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
  pos.entryPrice = safeNumber(pos.entryPrice, 1);
  pos.markPrice = safeNumber(pos.markPrice, pos.entryPrice);
  pos.pnl = safeNumber(pos.pnl, 0);
  pos.roi = safeNumber(pos.roi, 0);

  if (!pos.openedAt) pos.openedAt = Date.now();
  if (!pos.openedAtIso) pos.openedAtIso = nowIso();
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
  if (!profile.ownerEmail) profile.ownerEmail = 'admin@tensorwallet.local';
  if (!profile.ownerWalletId) profile.ownerWalletId = 'system';
  if (!profile.name) profile.name = 'Copy Trading Profile';
  if (!profile.tag) profile.tag = 'Admin live trading profile';
  if (!profile.description) profile.description = '';

  profile.roi = safeNumber(profile.roi ?? profile.currentRoi, 0);
  profile.pnl = safeNumber(profile.pnl ?? profile.currentPnl, 0);
  profile.openPnl = safeNumber(profile.openPnl, 0);
  profile.closedPnl = safeNumber(profile.closedPnl, 0);
  profile.totalMargin = safeNumber(profile.totalMargin, 0);
  profile.followers = Math.max(0, Math.floor(safeNumber(profile.followers ?? profile.copiers, 0)));
  profile.risk = ['Low', 'Medium', 'High'].includes(profile.risk) ? profile.risk : 'Medium';
  profile.minCopyUsdt = Math.max(1, safeNumber(profile.minCopyUsdt, 50));
  profile.status = profile.status === 'paused' ? 'paused' : 'active';
  profile.source = profile.source || 'admin_live_trading';

  if (!Array.isArray(profile.positions)) profile.positions = [];
  if (!Array.isArray(profile.history)) profile.history = [];

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
      writeDb(db);
    }
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

function calculateRoiFromPnl(pnl, margin) {
  const m = safeNumber(margin, 0);
  if (m <= 0) return 0;
  return (safeNumber(pnl, 0) / m) * 100;
}

function findTokenById(db, tokenId) {
  return db.tensorRegistry.find(t => String(t.id) === String(tokenId));
}

/* -------------------- Copy Trading Engine -------------------- */

function getAdminOpenPositionsWithPnl(db, admin) {
  migrateUser(admin);

  return (admin.positions || []).map(pos => {
    migratePosition(pos);

    const token = findTokenById(db, pos.tokenId);
    const markPrice = token ? token.price : safeNumber(pos.markPrice, pos.entryPrice);
    const pnl = calculatePnl(pos, markPrice);
    const roi = calculateRoiFromPnl(pnl, pos.margin);

    return {
      ...pos,
      markPrice,
      pnl,
      roi,
      adminPositionId: pos.id
    };
  });
}

function calculateAdminProfileStats(db, admin) {
  migrateUser(admin);

  const openPositions = getAdminOpenPositionsWithPnl(db, admin);

  let openPnl = 0;
  let openMargin = 0;
  let closedPnl = 0;
  let closedMargin = 0;

  openPositions.forEach(pos => {
    openPnl += safeNumber(pos.pnl, 0);
    openMargin += safeNumber(pos.margin, 0);
  });

  (admin.orderHistory || []).forEach(trade => {
    closedPnl += safeNumber(trade.pnl, 0);
    closedMargin += safeNumber(trade.margin, 0);
  });

  const totalPnl = openPnl + closedPnl;
  const totalMargin = openMargin + closedMargin;
  const roi = totalMargin > 0 ? (totalPnl / totalMargin) * 100 : 0;

  return {
    pnl: Number(totalPnl.toFixed(6)),
    roi: Number(roi.toFixed(4)),
    openPnl: Number(openPnl.toFixed(6)),
    closedPnl: Number(closedPnl.toFixed(6)),
    openMargin: Number(openMargin.toFixed(6)),
    closedMargin: Number(closedMargin.toFixed(6)),
    totalMargin: Number(totalMargin.toFixed(6)),
    positions: openPositions,
    history: (admin.orderHistory || []).slice(0, 50)
  };
}

function syncCopyProfileFromAdmin(db, profile) {
  migrateCopyProfile(profile);

  const admin = db.users[normalizeEmail(profile.ownerEmail)];

  if (!admin) {
    profile.updatedAt = Date.now();
    profile.updatedAtIso = nowIso();
    return profile;
  }

  const stats = calculateAdminProfileStats(db, admin);

  profile.pnl = stats.pnl;
  profile.roi = stats.roi;
  profile.openPnl = stats.openPnl;
  profile.closedPnl = stats.closedPnl;
  profile.totalMargin = stats.totalMargin;
  profile.positions = stats.positions;
  profile.history = stats.history;
  profile.source = 'admin_live_trading';
  profile.updatedAt = Date.now();
  profile.updatedAtIso = nowIso();

  return profile;
}

function syncAllCopyProfilesFromAdmins(db) {
  Object.values(db.copyProfiles || {}).forEach(profile => {
    syncCopyProfileFromAdmin(db, profile);
  });
}

function getActiveFollowersForProfile(db, profileId) {
  const followers = [];

  Object.values(db.users || {}).forEach(user => {
    migrateUser(user);

    const activeCopies = (user.copyTrades || []).filter(copy => {
      return copy.status === 'active'
        && String(copy.profileId) === String(profileId)
        && copy.followsNewAdminTrades !== false;
    });

    activeCopies.forEach(copy => {
      followers.push({ user, copy });
    });
  });

  return followers;
}

function buildCopiedPositionFromAdmin({ adminPosition, copyTrade, profile }) {
  const amountUsdt = safeNumber(copyTrade.amountUsdt, 0);
  const profileTotalMargin = Math.max(1, safeNumber(profile.totalMargin, 0));
  const adminMargin = safeNumber(adminPosition.margin, 0);
  const ratio = adminMargin > 0 ? adminMargin / profileTotalMargin : 0;
  const copyMargin = Math.max(0.01, amountUsdt * ratio);
  const leverage = safeNumber(adminPosition.leverage, 1);

  return {
    id: makeId('copypos'),
    adminPositionId: adminPosition.id,
    profileId: profile.id,
    tokenId: adminPosition.tokenId,
    symbol: adminPosition.symbol,
    side: adminPosition.side === 'short' ? 'short' : 'long',
    margin: Number(copyMargin.toFixed(6)),
    leverage,
    marginMode: adminPosition.marginMode || 'cross',
    size: Number((copyMargin * leverage).toFixed(6)),
    entryPrice: safeNumber(adminPosition.entryPrice, 1),
    markPrice: safeNumber(adminPosition.markPrice, adminPosition.entryPrice),
    pnl: 0,
    roi: 0,
    status: 'open',
    copiedFromAdminEmail: profile.ownerEmail,
    openedAt: Date.now(),
    openedAtIso: nowIso()
  };
}

function copyAdminOpenPositionsToCopyTrade(db, profile, copyTrade) {
  syncCopyProfileFromAdmin(db, profile);

  if (!Array.isArray(copyTrade.copiedPositions)) copyTrade.copiedPositions = [];

  const adminPositions = profile.positions || [];

  adminPositions.forEach(adminPos => {
    const exists = copyTrade.copiedPositions.some(pos => {
      return String(pos.adminPositionId) === String(adminPos.id) && pos.status === 'open';
    });

    if (!exists) {
      copyTrade.copiedPositions.push(
        buildCopiedPositionFromAdmin({
          adminPosition: adminPos,
          copyTrade,
          profile
        })
      );
    }
  });

  updateSingleCopyTradePerformance(db, copyTrade);
}

function copyAdminNewPositionToFollowers(db, adminUser, adminPosition) {
  const profiles = Object.values(db.copyProfiles || {}).filter(profile => {
    return normalizeEmail(profile.ownerEmail) === normalizeEmail(adminUser.email)
      && profile.status === 'active';
  });

  profiles.forEach(profile => {
    syncCopyProfileFromAdmin(db, profile);

    const followers = getActiveFollowersForProfile(db, profile.id);

    followers.forEach(({ copy }) => {
      if (!Array.isArray(copy.copiedPositions)) copy.copiedPositions = [];

      const exists = copy.copiedPositions.some(pos => {
        return String(pos.adminPositionId) === String(adminPosition.id) && pos.status === 'open';
      });

      if (!exists) {
        copy.copiedPositions.push(
          buildCopiedPositionFromAdmin({
            adminPosition,
            copyTrade: copy,
            profile
          })
        );
      }

      updateSingleCopyTradePerformance(db, copy);
    });
  });
}

function closeCopiedPositionsForAdminPosition(db, adminUser, closedAdminPosition, closePrice) {
  const profiles = Object.values(db.copyProfiles || {}).filter(profile => {
    return normalizeEmail(profile.ownerEmail) === normalizeEmail(adminUser.email);
  });

  profiles.forEach(profile => {
    const followers = getActiveFollowersForProfile(db, profile.id);

    followers.forEach(({ copy }) => {
      if (!Array.isArray(copy.copiedPositions)) copy.copiedPositions = [];

      copy.copiedPositions.forEach(pos => {
        if (String(pos.adminPositionId) !== String(closedAdminPosition.id) || pos.status !== 'open') return;

        const finalPrice = safeNumber(closePrice, pos.markPrice);
        const pnl = calculatePnl(pos, finalPrice);
        const roi = calculateRoiFromPnl(pnl, pos.margin);

        pos.markPrice = finalPrice;
        pos.closePrice = finalPrice;
        pos.pnl = Number(pnl.toFixed(6));
        pos.roi = Number(roi.toFixed(4));
        pos.status = 'closed';
        pos.closeReason = closedAdminPosition.closeReason || 'Admin Closed';
        pos.closedAt = Date.now();
        pos.closedAtIso = nowIso();
      });

      updateSingleCopyTradePerformance(db, copy);
    });
  });
}

function updateSingleCopyTradePerformance(db, copyTrade) {
  if (!copyTrade || copyTrade.status !== 'active') return;

  if (!Array.isArray(copyTrade.copiedPositions)) copyTrade.copiedPositions = [];

  let totalPnl = 0;
  let totalMargin = 0;

  copyTrade.copiedPositions.forEach(pos => {
    migrateCopiedPosition(pos);

    if (pos.status === 'open') {
      const token = findTokenById(db, pos.tokenId);
      const currentPrice = token ? token.price : safeNumber(pos.markPrice, pos.entryPrice);
      const pnl = calculatePnl(pos, currentPrice);
      const roi = calculateRoiFromPnl(pnl, pos.margin);

      pos.markPrice = currentPrice;
      pos.pnl = Number(pnl.toFixed(6));
      pos.roi = Number(roi.toFixed(4));
      pos.updatedAt = Date.now();
      pos.updatedAtIso = nowIso();
    }

    totalPnl += safeNumber(pos.pnl, 0);
    totalMargin += safeNumber(pos.margin, 0);
  });

  copyTrade.pnl = Number(totalPnl.toFixed(6));
  copyTrade.roi = Number(calculateRoiFromPnl(totalPnl, totalMargin || copyTrade.amountUsdt).toFixed(4));
  copyTrade.markValueUsdt = Number((safeNumber(copyTrade.amountUsdt, 0) + totalPnl).toFixed(6));
  copyTrade.updatedAt = Date.now();
  copyTrade.updatedAtIso = nowIso();
}

function updateAllCopyTradesPerformance(db) {
  Object.values(db.users || {}).forEach(user => {
    migrateUser(user);

    (user.copyTrades || []).forEach(copy => {
      updateSingleCopyTradePerformance(db, copy);
    });
  });
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

/* -------------------- Market Loop -------------------- */

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

          if (user.role === 'staff') {
            closeCopiedPositionsForAdminPosition(db, user, { ...pos, closeReason: 'Admin Liquidation' }, currentPrice);
          }
        } else {
          keptPositions.push(pos);
        }
      });

      user.positions = keptPositions;
      user.orderHistory = user.orderHistory.slice(0, 100);
      user.updatedAt = nowIso();
    });

    syncAllCopyProfilesFromAdmins(db);
    updateAllCopyTradesPerformance(db);

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
  <text x="1070" y="322" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">$${formatMoney(t.margin, 2)}</text>
  <text x="725" y="382" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="850" fill="${muted}">Position Size</text>
  <text x="1070" y="382" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">$${formatMoney(t.size, 2)}</text>
  <text x="725" y="442" font-family="Inter, Arial, sans-serif" font-size="21" font-weight="850" fill="${muted}">Mark Price</text>
  <text x="1070" y="442" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">$${formatPrice(t.markPrice)}</text>
  <rect x="92" y="488" width="1003" height="1" fill="${grid}"/>
  <text x="96" y="535" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" fill="${muted}">Entry</text>
  <text x="96" y="566" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">$${formatPrice(t.entryPrice)}</text>
  <text x="335" y="535" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" fill="${muted}">Close</text>
  <text x="335" y="566" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">$${formatPrice(t.closePrice)}</text>
  <text x="574" y="535" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" fill="${muted}">Reason</text>
  <text x="574" y="566" font-family="Inter, Arial, sans-serif" font-size="25" font-weight="900" fill="${white}">${escapeHtml(t.closeReason)}</text>
  <text x="1095" y="598" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="16" font-weight="800" fill="${muted}">Trade ID ${escapeHtml(String(t.id).slice(0, 18))}</text>
  <text x="600" y="648" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="850" fill="${muted}">${escapeHtml(watermark)} • ${escapeHtml(card.verificationText)}</text>
</svg>`;
}

function renderTradePublicPage(card) {
  const t = card.trade;
  const color = card.style.color;
  const pnlText = `${t.pnl >= 0 ? '+' : '-'}$${formatMoney(Math.abs(t.pnl), 2)}`;
  const roiText = `${t.roi >= 0 ? '+' : ''}${formatMoney(t.roi, 2)}%`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(t.symbol)} ${escapeHtml(t.side)} ${escapeHtml(roiText)} | bluecrypto.ink</title>
  <meta property="og:title" content="${escapeHtml(t.symbol)} Trade ${escapeHtml(roiText)} ROI"/>
  <meta property="og:description" content="Verified by Tensor Wallet on bluecrypto.ink"/>
  <meta property="og:image" content="${escapeHtml(card.links.image)}"/>
  <meta property="og:type" content="website"/>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#070a0f;color:#f8fafc;font-family:Inter,Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:18px}
    .wrap{width:min(980px,100%)}
    .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px}
    .brand{font-weight:950;font-size:1.25rem}
    .verified{color:#94a3b8;font-weight:850;font-size:.86rem}
    .card{border:1px solid #1f2937;background:#111827;border-radius:24px;overflow:hidden;box-shadow:0 20px 70px rgba(0,0,0,.45)}
    img{width:100%;display:block;background:#070a0f}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    a{color:white;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:12px;padding:12px 14px;font-weight:900}
    a.primary{background:${color};border-color:${color}}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
    .stat{background:#0b1220;border:1px solid #1f2937;border-radius:16px;padding:14px}
    .label{color:#94a3b8;font-size:.75rem;font-weight:850}
    .value{font-size:1.05rem;font-weight:950;margin-top:6px}
    @media(max-width:720px){.stats{grid-template-columns:1fr 1fr}.top{align-items:flex-start;flex-direction:column}}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div>
        <div class="brand">bluecrypto.ink</div>
        <div class="verified">Verified by Tensor Wallet</div>
      </div>
      <div style="font-weight:950;color:${color}">${escapeHtml(t.symbol)} ${escapeHtml(t.side)} ${escapeHtml(t.leverage)}x</div>
    </div>
    <div class="card">
      <img src="${escapeHtml(card.links.image)}" alt="Verified trade card"/>
    </div>
    <div class="actions">
      <a class="primary" href="${escapeHtml(card.links.download)}">Download Trade Image</a>
      <a href="${escapeHtml(card.links.image)}" target="_blank">Open Image</a>
      <a href="/trading">Open Trading</a>
    </div>
    <section class="stats">
      <div class="stat"><div class="label">ROI</div><div class="value" style="color:${color}">${escapeHtml(roiText)}</div></div>
      <div class="stat"><div class="label">PNL</div><div class="value" style="color:${color}">${escapeHtml(pnlText)}</div></div>
      <div class="stat"><div class="label">Mark Price</div><div class="value">$${formatPrice(t.markPrice)}</div></div>
      <div class="stat"><div class="label">Position Size</div><div class="value">$${formatMoney(t.size, 2)}</div></div>
    </section>
  </main>
</body>
</html>`;
}

/* -------------------- Copy Profile Pages -------------------- */

function publicCopyProfileForResponse(req, profile) {
  const baseUrl = getBaseUrl(req);

  return {
    id: profile.id,
    publicId: profile.publicId || profile.id,
    ownerEmailHash: sha(profile.ownerEmail || '').slice(0, 16),
    name: profile.name,
    tag: profile.tag,
    description: profile.description,
    roi: safeNumber(profile.roi, 0),
    pnl: safeNumber(profile.pnl, 0),
    openPnl: safeNumber(profile.openPnl, 0),
    closedPnl: safeNumber(profile.closedPnl, 0),
    totalMargin: safeNumber(profile.totalMargin, 0),
    followers: safeNumber(profile.followers, 0),
    risk: profile.risk,
    minCopyUsdt: safeNumber(profile.minCopyUsdt, 50),
    status: profile.status,
    positions: Array.isArray(profile.positions) ? profile.positions : [],
    history: Array.isArray(profile.history) ? profile.history.slice(0, 20) : [],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    source: profile.source || 'admin_live_trading',
    shareUrl: `${baseUrl}/copy/${profile.publicId || profile.id}`,
    joinUrl: `${baseUrl}/trading?copy=${encodeURIComponent(profile.publicId || profile.id)}`
  };
}

function renderCopyProfilePage(req, profile) {
  const p = publicCopyProfileForResponse(req, profile);
  const roiClass = p.roi >= 0 ? '#0ecb81' : '#f6465d';
  const pnlText = `${p.pnl >= 0 ? '+' : '-'}$${formatMoney(Math.abs(p.pnl))}`;
  const roiText = `${p.roi >= 0 ? '+' : ''}${formatMoney(p.roi)}%`;

  const positions = (p.positions || []).slice(0, 8).map(pos => {
    const pnl = safeNumber(pos.pnl, 0);
    const pnlColor = pnl >= 0 ? '#0ecb81' : '#f6465d';

    return `
      <div class="row">
        <span>${escapeHtml(pos.symbol || 'Asset')} ${escapeHtml(pos.side || '')} ${escapeHtml(pos.leverage || 1)}x</span>
        <b style="color:${pnlColor}">${pnl >= 0 ? '+' : '-'}$${formatMoney(Math.abs(pnl))}</b>
      </div>
    `;
  }).join('') || '<div class="muted">No public active positions listed.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(p.name)} | Copy Trading</title>
  <meta property="og:title" content="${escapeHtml(p.name)} Copy Trading">
  <meta property="og:description" content="${escapeHtml(roiText)} ROI • ${escapeHtml(pnlText)} PNL">
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#070a0f;color:#f8fafc;font-family:Inter,Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:18px}
    .wrap{width:min(760px,100%)}
    .card{background:#111827;border:1px solid #1f2937;border-radius:26px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.42)}
    .brand{font-weight:950;color:#94a3b8;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
    .title{font-size:2rem;font-weight:950;margin:10px 0 4px}
    .tag{color:#94a3b8;font-weight:800}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}
    .stat{background:#0b1220;border:1px solid #1f2937;border-radius:16px;padding:14px}
    .label{color:#94a3b8;font-size:.72rem;font-weight:850}
    .val{font-weight:950;font-size:1.08rem;margin-top:6px}
    .row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #1f2937;color:#e5e7eb}
    .muted{color:#94a3b8;font-weight:750}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    a{color:white;text-decoration:none;padding:12px 14px;border-radius:12px;background:#1f2937;border:1px solid #334155;font-weight:950}
    .primary{background:#8b5cf6;border-color:#8b5cf6}
    @media(max-width:680px){.stats{grid-template-columns:1fr 1fr}.title{font-size:1.45rem}}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="brand">bluecrypto.ink • Tensor Wallet</div>
      <h1 class="title">${escapeHtml(p.name)}</h1>
      <div class="tag">${escapeHtml(p.tag)} • ${escapeHtml(p.risk)} risk • ${escapeHtml(p.status)}</div>
      <div class="stats">
        <div class="stat"><div class="label">ROI</div><div class="val" style="color:${roiClass}">${escapeHtml(roiText)}</div></div>
        <div class="stat"><div class="label">PNL</div><div class="val" style="color:${roiClass}">${escapeHtml(pnlText)}</div></div>
        <div class="stat"><div class="label">Running</div><div class="val">${p.positions.length}</div></div>
        <div class="stat"><div class="label">Min Copy</div><div class="val">$${formatMoney(p.minCopyUsdt, 0)}</div></div>
      </div>
      <div class="muted">${escapeHtml(p.description || 'Public copy trading profile.')}</div>
      <div style="margin-top:18px">
        <b>Admin running positions</b>
        ${positions}
      </div>
      <div class="actions">
        <a class="primary" href="${escapeHtml(p.joinUrl)}">Open & Copy</a>
        <a href="/trading">Open Trading</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

/* -------------------- Page Routes -------------------- */

app.get('/', (req, res) => {
  res.render('index', {
    error: null,
    success: null,
    otpEmail: null
  });
});

app.get('/index.html', (req, res) => {
  res.render('index', {
    error: null,
    success: null,
    otpEmail: null
  });
});

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('wallet', {
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: safeJsonForEjs(user)
  });
});

app.get('/wallet.ejs', requireAuth, (req, res) => {
  res.redirect('/wallet');
});

app.get('/trading', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('trading', {
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: safeJsonForEjs(user),
    treasury: safeJsonForEjs(TREASURY_USDT_ADDRESSES)
  });
});

app.get('/trading.ejs', requireAuth, (req, res) => {
  res.redirect('/trading');
});

/* -------------------- Public Share Routes -------------------- */

app.get('/trade/:id', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.id];

  if (!card) {
    return res.status(404).send('Trade card not found.');
  }

  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderTradePublicPage(card));
});

app.get('/trade/:id/image.svg', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.id];

  if (!card) {
    return res.status(404).send('Trade image not found.');
  }

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(renderTradeCardSvg(card));
});

app.get('/trade/:id/download', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.id];

  if (!card) {
    return res.status(404).send('Trade image not found.');
  }

  const filename = `bluecrypto-${card.trade.symbol}-${card.trade.side}-${card.id}.svg`;

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(renderTradeCardSvg(card));
});

app.get('/copy/:id', (req, res) => {
  const db = readDb();
  syncAllCopyProfilesFromAdmins(db);
  updateAllCopyTradesPerformance(db);
  writeDb(db);

  const profile = Object.values(db.copyProfiles).find(p => {
    return String(p.publicId || p.id) === String(req.params.id);
  });

  if (!profile) {
    return res.status(404).send('Copy profile not found.');
  }

  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderCopyProfilePage(req, profile));
});

/* -------------------- Auth Routes -------------------- */

app.post('/send-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !email.includes('@')) {
      return res.render('index', {
        error: 'Enter a valid email.',
        success: null,
        otpEmail: null
      });
    }

    const otp = generateOtp();
    saveOtp(email, otp);

    const sent = await sendOtpEmail(email, otp);

    res.render('index', {
      error: null,
      success: sent
        ? 'OTP sent. Check your inbox.'
        : 'DEV mode: OTP was printed in your server logs.',
      otpEmail: email
    });
  } catch (err) {
    console.error('send-otp error:', err);

    res.render('index', {
      error: 'Could not send OTP. Check server email settings.',
      success: null,
      otpEmail: normalizeEmail(req.body.email)
    });
  }
});

app.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const result = verifyOtp(email, otp);

  if (!result.ok) {
    return res.render('index', {
      error: result.reason,
      success: null,
      otpEmail: email
    });
  }

  const user = getOrCreateUser(email, 'user');

  req.session.user = {
    email,
    username: email.split('@')[0],
    role: user.role,
    walletId: user.id
  };

  req.session.save(() => res.redirect('/trading'));
});

app.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return res.render('index', {
      error: 'Invalid staff login.',
      success: null,
      otpEmail: null
    });
  }

  const adminEmail = 'admin@tensorwallet.local';
  const user = getOrCreateUser(adminEmail, 'staff');

  req.session.user = {
    email: adminEmail,
    username: 'admin',
    role: 'staff',
    walletId: user.id
  };

  req.session.save(() => res.redirect('/trading'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tensorwallet.sid');
    res.redirect('/index.html');
  });
});

app.post('/logout', (req, res) => {
  res.redirect('/logout');
});

/* -------------------- Copy Trading APIs -------------------- */

app.get('/api/copy/profiles', requireAuthJson, (req, res) => {
  const db = readDb();

  syncAllCopyProfilesFromAdmins(db);
  updateAllCopyTradesPerformance(db);
  writeDb(db);

  const profiles = Object.values(db.copyProfiles)
    .map(profile => publicCopyProfileForResponse(req, profile))
    .sort((a, b) => safeNumber(b.updatedAt, 0) - safeNumber(a.updatedAt, 0));

  res.json({
    ok: true,
    profiles
  });
});

app.get('/api/copy/profile/:id', requireAuthJson, (req, res) => {
  const db = readDb();

  syncAllCopyProfilesFromAdmins(db);
  updateAllCopyTradesPerformance(db);
  writeDb(db);

  const profile = Object.values(db.copyProfiles).find(p => {
    return String(p.id) === String(req.params.id) || String(p.publicId) === String(req.params.id);
  });

  if (!profile) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  res.json({
    ok: true,
    profile: publicCopyProfileForResponse(req, profile)
  });
});

app.post('/api/copy/admin/profile', requireAdminJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  const name = String(req.body.name || '').trim().slice(0, 64);
  const tag = String(req.body.tag || 'Admin live trading profile').trim().slice(0, 80);
  const description = String(req.body.description || 'This profile follows the admin trader live. ROI, PNL, and running positions are calculated from admin trades.').trim().slice(0, 500);
  const risk = ['Low', 'Medium', 'High'].includes(req.body.risk) ? req.body.risk : 'Medium';
  const minCopyUsdt = Math.max(1, safeNumber(req.body.minCopyUsdt, 50));
  const status = req.body.status === 'paused' ? 'paused' : 'active';

  if (!name) {
    return res.status(400).json({ error: 'Profile name is required.' });
  }

  const id = makePublicId('copy');

  const profile = {
    id,
    publicId: id,
    ownerEmail: user.email,
    ownerWalletId: user.id,
    name,
    tag,
    description,
    followers: 0,
    risk,
    minCopyUsdt,
    status,
    source: 'admin_live_trading',
    positions: [],
    history: [],
    pnl: 0,
    roi: 0,
    openPnl: 0,
    closedPnl: 0,
    totalMargin: 0,
    createdAt: Date.now(),
    createdAtIso: nowIso(),
    updatedAt: Date.now(),
    updatedAtIso: nowIso()
  };

  db.copyProfiles[id] = profile;
  syncCopyProfileFromAdmin(db, profile);

  writeDb(db);

  res.json({
    ok: true,
    profile: publicCopyProfileForResponse(req, profile)
  });
});

app.put('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
  const db = readDb();

  const profile = db.copyProfiles[req.params.id] || Object.values(db.copyProfiles).find(p => {
    return String(p.publicId) === String(req.params.id);
  });

  if (!profile) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  if (normalizeEmail(profile.ownerEmail) !== normalizeEmail(req.session.user.email)) {
    return res.status(403).json({ error: 'You can only update your own copy profile.' });
  }

  if (req.body.name !== undefined) profile.name = String(req.body.name || profile.name).trim().slice(0, 64);
  if (req.body.tag !== undefined) profile.tag = String(req.body.tag || profile.tag).trim().slice(0, 80);
  if (req.body.description !== undefined) profile.description = String(req.body.description || '').trim().slice(0, 500);
  if (req.body.risk !== undefined) profile.risk = ['Low', 'Medium', 'High'].includes(req.body.risk) ? req.body.risk : profile.risk;
  if (req.body.minCopyUsdt !== undefined) profile.minCopyUsdt = Math.max(1, safeNumber(req.body.minCopyUsdt, profile.minCopyUsdt));
  if (req.body.status !== undefined) profile.status = req.body.status === 'paused' ? 'paused' : 'active';

  syncCopyProfileFromAdmin(db, profile);
  updateAllCopyTradesPerformance(db);

  writeDb(db);

  res.json({
    ok: true,
    profile: publicCopyProfileForResponse(req, profile)
  });
});

app.delete('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
  const db = readDb();

  const key = db.copyProfiles[req.params.id]
    ? req.params.id
    : Object.keys(db.copyProfiles).find(k => String(db.copyProfiles[k].publicId) === String(req.params.id));

  if (!key) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  const profile = db.copyProfiles[key];

  if (normalizeEmail(profile.ownerEmail) !== normalizeEmail(req.session.user.email)) {
    return res.status(403).json({ error: 'You can only delete your own copy profile.' });
  }

  delete db.copyProfiles[key];

  Object.values(db.users).forEach(user => {
    migrateUser(user);
    user.copyTrades.forEach(copy => {
      if (String(copy.profileId) === String(profile.id) && copy.status === 'active') {
        copy.status = 'profile_deleted';
        copy.closedAt = Date.now();
        copy.closedAtIso = nowIso();
      }
    });
  });

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/copy/join', requireAuthJson, (req, res) => {
  const profileId = String(req.body.profileId || '').trim();
  const amountUsdt = safeNumber(req.body.amountUsdt, 0);

  if (!profileId) {
    return res.status(400).json({ error: 'Missing copy profile ID.' });
  }

  if (amountUsdt <= 0) {
    return res.status(400).json({ error: 'Enter a valid USDT amount.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  const profile = db.copyProfiles[profileId] || Object.values(db.copyProfiles).find(p => {
    return String(p.publicId) === profileId;
  });

  if (!profile) {
    return res.status(404).json({ error: 'Copy profile not found.' });
  }

  syncCopyProfileFromAdmin(db, profile);

  if (profile.status !== 'active') {
    return res.status(400).json({ error: 'This copy profile is not active.' });
  }

  if (normalizeEmail(profile.ownerEmail) === normalizeEmail(user.email)) {
    return res.status(400).json({ error: 'You cannot copy your own profile.' });
  }

  if (amountUsdt < safeNumber(profile.minCopyUsdt, 50)) {
    return res.status(400).json({ error: `Minimum copy amount is ${profile.minCopyUsdt} USDT.` });
  }

  if (safeNumber(user.usdtBalance, 0) < amountUsdt) {
    return res.status(400).json({ error: 'Insufficient USDT balance.' });
  }

  const automaticNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  const copyDeposit = buildCopyDeposit({
    user,
    profile,
    amountUsdt,
    network: automaticNetwork
  });

  const copyTrade = {
    id: makeId('copytrade'),
    profileId: profile.id,
    profilePublicId: profile.publicId || profile.id,
    profileName: profile.name,
    ownerEmailHash: sha(profile.ownerEmail || '').slice(0, 16),
    amountUsdt,
    pnl: 0,
    roi: 0,
    markValueUsdt: amountUsdt,
    status: 'active',
    startedAt: Date.now(),
    startedAtIso: nowIso(),
    depositId: copyDeposit.id,
    treasuryTxHash: copyDeposit.txHash,
    treasuryNetwork: copyDeposit.destinationNetwork,
    treasuryAddress: copyDeposit.destinationAddress,
    followsNewAdminTrades: req.body.followNewTrades !== false,
    copiedPositions: []
  };

  copyAdminOpenPositionsToCopyTrade(db, profile, copyTrade);

  user.usdtNetwork = automaticNetwork;
  user.usdtBalance = safeNumber(user.usdtBalance, 0) - amountUsdt;
  user.copyTrades.unshift(copyTrade);
  user.copyDeposits.unshift(copyDeposit);
  user.copyDeposits = user.copyDeposits.slice(0, 200);
  user.updatedAt = nowIso();

  profile.followers = Math.max(0, safeNumber(profile.followers, 0)) + 1;
  profile.updatedAt = Date.now();
  profile.updatedAtIso = nowIso();

  db.treasury.copyDeposits.unshift(copyDeposit);
  db.treasury.copyDeposits = db.treasury.copyDeposits.slice(0, 1000);

  updateSingleCopyTradePerformance(db, copyTrade);
  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    copyTrade,
    copyDeposit,
    treasuryDestination: {
      network: copyDeposit.destinationNetwork,
      address: copyDeposit.destinationAddress,
      symbol: copyDeposit.destinationSymbol
    }
  });
});

app.post('/api/copy/stop', requireAuthJson, (req, res) => {
  const copyTradeId = String(req.body.copyTradeId || '').trim();

  if (!copyTradeId) {
    return res.status(400).json({ error: 'Missing copy trade ID.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  updateAllCopyTradesPerformance(db);

  const idx = user.copyTrades.findIndex(c => {
    return String(c.id) === copyTradeId && c.status === 'active';
  });

  if (idx === -1) {
    return res.status(404).json({ error: 'Active copy trade not found.' });
  }

  const copy = user.copyTrades[idx];
  const returnAmount = Math.max(0, safeNumber(copy.amountUsdt, 0) + safeNumber(copy.pnl, 0));

  user.usdtBalance = safeNumber(user.usdtBalance, 0) + returnAmount;

  const closed = {
    ...copy,
    status: 'closed',
    closedAt: Date.now(),
    closedAtIso: nowIso(),
    returnedUsdt: returnAmount
  };

  user.copyTrades.splice(idx, 1);

  user.orderHistory.unshift({
    id: closed.id,
    symbol: 'COPY',
    side: 'long',
    leverage: 1,
    margin: closed.amountUsdt,
    size: closed.amountUsdt,
    entryPrice: 1,
    closePrice: 1,
    markPrice: 1,
    pnl: closed.pnl,
    roi: closed.roi,
    closeReason: `Stopped Copy: ${closed.profileName}`,
    openedAt: closed.startedAt,
    openedAtIso: closed.startedAtIso,
    closedAt: closed.closedAt,
    closedAtIso: closed.closedAtIso
  });

  const profile = db.copyProfiles[copy.profileId];

  if (profile) {
    profile.followers = Math.max(0, safeNumber(profile.followers, 0) - 1);
    profile.updatedAt = Date.now();
    profile.updatedAtIso = nowIso();
  }

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    closedCopyTrade: closed
  });
});

/* -------------------- Trading APIs -------------------- */

app.get('/api/trading/state', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  syncAllCopyProfilesFromAdmins(db);
  updateAllCopyTradesPerformance(db);
  writeDb(db);

  res.json({
    usdtBalance: safeNumber(user.usdtBalance, 0),
    usdtNetwork: normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user)),
    positions: user.positions || [],
    orderHistory: user.orderHistory || [],
    publicTradeCards: user.publicTradeCards || [],
    tradeDeposits: user.tradeDeposits || [],
    copyTrades: user.copyTrades || [],
    copyDeposits: user.copyDeposits || [],
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/trading/execute', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const side = String(req.body.side || '').toLowerCase();
  const margin = safeNumber(req.body.margin, 0);
  const leverage = safeNumber(req.body.leverage, 1);
  const marginMode = String(req.body.marginMode || 'cross').toLowerCase() === 'isolated'
    ? 'isolated'
    : 'cross';

  if (!tokenId || !['long', 'short'].includes(side)) {
    return res.status(400).json({ error: 'Invalid trade side or asset.' });
  }

  if (margin <= 0 || leverage < 1 || leverage > 150) {
    return res.status(400).json({ error: 'Invalid margin or leverage.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  if (safeNumber(user.usdtBalance, 0) < margin) {
    return res.status(400).json({ error: 'Insufficient USDT balance.' });
  }

  const automaticNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  const treasuryDeposit = buildTreasuryDeposit({
    user,
    token,
    margin,
    leverage,
    side,
    marginMode,
    network: automaticNetwork
  });

  user.usdtNetwork = automaticNetwork;
  user.usdtBalance = safeNumber(user.usdtBalance, 0) - margin;

  const position = {
    id: makeId('pos'),
    tokenId: token.id,
    symbol: token.symbol,
    side,
    margin,
    leverage,
    marginMode,
    size: margin * leverage,
    entryPrice: token.price,
    markPrice: token.price,
    openedAt: Date.now(),
    openedAtIso: nowIso(),
    treasuryDepositId: treasuryDeposit.id,
    treasuryTxHash: treasuryDeposit.txHash,
    treasuryNetwork: treasuryDeposit.destinationNetwork,
    treasuryAddress: treasuryDeposit.destinationAddress
  };

  user.positions.unshift(position);
  user.tradeDeposits.unshift(treasuryDeposit);
  user.tradeDeposits = user.tradeDeposits.slice(0, 200);

  db.treasury.tradeDeposits.unshift(treasuryDeposit);
  db.treasury.tradeDeposits = db.treasury.tradeDeposits.slice(0, 1000);

  user.updatedAt = nowIso();

  if (user.role === 'staff') {
    copyAdminNewPositionToFollowers(db, user, position);
    syncAllCopyProfilesFromAdmins(db);
    updateAllCopyTradesPerformance(db);
  }

  writeDb(db);

  res.json({
    ok: true,
    position,
    usdtBalance: user.usdtBalance,
    usdtNetwork: automaticNetwork,
    treasuryDeposit,
    treasuryDestination: {
      network: treasuryDeposit.destinationNetwork,
      address: treasuryDeposit.destinationAddress,
      symbol: treasuryDeposit.destinationSymbol
    }
  });
});

app.post('/api/trading/close', requireAuthJson, (req, res) => {
  const positionId = String(req.body.positionId || '');

  if (!positionId) {
    return res.status(400).json({ error: 'Missing position ID.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const posIdx = user.positions.findIndex(p => String(p.id) === positionId);

  if (posIdx === -1) {
    return res.status(404).json({ error: 'Position not found.' });
  }

  const pos = user.positions[posIdx];
  const token = db.tensorRegistry.find(t => t.id === pos.tokenId);
  const currentPrice = token ? token.price : pos.entryPrice;
  const pnl = calculatePnl(pos, currentPrice);
  const roi = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;

  user.usdtBalance = safeNumber(user.usdtBalance, 0) + safeNumber(pos.margin, 0) + pnl;
  user.positions.splice(posIdx, 1);

  const historyRecord = {
    ...pos,
    closePrice: currentPrice,
    markPrice: currentPrice,
    pnl,
    roi,
    closedAt: Date.now(),
    closedAtIso: nowIso(),
    closeReason: 'Market Close'
  };

  user.orderHistory.unshift(historyRecord);
  user.orderHistory = user.orderHistory.slice(0, 100);
  user.updatedAt = nowIso();

  if (user.role === 'staff') {
    closeCopiedPositionsForAdminPosition(db, user, historyRecord, currentPrice);
    syncAllCopyProfilesFromAdmins(db);
    updateAllCopyTradesPerformance(db);
  }

  const publicCard = buildTradeCardPayload({
    req,
    db,
    user,
    trade: historyRecord
  });

  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    pnl,
    roi,
    historyRecord,
    publicTradeCard: publicCard,
    shareUrl: publicCard.links.page,
    imageUrl: publicCard.links.image,
    downloadUrl: publicCard.links.download
  });
});

app.post('/api/trading/share', requireAuthJson, (req, res) => {
  const historyId = String(req.body.historyId || req.body.tradeId || '');

  if (!historyId) {
    return res.status(400).json({ error: 'Missing history trade ID.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const trade = user.orderHistory.find(t => String(t.id) === historyId);

  if (!trade) {
    return res.status(404).json({ error: 'Trade history not found.' });
  }

  const publicCard = buildTradeCardPayload({
    req,
    db,
    user,
    trade
  });

  user.updatedAt = nowIso();
  writeDb(db);

  res.json({
    ok: true,
    publicTradeCard: publicCard,
    shareUrl: publicCard.links.page,
    imageUrl: publicCard.links.image,
    downloadUrl: publicCard.links.download
  });
});

/* -------------------- Wallet APIs -------------------- */

app.get('/api/wallet', requireAuthJson, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.json({
    ...user,
    usdtNetwork: normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user)),
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/wallet/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  if (!req.body.encryptedVault) {
    return res.status(400).json({ error: 'No vault data provided.' });
  }

  user.encryptedVault = req.body.encryptedVault;
  user.publicWallets = Array.isArray(req.body.publicWallets) ? req.body.publicWallets : [];
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/wallet/usdt-network', requireAuthJson, (req, res) => {
  const network = normalizeNetwork(req.body.network || req.body.usdtNetwork || '');
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  user.usdtNetwork = network;
  user.updatedAt = nowIso();

  writeDb(db);

  const destination = getTreasuryDestination(network);

  res.json({
    ok: true,
    usdtNetwork: network,
    treasuryDestination: destination
  });
});

app.post('/api/wallet/send', requireAuthJson, (req, res) => {
  const network = String(req.body.network || '').trim();
  const asset = String(req.body.asset || '').trim();
  const amount = safeNumber(req.body.amount, 0);
  const toAddress = String(req.body.toAddress || '').trim();

  if (!network || !asset || amount <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;

  res.json({
    ok: true,
    txHash,
    status: 'demo-sent'
  });
});

/* -------------------- Tensor APIs -------------------- */

app.get('/api/tensor', requireAuthJson, async (req, res) => {
  try {
    await syncRealCryptoPrices();

    const db = readDb();
    const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

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
      } else {
        initializeCandlesForToken(token.id, token.price);
        token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);
      }
    });

    syncAllCopyProfilesFromAdmins(db);
    updateAllCopyTradesPerformance(db);

    writeDb(db);

    res.json({
      registry: db.tensorRegistry,
      address: user.tensorAddress,
      balances: user.tensorBalances || {},
      syncedAt: Date.now(),
      treasury: req.session.user.role === 'staff' ? db.treasury : undefined,
      treasuryDestinations: TREASURY_USDT_ADDRESSES
    });
  } catch (err) {
    console.error('/api/tensor error:', err);

    res.status(500).json({
      error: 'Could not load tensor registry.'
    });
  }
});

app.get('/api/tensor/chart', requireAuthJson, (req, res) => {
  const tokenId = String(req.query.tokenId || '');

  if (!tokenId) {
    return res.json({ candles: [] });
  }

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.json({ candles: [] });
  }

  initializeCandlesForToken(token.id, token.price);

  res.json({
    baseTimeframe: '5m',
    supportedTimeframes: ['5m', '15m', '30m', '1h'],
    candles: (tensorCandleHistory[token.id] || []).slice(-900),
    stats: {
      high24h: token.high24h,
      low24h: token.low24h,
      lifetimeHigh: token.lifetimeHigh,
      markPrice: token.price,
      changePercent24h: token.changePercent24h
    }
  });
});

app.get('/api/live-prices', requireAuthJson, async (req, res) => {
  try {
    await syncRealCryptoPrices(true);

    res.json({
      ok: true,
      prices: latestRealPrices,
      syncedAt: lastRealPriceSync
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: 'Could not load live prices.'
    });
  }
});

app.post('/api/tensor/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  if (!req.body.tensorVault) {
    return res.status(400).json({ error: 'No Tensor vault data provided.' });
  }

  user.tensorVault = req.body.tensorVault;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/tensor/deploy', requireAdminJson, (req, res) => {
  const name = String(req.body.name || '').trim();
  const symbol = String(req.body.symbol || '').trim().toUpperCase();
  const price = safeNumber(req.body.price, 0);
  const bias = String(req.body.bias || 'balanced').trim();
  const bullChance = safeNumber(req.body.bullChance, 50);
  const minPct = safeNumber(req.body.minPct, 0.1) / 100;
  const maxPct = safeNumber(req.body.maxPct, 0.5) / 100;
  const icon = String(req.body.icon || symbol.slice(0, 1) || 'T').trim();
  const supply = safeNumber(req.body.supply, 10000000);

  if (!name || !symbol || price <= 0 || supply <= 0) {
    return res.status(400).json({ error: 'Missing or invalid token parameters.' });
  }

  const db = readDb();

  const id = `T0x${crypto.randomBytes(20).toString('hex')}`;

  const token = {
    id,
    name,
    symbol,
    price,
    startPrice: price,
    bias,
    bullChance: clamp(bullChance, 0, 100),
    minPct: Math.max(0, minPct),
    maxPct: Math.max(minPct, maxPct),
    icon,
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

  initializeCandlesForToken(id, price);

  res.json({
    ok: true,
    id,
    token
  });
});

app.put('/api/tensor/update/:id', requireAdminJson, (req, res) => {
  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === req.params.id);

  if (!token) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  if (req.body.name !== undefined) token.name = String(req.body.name || token.name);
  if (req.body.symbol !== undefined) token.symbol = String(req.body.symbol || token.symbol).toUpperCase();
  if (req.body.icon !== undefined) token.icon = String(req.body.icon || token.icon);
  if (req.body.bias !== undefined) token.bias = String(req.body.bias || token.bias);

  if (req.body.price !== undefined) {
    token.price = Math.max(0.000001, safeNumber(req.body.price, token.price));
  }

  if (req.body.startPrice !== undefined) {
    token.startPrice = Math.max(0.000001, safeNumber(req.body.startPrice, token.startPrice));
  }

  if (req.body.bullChance !== undefined) {
    token.bullChance = clamp(req.body.bullChance, 0, 100);
  }

  if (req.body.minPct !== undefined) {
    token.minPct = Math.max(0, safeNumber(req.body.minPct, token.minPct * 100) / 100);
  }

  if (req.body.maxPct !== undefined) {
    token.maxPct = Math.max(token.minPct, safeNumber(req.body.maxPct, token.maxPct * 100) / 100);
  }

  if (req.body.supply !== undefined) {
    token.supply = Math.max(1, safeNumber(req.body.supply, token.supply));
  }

  token.marketCap = token.price * token.supply;
  token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);

  writeDb(db);
  initializeCandlesForToken(token.id, token.price);

  res.json({
    ok: true,
    token
  });
});

app.delete('/api/tensor/delete/:id', requireAdminJson, (req, res) => {
  const db = readDb();
  const index = db.tensorRegistry.findIndex(t => t.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  db.tensorRegistry.splice(index, 1);
  delete tensorCandleHistory[req.params.id];

  Object.values(db.users).forEach(user => {
    if (user.tensorBalances) delete user.tensorBalances[req.params.id];

    if (Array.isArray(user.positions)) {
      user.positions = user.positions.filter(p => p.tokenId !== req.params.id);
    }

    if (Array.isArray(user.copyTrades)) {
      user.copyTrades.forEach(copy => {
        if (Array.isArray(copy.copiedPositions)) {
          copy.copiedPositions = copy.copiedPositions.filter(p => p.tokenId !== req.params.id);
        }
      });
    }
  });

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/tensor/admin-mint', requireAdminJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const amount = safeNumber(req.body.amount, 0);

  if (!tokenId || amount <= 0) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  const user = db.users[req.session.user.email];

  user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + amount;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    newBalance: user.tensorBalances[tokenId]
  });
});

app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const spend = safeNumber(req.body.usdtAmount, 0);

  if (!tokenId || spend <= 0) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Token missing.' });
  }

  if (safeNumber(user.usdtBalance, 0) < spend) {
    return res.status(400).json({ error: 'Insufficient USDT balance.' });
  }

  const feeRate = 0.000001;
  const feeAmount = spend * feeRate;
  const netSpend = spend - feeAmount;

  db.treasury.collectedFeesUsdt = safeNumber(db.treasury.collectedFeesUsdt, 0) + feeAmount;

  let priceImpact = 0;

  if (token.bias !== 'pegged' && token.bias !== 'real') {
    const marketCap = Math.max(100, safeNumber(token.marketCap, token.price * token.supply));
    const impactMultiplier = netSpend / marketCap;
    priceImpact = Math.min(0.5, impactMultiplier * 0.8);
  }

  const originalPrice = token.price;
  const executionPrice = originalPrice * (1 + priceImpact / 2);
  const received = netSpend / executionPrice;

  user.usdtBalance -= spend;
  user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + received;

  if (token.bias !== 'pegged' && token.bias !== 'real') {
    token.price = Math.max(0.000001, originalPrice * (1 + priceImpact));
    token.marketCap = token.price * token.supply;
    token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);
  }

  token.volume = safeNumber(token.volume, 0) + spend;

  pushLiveCandle(token, originalPrice);

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    received,
    impactPercent: Number((priceImpact * 100).toFixed(4)),
    feePaid: feeAmount,
    usdtBalance: user.usdtBalance
  });
});

app.post('/api/tensor/send', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const amount = safeNumber(req.body.amount, 0);
  const toAddress = String(req.body.toAddress || '').trim();

  if (!tokenId || amount <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  const db = readDb();
  const sender = db.users[req.session.user.email];

  if (safeNumber(sender.tensorBalances[tokenId], 0) < amount) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }

  const recipientEmail = Object.keys(db.users).find(email => {
    return db.users[email].tensorAddress === toAddress;
  });

  if (!recipientEmail) {
    return res.status(404).json({ error: 'Recipient not found.' });
  }

  const recipient = db.users[recipientEmail];

  sender.tensorBalances[tokenId] -= amount;
  recipient.tensorBalances[tokenId] = safeNumber(recipient.tensorBalances[tokenId], 0) + amount;

  sender.updatedAt = nowIso();
  recipient.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

/* -------------------- Standard Market APIs -------------------- */

app.get('/api/prices', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!ids.length) {
      return res.json({});
    }

    const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;

    const data = await cachedJson(`cg-prices:${ids.join(',')}`, 5000, () => {
      return fetchJsonWithTimeout(url, {}, 8000);
    });

    res.json(data);
  } catch (err) {
    console.error('/api/prices error:', err.message);
    res.json({});
  }
});

/* -------------------- Health / Fallback -------------------- */

app.get('/health', (req, res) => {
  const dbExists = fs.existsSync(DB_PATH);
  let copyProfileCount = 0;
  let userCount = 0;

  try {
    const db = readDb();
    copyProfileCount = Object.keys(db.copyProfiles || {}).length;
    userCount = Object.keys(db.users || {}).length;
  } catch {}

  res.json({
    ok: true,
    uptime: process.uptime(),
    startupPage: '/index.html',
    pages: {
      index: '/ or /index.html',
      wallet: '/wallet',
      trading: '/trading',
      publicTrade: '/trade/:id',
      publicTradeImage: '/trade/:id/image.svg',
      publicCopyProfile: '/copy/:id'
    },
    api: {
      copyProfiles: '/api/copy/profiles',
      copyJoin: '/api/copy/join',
      copyStop: '/api/copy/stop',
      adminCopyProfile: '/api/copy/admin/profile'
    },
    candleBase: '5m',
    supportedChartTimeframes: ['5m', '15m', '30m', '1h'],
    treasuryDestinations: TREASURY_USDT_ADDRESSES,
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    dbExists,
    userCount,
    copyProfileCount,
    lastRealPriceSync,
    realPriceCount: Object.keys(latestRealPrices).length,
    note: 'This server records demo ledger movements only. It does not broadcast real blockchain transactions.'
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  return res.redirect('/index.html');
});

/* -------------------- Startup -------------------- */

ensureDb();
hydrateAllCandles();

syncRealCryptoPrices(true)
  .then(() => runMarketLoop())
  .catch(() => runMarketLoop());

setInterval(() => {
  runMarketLoop();
}, MARKET_LOOP_MS);

app.listen(PORT, () => {
  console.log(`Tensor Wallet running on port ${PORT}`);
  console.log(`Startup page: /index.html -> views/index.ejs`);
  console.log(`Wallet page: /wallet -> views/wallet.ejs`);
  console.log(`Trading page: /trading -> views/trading.ejs`);
  console.log(`Chart base candles: 5m`);
  console.log(`Supported chart timeframes: 5m, 15m, 30m, 1h`);
  console.log(`Public trade page: /trade/:id`);
  console.log(`Public trade image: /trade/:id/image.svg`);
  console.log(`Public copy profile: /copy/:id`);
  console.log(`Copy trading is simulated in the local ledger. No real on-chain broadcasts are performed.`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database path: ${DB_PATH}`);
});