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
            ...