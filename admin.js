'use strict';

const express = require('express');
const crypto = require('crypto');

function createAdminRouter(ctx) {
  const router = express.Router();

  const {
    ADMIN_EMAIL = 'admin@tensorwallet.local',
    readDb,
    writeDb,
    getOrCreateUser,
    getAdminUser,
    safeJsonForEjs,
    TREASURY_USDT_ADDRESSES,
    SUPPORTED_WALLET_ASSETS,
    tensorCandleHistory,
    initializeCandlesForToken,
    publicCopyPortfolioForResponse,
    syncCopyTradePerformance,
    migrateUser,
    migrateToken,
    migrateCopyPortfolio,
    sanitizeTokenPayload,
    normalizeEmail,
    normalizeAsset,
    normalizeNetwork,
    safeNumber,
    makeId,
    nowIso,
    getSpendableBalance,
    setSpendableBalance,
    creditSpendableBalance,
    debitSpendableBalance,
    getIncludedAdminPositions,
    getIncludedAdminHistory,
    calculateAdminCopyPortfolioStats,
    closeMirroredAdminTradeForCopiers,
    mirrorNewAdminTradeToCopiers
  } = ctx;

  function isStaffSession(req) {
    return req.session.user && (
      req.session.user.role === 'staff' ||
      normalizeEmail(req.session.user.email) === ADMIN_EMAIL
    );
  }

  function requireAdminPage(req, res, next) {
    if (!isStaffSession(req)) {
      return res.redirect('/index.html');
    }

    next();
  }

  function requireAdminJson(req, res, next) {
    if (!isStaffSession(req)) {
      return res.status(403).json({
        error: 'Admin access required.'
      });
    }

    next();
  }

  function makePublicId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(10).toString('hex')}`;
  }

  function adminPublicUser(user) {
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      usdtBalance: safeNumber(user.usdtBalance, 0),
      ousdBalance: safeNumber(user.ousdBalance, 0),
      btcBalance: safeNumber(user.btcBalance, 0),
      ethBalance: safeNumber(user.ethBalance, 0),
      solBalance: safeNumber(user.solBalance, 0),
      bnbBalance: safeNumber(user.bnbBalance, 0),
      xrpBalance: safeNumber(user.xrpBalance, 0),
      dogeBalance: safeNumber(user.dogeBalance, 0),
      tensorAddress: user.tensorAddress,
      positionsCount: Array.isArray(user.positions) ? user.positions.length : 0,
      historyCount: Array.isArray(user.orderHistory) ? user.orderHistory.length : 0,
      copyTradesCount: Array.isArray(user.copyTrades) ? user.copyTrades.length : 0,
      walletTxCount: Array.isArray(user.walletTxHistory) ? user.walletTxHistory.length : 0,
      tradeDepositsCount: Array.isArray(user.tradeDeposits) ? user.tradeDeposits.length : 0,
      copyDepositsCount: Array.isArray(user.copyDeposits) ? user.copyDeposits.length : 0
    };
  }

  function adminFullUser(user) {
    const clean = adminPublicUser(user);

    if (!clean) return null;

    return {
      ...clean,
      positions: Array.isArray(user.positions) ? user.positions : [],
      orderHistory: Array.isArray(user.orderHistory) ? user.orderHistory : [],
      copyTrades: Array.isArray(user.copyTrades) ? user.copyTrades : [],
      tradeDeposits: Array.isArray(user.tradeDeposits) ? user.tradeDeposits : [],
      copyDeposits: Array.isArray(user.copyDeposits) ? user.copyDeposits : [],
      walletTxHistory: Array.isArray(user.walletTxHistory) ? user.walletTxHistory : [],
      adminBalanceAdjustments: Array.isArray(user.adminBalanceAdjustments) ? user.adminBalanceAdjustments : [],
      adminTensorAdjustments: Array.isArray(user.adminTensorAdjustments) ? user.adminTensorAdjustments : [],
      adminMints: Array.isArray(user.adminMints) ? user.adminMints : [],
      tensorBalances: user.tensorBalances || {}
    };
  }

  function getAdminStats(db, req) {
    const users = Object.values(db.users || {});
    const treasury = db.treasury || {};
    const portfolio = publicCopyPortfolioForResponse(req, db);
    const copyStats = calculateAdminCopyPortfolioStats(db);

    const userTotals = users.reduce((acc, user) => {
      migrateUser(user);

      acc.usdt += safeNumber(user.usdtBalance, 0);
      acc.ousd += safeNumber(user.ousdBalance, 0);
      acc.openPositions += Array.isArray(user.positions) ? user.positions.length : 0;
      acc.copyTrades += Array.isArray(user.copyTrades) ? user.copyTrades.length : 0;
      acc.history += Array.isArray(user.orderHistory) ? user.orderHistory.length : 0;

      return acc;
    }, {
      usdt: 0,
      ousd: 0,
      openPositions: 0,
      copyTrades: 0,
      history: 0
    });

    return {
      usersCount: users.length,
      staffCount: users.filter(u => u.role === 'staff').length,
      tensorTokenCount: Array.isArray(db.tensorRegistry) ? db.tensorRegistry.length : 0,
      publicTradeCardsCount: Object.keys(db.publicTradeCards || {}).length,
      treasury: {
        collectedFeesUsdt: safeNumber(treasury.collectedFeesUsdt, 0),
        tradeDepositsCount: Array.isArray(treasury.tradeDeposits) ? treasury.tradeDeposits.length : 0,
        copyDepositsCount: Array.isArray(treasury.copyDeposits) ? treasury.copyDeposits.length : 0,
        walletSendsCount: Array.isArray(treasury.walletSends) ? treasury.walletSends.length : 0
      },
      userTotals,
      copyPortfolio: portfolio,
      copyStats,
      supportedWalletAssets: SUPPORTED_WALLET_ASSETS,
      treasuryDestinations: TREASURY_USDT_ADDRESSES
    };
  }

  function applyTokenDashboardExtras(token, body = {}) {
    const stableCoin = body.stableCoin === true || body.stable === true || body.bias === 'pegged';

    token.stableCoin = stableCoin;
    token.stable = stableCoin;
    token.volatilityMode = String(body.volatilityMode || token.volatilityMode || 'medium');
    token.moveEverySec = Math.max(1, safeNumber(body.moveEverySec, token.moveEverySec || 3));

    if (body.iconId !== undefined) token.iconId = String(body.iconId || '');
    if (body.iconSvg !== undefined) token.iconSvg = String(body.iconSvg || '');
    if (body.icon !== undefined) token.icon = String(body.icon || token.symbol?.slice(0, 1) || 'T');

    if (body.bullZoneMin !== undefined) token.bullZoneMin = safeNumber(body.bullZoneMin, 0);
    if (body.bullZoneMax !== undefined) token.bullZoneMax = safeNumber(body.bullZoneMax, 0);
    if (body.bearZoneMin !== undefined) token.bearZoneMin = safeNumber(body.bearZoneMin, 0);
    if (body.bearZoneMax !== undefined) token.bearZoneMax = safeNumber(body.bearZoneMax, 0);

    if (stableCoin) {
      token.bias = 'pegged';
      token.bullChance = 50;
      token.minPct = 0;
      token.maxPct = 0;
    }

    token.marketCap = safeNumber(token.price, 0) * safeNumber(token.supply, 0);
    token.updatedAt = Date.now();
    token.updatedAtIso = nowIso();

    return token;
  }

  function makeDashboardCopyProfile(req, profile = {}) {
    const id = profile.id || profile.publicId || makePublicId('copy');

    return {
      id,
      publicId: profile.publicId || id,
      ownerEmail: profile.ownerEmail || ADMIN_EMAIL,
      ownerWalletId: profile.ownerWalletId || 'system',
      name: String(profile.name || 'Copy Trading Profile').trim().slice(0, 80),
      tag: String(profile.tag || 'Admin strategy').trim().slice(0, 120),
      description: String(profile.description || '').trim().slice(0, 800),
      risk: ['Low', 'Medium', 'High'].includes(profile.risk) ? profile.risk : 'Medium',
      minCopyUsdt: Math.max(1, safeNumber(profile.minCopyUsdt, 50)),
      status: profile.status === 'paused' ? 'paused' : 'active',
      daysTrading: Math.max(0, Math.floor(safeNumber(profile.daysTrading, 1))),
      manualRoi: safeNumber(profile.manualRoi ?? profile.roi, 0),
      manualPnl: safeNumber(profile.manualPnl ?? profile.pnl, 0),
      roi: safeNumber(profile.manualRoi ?? profile.roi, 0),
      pnl: safeNumber(profile.manualPnl ?? profile.pnl, 0),
      followers: Math.max(0, Math.floor(safeNumber(profile.followers, 0))),
      positionSource: profile.positionSource || 'admin_live',
      positions: Array.isArray(profile.positions) ? profile.positions.slice(0, 50) : [],
      shareUrl: `${req.protocol}://${req.get('host')}/copy/${profile.publicId || id}`,
      joinUrl: `${req.protocol}://${req.get('host')}/trading?copy=${encodeURIComponent(profile.publicId || id)}`,
      deleted: false,
      createdAt: profile.createdAt || Date.now(),
      createdAtIso: profile.createdAtIso || nowIso(),
      updatedAt: Date.now(),
      updatedAtIso: nowIso()
    };
  }

  function ensureCopyProfiles(db) {
    if (!db.copyProfiles || typeof db.copyProfiles !== 'object') {
      db.copyProfiles = {};
    }

    if (db.copyPortfolio && !db.copyProfiles.admin_copy_portfolio) {
      db.copyProfiles.admin_copy_portfolio = {
        ...db.copyPortfolio,
        id: 'admin_copy_portfolio',
        publicId: 'admin_copy_portfolio',
        positionSource: 'admin_live'
      };
    }

    return db.copyProfiles;
  }

  function publicDashboardCopyProfile(req, db, profile) {
    const clean = makeDashboardCopyProfile(req, profile);

    if (clean.id === 'admin_copy_portfolio' || clean.positionSource === 'admin_live') {
      const live = publicCopyPortfolioForResponse(req, db);

      if (live) {
        return {
          ...clean,
          ...live,
          id: clean.id,
          publicId: clean.publicId,
          name: clean.name,
          tag: clean.tag,
          description: clean.description,
          risk: clean.risk,
          minCopyUsdt: clean.minCopyUsdt,
          status: clean.status,
          daysTrading: clean.daysTrading,
          manualRoi: clean.manualRoi,
          manualPnl: clean.manualPnl,
          roi: clean.manualRoi + safeNumber(live.roi, 0),
          pnl: clean.manualPnl + safeNumber(live.pnl, 0),
          shareUrl: `${req.protocol}://${req.get('host')}/copy/${clean.publicId}`,
          joinUrl: `${req.protocol}://${req.get('host')}/trading?copy=${encodeURIComponent(clean.publicId)}`
        };
      }
    }

    return clean;
  }

  /* -------------------- Dashboard Page -------------------- */

  router.get('/dashboard', requireAdminPage, (req, res) => {
    const db = readDb();
    const admin = getOrCreateUser(ADMIN_EMAIL, 'staff');

    res.render('dashboard', {
      email: req.session.user.email,
      role: req.session.user.role,
      wallet: safeJsonForEjs(admin),
      adminStats: safeJsonForEjs(getAdminStats(db, req)),
      treasury: safeJsonForEjs(TREASURY_USDT_ADDRESSES),
      supportedAssets: safeJsonForEjs(SUPPORTED_WALLET_ASSETS)
    });
  });

  router.get('/dashboard.ejs', requireAdminPage, (req, res) => {
    res.redirect('/dashboard');
  });

  /* -------------------- Admin Overview APIs -------------------- */

  router.get('/api/admin/state', requireAdminJson, (req, res) => {
    const db = readDb();
    const admin = getAdminUser(db);

    migrateUser(admin);

    const copyProfiles = Object.values(ensureCopyProfiles(db))
      .filter(p => !p.deleted)
      .map(p => publicDashboardCopyProfile(req, db, p));

    res.json({
      ok: true,
      wallet: adminFullUser(admin),
      tokens: db.tensorRegistry || [],
      copyProfiles,
      users: Object.values(db.users || {}).map(adminPublicUser),
      summary: getAdminStats(db, req)
    });
  });

  router.get('/api/admin/summary', requireAdminJson, (req, res) => {
    const db = readDb();

    res.json({
      ok: true,
      summary: getAdminStats(db, req)
    });
  });

  router.get('/api/admin/health', requireAdminJson, (req, res) => {
    const db = readDb();

    res.json({
      ok: true,
      adminEmail: ADMIN_EMAIL,
      usersCount: Object.keys(db.users || {}).length,
      tensorTokenCount: Array.isArray(db.tensorRegistry) ? db.tensorRegistry.length : 0,
      copyPortfolioExists: Boolean(db.copyPortfolio),
      copyPortfolioStatus: db.copyPortfolio ? db.copyPortfolio.status : null,
      treasuryDestinations: TREASURY_USDT_ADDRESSES,
      supportedWalletAssets: SUPPORTED_WALLET_ASSETS
    });
  });

  /* -------------------- Admin Wallet APIs -------------------- */

  router.get('/api/admin/wallet', requireAdminJson, (req, res) => {
    const db = readDb();
    const admin = getAdminUser(db);

    migrateUser(admin);
    syncCopyTradePerformance(db, admin);
    writeDb(db);

    res.json({
      ok: true,
      wallet: adminFullUser(admin)
    });
  });

  router.post('/api/admin/wallet/adjust', requireAdminJson, (req, res) => {
    const db = readDb();
    const admin = getAdminUser(db);

    migrateUser(admin);

    const walletType = String(req.body.walletType || 'crypto').toLowerCase();
    const asset = normalizeAsset(req.body.asset || 'USDT');
    const amount = safeNumber(req.body.amount, 0);
    const reason = String(req.body.reason || 'Admin wallet adjustment').slice(0, 220);

    if (!amount) {
      return res.status(400).json({
        error: 'Amount is required.'
      });
    }

    let before = 0;
    let after = 0;

    if (walletType === 'tensor') {
      const token = db.tensorRegistry.find(t => String(t.id) === String(req.body.asset));

      if (!token) {
        return res.status(404).json({
          error: 'Tensor token not found.'
        });
      }

      before = safeNumber(admin.tensorBalances[token.id], 0);
      admin.tensorBalances[token.id] = Math.max(0, before + amount);
      after = admin.tensorBalances[token.id];

      if (!Array.isArray(admin.adminTensorAdjustments)) admin.adminTensorAdjustments = [];

      admin.adminTensorAdjustments.unshift({
        id: makeId('tensor_adjust'),
        tokenId: token.id,
        symbol: token.symbol,
        amount,
        before,
        after,
        reason,
        adminEmail: req.session.user.email,
        createdAt: Date.now(),
        createdAtIso: nowIso()
      });

      admin.adminTensorAdjustments = admin.adminTensorAdjustments.slice(0, 200);
    } else {
      if (!SUPPORTED_WALLET_ASSETS.includes(asset)) {
        return res.status(400).json({
          error: 'Unsupported crypto asset.'
        });
      }

      before = getSpendableBalance(admin, asset);
      setSpendableBalance(admin, asset, Math.max(0, before + amount));
      after = getSpendableBalance(admin, asset);

      if (!Array.isArray(admin.adminBalanceAdjustments)) admin.adminBalanceAdjustments = [];

      admin.adminBalanceAdjustments.unshift({
        id: makeId('balance_adjust'),
        asset,
        amount,
        before,
        after,
        reason,
        adminEmail: req.session.user.email,
        createdAt: Date.now(),
        createdAtIso: nowIso()
      });

      admin.adminBalanceAdjustments = admin.adminBalanceAdjustments.slice(0, 200);
    }

    admin.updatedAt = nowIso();
    writeDb(db);

    res.json({
      ok: true,
      before,
      after,
      wallet: adminFullUser(admin)
    });
  });

  /* -------------------- User Admin APIs -------------------- */

  router.get('/api/admin/users', requireAdminJson, (req, res) => {
    const db = readDb();

    const users = Object.values(db.users || {})
      .map(user => {
        migrateUser(user);
        syncCopyTradePerformance(db, user);
        return adminPublicUser(user);
      })
      .sort((a, b) => String(a.email).localeCompare(String(b.email)));

    writeDb(db);

    res.json({
      ok: true,
      users
    });
  });

  router.get('/api/admin/users/:email', requireAdminJson, (req, res) => {
    const email = normalizeEmail(req.params.email);
    const db = readDb();
    const user = db.users[email];

    if (!user) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    migrateUser(user);
    syncCopyTradePerformance(db, user);
    writeDb(db);

    res.json({
      ok: true,
      user: adminFullUser(user)
    });
  });

  router.post('/api/admin/users/create', requireAdminJson, (req, res) => {
    const email = normalizeEmail(req.body.email);
    const role = req.body.role === 'staff' ? 'staff' : 'user';

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        error: 'Valid email is required.'
      });
    }

    const user = getOrCreateUser(email, role);

    res.json({
      ok: true,
      user: adminPublicUser(user)
    });
  });

  router.put('/api/admin/users/:email/role', requireAdminJson, (req, res) => {
    const email = normalizeEmail(req.params.email);

    if (email === ADMIN_EMAIL) {
      return res.status(400).json({
        error: 'Main admin role cannot be changed.'
      });
    }

    const role = req.body.role === 'staff' ? 'staff' : 'user';
    const db = readDb();
    const user = db.users[email];

    if (!user) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    migrateUser(user);
    user.role = role;
    user.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      user: adminPublicUser(user)
    });
  });

  router.put('/api/admin/users/:email/balance', requireAdminJson, (req, res) => {
    const email = normalizeEmail(req.params.email);
    const asset = normalizeAsset(req.body.asset || 'USDT');
    const mode = String(req.body.mode || 'set').toLowerCase();
    const amount = safeNumber(req.body.amount, 0);

    if (!SUPPORTED_WALLET_ASSETS.includes(asset)) {
      return res.status(400).json({
        error: 'Unsupported asset.'
      });
    }

    const db = readDb();
    const user = db.users[email];

    if (!user) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    migrateUser(user);

    const before = getSpendableBalance(user, asset);

    if (mode === 'add') {
      creditSpendableBalance(user, asset, amount);
    } else if (mode === 'subtract') {
      const debit = debitSpendableBalance(user, asset, amount);

      if (!debit.ok) {
        return res.status(400).json({
          error: debit.error
        });
      }
    } else {
      setSpendableBalance(user, asset, amount);
    }

    const after = getSpendableBalance(user, asset);

    if (!Array.isArray(user.adminBalanceAdjustments)) {
      user.adminBalanceAdjustments = [];
    }

    user.adminBalanceAdjustments.unshift({
      id: makeId('balance_adjust'),
      asset,
      mode,
      amount,
      before,
      after,
      adminEmail: req.session.user.email,
      createdAt: Date.now(),
      createdAtIso: nowIso()
    });

    user.adminBalanceAdjustments = user.adminBalanceAdjustments.slice(0, 200);
    user.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      asset,
      before,
      after,
      user: adminPublicUser(user)
    });
  });

  router.post('/api/admin/users/adjust', requireAdminJson, (req, res) => {
    const targetEmail = normalizeEmail(req.body.targetEmail || req.body.email);
    const walletType = String(req.body.walletType || 'crypto').toLowerCase();
    const asset = normalizeAsset(req.body.asset || 'USDT');
    const amount = safeNumber(req.body.amount, 0);
    const reason = String(req.body.reason || 'Admin user wallet adjustment').slice(0, 220);

    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({
        error: 'Target email is required.'
      });
    }

    if (!amount) {
      return res.status(400).json({
        error: 'Amount is required.'
      });
    }

    const db = readDb();
    const user = db.users[targetEmail];

    if (!user) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    migrateUser(user);

    let before = 0;
    let after = 0;

    if (walletType === 'tensor') {
      const token = db.tensorRegistry.find(t => String(t.id) === String(req.body.asset));

      if (!token) {
        return res.status(404).json({
          error: 'Tensor token not found.'
        });
      }

      before = safeNumber(user.tensorBalances[token.id], 0);
      user.tensorBalances[token.id] = Math.max(0, before + amount);
      after = user.tensorBalances[token.id];

      if (!Array.isArray(user.adminTensorAdjustments)) user.adminTensorAdjustments = [];

      user.adminTensorAdjustments.unshift({
        id: makeId('tensor_adjust'),
        tokenId: token.id,
        symbol: token.symbol,
        amount,
        before,
        after,
        reason,
        adminEmail: req.session.user.email,
        createdAt: Date.now(),
        createdAtIso: nowIso()
      });

      user.adminTensorAdjustments = user.adminTensorAdjustments.slice(0, 200);
    } else {
      if (!SUPPORTED_WALLET_ASSETS.includes(asset)) {
        return res.status(400).json({
          error: 'Unsupported crypto asset.'
        });
      }

      before = getSpendableBalance(user, asset);
      setSpendableBalance(user, asset, Math.max(0, before + amount));
      after = getSpendableBalance(user, asset);

      if (!Array.isArray(user.adminBalanceAdjustments)) user.adminBalanceAdjustments = [];

      user.adminBalanceAdjustments.unshift({
        id: makeId('balance_adjust'),
        asset,
        amount,
        before,
        after,
        reason,
        adminEmail: req.session.user.email,
        createdAt: Date.now(),
        createdAtIso: nowIso()
      });

      user.adminBalanceAdjustments = user.adminBalanceAdjustments.slice(0, 200);
    }

    user.updatedAt = nowIso();
    writeDb(db);

    res.json({
      ok: true,
      before,
      after,
      user: adminFullUser(user)
    });
  });

  router.post('/api/admin/users/reset-wallet', requireAdminJson, (req, res) => {
    const targetEmail = normalizeEmail(req.body.targetEmail || req.body.email);

    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({
        error: 'Target email is required.'
      });
    }

    if (targetEmail === ADMIN_EMAIL) {
      return res.status(400).json({
        error: 'Main admin wallet cannot be reset from this route.'
      });
    }

    const db = readDb();
    const user = db.users[targetEmail];

    if (!user) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    migrateUser(user);

    user.usdtBalance = 15000;
    user.ousdBalance = 5000;
    user.btcBalance = 0;
    user.ethBalance = 0;
    user.solBalance = 0;
    user.bnbBalance = 0;
    user.xrpBalance = 0;
    user.dogeBalance = 0;
    user.tensorBalances = {};
    user.positions = [];
    user.orderHistory = [];
    user.copyTrades = [];
    user.copyDeposits = [];
    user.tradeDeposits = [];
    user.walletTxHistory = [];
    user.publicTradeCards = [];
    user.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      user: adminFullUser(user)
    });
  });

  router.delete('/api/admin/users/:email', requireAdminJson, (req, res) => {
    const email = normalizeEmail(req.params.email);

    if (email === ADMIN_EMAIL) {
      return res.status(400).json({
        error: 'Main admin user cannot be deleted.'
      });
    }

    const db = readDb();

    if (!db.users[email]) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    delete db.users[email];
    writeDb(db);

    res.json({
      ok: true
    });
  });

  /* -------------------- Tensor Token Admin APIs -------------------- */

  router.get('/api/admin/tensor/tokens', requireAdminJson, (req, res) => {
    const db = readDb();

    db.tensorRegistry.forEach(migrateToken);
    writeDb(db);

    res.json({
      ok: true,
      tokens: db.tensorRegistry
    });
  });

  router.post('/api/admin/tensor/tokens', requireAdminJson, (req, res) => {
    const payload = sanitizeTokenPayload(req.body);

    if (!payload.name || !payload.symbol || payload.price <= 0 || payload.supply <= 0) {
      return res.status(400).json({
        error: 'Missing or invalid token parameters.'
      });
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
      createdBy: req.session.user.email,
      createdAt: Date.now(),
      createdAtIso: nowIso()
    };

    applyTokenDashboardExtras(token, req.body);

    db.tensorRegistry.push(token);
    writeDb(db);

    initializeCandlesForToken(id, payload.price);

    res.json({
      ok: true,
      id,
      token
    });
  });

  router.post('/api/admin/tensor/deploy', requireAdminJson, (req, res) => {
    const payload = sanitizeTokenPayload(req.body);

    if (!payload.name || !payload.symbol || payload.price <= 0 || payload.supply <= 0) {
      return res.status(400).json({
        error: 'Missing or invalid token parameters.'
      });
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
      createdBy: req.session.user.email,
      createdAt: Date.now(),
      createdAtIso: nowIso()
    };

    applyTokenDashboardExtras(token, req.body);

    db.tensorRegistry.push(token);
    writeDb(db);

    initializeCandlesForToken(id, payload.price);

    res.json({
      ok: true,
      id,
      token
    });
  });

  router.put('/api/admin/tensor/tokens/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const token = db.tensorRegistry.find(t => String(t.id) === String(req.params.id));

    if (!token) {
      return res.status(404).json({
        error: 'Token not found.'
      });
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
    token.updatedBy = req.session.user.email;
    token.updatedAt = Date.now();
    token.updatedAtIso = nowIso();

    applyTokenDashboardExtras(token, req.body);

    writeDb(db);
    initializeCandlesForToken(token.id, token.price);

    res.json({
      ok: true,
      token
    });
  });

  router.put('/api/admin/tensor/update/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const token = db.tensorRegistry.find(t => String(t.id) === String(req.params.id));

    if (!token) {
      return res.status(404).json({
        error: 'Token not found.'
      });
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
    token.updatedBy = req.session.user.email;
    token.updatedAt = Date.now();
    token.updatedAtIso = nowIso();

    applyTokenDashboardExtras(token, req.body);

    writeDb(db);
    initializeCandlesForToken(token.id, token.price);

    res.json({
      ok: true,
      token
    });
  });

  router.delete('/api/admin/tensor/tokens/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const index = db.tensorRegistry.findIndex(t => String(t.id) === String(req.params.id));

    if (index === -1) {
      return res.status(404).json({
        error: 'Token not found.'
      });
    }

    const removed = db.tensorRegistry[index];

    db.tensorRegistry.splice(index, 1);

    if (tensorCandleHistory) {
      delete tensorCandleHistory[req.params.id];
    }

    Object.values(db.users || {}).forEach(user => {
      migrateUser(user);

      if (user.tensorBalances) {
        delete user.tensorBalances[req.params.id];
      }

      if (Array.isArray(user.positions)) {
        user.positions = user.positions.filter(p => p.tokenId !== req.params.id);
      }

      if (Array.isArray(user.copyTrades)) {
        user.copyTrades.forEach(copy => {
          copy.mirroredPositions = (copy.mirroredPositions || []).filter(p => p.tokenId !== req.params.id);
          copy.closedMirrors = (copy.closedMirrors || []).filter(p => p.tokenId !== req.params.id);
        });
      }
    });

    writeDb(db);

    res.json({
      ok: true,
      removed
    });
  });

  router.delete('/api/admin/tensor/delete/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const index = db.tensorRegistry.findIndex(t => String(t.id) === String(req.params.id));

    if (index === -1) {
      return res.status(404).json({
        error: 'Token not found.'
      });
    }

    const removed = db.tensorRegistry[index];

    db.tensorRegistry.splice(index, 1);

    if (tensorCandleHistory) {
      delete tensorCandleHistory[req.params.id];
    }

    Object.values(db.users || {}).forEach(user => {
      migrateUser(user);

      if (user.tensorBalances) {
        delete user.tensorBalances[req.params.id];
      }

      if (Array.isArray(user.positions)) {
        user.positions = user.positions.filter(p => p.tokenId !== req.params.id);
      }

      if (Array.isArray(user.copyTrades)) {
        user.copyTrades.forEach(copy => {
          copy.mirroredPositions = (copy.mirroredPositions || []).filter(p => p.tokenId !== req.params.id);
          copy.closedMirrors = (copy.closedMirrors || []).filter(p => p.tokenId !== req.params.id);
        });
      }
    });

    writeDb(db);

    res.json({
      ok: true,
      removed
    });
  });

  router.post('/api/admin/tensor/mint', requireAdminJson, (req, res) => {
    const tokenId = String(req.body.tokenId || '');
    const amount = safeNumber(req.body.amount, 0);
    const targetEmail = normalizeEmail(req.body.email || req.body.targetEmail || req.session.user.email);

    if (!tokenId || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid token or amount.'
      });
    }

    const db = readDb();
    const token = db.tensorRegistry.find(t => String(t.id) === tokenId);

    if (!token) {
      return res.status(404).json({
        error: 'Token not found.'
      });
    }

    const user = db.users[targetEmail] || getOrCreateUser(targetEmail, 'user');

    migrateUser(user);

    user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + amount;

    if (!Array.isArray(user.adminMints)) {
      user.adminMints = [];
    }

    user.adminMints.unshift({
      id: makeId('mint'),
      tokenId,
      symbol: token.symbol,
      amount,
      adminEmail: req.session.user.email,
      createdAt: Date.now(),
      createdAtIso: nowIso()
    });

    user.adminMints = user.adminMints.slice(0, 200);
    user.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      token,
      targetEmail,
      minted: amount,
      newBalance: user.tensorBalances[tokenId]
    });
  });

  /* -------------------- Compatibility Routes For Existing Pages -------------------- */

  router.post('/api/tensor/deploy', requireAdminJson, (req, res) => {
    const payload = sanitizeTokenPayload(req.body);

    if (!payload.name || !payload.symbol || payload.price <= 0 || payload.supply <= 0) {
      return res.status(400).json({
        error: 'Missing or invalid token parameters.'
      });
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
      createdBy: req.session.user.email,
      createdAt: Date.now(),
      createdAtIso: nowIso()
    };

    applyTokenDashboardExtras(token, req.body);

    db.tensorRegistry.push(token);
    writeDb(db);

    initializeCandlesForToken(id, payload.price);

    res.json({
      ok: true,
      id,
      token
    });
  });

  router.put('/api/tensor/update/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const token = db.tensorRegistry.find(t => String(t.id) === String(req.params.id));

    if (!token) {
      return res.status(404).json({
        error: 'Token not found.'
      });
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
    token.updatedBy = req.session.user.email;
    token.updatedAt = Date.now();
    token.updatedAtIso = nowIso();

    applyTokenDashboardExtras(token, req.body);

    writeDb(db);
    initializeCandlesForToken(token.id, token.price);

    res.json({
      ok: true,
      token
    });
  });

  router.delete('/api/tensor/delete/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const index = db.tensorRegistry.findIndex(t => String(t.id) === String(req.params.id));

    if (index === -1) {
      return res.status(404).json({
        error: 'Token not found.'
      });
    }

    const removed = db.tensorRegistry[index];

    db.tensorRegistry.splice(index, 1);

    if (tensorCandleHistory) {
      delete tensorCandleHistory[req.params.id];
    }

    Object.values(db.users || {}).forEach(user => {
      migrateUser(user);

      if (user.tensorBalances) {
        delete user.tensorBalances[req.params.id];
      }

      if (Array.isArray(user.positions)) {
        user.positions = user.positions.filter(p => p.tokenId !== req.params.id);
      }

      if (Array.isArray(user.copyTrades)) {
        user.copyTrades.forEach(copy => {
          copy.mirroredPositions = (copy.mirroredPositions || []).filter(p => p.tokenId !== req.params.id);
          copy.closedMirrors = (copy.closedMirrors || []).filter(p => p.tokenId !== req.params.id);
        });
      }
    });

    writeDb(db);

    res.json({
      ok: true,
      removed
    });
  });

  router.post('/api/tensor/admin-mint', requireAdminJson, (req, res) => {
    const tokenId = String(req.body.tokenId || '');
    const amount = safeNumber(req.body.amount, 0);
    const targetEmail = normalizeEmail(req.body.email || req.body.targetEmail || req.session.user.email);

    if (!tokenId || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid token or amount.'
      });
    }

    const db = readDb();
    const token = db.tensorRegistry.find(t => String(t.id) === tokenId);

    if (!token) {
      return res.status(404).json({
        error: 'Token not found.'
      });
    }

    const user = db.users[targetEmail] || getOrCreateUser(targetEmail, 'user');

    migrateUser(user);

    user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + amount;
    user.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      token,
      targetEmail,
      minted: amount,
      newBalance: user.tensorBalances[tokenId]
    });
  });

  /* -------------------- Copy Portfolio Admin APIs -------------------- */

  router.get('/api/admin/copy/portfolio', requireAdminJson, (req, res) => {
    const db = readDb();
    const portfolio = publicCopyPortfolioForResponse(req, db);
    const stats = calculateAdminCopyPortfolioStats(db);

    res.json({
      ok: true,
      portfolio,
      stats,
      adminPositions: getIncludedAdminPositions(db),
      adminHistory: getIncludedAdminHistory(db)
    });
  });

  router.post('/api/admin/copy/portfolio', requireAdminJson, (req, res) => {
    const db = readDb();

    if (!db.copyPortfolio || typeof db.copyPortfolio !== 'object') {
      db.copyPortfolio = {};
    }

    const profile = db.copyPortfolio;

    migrateCopyPortfolio(profile);

    profile.name = String(req.body.name || profile.name || 'Tensor Alpha Copy').trim().slice(0, 80);
    profile.tag = String(req.body.tag || profile.tag || 'Admin copy portfolio').trim().slice(0, 120);
    profile.description = String(req.body.description || profile.description || '').trim().slice(0, 800);
    profile.risk = ['Low', 'Medium', 'High'].includes(req.body.risk) ? req.body.risk : profile.risk;
    profile.minCopyUsdt = Math.max(1, safeNumber(req.body.minCopyUsdt, profile.minCopyUsdt));
    profile.status = req.body.status === 'paused' ? 'paused' : 'active';
    profile.daysTrading = Math.max(0, Math.floor(safeNumber(req.body.daysTrading, profile.daysTrading)));
    profile.manualRoi = safeNumber(req.body.manualRoi ?? req.body.roi, profile.manualRoi);
    profile.manualPnl = safeNumber(req.body.manualPnl ?? req.body.pnl, profile.manualPnl);
    profile.deleted = false;
    profile.updatedBy = req.session.user.email;
    profile.updatedAt = Date.now();
    profile.updatedAtIso = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      portfolio: publicCopyPortfolioForResponse(req, db)
    });
  });

  router.put('/api/admin/copy/portfolio', requireAdminJson, (req, res) => {
    const db = readDb();

    if (!db.copyPortfolio || typeof db.copyPortfolio !== 'object') {
      db.copyPortfolio = {};
    }

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
    profile.updatedBy = req.session.user.email;
    profile.updatedAt = Date.now();
    profile.updatedAtIso = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      portfolio: publicCopyPortfolioForResponse(req, db)
    });
  });

  router.delete('/api/admin/copy/portfolio', requireAdminJson, (req, res) => {
    const db = readDb();

    if (!db.copyPortfolio || typeof db.copyPortfolio !== 'object') {
      db.copyPortfolio = {};
    }

    migrateCopyPortfolio(db.copyPortfolio);

    db.copyPortfolio.deleted = true;
    db.copyPortfolio.status = 'paused';
    db.copyPortfolio.updatedBy = req.session.user.email;
    db.copyPortfolio.updatedAt = Date.now();
    db.copyPortfolio.updatedAtIso = nowIso();

    Object.values(db.users || {}).forEach(user => {
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
          copy.returnedAsset = fundingAsset;
          copy.closeReason = 'Copy portfolio deleted by admin';
        }
      });

      user.copyTrades = user.copyTrades.filter(copy => copy.status === 'active');
      user.updatedAt = nowIso();
    });

    writeDb(db);

    res.json({
      ok: true
    });
  });

  /* -------------------- Multiple Copy Profile APIs -------------------- */

  router.get('/api/admin/copy/profiles', requireAdminJson, (req, res) => {
    const db = readDb();

    const profiles = Object.values(ensureCopyProfiles(db))
      .filter(p => !p.deleted)
      .map(p => publicDashboardCopyProfile(req, db, p));

    writeDb(db);

    res.json({
      ok: true,
      profiles,
      copyProfiles: profiles
    });
  });

  router.post('/api/admin/copy/profiles', requireAdminJson, (req, res) => {
    const db = readDb();
    const profiles = ensureCopyProfiles(db);

    const id = makePublicId('copy');

    const profile = makeDashboardCopyProfile(req, {
      ...req.body,
      id,
      publicId: id
    });

    profiles[profile.id] = profile;
    writeDb(db);

    res.json({
      ok: true,
      profile: publicDashboardCopyProfile(req, db, profile)
    });
  });

  router.put('/api/admin/copy/profiles/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const profiles = ensureCopyProfiles(db);

    const key = Object.keys(profiles).find(k => {
      return String(k) === String(req.params.id) || String(profiles[k].publicId) === String(req.params.id);
    });

    if (!key) {
      return res.status(404).json({
        error: 'Copy profile not found.'
      });
    }

    profiles[key] = makeDashboardCopyProfile(req, {
      ...profiles[key],
      ...req.body,
      id: profiles[key].id || key,
      publicId: profiles[key].publicId || key,
      updatedBy: req.session.user.email
    });

    writeDb(db);

    res.json({
      ok: true,
      profile: publicDashboardCopyProfile(req, db, profiles[key])
    });
  });

  router.delete('/api/admin/copy/profiles/:id', requireAdminJson, (req, res) => {
    const db = readDb();
    const profiles = ensureCopyProfiles(db);

    const key = Object.keys(profiles).find(k => {
      return String(k) === String(req.params.id) || String(profiles[k].publicId) === String(req.params.id);
    });

    if (!key) {
      return res.status(404).json({
        error: 'Copy profile not found.'
      });
    }

    profiles[key].deleted = true;
    profiles[key].status = 'paused';
    profiles[key].updatedBy = req.session.user.email;
    profiles[key].updatedAt = Date.now();
    profiles[key].updatedAtIso = nowIso();

    writeDb(db);

    res.json({
      ok: true
    });
  });

  /* -------------------- Compatibility With Current Trading.ejs Copy Routes -------------------- */

  router.post('/api/copy/admin/profile', requireAdminJson, (req, res) => {
    const db = readDb();

    if (!db.copyPortfolio || typeof db.copyPortfolio !== 'object') {
      db.copyPortfolio = {};
    }

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

  router.put('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
    if (String(req.params.id) !== 'admin_copy_portfolio') {
      return res.status(404).json({
        error: 'Copy portfolio not found.'
      });
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

  router.delete('/api/copy/admin/profile/:id', requireAdminJson, (req, res) => {
    if (String(req.params.id) !== 'admin_copy_portfolio') {
      return res.status(404).json({
        error: 'Copy portfolio not found.'
      });
    }

    const db = readDb();

    db.copyPortfolio.deleted = true;
    db.copyPortfolio.status = 'paused';
    db.copyPortfolio.updatedAt = Date.now();
    db.copyPortfolio.updatedAtIso = nowIso();

    writeDb(db);

    res.json({
      ok: true
    });
  });

  /* -------------------- Admin Position / Copy Display APIs -------------------- */

  router.put('/api/admin/positions/:positionId/copy-display', requireAdminJson, (req, res) => {
    const db = readDb();
    const admin = getAdminUser(db);
    const position = admin.positions.find(p => String(p.id) === String(req.params.positionId));

    if (!position) {
      return res.status(404).json({
        error: 'Admin position not found.'
      });
    }

    position.includeInCopyPortfolio = req.body.includeInCopyPortfolio !== false;
    position.updatedAt = Date.now();
    position.updatedAtIso = nowIso();

    if (position.includeInCopyPortfolio) {
      mirrorNewAdminTradeToCopiers(db, position);
    } else {
      closeMirroredAdminTradeForCopiers(db, position.id, position.markPrice || position.entryPrice);
    }

    admin.updatedAt = nowIso();

    writeDb(db);

    res.json({
      ok: true,
      position
    });
  });

  router.get('/api/admin/positions/copy-included', requireAdminJson, (req, res) => {
    const db = readDb();

    res.json({
      ok: true,
      positions: getIncludedAdminPositions(db),
      history: getIncludedAdminHistory(db),
      stats: calculateAdminCopyPortfolioStats(db)
    });
  });

  /* -------------------- Treasury / Records APIs -------------------- */

  router.get('/api/admin/treasury', requireAdminJson, (req, res) => {
    const db = readDb();

    res.json({
      ok: true,
      treasury: db.treasury || {},
      treasuryDestinations: TREASURY_USDT_ADDRESSES
    });
  });

  router.get('/api/admin/deposits', requireAdminJson, (req, res) => {
    const db = readDb();
    const treasury = db.treasury || {};

    res.json({
      ok: true,
      tradeDeposits: Array.isArray(treasury.tradeDeposits) ? treasury.tradeDeposits : [],
      copyDeposits: Array.isArray(treasury.copyDeposits) ? treasury.copyDeposits : [],
      walletSends: Array.isArray(treasury.walletSends) ? treasury.walletSends : []
    });
  });

  router.get('/api/admin/trades/history', requireAdminJson, (req, res) => {
    const db = readDb();

    const history = Object.values(db.users || {}).flatMap(user => {
      migrateUser(user);

      return (user.orderHistory || []).map(trade => ({
        ...trade,
        userEmail: user.email,
        userWalletId: user.id
      }));
    }).sort((a, b) => safeNumber(b.closedAt, 0) - safeNumber(a.closedAt, 0));

    res.json({
      ok: true,
      history
    });
  });

  router.get('/api/admin/trades/open', requireAdminJson, (req, res) => {
    const db = readDb();

    const positions = Object.values(db.users || {}).flatMap(user => {
      migrateUser(user);

      return (user.positions || []).map(pos => ({
        ...pos,
        userEmail: user.email,
        userWalletId: user.id
      }));
    }).sort((a, b) => safeNumber(b.openedAt, 0) - safeNumber(a.openedAt, 0));

    res.json({
      ok: true,
      positions
    });
  });

  /* -------------------- Utility APIs -------------------- */

  router.post('/api/admin/reset-demo', requireAdminJson, (req, res) => {
    const confirm = String(req.body.confirm || '').trim();

    if (confirm !== 'RESET') {
      return res.status(400).json({
        error: 'Send confirm: RESET to reset demo data.'
      });
    }

    const db = readDb();

    Object.values(db.users || {}).forEach(user => {
      migrateUser(user);

      user.positions = [];
      user.orderHistory = [];
      user.tradeDeposits = [];
      user.copyTrades = [];
      user.copyDeposits = [];
      user.walletTxHistory = [];
      user.publicTradeCards = [];

      if (user.role === 'staff' || normalizeEmail(user.email) === ADMIN_EMAIL) {
        user.usdtBalance = 1000000;
        user.ousdBalance = 500000;
      } else {
        user.usdtBalance = 15000;
        user.ousdBalance = 5000;
      }

      user.btcBalance = 0;
      user.ethBalance = 0;
      user.solBalance = 0;
      user.bnbBalance = 0;
      user.xrpBalance = 0;
      user.dogeBalance = 0;

      user.updatedAt = nowIso();
    });

    if (db.treasury) {
      db.treasury.collectedFeesUsdt = 0;
      db.treasury.tradeDeposits = [];
      db.treasury.copyDeposits = [];
      db.treasury.walletSends = [];
    }

    db.publicTradeCards = {};

    if (db.copyPortfolio) {
      migrateCopyPortfolio(db.copyPortfolio);
      db.copyPortfolio.followers = 0;
      db.copyPortfolio.manualRoi = 0;
      db.copyPortfolio.manualPnl = 0;
      db.copyPortfolio.deleted = false;
      db.copyPortfolio.status = 'active';
      db.copyPortfolio.updatedAt = Date.now();
      db.copyPortfolio.updatedAtIso = nowIso();
    }

    if (db.copyProfiles && typeof db.copyProfiles === 'object') {
      Object.values(db.copyProfiles).forEach(profile => {
        profile.followers = 0;
        profile.manualRoi = 0;
        profile.manualPnl = 0;
        profile.roi = 0;
        profile.pnl = 0;
        profile.deleted = false;
        profile.status = 'active';
        profile.updatedAt = Date.now();
        profile.updatedAtIso = nowIso();
      });
    }

    writeDb(db);

    res.json({
      ok: true
    });
  });

  return router;
}

module.exports = createAdminRouter;