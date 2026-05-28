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
    clamp,
    makeId,
    nowIso,
    sha,
    getSpendableBalance,
    setSpendableBalance,
    creditSpendableBalance,
    debitSpendableBalance,
    getAssetBalanceField,
    getIncludedAdminPositions,
    getIncludedAdminHistory,
    calculateAdminCopyPortfolioStats,
    closeMirroredAdminTradeForCopiers,
    mirrorNewAdminTradeToCopiers,
    calculatePnl
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

    const clean = {
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

    return clean;
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

    db.tensorRegistry.push(token);
    writeDb(db);

    initializeCandlesForToken(id, payload.price);

    res.json({
      ok: true,
      id,
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

    writeDb(db);
    initializeCandlesForToken(token.id, token.price);

    res.json({
      ok: true,
      token
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

  /*
    Compatibility routes:
    Your older trading/wallet pages may still call these.
    Keep them here, then remove the same routes from server.js.
  */

  router.post('/api/tensor/deploy', requireAdminJson, (req, res, next) => {
    req.url = '/api/admin/tensor/deploy';
    next();
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

  /*
    Compatibility with your current trading.ejs.
    You can later update the frontend to use /api/admin/copy/portfolio directly.
  */

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

    writeDb(db);

    res.json({
      ok: true
    });
  });

  return router;
}

module.exports = createAdminRouter;