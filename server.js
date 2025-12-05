// backend/server.js — v28 FINAL — CLEAN, MODULAR, PRINTING FOREVER
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

// ——— CORS ———
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ——— MODULES ———
const db = require('./db');
const { sendTelegram } = require('./alphas');
const { executeBuy, startAutoSell } = require('./trading');
const { syncHeliusWebhook, extractAlphasFromCA } = require('./alphas');

// ——— API ROUTES ———
app.get('/api/data', (req, res) => {
  const state = db.getState();
  res.json({
    trades: state.trades.slice(0, 50),
    settings: state.settings,
    positions: Object.values(state.positions),
    watched: state.watched,
    goldenAlphas: state.goldenAlphas,
    totalProfit: state.totalProfit
  });
});

app.post('/api/add-ca', (req, res) => {
  const { ca } = req.body;
  if (!ca || ca.length < 32) return res.status(400).json({ error: "Invalid CA" });
  res.json({ success: true });
  extractAlphasFromCA(ca);
});

app.post('/api/wallet', (req, res) => {
  const { wallet, action = "add" } = req.body;
  if (!wallet || wallet.length < 32) return res.status(400).json({ error: "Invalid wallet" });
  if (action === "add") db.get('watched').push(wallet).write();
  if (action === "remove") db.get('watched').pull(wallet).write();
  syncHeliusWebhook();
  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { buyAmount, slippage } = req.body;
  db.update('settings', s => ({ ...s, buyAmount: Number(buyAmount), slippage: Number(slippage) })).write();
  res.json({ success: true });
});

// ——— HELIUS WEBHOOK ———
app.post('/webhook', (req, res) => {
  console.log("HELIUS WEBHOOK HIT —", req.body.length, "txs");
  for (const tx of req.body) {
    if (tx.type !== "SWAP" || !tx.tokenTransfers?.length) continue;
    const mint = tx.tokenTransfers[0].mint;
    if (mint === "So11111111111111111111111111111111111111112") continue; // ignore WSOL
    if (db.get('watched').value().includes(tx.feePayer)) {
      console.log(`ALPHA BUY → ${tx.feePayer.slice(0,8)}... → ${mint.slice(0,8)}...`);
      sendTelegram(`ALPHA BUY\n<code>${tx.feePayer}</code>\nToken: <code>${mint}</code>`);
      executeBuy(mint, tx.feePayer);
    }
  }
  res.status(200).json({ success: true });
});

app.options('/webhook', (req, res) => res.status(200).end());

// ——— HEALTH & ROOT ———
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('SolFollow v28 — MODULAR & IMMORTAL'));

// ——— START ———
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSOLFOLLOW v28 — FINAL MODULAR BOT LIVE ON PORT ${PORT}`);
  console.log(`Webhooks, sniping, compounding — ALL ACTIVE\n`);
  
  // Start auto-sell loop
  startAutoSell();
  
  // Sync Helius on boot
  syncHeliusWebhook();
});
