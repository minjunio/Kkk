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
const CHART_CANDLE_LIMIT = 900;

const ADMIN_EMAIL = 'admin@tensorwallet.local';

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
    short: 'ERC20',
    symbol: 'ETH',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  arbitrum: {
    network: 'Arbitrum',
    short: 'ARB',
    symbol: 'ARB',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  sol: {
    network: 'Solana',
    short: 'SOL',
    symbol: 'SOL',
    address: '9prrQtQxzdt5Kt7nPHUxwWAVQLZATrj2bjU27k5Xkt5i'
  },
  trx: {
    network: 'TRON',
    short: 'TRC20',
    symbol: 'TRX',
    address: 'TPwY7YfXuufmgfCLF7ie9E2nyo6KhT4fn2'
  }
};

const SUPPORTED_WALLET_ASSETS = [
  'USDT',
  'OUSD',
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE'
];

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
  if (envBase) return envBase.replace(/\/+$/, '');
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

function normalizeAsset(asset) {
  return String(asset || 'USDT').trim().toUpperCase();
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

function isStaffUser(user) {
  if (!user) return false;
  return user.role === 'staff' || normalizeEmail(user.email) === ADMIN_EMAIL;
}

function isStaffSession(req) {
  return req.session.user && (
    req.session.user.role === 'staff' ||
    normalizeEmail(req.session.user.email) === ADMIN_EMAIL
  );
}

function getAssetBalanceField(asset) {
  const symbol = normalizeAsset(asset);
  if (symbol === 'USDT') return 'usdtBalance';
  if (symbol === 'OUSD') return 'ousdBalance';
  return `${symbol.toLowerCase()}Balance`;
}

function getSpendableBalance(user, asset = 'USDT') {
  const field = getAssetBalanceField(asset);
  return safeNumber(user[field], 0);
}

function setSpendableBalance(user, asset, value) {
  const field = getAssetBalanceField(asset);
  user[field] = safeNumber(value, 0);
}

function debitSpendableBalance(user, asset, amount) {
  const symbol = normalizeAsset(asset);
  const current = getSpendableBalance(user, symbol);
  const amt = safeNumber(amount, 0);

  if (amt <= 0) return { ok: false, error: 'Invalid amount.' };
  if (current < amt) return { ok: false, error: `Insufficient ${symbol} balance.` };

  setSpendableBalance(user, symbol, current - amt);

  return { ok: true, balance: getSpendableBalance(user, symbol) };
}

function creditSpendableBalance(user, asset, amount) {
  const symbol = normalizeAsset(asset);
  const current = getSpendableBalance(user, symbol);
  setSpendableBalance(user, symbol, current + safeNumber(amount, 0));
  return getSpendableBalance(user, symbol);
}

function getWalletReceiveAddress(user, asset = 'USDT', network = 'eth') {
  const symbol = normalizeAsset(asset);
  const net = normalizeNetwork(network);

  if (symbol === 'USDT' || symbol === 'OUSD') {
    return getTreasuryDestination(net).address;
  }

  const candidates = [];
  if (Array.isArray(user.publicWallets)) candidates.push(...user.publicWallets);
  if (Array.isArray(user.assets)) candidates.push(...user.assets);
  if (Array.isArray(user.wallets)) candidates.push(...user.wallets);
  if (Array.isArray(user.balances)) candidates.push(...user.balances);

  const found = candidates.find(item => {
    const text = JSON.stringify(item || {}).toLowerCase();
    return text.includes(symbol.toLowerCase()) && text.includes(net);
  });

  if (found) {
    return found.address || found.publicAddress || found.walletAddress || found.depositAddress || '';
  }

  if (net === 'sol') return TREASURY_USDT_ADDRESSES.sol.address;
  if (net === 'trx') return TREASURY_USDT_ADDRESSES.trx.address;

  return user.tensorAddress || TREASURY_USDT_ADDRESSES.eth.address;
}

function buildReceiveAddresses(user) {
  const result = {};

  SUPPORTED_WALLET_ASSETS.forEach(asset => {
    result[asset] = {};
    Object.keys(TREASURY_USDT_ADDRESSES).forEach(network => {
      result[asset][network] = getWalletReceiveAddress(user, asset, network);
    });
  });

  return result;
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

function defaultCopyPortfolio() {
  return {
    id: 'admin_copy_portfolio',
    publicId: 'admin_copy_portfolio',
    ownerEmail: ADMIN_EMAIL,
    ownerWalletId: 'system',
    name: 'Tensor Alpha Copy',
    tag: 'Admin copy portfolio',
    description: 'Live admin copy portfolio.',
    risk: 'Medium',
    minCopyUsdt: 50,
    status: 'active',
    daysTrading: 1,
    manualRoi: 0,
    manualPnl: 0,
    followers: 0,
    deleted: false,
    createdAt: Date.now(),
    createdAtIso: nowIso(),
    updatedAt: Date.now(),
    updatedAtIso: nowIso()
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
      copyDeposits: [],
      walletSends: []
    },
    publicTradeCards: {},
    copyPortfolio: defaultCopyPortfolio()
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
      copyDeposits: [],
      walletSends: []
    };
  }

  if (!Array.isArray(db.treasury.tradeDeposits)) db.treasury.tradeDeposits = [];
  if (!Array.isArray(db.treasury.copyDeposits)) db.treasury.copyDeposits = [];
  if (!Array.isArray(db.treasury.walletSends)) db.treasury.walletSends = [];
  if (db.treasury.collectedFeesUsdt === undefined) db.treasury.collectedFeesUsdt = 0;

  if (!db.publicTradeCards) db.publicTradeCards = {};

  if (!db.copyPortfolio || typeof db.copyPortfolio !== 'object') {
    db.copyPortfolio = defaultCopyPortfolio();

    if (db.copyProfiles && typeof db.copyProfiles === 'object') {
      const firstLegacy = Object.values(db.copyProfiles)[0];
      if (firstLegacy) {
        db.copyPortfolio = {
          ...db.copyPortfolio,
          ...firstLegacy,
          id: 'admin_copy_portfolio',
          publicId: 'admin_copy_portfolio'
        };
      }
    }
  }

  migrateCopyPortfolio(db.copyPortfolio);

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
  if (!Array.isArray(user.walletTxHistory)) user.walletTxHistory = [];

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

  if (user.ousdBalance === undefined) {
    user.ousdBalance = user.role === 'staff' ? 500000 : 5000;
  }

  user.usdtBalance = safeNumber(user.usdtBalance, user.role === 'staff' ? 1000000 : 15000);
  user.ousdBalance = safeNumber(user.ousdBalance, user.role === 'staff' ? 500000 : 5000);

  SUPPORTED_WALLET_ASSETS.forEach(asset => {
    if (asset === 'USDT' || asset === 'OUSD') return;
    const field = getAssetBalanceField(asset);
    if (user[field] === undefined) user[field] = 0;
    user[field] = safeNumber(user[field], 0);
  });

  user.usdtNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  user.positions.forEach(pos => migratePosition(pos));
  user.copyTrades.forEach(copy => migrateCopyTrade(copy));
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
  pos.settlementAsset = normalizeAsset(pos.settlementAsset || 'USDT');

  if (pos.includeInCopyPortfolio === undefined) {
    pos.includeInCopyPortfolio = true;
  }
}

function migrateCopyTrade(copy) {
  if (!copy.id) copy.id = makeId('copytrade');

  copy.amountUsdt = safeNumber(copy.amountUsdt, 0);
  copy.pnl = safeNumber(copy.pnl, 0);
  copy.roi = safeNumber(copy.roi, 0);
  copy.markValueUsdt = safeNumber(copy.markValueUsdt, copy.amountUsdt + copy.pnl);
  copy.status = copy.status || 'active';
  copy.startedAt = safeNumber(copy.startedAt, Date.now());
  copy.fundingAsset = normalizeAsset(copy.fundingAsset