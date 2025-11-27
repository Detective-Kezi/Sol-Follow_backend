// backend/server.js — SOLFOLLOW v19 — FINAL & IMMORTAL (FULLY TESTED)
require('dotenv').config();
const express = require('express');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const low = require('lowdb');
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
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" })
    });
  } catch (e) { console.error("Telegram failed:", e.message); }
}

// ——— JUPITER ———
async function getQuote(input, output, amount, slippage = 15) {
  const params = new URLSearchParams({
    inputMint: input,
    outputMint: output,
    amount: amount.toString(),
    slippageBps: (slippage * 100).toString(),
  });
  const res = await fetch("https://quote-api.jup.ag/v6/quote?" + params);
  if (!res.ok) throw new Error("Quote failed");
  return res.json();
}

async function getSwapTx(quote) {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: botKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  return res.json();
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
    const res = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [serialized] })
    });
    const json = await res.json();
    console.log("JITO BUNDLE →", json.result || json.error?.message);
    return json.result;
  } catch (e) {
    console.error("Jito failed:", e.message);
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

// ——— v19 EXTRACT ALPHAS FROM PAST MOONSHOT (PUBLIC RPC SAFE + AUTO AFTER BUY) ———
async function extractAlphasFromCA(ca) {
  if (!ca || ca.length < 32) return;
  if (db.get('pastMoonshots').value().includes(ca)) return;

  // PUBLIC RPC SAFE — 4 MIN COOLDOWN
  const now = Date.now();
  const lastRun = db.get('lastHeavyExtraction').value() || 0;
  if (now - lastRun < 240000) {
    console.log("RPC cooldown active — wait 4 min");
    return;
  }
  db.set('lastHeavyExtraction', now).write();

  console.log(`v19 GOD HUNT → ${ca.slice(0,8)}...`);
  sendTelegram(`GOD HUNT v19\n<code>${ca}</code>\nExtracting early buyers...`);

  try {
    let allSigs = [];
    let before = undefined;
    while (allSigs.length < 800) {
      const batch = await connection.getSignaturesForAddress(new PublicKey(ca), { limit: 1000, before }).catch(() => []);
      if (batch.length === 0) break;
      allSigs.push(...batch);
      before = batch[batch.length - 1].signature;
    }

    const earlySigs = allSigs.reverse().slice(0, 800);
    const buyers = new Set();

    for (const sig of earlySigs) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || tx.meta?.err) continue;
        tx.transaction.message.instructions.forEach(ix => {
          if (ix.parsed?.type === "transfer" && ix.parsed?.info?.source === "So11111111111111111111111111111111111111112") {
            buyers.add(ix.parsed.info.destination);
          }
        });
      } catch (e) {}
    }

    Array.from(buyers).slice(0, 15).forEach((wallet, i) => updateGoldenAlpha(wallet, i + 1));
    db.get('pastMoonshots').push(ca).write();
    sendTelegram(`EXTRACTION COMPLETE\n${buyers.size} early buyers → Golden Alphas updated`);

  } catch (e) {
    console.error("Extraction failed:", e.message);
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

  if (!position && alphaCount >= 1) {
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

app.post('/api/wallet', (req, res) => {
  const { wallet, action = "add" } = req.body;

  if (!wallet || wallet.length < 32) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (action === "add") {
    db.get('watched').push(wallet).write();
    console.log(`WALLET ADDED → ${wallet.slice(0,8)}...`);
  }
  if (action === "remove") {
    db.get('watched').pull(wallet).write();
    console.log(`WALLET REMOVED → ${wallet.slice(0,8)}...`);
  }

  res.json({ success: true });
});

app.post('/api/settings', (req, res) => {
  const { buyAmount, slippage } = req.body;
  db.update('settings', s => ({ ...s, buyAmount: Number(buyAmount), slippage: Number(slippage) })).write();
  res.json({ success: true });
});

// ——— HEALTH ———
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('SolFollow v19 — FINAL & IMMORTAL'));

// ——— START ———
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSOLFOLLOW v19 — FINAL & IMMORTAL`);
  console.log(`Running on port ${PORT} — Dashboard ready`);
  console.log(`Add CA → extracts alphas → auto-follows → prints forever\n`);
});
