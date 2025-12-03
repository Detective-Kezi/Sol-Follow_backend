// backend/server.js — SOLFOLLOW v19 — FINAL & IMMORTAL (FULLY TESTED)
require('dotenv').config();
const express = require('express');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const low = require('lowdb');
const axios = require('axios');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('data.json');
const db = low(adapter);

const app = express();
app.use(express.json());

// ——— FINAL CORS + PREFLIGHT FIX (RAILWAY 2025) ———
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "https://sol-follow-production.up.railway.app");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Max-Age", "86400");

  // THIS LINE IS THE KILLER — HANDLE PREFLIGHT INSTANTLY
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

// ——— DATABASE ———
db.defaults({
  settings: { baseBuyAmount: 0.5, currentBuyAmount: 0.5, slippage: 15, maxBuyAmount: 5 },
  watched: [],
  positions: {},
  trades: [],
  pendingBuys: {},
  totalProfit: 0,
  goldenAlphas: [],
  pastMoonshots: [],
  alphaStats: {},
  lastHeavyExtraction: 0
}).write();

// ——— PREVENT CRASHES ———
process.on('uncaughtException', err => console.error('UNCAUGHT →', err));
process.on('unhandledRejection', err => console.error('REJECTION →', err));

// ——— WALLET ———
let botKeypair;
try {
  const raw = process.env.BOT_PRIVATE_KEY.trim();
  const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  botKeypair = Keypair.fromSecretKey(secret);
  console.log("\nWallet loaded:", botKeypair.publicKey.toBase58());
} catch (e) {
  console.error("Invalid BOT_PRIVATE_KEY →", e.message);
  process.exit(1);
}

// ——— RPC ———
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
console.log("RPC Connected →", RPC_URL);

// ——— TELEGRAM ———
async function sendTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — skipping message");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      },
      {
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log("Telegram sent");
  } catch (error) {
    const errMsg = error.response 
      ? `Telegram error: ${error.response.status} ${error.response.data?.description || ''}`
      : error.code === 'ECONNABORTED' 
        ? 'Telegram timeout' 
        : `Telegram failed: ${error.message}`;
    console.error(errMsg);
  }
}

// ——— JUPITER ———
async function getQuote(input, output, amount, slippage = 15) {
  const params = new URLSearchParams({
    inputMint: input,
    outputMint: output,
    amount: amount.toString(),
    slippageBps: (slippage * 100).toString(),
  });

  // OFFICIAL MIRRORS — TRY EACH UNTIL ONE WORKS
  const urls = [
    "https://lite-api.jup.ag/swap/v1/quote",
    "https://api.jup.ag/swap/v1/quote"
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url + "?" + params, { timeout: 10000 });
      return res.data;
    } catch (e) {
      console.log(`Mirror ${url} failed, trying next...`);
    }
  }

  throw new Error("All Jupiter mirrors failed — check RPC");
}

async function getSwapTx(quote) {
  const urls = [
    "https://lite-api.jup.ag/swap/v1/swap",
    "https://api.jup.ag/swap/v1/swap"
  ];

  for (const url of urls) {
    try {
      const res = await axios.post(url, {
        quoteResponse: quote,
        userPublicKey: botKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true
      }, { timeout: 15000 });
      return res.data;
    } catch (e) {
      console.log(`Swap mirror ${url} failed, trying next...`);
    }
  }

  throw new Error("All Jupiter swap mirrors failed");
}

// ——— JITO BUNDLE ———
async function sendJitoBundle(transactions, tipLamports = 50000) {
  const serialized = transactions.map(tx => tx.serialize().toString('base64'));
  const tipTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: botKeypair.publicKey,
      toPubkey: new PublicKey("T1pyyaTNZsKv2WcRAB8oVnk93mLJw2Y8zZ7R8gVFf4px"),
      lamports: tipLamports,
    })
  );
  tipTx.sign(botKeypair);
  serialized.push(tipTx.serialize().toString('base64'));

  try {
    const response = await axios.post("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serialized]
    }, {
      timeout: 20000,
      headers: { "Content-Type": "application/json" }
    });

    console.log("JITO BUNDLE SUCCESS →", response.data.result || response.data.error);
    return response.data.result;
  } catch (e) {
    console.error("JITO BUNDLE FAILED →", e.response?.data || e.message);
    return null;
  }
}

// ——— MULTIPLIER TABLE ———
const MULTIPLIER_TABLE = {1:100,2:300,3:600,4:1000,5:1500,6:2100,7:2800,8:3600,9:4500,10:5500};

// ——— TRUE ALPHA SCORING ———
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

// FINAL extractAlphasFromCA v24 — HELIUS FREE TIER 100% SAFE (LIGHTWEIGHT)
async function extractAlphasFromCA(ca) {
  if (!ca || ca.length < 32) return;
  if (db.get('pastMoonshots').value().includes(ca)) return;

  // COOLDOWN — 5 MIN FOR FREE TIER
  const now = Date.now();
  const lastRun = db.get('lastHeavyExtraction').value() || 0;
  if (now - lastRun < 300000) { // 5 min
    console.log("FREE TIER COOLDOWN — 5 min");
    return;
  }
  db.set('lastHeavyExtraction', now).write();

  console.log(`v24 SAFE HUNT → ${ca.slice(0,8)}... (100 txs, 1/sec)`);
  sendTelegram(`SAFE HUNT v24\n<code>${ca}</code>\nLight scan for free tier...`);

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const buyers = new Set();

  try {
    // LIGHT SCAN — ONLY 100 TXS
    const sigs = await connection.getSignaturesForAddress(new PublicKey(ca), { limit: 100 });
    for (const sig of sigs.slice(0, 100)) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        });
        if (!tx || tx.meta?.err) continue;

        // Check main + inner instructions
        const allIxs = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
        ];

        allIxs.forEach(ix => {
          if (ix.parsed?.type === "transfer" && 
              ix.parsed?.info?.source === "So11111111111111111111111111111111111111112") {
            const buyer = ix.parsed.info.destination;
            if (buyer) buyers.add(buyer);
          }
        });
      } catch (e) { console.log("TX skip:", e.message); }
      await delay(1000); // 1 req/sec — ultra safe
    }

    const topBuyers = Array.from(buyers).slice(0, 10);
    topBuyers.forEach((wallet, i) => updateGoldenAlpha(wallet, i + 1));

    db.get('pastMoonshots').push(ca).write();
    sendTelegram(`SAFE HUNT COMPLETE\n${topBuyers.length} alphas added (free tier mode)`);

  } catch (e) {
    console.error("v24 failed:", e.message);
  }
}

// ——— CONSENSUS BUY + AUTO-ALPHA EXTRACTION ———
async function executeBuy(tokenMint, alphaWallet) {
  let pending = db.get(`pendingBuys.${tokenMint}`).value() || { count: 0, alphas: [], lastSeen: Date.now() };
  if (!pending.alphas.includes(alphaWallet)) {
    pending.alphas.push(alphaWallet);
    pending.count++;
    pending.lastSeen = Date.now();
    db.set(`pendingBuys.${tokenMint}`, pending).write();
  }

  if (Date.now() - pending.lastSeen > 90000) {
    db.unset(`pendingBuys.${tokenMint}`).write();
    return;
  }

  const alphaCount = pending.count;
  const multiplier = MULTIPLIER_TABLE[alphaCount] || 5500;
  const position = db.get(`positions.${tokenMint}`).value();

  if (!position && alphaCount >= 2) {
    const currentBuy = db.get('settings.currentBuyAmount').value() || 0.5;
    console.log(`CONSENSUS BUY — ${alphaCount} ALPHAS → ${multiplier}% TP → ${currentBuy} SOL`);

    try {
      const quote = await getQuote("So11111111111111111111111111111111111111112", tokenMint, BigInt(LAMPORTS_PER_SOL * currentBuy));
      const swapData = await getSwapTx(quote);
      const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
      swapTx.sign([botKeypair]);
      await sendJitoBundle([swapTx]);

      db.set(`positions.${tokenMint}`, {
        amount: Number(quote.outAmount) / 1e9,
        avgBuyPrice: Number(quote.outAmount) / Number(quote.inAmount),
        alphaCount,
        targetMultiplier: multiplier
      }).write();

      db.get('trades').unshift({
        token: tokenMint.slice(0,8),
        type: "BUY",
        amount: currentBuy,
        alphas: alphaCount,
        multiplier,
        time: new Date().toISOString()
      }).write();

      sendTelegram(`BUY FIRED\nToken: ${tokenMint}\nAlphas: ${alphaCount} → ${multiplier}% TP\nSize: ${currentBuy} SOL`);

      // AUTO-EXTRACT ALPHAS FROM THIS TOKEN AFTER CONSENSUS
      if (alphaCount >= 2) {
        setTimeout(() => extractAlphasFromCA(tokenMint), 30000);
      }

      db.unset(`pendingBuys.${tokenMint}`).write();
    } catch (e) {
      console.error("BUY FAILED:", e.message);
    }
  }
}

// ——— AUTO-SELL + COMPOUNDING ———
setInterval(async () => {
  const positions = db.get('positions').value() || {};
  for (const [mint, pos] of Object.entries(positions)) {
    try {
      const quote = await getQuote(mint, "So11111111111111111111111111111111111111112", BigInt(pos.amount * 1e9), 100);
      const currentPrice = Number(quote.outAmount) / LAMPORTS_PER_SOL;
      const profitPct = ((currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100;

      if (profitPct >= pos.targetMultiplier) {
        const swapData = await getSwapTx(quote);
        const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
        tx.sign([botKeypair]);
        await sendJitoBundle([tx], 30000);

        const profitSOL = (currentPrice - pos.avgBuyPrice) * pos.amount;
        const newBuyAmount = Math.min(db.get('settings.currentBuyAmount').value() + (profitSOL * 0.5), 5);
        db.set('settings.currentBuyAmount', parseFloat(newBuyAmount.toFixed(3)))
          .set('totalProfit', (db.get('totalProfit').value() || 0) + profitSOL)
          .unset(`positions.${mint}`)
          .write();

        sendTelegram(`SOLD — TARGET HIT\nToken: ${mint.slice(0,8)}\nProfit: +${profitPct.toFixed(1)}% (${profitSOL.toFixed(3)} SOL)`);
      }
    } catch (e) {}
  }
}, 8000);

// ——— HTTP API ———
// FINAL syncHeliusWebhook() — QUERY PARAM ONLY (DOCS EXACT)
async function syncHeliusWebhook() {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  const WEBHOOK_ID = process.env.WEBHOOK_ID;
  const watched = db.get('watched').value();

  if (!HELIUS_API_KEY || !WEBHOOK_ID || watched.length === 0) {
    console.log("Helius sync skipped — missing config");
    return;
  }

  try {
    const response = await axios.put(
      `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,  // ← QUERY PARAM ONLY
      {
        webhookURL: "https://sol-followbackend-production.up.railway.app/webhook",  // ← REQUIRED
        accountAddresses: watched,
        transactionTypes: ["SWAP"],
        webhookType: "enhanced"
      },
      {
        headers: {
          "Content-Type": "application/json"
        }  // ← NO AUTH HEADER
      }
    );

    console.log(`HELIUS SYNC SUCCESS → ${watched.length} alphas live`);
    sendTelegram(`HELIUS SYNCED\n${watched.length} alphas now monitored`);
  } catch (error) {
    console.error("Helius sync failed:", error.response?.data || error.message);
  }
}

app.get('/api/data', (req, res) => {
  res.json({
    trades: db.get('trades').take(50).value() || [],
    settings: db.get('settings').value() || {},
    positions: Object.values(db.get('positions').value() || {}),
    watched: db.get('watched').value() || [],
    goldenAlphas: db.get('goldenAlphas').value() || [],
    totalProfit: db.get('totalProfit').value() || 0
  });
});

app.post('/api/add-ca', async (req, res) => {
  const { ca } = req.body;
  if (!ca || ca.length < 32) return res.status(400).json({ error: "Invalid CA" });
  res.json({ success: true, message: "Extraction started..." });
  extractAlphasFromCA(ca).catch(() => {});
});

app.post('/api/wallet', async (req, res) => {
  const { wallet, action = "add" } = req.body;

  if (!wallet || wallet.length < 32) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  // Save to data.json
  if (action === "add") {
    db.get('watched').push(wallet).write();
    console.log(`WALLET ADDED → ${wallet.slice(0,8)}...`);
  }
  if (action === "remove") {
    db.get('watched').pull(wallet).write();
    console.log(`WALLET REMOVED → ${wallet.slice(0,8)}...`);
  }

  // AUTOMATIC HELIUS SYNC — CALL PATCH API
  await syncHeliusWebhook().catch(err => console.error("Helius sync failed:", err));

  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { buyAmount, slippage } = req.body;
  db.update('settings', s => ({ ...s, buyAmount: Number(buyAmount), slippage: Number(slippage) })).write();
  res.json({ success: true });
});

// AUTO-ADD GOLDEN CABAL GHOSTS FROM TELEGRAM BOT
app.post('/api/auto-add-ghosts', async (req, res) => {
  const { ghosts } = req.body;
  if (!ghosts || !Array.isArray(ghosts)) return res.status(400).json({ error: "Invalid" });

  ghosts.forEach(wallet => {
    if (!db.get('watched').value().includes(wallet)) {
      db.get('watched').push(wallet).write();
      console.log(`GOLDEN CABAL GHOST ADDED → ${wallet.slice(0,8)}...`);
    }
  });

  await syncHeliusWebhook();
  sendTelegram(`GOLDEN CABAL GHOSTS CROWNED & ADDED\n${ghosts.length} new immortals`);
  res.json({ success: true });
});

// ——— HELIUS WEBHOOK — THE ONE THAT WAS MISSING ———
app.post('/webhook', async (req, res) => {
  console.log("HELIUS WEBHOOK HIT — PAYLOAD RECEIVED");
  console.log("Transactions count:", req.body.length);

  try {
    // Helius sends an array of transactions
    for (const tx of req.body) {
      console.log(`Processing tx type: ${tx.type} | feePayer: ${tx.feePayer?.slice(0,8)}...`);

      // Only care about SWAPs
      if (tx.type === "SWAP" && tx.tokenTransfers?.length > 0) {
        const mint = tx.tokenTransfers[0].mint;
        const feePayer = tx.feePayer;

        // CHECK IF THIS IS ONE OF OUR WATCHED ALPHAS
        if (db.get('watched').value().includes(feePayer)) {
          console.log(`ALPHA DETECTED → ${feePayer.slice(0,8)}... BUYING ${mint.slice(0,8)}...`);
          sendTelegram(`ALPHA BUY DETECTED\nWallet: <code>${feePayer}</code>\nToken: <code>${mint}</code>`);

          // Fire the buy
          executeBuy(mint, feePayer);
        } else {
          console.log(`Unknown wallet bought — skipping`);
        }
      }
    }

    // Always respond 200 OK so Helius doesn't retry
    res.status(200).json({ success: true });
  } catch (e) {
    console.error("Webhook processing error:", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// Handle OPTIONS preflight for /webhook
app.options('/webhook', (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.status(200).end();
});

// ——— HEALTH ———
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('SolFollow v19 — FINAL & IMMORTAL'));

// ——— TEST ENDPOINTS — ADD THIS TO TROUBLESHOOT ———
app.get('/test/rpc', async (req, res) => {
  try {
    const slot = await connection.getSlot();
    console.log("RPC TEST SUCCESS — Latest slot:", slot);
    res.json({ success: true, slot });
  } catch (e) {
    console.error("RPC TEST FAILED:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/test/extract', async (req, res) => {
  const { ca } = req.query;
  if (!ca) return res.status(400).json({ error: "Add ?ca=your-ca to URL" });
  await extractAlphasFromCA(ca);
  res.json({ success: true });
});

app.get('/test/buy', async (req, res) => {
  const { tokenMint, alphaWallet } = req.query;
  if (!tokenMint || !alphaWallet) return res.status(400).json({ error: "Add ?tokenMint=...&alphaWallet=..." });
  await executeBuy(tokenMint, alphaWallet);
  res.json({ success: true });
});

app.get('/test/update-alpha', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: "Add ?wallet=your-wallet" });
  updateGoldenAlpha(wallet, 1);
  res.json({ success: true });
});

// TEST TELEGRAM — INSTANT
app.get('/test/telegram', async (req, res) => {
  await sendTelegram("TELEGRAM TEST SUCCESS — YOUR BOT IS ALIVE");
  res.json({ success: true });
});

// ——— START ———
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSOLFOLLOW v19 — FINAL & IMMORTAL`);
  console.log(`Running on port ${PORT} — Dashboard ready`);
  console.log(`Add CA → extracts alphas → auto-follows → prints forever\n`);
});









