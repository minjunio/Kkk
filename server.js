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

const DEMO_SEED_WORDS = [
  'alpha', 'orbit', 'matrix', 'tensor', 'vault', 'river', 'signal', 'quantum',
  'neural', 'forest', 'silver', 'phoenix', 'rocket', 'cipher', 'galaxy',
  'anchor', 'velvet', 'dragon', 'ember', 'crystal', 'shadow', 'summit',
  'pixel', 'vector', 'ocean', 'kernel', 'nova', 'bridge', 'solar', 'radar',
  'marble', 'logic', 'future', 'atlas', 'cobalt', 'prism', 'lunar', 'storm',
  'cloud', 'binary', 'tempo', 'satoshi', 'origin', 'fusion', 'delta', 'prime'
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

function normalizeAsset(asset) {
  return String(asset || '').trim().toUpperCase();
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
  const amt = safeNumber(amount, 0);
  const current = getSpendableBalance(user, symbol);

  if (amt <= 0) {
    return { ok: false, error: 'Invalid amount.' };
  }

  if (current < amt) {
    return { ok: false, error: `Insufficient ${symbol} balance.` };
  }

  setSpendableBalance(user, symbol, current - amt);

  return {
    ok: true,
    balance: getSpendableBalance(user, symbol)
  };
}

function creditSpendableBalance(user, asset, amount) {
  const symbol = normalizeAsset(asset);
  const current = getSpendableBalance(user, symbol);

  setSpendableBalance(user, symbol, current + safeNumber(amount, 0));

  return getSpendableBalance(user, symbol);
}

function seededWordIndex(seed, index) {
  const hash = sha(`${seed}:${index}`);
  const n = parseInt(hash.slice(0, 8), 16);
  return n % DEMO_SEED_WORDS.length;
}

function makeDemoSeed(seedInput) {
  const words = [];

  for (let i = 0; i < 12; i++) {
    words.push(DEMO_SEED_WORDS[seededWordIndex(seedInput, i)]);
  }

  return words.join(' ');
}

function ensureUserSeeds(user) {
  if (!user) return;

  const base = `${user.email || ''}:${user.id || ''}:${user.tensorAddress || ''}`;

  if (!user.normalSeed) {
    user.normalSeed = makeDemoSeed(`${base}:normal`);
  }

  if (!user.tensorSeed) {
    user.tensorSeed = makeDemoSeed(`${base}:tensor`);
  }
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

function getWalletReceiveAddress(user, asset = 'USDT', network = 'eth') {
  const symbol = normalizeAsset(asset);
  const net = normalizeNetwork(network);

  if (symbol === 'USDT' || symbol === 'OUSD') {
    return getTreasuryDestination(net).address;
  }

  if (symbol.startsWith('TENSOR:')) {
    return user.tensorAddress || getTreasuryDestination(net).address;
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

  result.TENSOR = {
    eth: user.tensorAddress,
    arbitrum: user.tensorAddress,
    sol: user.tensorAddress,
    trx: user.tensorAddress
  };

  return result;
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

function sanitizeTokenPayload(body, existing = {}) {
  const symbol = String(body.symbol || existing.symbol || '').trim().toUpperCase();

  const minPctRaw = body.minPct !== undefined
    ? safeNumber(body.minPct, 0.2)
    : safeNumber(existing.minPct, 0.002) * 100;

  const maxPctRaw = body.maxPct !== undefined
    ? safeNumber(body.maxPct, 1.2)
    : safeNumber(existing.maxPct, 0.012) * 100;

  const price = Math.max(0.000001, safeNumber(body.price, existing.price || 1));

  return {
    name: String(body.name || existing.name || symbol || 'Tensor Asset').trim(),
    symbol,
    price,
    startPrice: Math.max(0.000001, safeNumber(body.startPrice ?? body.price, existing.startPrice || existing.price || price)),
    bias: String(body.bias || existing.bias || 'balanced').trim(),
    bullChance: Math.max(0, Math.min(100, safeNumber(body.bullChance, existing.bullChance || 50))),
    minPct: Math.max(0, minPctRaw / 100),
    maxPct: Math.max(Math.max(0, minPctRaw / 100), maxPctRaw / 100),
    icon: String(body.icon || existing.icon || symbol.slice(0, 1) || 'T').trim(),
    supply: Math.max(1, safeNumber(body.supply, existing.supply || 10000000))
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

  ensureUserSeeds(user);

  user.positions.forEach(migratePosition);
  user.copyTrades.forEach(migrateCopyTrade);
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
  copy.fundingAsset = normalizeAsset(copy.fundingAsset || 'USDT');

  if (!copy.startedAtIso) copy.startedAtIso = nowIso();
  if (!Array.isArray(copy.mirroredPositions)) copy.mirroredPositions = [];
  if (!Array.isArray(copy.closedMirrors)) copy.closedMirrors = [];
  if (copy.followsNewAdminTrades === undefined) copy.followsNewAdminTrades = true;
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

function migrateCopyPortfolio(profile) {
  const defaults = defaultCopyPortfolio();

  profile.id = 'admin_copy_portfolio';
  profile.publicId = 'admin_copy_portfolio';
  profile.ownerEmail = normalizeEmail(profile.ownerEmail || ADMIN_EMAIL);
  profile.ownerWalletId = profile.ownerWalletId || 'system';
  profile.name = String(profile.name || defaults.name).slice(0, 80);
  profile.tag = String(profile.tag || defaults.tag).slice(0, 120);
  profile.description = String(profile.description || defaults.description).slice(0, 800);
  profile.risk = ['Low', 'Medium', 'High'].includes(profile.risk) ? profile.risk : 'Medium';
  profile.minCopyUsdt = Math.max(1, safeNumber(profile.minCopyUsdt, 50));
  profile.status = profile.status === 'paused' ? 'paused' : 'active';
  profile.daysTrading = Math.max(0, Math.floor(safeNumber(profile.daysTrading, 1)));
  profile.manualRoi = safeNumber(profile.manualRoi ?? profile.roi, 0);
  profile.manualPnl = safeNumber(profile.manualPnl ?? profile.pnl, 0);
  profile.followers = Math.max(0, Math.floor(safeNumber(profile.followers, 0)));
  profile.deleted = Boolean(profile.deleted);
  profile.createdAt = safeNumber(profile.createdAt, Date.now());
  profile.updatedAt = safeNumber(profile.updatedAt, Date.now());

  if (!profile.createdAtIso) profile.createdAtIso = nowIso();
  if (!profile.updatedAtIso) profile.updatedAtIso = nowIso();
}

/* -------------------- Users/Auth Helpers -------------------- */

function createWalletRecord(email, role = 'user') {
  const hash = sha(email);

  const record = {
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
    walletTxHistory: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null,
    tensorBalances: {},
    usdtBalance: role === 'staff' ? 1000000 : 15000,
    ousdBalance: role === 'staff' ? 500000 : 5000,
    btcBalance: 0,
    ethBalance: 0,
    solBalance: 0,
    bnbBalance: 0,
    xrpBalance: 0,
    dogeBalance: 0,
    usdtNetwork: 'eth',
    positions: [],
    orderHistory: [],
    tradeDeposits: [],
    publicTradeCards: [],
    copyTrades: [],
    copyDeposits: []
  };

  ensureUserSeeds(record);

  return record;
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

function getAdminUser(db) {
  const admin = db.users[ADMIN_EMAIL];

  if (admin) {
    migrateUser(admin);
    admin.role = 'staff';
    return admin;
  }

  db.users[ADMIN_EMAIL] = createWalletRecord(ADMIN_EMAIL, 'staff');
  return db.users[ADMIN_EMAIL];
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
  if (!isStaffSession(req)) {
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

function sanitizeCandles(candles) {
  return candles
    .filter(c => c && Number.isFinite(Number(c.time)))
    .map(c => ({
      time: Number(c.time),
      open: Math.max(0.000001, safeNumber(c.open, c.close || 1)),
      high: Math.max(0.000001, safeNumber(c.high, c.close || c.open || 1)),
      low: Math.max(0.000001, safeNumber(c.low, c.close || c.open || 1)),
      close: Math.max(0.000001, safeNumber(c.close, c.open || 1))
    }))
    .sort((a, b) => a.time - b.time)
    .map((c, i, arr) => {
      if (i > 0) c.open = arr[i - 1].close;
      c.high = Math.max(c.open, c.close, c.high);
      c.low = Math.min(c.open, c.close, c.low);
      return c;
    });
}

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId] && tensorCandleHistory[tokenId].length) {
    return;
  }

  const candles = [];
  let price = Math.max(0.000001, safeNumber(startPrice, 1));
  let timeCursor = Math.floor((Date.now() - 14 * 24 * 60 * 60 * 1000) / BASE_CANDLE_MS) * BASE_CANDLE_MS;

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

  tensorCandleHistory[tokenId] = sanitizeCandles(candles);
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
  const currentPrice = Math.max(0.000001, safeNumber(token.price, oldPrice || 1));

  if (last && last.time === fiveMinuteBucket) {
    last.close = currentPrice;
    last.high = Math.max(last.high, currentPrice, last.open);
    last.low = Math.min(last.low, currentPrice, last.open);
  } else {
    const open = last ? last.close : Math.max(0.000001, safeNumber(oldPrice, currentPrice));

    history.push({
      time: fiveMinuteBucket,
      open,
      high: Math.max(open, currentPrice),
      low: Math.min(open, currentPrice),
      close: currentPrice
    });

    while (history.length > MAX_CANDLES) {
      history.shift();
    }
  }

  tensorCandleHistory[token.id] = sanitizeCandles(history);
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

/* -------------------- Treasury / Copy Helpers -------------------- */

function buildTreasuryDeposit({ user, token, margin, leverage, side, marginMode, network, settlementAsset = 'USDT' }) {
  const selectedNetwork = normalizeNetwork(network || user.usdtNetwork || inferUserUsdtNetwork(user));
  const destination = getTreasuryDestination(selectedNetwork);
  const id = makeId('deposit');
  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
  const asset = normalizeAsset(settlementAsset);

  return {
    id,
    txHash,
    type: `${asset}_TRADE_MARGIN_DEPOSIT`,
    status: 'recorded',
    note: 'Demo ledger transfer recorded by Tensor Wallet. No on-chain broadcast is performed without wallet signing infrastructure.',
    userEmail: user.email,
    userWalletId: user.id,
    amountUsdt: margin,
    amount: margin,
    asset,
    tokenId: token.id,
    symbol: token.symbol,
    side,
    leverage,
    marginMode,
    sourceUsdtNetwork: selectedNetwork,
    sourceNetwork: selectedNetwork,
    destinationNetworkKey: destination.key,
    destinationNetwork: destination.network,
    destinationSymbol: destination.symbol,
    destinationAddress: destination.address,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };
}

function buildCopyDeposit({ user, amountUsdt, network, fundingAsset = 'USDT' }) {
  const selectedNetwork = normalizeNetwork(network || user.usdtNetwork || inferUserUsdtNetwork(user));
  const destination = getTreasuryDestination(selectedNetwork);
  const asset = normalizeAsset(fundingAsset);

  return {
    id: makeId('copydep'),
    txHash: `0x${crypto.randomBytes(32).toString('hex')}`,
    type: `${asset}_COPY_TRADING_DEPOSIT`,
    status: 'recorded',
    note: 'Demo copy-trading allocation recorded in the Tensor Wallet ledger. No on-chain broadcast is performed without wallet signing infrastructure.',
    userEmail: user.email,
    userWalletId: user.id,
    profileId: 'admin_copy_portfolio',
    profileName: 'Admin Copy Portfolio',
    amountUsdt,
    amount: amountUsdt,
    asset,
    sourceUsdtNetwork: selectedNetwork,
    sourceNetwork: selectedNetwork,
    destinationNetworkKey: destination.key,
    destinationNetwork: destination.network,
    destinationSymbol: destination.symbol,
    destinationAddress: destination.address,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };
}

function getIncludedAdminPositions(db) {
  const admin = getAdminUser(db);

  return admin.positions
    .filter(p => p.includeInCopyPortfolio !== false)
    .map(pos => {
      const token = db.tensorRegistry.find(t => t.id === pos.tokenId);
      const markPrice = token ? token.price : pos.markPrice || pos.entryPrice;
      const pnl = calculatePnl(pos, markPrice);
      const roi = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;

      return {
        ...pos,
        markPrice,
        pnl,
        roi,
        adminPositionId: pos.id
      };
    });
}

function getIncludedAdminHistory(db) {
  const admin = getAdminUser(db);
  return admin.orderHistory.filter(t => t.includeInCopyPortfolio !== false);
}

function calculateAdminCopyPortfolioStats(db) {
  const positions = getIncludedAdminPositions(db);
  const history = getIncludedAdminHistory(db);

  let openPnl = 0;
  let openMargin = 0;
  let closedPnl = 0;
  let closedMargin = 0;

  positions.forEach(pos => {
    openPnl += safeNumber(pos.pnl, 0);
    openMargin += safeNumber(pos.margin, 0);
  });

  history.forEach(trade => {
    closedPnl += safeNumber(trade.pnl, 0);
    closedMargin += safeNumber(trade.margin, 0);
  });

  const totalPnl = openPnl + closedPnl;
  const totalMargin = openMargin + closedMargin;
  const roi = totalMargin > 0 ? (totalPnl / totalMargin) * 100 : 0;

  return {
    roi,
    pnl: totalPnl,
    openPnl,
    closedPnl,
    openMargin,
    closedMargin,
    totalMargin,
    positions
  };
}

function publicCopyPortfolioForResponse(req, db) {
  migrateCopyPortfolio(db.copyPortfolio);

  if (db.copyPortfolio.deleted || db.copyPortfolio.status === 'deleted') {
    return null;
  }

  const baseUrl = getBaseUrl(req);
  const stats = calculateAdminCopyPortfolioStats(db);
  const manualRoi = safeNumber(db.copyPortfolio.manualRoi, 0);
  const manualPnl = safeNumber(db.copyPortfolio.manualPnl, 0);

  return {
    id: 'admin_copy_portfolio',
    publicId: 'admin_copy_portfolio',
    name: db.copyPortfolio.name,
    tag: db.copyPortfolio.tag,
    description: db.copyPortfolio.description,
    risk: db.copyPortfolio.risk,
    status: db.copyPortfolio.status,
    minCopyUsdt: safeNumber(db.copyPortfolio.minCopyUsdt, 50),
    daysTrading: safeNumber(db.copyPortfolio.daysTrading, 1),
    manualRoi,
    manualPnl,
    roi: manualRoi + stats.roi,
    pnl: manualPnl + stats.pnl,
    openPnl: stats.openPnl,
    closedPnl: stats.closedPnl,
    totalMargin: stats.totalMargin,
    followers: safeNumber(db.copyPortfolio.followers, 0),
    positions: stats.positions,
    source: 'admin_live_trading',
    createdAt: db.copyPortfolio.createdAt,
    updatedAt: db.copyPortfolio.updatedAt,
    shareUrl: `${baseUrl}/copy/admin_copy_portfolio`,
    joinUrl: `${baseUrl}/trading?copy=admin_copy_portfolio`
  };
}

function getAdminPortfolioBasis(db) {
  const positions = getIncludedAdminPositions(db);
  const totalMargin = positions.reduce((sum, pos) => sum + safeNumber(pos.margin, 0), 0);

  return Math.max(totalMargin, 1);
}

function createMirrorFromAdminPosition({ adminPosition, copierCopyTrade, db }) {
  const basis = getAdminPortfolioBasis(db);
  const adminMargin = safeNumber(adminPosition.margin, 0);
  const allocation = safeNumber(copierCopyTrade.amountUsdt, 0);

  const proportionalMargin = allocation * (adminMargin / basis);
  const mirrorMargin = Math.max(0.01, Math.min(allocation, proportionalMargin || allocation * 0.1));
  const leverage = clamp(adminPosition.leverage, 1, 150);
  const markPrice = safeNumber(adminPosition.markPrice, adminPosition.entryPrice);

  return {
    id: makeId('mirror'),
    adminPositionId: adminPosition.id,
    tokenId: adminPosition.tokenId,
    symbol: adminPosition.symbol,
    side: adminPosition.side === 'short' ? 'short' : 'long',
    margin: mirrorMargin,
    leverage,
    marginMode: adminPosition.marginMode || 'cross',
    size: mirrorMargin * leverage,
    entryPrice: markPrice,
    markPrice,
    pnl: 0,
    roi: 0,
    openedAt: Date.now(),
    openedAtIso: nowIso()
  };
}

function syncCopyTradePerformance(db, user) {
  if (!Array.isArray(user.copyTrades)) return;

  user.copyTrades.forEach(copy => {
    migrateCopyTrade(copy);

    if (copy.status !== 'active') return;

    let openPnl = 0;
    let marginUsed = 0;
    const keptMirrors = [];

    copy.mirroredPositions.forEach(mirror => {
      const token = db.tensorRegistry.find(t => t.id === mirror.tokenId);

      if (!token) {
        keptMirrors.push(mirror);
        return;
      }

      mirror.markPrice = token.price;
      mirror.pnl = calculatePnl(mirror, token.price);
      mirror.roi = mirror.margin > 0 ? (mirror.pnl / mirror.margin) * 100 : 0;

      openPnl += safeNumber(mirror.pnl, 0);
      marginUsed += safeNumber(mirror.margin, 0);

      keptMirrors.push(mirror);
    });

    copy.mirroredPositions = keptMirrors;

    const closedPnl = (copy.closedMirrors || []).reduce((sum, m) => sum + safeNumber(m.pnl, 0), 0);
    const closedMargin = (copy.closedMirrors || []).reduce((sum, m) => sum + safeNumber(m.margin, 0), 0);

    const totalPnl = openPnl + closedPnl;
    const totalMargin = marginUsed + closedMargin;
    const roi = totalMargin > 0 ? (totalPnl / totalMargin) * 100 : 0;

    copy.pnl = Number(totalPnl.toFixed(6));
    copy.roi = Number(roi.toFixed(4));
    copy.markValueUsdt = Number((safeNumber(copy.amountUsdt, 0) + totalPnl).toFixed(6));
    copy.updatedAt = Date.now();
    copy.updatedAtIso = nowIso();
  });
}

function mirrorNewAdminTradeToCopiers(db, adminPosition) {
  if (!adminPosition || adminPosition.includeInCopyPortfolio === false) return;

  Object.values(db.users).forEach(user => {
    if (normalizeEmail(user.email) === ADMIN_EMAIL) return;

    migrateUser(user);

    user.copyTrades.forEach(copy => {
      migrateCopyTrade(copy);

      if (copy.status !== 'active') return;
      if (copy.followsNewAdminTrades === false) return;
      if (copy.profileId !== 'admin_copy_portfolio') return;

      const alreadyMirrored = copy.mirroredPositions.some(m => {
        return String(m.adminPositionId) === String(adminPosition.id);
      });

      if (alreadyMirrored) return;

      const mirror = createMirrorFromAdminPosition({
        adminPosition,
        copierCopyTrade: copy,
        db
      });

      copy.mirroredPositions.unshift(mirror);
      copy.updatedAt = Date.now();
      copy.updatedAtIso = nowIso();
    });

    syncCopyTradePerformance(db, user);
  });
}

function closeMirroredAdminTradeForCopiers(db, adminPositionId, closePrice) {
  Object.values(db.users).forEach(user => {
    if (normalizeEmail(user.email) === ADMIN_EMAIL) return;

    migrateUser(user);

    user.copyTrades.forEach(copy => {
      migrateCopyTrade(copy);

      if (copy.status !== 'active') return;

      const idx = copy.mirroredPositions.findIndex(m => {
        return String(m.adminPositionId) === String(adminPositionId);
      });

      if (idx === -1) return;

      const mirror = copy.mirroredPositions[idx];
      const finalPrice = safeNumber(closePrice, mirror.markPrice || mirror.entryPrice);
      const pnl = calculatePnl(mirror, finalPrice);
      const roi = mirror.margin > 0 ? (pnl / mirror.margin) * 100 : 0;

      const closed = {
        ...mirror,
        closePrice: finalPrice,
        markPrice: finalPrice,
        pnl,
        roi,
        closedAt: Date.now(),
        closedAtIso: nowIso(),
        closeReason: 'Admin Position Closed'
      };

      copy.mirroredPositions.splice(idx, 1);
      copy.closedMirrors.unshift(closed);
      copy.closedMirrors = copy.closedMirrors.slice(0, 100);
    });

    syncCopyTradePerformance(db, user);
  });
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

      syncCopyTradePerformance(db, user);

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
        const settlementAsset = normalizeAsset(pos.settlementAsset || 'USDT');
        const availableBalance = getSpendableBalance(user, settlementAsset);
        const liqPrice = getLiquidationPrice(pos, availableBalance);

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

          if (normalizeEmail(user.email) === ADMIN_EMAIL && pos.includeInCopyPortfolio !== false) {
            closeMirroredAdminTradeForCopiers(db, pos.id, currentPrice);
          }
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
  <text x="600" y="648" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="18" font-weight="850" fill="${muted}">bluecrypto.ink • ${escapeHtml(card.verificationText)}</text>
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

function renderCopyProfilePage(req, profile) {
  if (!profile) return 'Copy profile not found.';

  const roiClass = profile.roi >= 0 ? '#0ecb81' : '#f6465d';
  const pnlText = `${profile.pnl >= 0 ? '+' : '-'}$${formatMoney(Math.abs(profile.pnl))}`;
  const roiText = `${profile.roi >= 0 ? '+' : ''}${formatMoney(profile.roi)}%`;

  const positions = (profile.positions || []).slice(0, 8).map(pos => {
    return `<div class="row"><span>${escapeHtml(pos.symbol || 'Asset')} ${escapeHtml(pos.side || '')}</span><b>${escapeHtml(pos.leverage || 1)}x</b></div>`;
  }).join('') || '<div class="muted">No public active positions listed.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(profile.name)} | Copy Trading</title>
  <meta property="og:title" content="${escapeHtml(profile.name)} Copy Trading">
  <meta property="og:description" content="${escapeHtml(roiText)} ROI • ${escapeHtml(pnlText)} PNL">
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#070a0f;color:#f8fafc;font-family:Inter,Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:18px}
    .wrap{width:min(760px,100%)}
    .card{background:#111827;border:1px solid #1f2937;border-radius:26px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.42)}
    .brand{font-weight:950;color:#94a3b8;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em}
    .title{font-size:2rem;font-weight:950;margin:10px 0 4px}
    .tag{color:#94a3b8;font-weight:800}
    .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:18px 0}
    .stat{background:#0b1220;border:1px solid #1f2937;border-radius:16px;padding:14px}
    .label{color:#94a3b8;font-size:.72rem;font-weight:850}
    .val{font-weight:950;font-size:1.08rem;margin-top:6px}
    .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1f2937;color:#e5e7eb}
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
      <h1 class="title">${escapeHtml(profile.name)}</h1>
      <div class="tag">${escapeHtml(profile.tag)} • ${escapeHtml(profile.risk)} risk • ${escapeHtml(profile.status)}</div>
      <div class="stats">
        <div class="stat"><div class="label">ROI</div><div class="val" style="color:${roiClass}">${escapeHtml(roiText)}</div></div>
        <div class="stat"><div class="label">PNL</div><div class="val" style="color:${roiClass}">${escapeHtml(pnlText)}</div></div>
        <div class="stat"><div class="label">Days</div><div class="val">${formatMoney(profile.daysTrading, 0)}</div></div>
        <div class="stat"><div class="label">Followers</div><div class="val">${formatMoney(profile.followers, 0)}</div></div>
        <div class="stat"><div class="label">Min Copy</div><div class="val">$${formatMoney(profile.minCopyUsdt, 0)}</div></div>
      </div>
      <div class="muted">${escapeHtml(profile.description || 'Public copy trading profile.')}</div>
      <div style="margin-top:18px"><b>Public positions</b>${positions}</div>
      <div class="actions">
        <a class="primary" href="${escapeHtml(profile.joinUrl)}">Open & Copy</a>
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

  if (String(req.params.id) !== 'admin_copy_portfolio') {
    return res.status(404).send('Copy profile not found.');
  }

  const profile = publicCopyPortfolioForResponse(req, db);

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

  const user = getOrCreateUser(ADMIN_EMAIL, 'staff');

  req.session.user = {
    email: ADMIN_EMAIL,
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

/* -------------------- Copy Portfolio APIs -------------------- */

app.get('/api/copy/profiles', requireAuthJson, (req, res) => {
  const db = readDb();
  const profile = publicCopyPortfolioForResponse(req, db);

  res.json({
    ok: true,
    profiles: profile ? [profile] : [],
    portfolio: profile
  });
});

app.get('/api/copy/profile/:id', requireAuthJson, (req, res) => {
  if (String(req.params.id) !== 'admin_copy_portfolio') {
    return res.status(404).json({ error: 'Copy portfolio not found.' });
  }

  const db = readDb();
  const profile = publicCopyPortfolioForResponse(req, db);

  if (!profile) {
    return res.status(404).json({ error: 'Copy portfolio not found.' });
  }

  res.json({
    ok: true,
    profile
  });
});

app.post('/api/copy/admin/profile', requireAdminJson, (req, res) => {
  const db = readDb();
  const profile = db.copyPortfolio;

  migrateCopyPortfolio(profile);

  profile.name = String(req.body.name || profile.name || 'Tensor Alpha Copy').trim().slice(0, 80);
  profile.tag = String(req.body.tag || 'Admin copy portfolio').trim().slice(0, 120);
  profile.description = String(req.body.description || profile.description || '').trim().slice(0, 800);
  profile.risk = ['Low', 'Medium', 'High'].includes(req.body.risk) ? req.body.risk : profile.risk;
  profile.minCopyUsdt = Math.max(1, safeNumber(req.body.minCopyUsdt, profile.minCopyUsdt));
  profile.status = req.body.status === 'paused' ? 'paused' : 'active';
  profile.daysTrading = Math.max(0, Math.floor(safeNumber(req.body.daysTrading, profile.daysTrading)));
  profile.manualRoi = safeNumber(req.body.manualRoi ?? req.body.roi, profile.manualRoi);
  profile.manualPnl = safeNumber(req.body.manualPnl ?? req.body.pnl, profile.manualPnl);
  profile.deleted = false;
  profile.updatedAt = Date.now();
  profile.updatedAtIso = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    profile: publicCopyPortfolioForResponse(req, db)
  });
});

app.put('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
  if (String(req.params.id) !== 'admin_copy_portfolio') {
    return res.status(404).json({ error: 'Copy portfolio not found.' });
  }

  const db = readDb();
  const profile = db.copyPortfolio;

  migrateCopyPortfolio(profile);

  if (req.body.name !== undefined) profile.name = String(req.body.name || profile.name).trim().slice(0, 80);
  if (req.body.tag !== undefined) profile.tag = String(req.body.tag || profile.tag).trim().slice(0, 120);
  if (req.body.description !== undefined) profile.description = String(req.body.description || '').trim().slice(0, 800);
  if (req.body.risk !== undefined) profile.risk = ['Low', 'Medium', 'High'].includes(req.body.risk) ? req.body.risk : profile.risk;
  if (req.body.minCopyUsdt !== undefined) profile.minCopyUsdt = Math.max(1, safeNumber(req.body.minCopyUsdt, profile.minCopyUsdt));
  if (req.body.status !== undefined) profile.status = req.body.status === 'paused' ? 'paused' : 'active';
  if (req.body.daysTrading !== undefined) profile.daysTrading = Math.max(0, Math.floor(safeNumber(req.body.daysTrading, profile.daysTrading)));
  if (req.body.manualRoi !== undefined || req.body.roi !== undefined) profile.manualRoi = safeNumber(req.body.manualRoi ?? req.body.roi, profile.manualRoi);
  if (req.body.manualPnl !== undefined || req.body.pnl !== undefined) profile.manualPnl = safeNumber(req.body.manualPnl ?? req.body.pnl, profile.manualPnl);

  profile.deleted = false;
  profile.updatedAt = Date.now();
  profile.updatedAtIso = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    profile: publicCopyPortfolioForResponse(req, db)
  });
});

app.delete('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
  if (String(req.params.id) !== 'admin_copy_portfolio') {
    return res.status(404).json({ error: 'Copy portfolio not found.' });
  }

  const db = readDb();

  db.copyPortfolio.deleted = true;
  db.copyPortfolio.status = 'paused';
  db.copyPortfolio.updatedAt = Date.now();
  db.copyPortfolio.updatedAtIso = nowIso();

  Object.values(db.users).forEach(user => {
    migrateUser(user);

    user.copyTrades.forEach(copy => {
      if (copy.profileId === 'admin_copy_portfolio' && copy.status === 'active') {
        syncCopyTradePerformance(db, user);

        const returnAmount = Math.max(0, safeNumber(copy.amountUsdt, 0) + safeNumber(copy.pnl, 0));
        const fundingAsset = normalizeAsset(copy.fundingAsset || 'USDT');

        creditSpendableBalance(user, fundingAsset, returnAmount);

        copy.status = 'closed';
        copy.closedAt = Date.now();
        copy.closedAtIso = nowIso();
        copy.returnedUsdt = returnAmount;
        copy.closeReason = 'Copy portfolio deleted by admin';
      }
    });

    user.copyTrades = user.copyTrades.filter(copy => copy.status === 'active');
    user.updatedAt = nowIso();
  });

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/copy/join', requireAuthJson, (req, res) => {
  const profileId = String(req.body.profileId || '').trim();
  const amountUsdt = safeNumber(req.body.amountUsdt, 0);
  const fundingAsset = normalizeAsset(req.body.fundingAsset || 'USDT');

  if (profileId !== 'admin_copy_portfolio') {
    return res.status(400).json({ error: 'Invalid copy portfolio.' });
  }

  if (!['USDT', 'OUSD'].includes(fundingAsset)) {
    return res.status(400).json({ error: 'Copy trading supports USDT or OUSD only.' });
  }

  if (amountUsdt <= 0) {
    return res.status(400).json({ error: 'Enter a valid amount.' });
  }

  const db = readDb();
  const profile = publicCopyPortfolioForResponse(req, db);

  if (!profile) {
    return res.status(404).json({ error: 'Copy portfolio not found.' });
  }

  if (profile.status !== 'active') {
    return res.status(400).json({ error: 'This copy portfolio is not active.' });
  }

  if (amountUsdt < safeNumber(profile.minCopyUsdt, 50)) {
    return res.status(400).json({ error: `Minimum copy amount is ${profile.minCopyUsdt} ${fundingAsset}.` });
  }

  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);
  migrateUser(user);

  if (normalizeEmail(user.email) === ADMIN_EMAIL) {
    return res.status(400).json({ error: 'Admin cannot copy their own portfolio.' });
  }

  const debit = debitSpendableBalance(user, fundingAsset, amountUsdt);

  if (!debit.ok) {
    return res.status(400).json({ error: debit.error });
  }

  const automaticNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  const copyDeposit = buildCopyDeposit({
    user,
    amountUsdt,
    network: automaticNetwork,
    fundingAsset
  });

  const copyTrade = {
    id: makeId('copytrade'),
    profileId: 'admin_copy_portfolio',
    profilePublicId: 'admin_copy_portfolio',
    profileName: profile.name,
    amountUsdt,
    fundingAsset,
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
    mirroredPositions: [],
    closedMirrors: []
  };

  const copyOpenPositions = req.body.copyOpenPositions !== false;

  if (copyOpenPositions) {
    const adminPositions = getIncludedAdminPositions(db);

    adminPositions.forEach(adminPosition => {
      copyTrade.mirroredPositions.push(createMirrorFromAdminPosition({
        adminPosition,
        copierCopyTrade: copyTrade,
        db
      }));
    });
  }

  user.usdtNetwork = automaticNetwork;
  user.copyTrades.unshift(copyTrade);
  user.copyDeposits.unshift(copyDeposit);
  user.copyDeposits = user.copyDeposits.slice(0, 200);
  user.updatedAt = nowIso();

  syncCopyTradePerformance(db, user);

  db.copyPortfolio.followers = Math.max(0, safeNumber(db.copyPortfolio.followers, 0)) + 1;
  db.copyPortfolio.updatedAt = Date.now();
  db.copyPortfolio.updatedAtIso = nowIso();

  db.treasury.copyDeposits.unshift(copyDeposit);
  db.treasury.copyDeposits = db.treasury.copyDeposits.slice(0, 1000);

  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    fundingAsset,
    fundingAssetBalance: getSpendableBalance(user, fundingAsset),
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

  migrateUser(user);
  syncCopyTradePerformance(db, user);

  const idx = user.copyTrades.findIndex(c => String(c.id) === copyTradeId && c.status === 'active');

  if (idx === -1) {
    return res.status(404).json({ error: 'Active copy trade not found.' });
  }

  const copy = user.copyTrades[idx];
  const fundingAsset = normalizeAsset(copy.fundingAsset || 'USDT');
  const returnAmount = Math.max(0, safeNumber(copy.amountUsdt, 0) + safeNumber(copy.pnl, 0));

  creditSpendableBalance(user, fundingAsset, returnAmount);

  const closed = {
    ...copy,
    status: 'closed',
    closedAt: Date.now(),
    closedAtIso: nowIso(),
    returnedUsdt: returnAmount,
    returnedAsset: fundingAsset
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

  if (db.copyPortfolio) {
    db.copyPortfolio.followers = Math.max(0, safeNumber(db.copyPortfolio.followers, 0) - 1);
    db.copyPortfolio.updatedAt = Date.now();
    db.copyPortfolio.updatedAtIso = nowIso();
  }

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    returnedAsset: fundingAsset,
    fundingAssetBalance: getSpendableBalance(user, fundingAsset),
    closedCopyTrade: closed
  });
});

/* -------------------- Trading APIs -------------------- */

app.get('/api/trading/state', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  migrateUser(user);
  syncCopyTradePerformance(db, user);

  writeDb(db);

  res.json({
    usdtBalance: safeNumber(user.usdtBalance, 0),
    ousdBalance: safeNumber(user.ousdBalance, 0),
    usdtNetwork: normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user)),
    positions: user.positions || [],
    orderHistory: user.orderHistory || [],
    publicTradeCards: user.publicTradeCards || [],
    tradeDeposits: user.tradeDeposits || [],
    copyTrades: user.copyTrades || [],
    copyDeposits: user.copyDeposits || [],
    walletTxHistory: user.walletTxHistory || [],
    receiveAddresses: buildReceiveAddresses(user),
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/trading/execute', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const side = String(req.body.side || '').toLowerCase();
  const margin = safeNumber(req.body.margin, 0);
  const leverage = safeNumber(req.body.leverage, 1);
  const settlementAsset = normalizeAsset(req.body.settlementAsset || req.body.asset || 'USDT');

  const marginMode = String(req.body.marginMode || 'cross').toLowerCase() === 'isolated'
    ? 'isolated'
    : 'cross';

  if (!tokenId || !['long', 'short'].includes(side)) {
    return res.status(400).json({ error: 'Invalid trade side or asset.' });
  }

  if (!['USDT', 'OUSD'].includes(settlementAsset)) {
    return res.status(400).json({ error: 'Trading margin supports USDT or OUSD only.' });
  }

  if (margin <= 0 || leverage < 1 || leverage > 150) {
    return res.status(400).json({ error: 'Invalid margin or leverage.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  migrateUser(user);

  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  const debit = debitSpendableBalance(user, settlementAsset, margin);

  if (!debit.ok) {
    return res.status(400).json({ error: debit.error });
  }

  const automaticNetwork = normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user));

  const treasuryDeposit = buildTreasuryDeposit({
    user,
    token,
    margin,
    leverage,
    side,
    marginMode,
    network: automaticNetwork,
    settlementAsset
  });

  user.usdtNetwork = automaticNetwork;

  const includeInCopyPortfolio = isStaffUser(user)
    ? req.body.includeInCopyPortfolio !== false
    : false;

  const position = {
    id: makeId('pos'),
    tokenId: token.id,
    symbol: token.symbol,
    side,
    margin,
    leverage,
    marginMode,
    settlementAsset,
    size: margin * leverage,
    entryPrice: token.price,
    markPrice: token.price,
    openedAt: Date.now(),
    openedAtIso: nowIso(),
    includeInCopyPortfolio,
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

  if (normalizeEmail(user.email) === ADMIN_EMAIL && includeInCopyPortfolio) {
    mirrorNewAdminTradeToCopiers(db, position);
  }

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    position,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    settlementAsset,
    settlementAssetBalance: getSpendableBalance(user, settlementAsset),
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

  migrateUser(user);

  const posIdx = user.positions.findIndex(p => String(p.id) === positionId);

  if (posIdx === -1) {
    return res.status(404).json({ error: 'Position not found.' });
  }

  const pos = user.positions[posIdx];
  const token = db.tensorRegistry.find(t => t.id === pos.tokenId);
  const currentPrice = token ? token.price : pos.entryPrice;
  const pnl = calculatePnl(pos, currentPrice);
  const roi = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
  const settlementAsset = normalizeAsset(pos.settlementAsset || 'USDT');

  creditSpendableBalance(user, settlementAsset, safeNumber(pos.margin, 0) + pnl);

  user.positions.splice(posIdx, 1);

  const historyRecord = {
    ...pos,
    settlementAsset,
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

  if (normalizeEmail(user.email) === ADMIN_EMAIL && pos.includeInCopyPortfolio !== false) {
    closeMirroredAdminTradeForCopiers(db, pos.id, currentPrice);
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
    ousdBalance: user.ousdBalance,
    settlementAsset,
    settlementAssetBalance: getSpendableBalance(user, settlementAsset),
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
  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  migrateUser(user);
  syncCopyTradePerformance(db, user);

  user.updatedAt = nowIso();
  writeDb(db);

  res.json({
    ...user,
    usdtBalance: safeNumber(user.usdtBalance, 0),
    ousdBalance: safeNumber(user.ousdBalance, 0),
    usdtNetwork: normalizeNetwork(user.usdtNetwork || inferUserUsdtNetwork(user)),
    receiveAddresses: buildReceiveAddresses(user),
    supportedAssets: SUPPORTED_WALLET_ASSETS,
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.get('/api/wallet/addresses', requireAuthJson, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  const asset = normalizeAsset(req.query.asset || 'USDT');
  const network = normalizeNetwork(req.query.network || user.usdtNetwork || 'eth');

  migrateUser(user);

  res.json({
    ok: true,
    asset,
    network,
    address: getWalletReceiveAddress(user, asset, network),
    receiveAddresses: buildReceiveAddresses(user),
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
  user.publicWallets = Array.isArray(req.body.publicWallets) ? req.body.publicWallets : user.publicWallets || [];
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

  migrateUser(user);

  user.usdtNetwork = network;
  user.updatedAt = nowIso();

  writeDb(db);

  const destination = getTreasuryDestination(network);

  res.json({
    ok: true,
    usdtNetwork: network,
    treasuryDestination: destination,
    receiveAddresses: buildReceiveAddresses(user)
  });
});

app.post('/api/wallet/send', requireAuthJson, (req, res) => {
  const network = normalizeNetwork(req.body.network || '');
  const asset = normalizeAsset(req.body.asset || '');
  const amount = safeNumber(req.body.amount, 0);
  const toAddress = String(req.body.toAddress || '').trim();

  if (!network || !asset || amount <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  migrateUser(user);

  if (SUPPORTED_WALLET_ASSETS.includes(asset)) {
    const debit = debitSpendableBalance(user, asset, amount);

    if (!debit.ok) {
      return res.status(400).json({ error: debit.error });
    }
  } else {
    return res.status(400).json({
      error: 'Unsupported normal wallet asset. Use Tensor send for Tensor tokens.'
    });
  }

  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;

  const record = {
    id: makeId('send'),
    type: 'WALLET_SEND',
    status: 'demo-sent',
    asset,
    amount,
    network,
    toAddress,
    fromWalletId: user.id,
    userEmail: user.email,
    txHash,
    note: 'Demo send record. No on-chain broadcast is performed without wallet signing infrastructure.',
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };

  user.walletTxHistory.unshift(record);
  user.walletTxHistory = user.walletTxHistory.slice(0, 200);
  user.updatedAt = nowIso();

  if (!db.treasury.walletSends) db.treasury.walletSends = [];
  db.treasury.walletSends.unshift(record);
  db.treasury.walletSends = db.treasury.walletSends.slice(0, 1000);

  writeDb(db);

  res.json({
    ok: true,
    txHash,
    status: 'demo-sent',
    record,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    assetBalance: getSpendableBalance(user, asset)
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

  const candles = sanitizeCandles(tensorCandleHistory[token.id] || []).slice(-CHART_CANDLE_LIMIT);

  res.json({
    baseTimeframe: '5m',
    supportedTimeframes: ['5m', '15m', '30m', '1h'],
    candles,
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
  const payload = sanitizeTokenPayload(req.body);

  if (!payload.name || !payload.symbol || payload.price <= 0 || payload.supply <= 0) {
    return res.status(400).json({ error: 'Missing or invalid token parameters.' });
  }

  const db = readDb();
  const id = `T0x${crypto.randomBytes(20).toString('hex')}`;

  const token = {
    id,
    name: payload.name,
    symbol: payload.symbol,
    price: payload.price,
    startPrice: payload.startPrice,
    bias: payload.bias,
    bullChance: payload.bullChance,
    minPct: payload.minPct,
    maxPct: payload.maxPct,
    icon: payload.icon,
    supply: payload.supply,
    marketCap: payload.price * payload.supply,
    volume: 0,
    dominance: 0,
    changePercent24h: 0,
    high24h: payload.price,
    low24h: payload.price,
    lifetimeHigh: payload.price,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };

  db.tensorRegistry.push(token);
  writeDb(db);

  initializeCandlesForToken(id, payload.price);

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

  const payload = sanitizeTokenPayload(req.body, token);

  token.name = payload.name;
  token.symbol = payload.symbol;
  token.price = payload.price;
  token.startPrice = payload.startPrice;
  token.bias = payload.bias;
  token.bullChance = payload.bullChance;
  token.minPct = payload.minPct;
  token.maxPct = payload.maxPct;
  token.icon = payload.icon;
  token.supply = payload.supply;
  token.marketCap = token.price * token.supply;
  token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);
  token.updatedAt = Date.now();
  token.updatedAtIso = nowIso();

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
        copy.mirroredPositions = (copy.mirroredPositions || []).filter(p => p.tokenId !== req.params.id);
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

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  migrateUser(user);

  user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + amount;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    token,
    minted: amount,
    newBalance: user.tensorBalances[tokenId]
  });
});

app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const spend = safeNumber(req.body.usdtAmount, 0);
  const spendAsset = normalizeAsset(req.body.asset || req.body.spendAsset || 'USDT');

  if (!['USDT', 'OUSD'].includes(spendAsset)) {
    return res.status(400).json({ error: 'Swap supports USDT or OUSD only.' });
  }

  if (!tokenId || spend <= 0) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  migrateUser(user);

  if (!token) {
    return res.status(404).json({ error: 'Token missing.' });
  }

  const debit = debitSpendableBalance(user, spendAsset, spend);

  if (!debit.ok) {
    return res.status(400).json({ error: debit.error });
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
    spendAsset,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    spendAssetBalance: getSpendableBalance(user, spendAsset)
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

  if (!sender) {
    return res.status(401).json({ error: 'User not found.' });
  }

  migrateUser(sender);

  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  if (safeNumber(sender.tensorBalances[tokenId], 0) < amount) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }

  const recipientEmail = Object.keys(db.users).find(email => {
    return db.users[email].tensorAddress === toAddress;
  });

  if (!recipientEmail) {
    return res.status(404).json({
      error: 'Recipient Tensor address not found. Tensor token sends are internal wallet-to-wallet in this demo.'
    });
  }

  const recipient = db.users[recipientEmail];
  migrateUser(recipient);

  sender.tensorBalances[tokenId] -= amount;
  recipient.tensorBalances[tokenId] = safeNumber(recipient.tensorBalances[tokenId], 0) + amount;

  const txHash = `TENSOR-${crypto.randomBytes(24).toString('hex')}`;

  const record = {
    id: makeId('tensor_send'),
    type: 'TENSOR_SEND',
    status: 'demo-sent',
    tokenId,
    symbol: token.symbol,
    amount,
    toAddress,
    fromWalletId: sender.id,
    userEmail: sender.email,
    txHash,
    createdAt: Date.now(),
    createdAtIso: nowIso()
  };

  sender.walletTxHistory.unshift(record);
  sender.walletTxHistory = sender.walletTxHistory.slice(0, 200);

  sender.updatedAt = nowIso();
  recipient.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    txHash,
    status: 'demo-sent',
    token,
    amount,
    newBalance: sender.tensorBalances[tokenId],
    record
  });
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
  let copyPortfolio = null;
  let usersCount = 0;
  let tensorTokenCount = 0;

  try {
    const db = readDb();

    copyPortfolio = {
      exists: Boolean(db.copyPortfolio),
      deleted: Boolean(db.copyPortfolio && db.copyPortfolio.deleted),
      status: db.copyPortfolio ? db.copyPortfolio.status : null
    };

    usersCount = Object.keys(db.users || {}).length;
    tensorTokenCount = Array.isArray(db.tensorRegistry) ? db.tensorRegistry.length : 0;
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
      publicCopyProfile: '/copy/admin_copy_portfolio'
    },
    apis: {
      wallet: '/api/wallet',
      walletAddresses: '/api/wallet/addresses',
      walletSend: '/api/wallet/send',
      tradingState: '/api/trading/state',
      tensor: '/api/tensor',
      tensorChart: '/api/tensor/chart',
      tensorDeploy: '/api/tensor/deploy',
      tensorUpdate: '/api/tensor/update/:id',
      tensorDelete: '/api/tensor/delete/:id',
      tensorMint: '/api/tensor/admin-mint',
      tensorSend: '/api/tensor/send',
      copyProfiles: '/api/copy/profiles'
    },
    candleBase: '5m',
    supportedChartTimeframes: ['5m', '15m', '30m', '1h'],
    treasuryDestinations: TREASURY_USDT_ADDRESSES,
    supportedWalletAssets: SUPPORTED_WALLET_ASSETS,
    walletFeatures: {
      normalSeed: true,
      tensorSeed: true,
      ousd: true,
      receiveAddresses: true,
      walletSendHistory: true,
      tensorAdminDeployEditDeleteMint: true
    },
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    dbExists: fs.existsSync(DB_PATH),
    lastRealPriceSync,
    realPriceCount: Object.keys(latestRealPrices).length,
    usersCount,
    tensorTokenCount,
    copyPortfolio
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
  console.log(`Public copy profile: /copy/admin_copy_portfolio`);
  console.log(`Wallet API: /api/wallet`);
  console.log(`Wallet send API: /api/wallet/send`);
  console.log(`Tensor deploy/update/delete/mint APIs enabled`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database path: ${DB_PATH}`);
});