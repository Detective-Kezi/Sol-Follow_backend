// backend/alphas.js — v28.1 — GOLDEN ALPHAS + HELIUS SYNC WITH GET AT STARTUP
const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const db = require('./db');
const { connection, sendTelegram } = require('./config');
const { executeBuy } = require('./trading');

// ——— UPDATE GOLDEN ALPHA SCORING ———
function updateGoldenAlpha(wallet, position = 1) {
  const stats = db.get('alphaStats').value() || {};
  const entry = stats[wallet] || { wins: 0, total: 0, avgPos: 0, volume: 0 };
  entry.total++;
  entry.avgPos = ((entry.avgPos * (entry.total - 1)) + position) / entry.total;
  entry.volume += db.get('settings.currentBuyAmount').value() || 0.5;
  if (position <= 5) entry.wins++;

  db.set(`alphaStats.${wallet}`, entry).write();

  const score = Math.min(10, (
    (10 - entry.avgPos) * 1.5 +
    (entry.wins / entry.total) * 100 * 0.8 +
    Math.min(entry.volume / 30, 10) * 0.5
  ).toFixed(1));

  let alphas = db.get('goldenAlphas').value() || [];
  const existing = alphas.find(a => a.fullAddress === wallet);
  const alphaData = {
    address: wallet.slice(0,8) + "..." + wallet.slice(-4),
    fullAddress: wallet,
    score,
    avgPosition: entry.avgPos.toFixed(1) + "%",
    winRate: ((entry.wins / entry.total) * 100).toFixed(0) + "%",
    volume24h: entry.volume.toFixed(1) + " SOL"
  };

  if (existing) Object.assign(existing, alphaData);
  else alphas.push(alphaData);

  alphas = alphas.sort((a,b) => b.score - a.score).slice(0,10);
  db.set('goldenAlphas', alphas).write();
  console.log(`GOLDEN ALPHA → ${wallet.slice(0,8)}... Score: ${score}`);
}

// ——— GET WEBHOOK FROM HELIUS (FETCH CURRENT WALLETS) ———
async function getHeliusWebhook() {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  const WEBHOOK_ID = process.env.WEBHOOK_ID;

  if (!HELIUS_API_KEY || !WEBHOOK_ID) {
    console.log("getHeliusWebhook skipped — missing config");
    return [];
  }

  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`
    );
    const currentWallets = response.data.accountAddresses || [];
    console.log(`Helius webhook fetched — ${currentWallets.length} wallets`);
    return currentWallets;
  } catch (error) {
    console.error("getHeliusWebhook failed:", error.response?.data || error.message);
    return [];
  }
}

// ——— HELIUS SYNC — GET FIRST, THEN PUT UPDATE ———
async function syncHeliusWebhook() {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  const WEBHOOK_ID = process.env.WEBHOOK_ID;
  const watched = db.get('watched').value();

  if (!HELIUS_API_KEY || !WEBHOOK_ID) {
    console.log("Helius sync skipped — missing config");
    return;
  }

  try {
    // PUT UPDATE WITH FULL CONFIG
    await axios.put(
      `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
      {
        webhookURL: "https://sol-followbackend-production.up.railway.app/webhook",
        accountAddresses: watched,
        transactionTypes: ["SWAP"],
        webhookType: "enhanced"
      }
    );
    console.log(`HELIUS SYNCED — ${watched.length} alphas live`);
    sendTelegram(`HELIUS SYNCED — ${watched.length} alphas monitored`);
  } catch (error) {
    console.error("Helius sync failed:", error.response?.data || error.message);
  }
}

// ——— STARTUP SYNC — GET FROM HELIUS IF DB EMPTY ———
async function syncHeliusOnStartup() {
  const watched = db.get('watched').value();
  if (watched.length === 0) {
    console.log("DB empty — fetching from Helius...");
    const currentWallets = await getHeliusWebhook();
    if (currentWallets.length > 0) {
      currentWallets.forEach(wallet => {
        db.get('watched').push(wallet).write();
      });
      console.log(`Startup sync — loaded ${currentWallets.length} wallets from Helius`);
      sendTelegram(`STARTUP SYNC — Loaded ${currentWallets.length} alphas from Helius`);
    }
  } else {
    console.log("DB has wallets — syncing updates...");
  }
  await syncHeliusWebhook(); // Always sync updates
}

// ——— EXTRACT ALPHAS FROM CA ———
async function extractAlphasFromCA(ca) {
  if (!ca || ca.length < 32 || db.get('pastMoonshots').value().includes(ca)) return;

  const now = Date.now();
  if (now - (db.get('lastHeavyExtraction').value() || 0) < 300000) {
    console.log("COOLDOWN — 5 min");
    return;
  }
  db.set('lastHeavyExtraction', now).write();

  console.log(`EXTRACTING → ${ca.slice(0,8)}...`);
  sendTelegram(`EXTRACTION STARTED\n<code>${ca}</code>`);

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const buyers = new Set();

  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(ca), { limit: 100 });
    for (const sig of sigs.slice(0, 100)) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta?.err) continue;
        const allIxs = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
        ];
        allIxs.forEach(ix => {
          if (ix.parsed?.type === "transfer" &&
              ix.parsed.info.source === "So11111111111111111111111111111111111111112") {
            const buyer = ix.parsed.info.destination;
            if (buyer) buyers.add(buyer);
          }
        });
      } catch (e) {}
      await delay(1000);
    }

    const topBuyers = Array.from(buyers).slice(0, 10);
    topBuyers.forEach((wallet, i) => updateGoldenAlpha(wallet, i + 1));
    db.get('pastMoonshots').push(ca).write();
    sendTelegram(`EXTRACTION COMPLETE\n${topBuyers.length} alphas added`);
  } catch (e) {
    console.error("Extraction failed:", e.message);
  }
}

module.exports = {
  updateGoldenAlpha,
  syncHeliusWebhook,
  extractAlphasFromCA,
  syncHeliusOnStartup
};
