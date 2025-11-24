// backend/server.js — SOLFOLLOW v10 — PAST MOONSHOT ALPHA EXTRACTOR (FULL & FINAL)
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('data.json');
const db = low(adapter);

const app = express();
app.use(express.json());
const server = http.createServer(app);

// SOCKET.IO — RAILWAY PROOF
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: false },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// RPC
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
console.log("RPC Connected →", RPC_URL);

// TELEGRAM
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

// DATABASE
db.defaults({
  settings: { baseBuyAmount: 0.5, currentBuyAmount: 0.5, slippage: 15, maxBuyAmount: 5 },
  watched: [],
  positions: {},
  trades: [],
  pendingBuys: {},
  totalProfit: 0,
  goldenAlphas: [],
  pastMoonshots: [],
  alphaStats: {}
}).write();

// PREVENT CRASHES
process.on('uncaughtException', err => console.error('UNCAUGHT →', err));
process.on('unhandledRejection', err => console.error('REJECTION →', err));

// WALLET
let botKeypair;
try {
  const raw = process.env.BOT_PRIVATE_KEY.trim();
  const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  botKeypair = Keypair.fromSecretKey(secret);
  console.log("\nWallet loaded:", botKeypair.publicKey.toBase58());
} catch (e) {
  console.error("Invalid BOT_PRIVATE_KEY");
  process.exit(1);
}

// JUPITER QUOTE & SWAP
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

// JITO BUNDLE
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

// CONSENSUS BUY
async function executeBuy(tokenMint, alphaWallet) {
  let pending = db.get(`pendingBuys.${tokenMint}`).value() || { count: 0, alphas: [], lastSeen: Date.now()};
  if (!pending.alphas.includes(alphaWallet)) {
    pending.alphas.push(alphaWallet);
    pending.count = pending.alphas.length;
    pending.lastSeen = Date.now();
    db.set(`pendingBuys.${tokenMint}`, pending).write();
  }

  if (Date.now() - pending.lastSeen > 90000) {
    db.unset(`pendingBuys.${tokenMint}`).write();
    return;
  }

  const alphaCount = pending.count;
  const multiplier = [0,100,300,600,1000,1500,2100,2800,3600,4500,5500][alphaCount] || 5500;
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

      io.emit('newTrade', { token: tokenMint.slice(0,8), type: "BUY", amount: currentBuy, alphas: alphaCount, multiplier });
      sendTelegram(`<b>BUY FIRED</b>\nToken: <code>${tokenMint}</code>\nAlphas: ${alphaCount} → ${multiplier}% TP\nSize: ${currentBuy} SOL`);

      db.unset(`pendingBuys.${tokenMint}`).write();
    } catch (e) {
      console.error("BUY FAILED:", e.message);
    }
  }
}

// AUTO-SELL + COMPOUNDING
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

        io.emit('sold', { token: mint.slice(0,8), profit: profitPct.toFixed(1), newBuyAmount: newBuyAmount.toFixed(3) });
        sendTelegram(`<b>SOLD — TARGET HIT</b>\nToken: <code>${mint.slice(0,8)}</code>\nProfit: +${profitPct.toFixed(1)}% (${profitSOL.toFixed(3)} SOL)`);
      }
    } catch (e) {}
  }
}, 8000);

// EXTRACT ALPHAS FROM PAST MOONSHOT
async function extractAlphasFromCA(ca) {
  if (db.get('pastMoonshots').value().includes(ca)) return;
  console.log(`Extracting alphas from: ${ca.slice(0,8)}...`);
  sendTelegram(`<b>MOONSHOT ADDED</b>\n<code>${ca}</code>\nExtracting early buyers...`);

  try {
    const signatures = await connection.getSignaturesForAddress(new PublicKey(ca), { limit: 100 });
    const buyers = {};

    for (const sig of signatures) {
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) continue;

      const transfer = tx.transaction.message.instructions.find(i =>
        i.parsed?.type === "transfer" &&
        i.parsed?.info?.destination &&
        i.parsed?.info?.source === "So11111111111111111111111111111111111111112"
      );

      if (transfer) {
        const wallet = transfer.parsed.info.destination;
        if (!buyers[wallet]) {
          const position = Object.keys(buyers).length + 1;
          buyers[wallet] = { position, volume: parseFloat(transfer.parsed.info.lamports) / LAMPORTS_PER_SOL };
        }
      }
    }

    Object.entries(buyers).slice(0, 10).forEach(([wallet, data]) => {
      const stats = db.get(`alphaStats.${wallet}`).value() || { wins: 0, total: 0, avgPos: 0, volume: 0 };
      stats.total++;
      stats.avgPos = ((stats.avgPos * (stats.total - 1)) + data.position) / stats.total;
      stats.volume += data.volume;
      if (data.position <= 5) stats.wins++;
      db.set(`alphaStats.${wallet}`, stats).write();

      const score = Math.min(10, ((10 - stats.avgPos) * 1.5 + (stats.wins / stats.total) * 100 * 0.8 + Math.min(stats.volume / 30, 10) * 0.5).toFixed(1));

      let alphas = db.get('goldenAlphas').value() || [];
      const existing = alphas.find(a => a.fullAddress === wallet);
      const alphaData = {
        address: wallet.slice(0,8) + "..." + wallet.slice(-4),
        fullAddress: wallet,
        score,
        avgPosition: stats.avgPos.toFixed(1) + "%",
        winRate: ((stats.wins / stats.total) * 100).toFixed(0) + "%",
        volume24h: stats.volume.toFixed(1) + " SOL"
      };

      if (existing) Object.assign(existing, alphaData);
      else alphas.push(alphaData);

      alphas = alphas.sort((a,b) => b.score - a.score).slice(0,10);
      db.set('goldenAlphas', alphas).write();
      io.emit('goldenAlphasUpdate', alphas);
    });

    db.get('pastMoonshots').push(ca).write();
    sendTelegram(`EXTRACTION COMPLETE\nTop 10 early buyers added to Golden Alphas`);
  } catch (e) {
    console.error("CA extraction failed:", e.message);
  }
}

// SOCKET
io.on('connection', (socket) => {
  console.log("DASHBOARD CONNECTED");
  socket.emit('init', {
    trades: db.get('trades').take(50).value() || [],
    settings: db.get('settings').value() || {},
    positions: Object.values(db.get('positions').value() || {}),
    goldenAlphas: db.get('goldenAlphas').value() || [],
    totalProfit: db.get('totalProfit').value() || 0
  });

  socket.on('addMoonshotCA', (ca) => {
    extractAlphasFromCA(ca);
  });
});

// WEBHOOK (for future Helius)
app.post('/webhook', (req, res) => {
  req.body.forEach(tx => {
    if (tx.type === "SWAP" && tx.tokenTransfers?.[0]?.mint && db.get('watched').value().includes(tx.feePayer)) {
      executeBuy(tx.tokenTransfers[0].mint, tx.feePayer);
    }
  });
  res.sendStatus(200);
});

// HEALTH
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('SolFollow v10 — PAST MOONSHOT ALPHA EXTRACTOR'));

// START
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSOLFOLLOW v10 — LIVE ON PORT ${PORT}`);
  console.log("Add a past moonshot CA → extracts real alphas → prints forever\n");
});
