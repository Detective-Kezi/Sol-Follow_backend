// backend/trading.js — THE MONEY ENGINE (BUY, SELL, JITO, JUPITER, BALANCE)
const axios = require('axios');
const { LAMPORTS_PER_SOL, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const db = require('./db');
const { botKeypair, connection, sendTelegram } = require('./config');

const MULTIPLIER_TABLE = {1:100,2:300,3:600,4:1000,5:1500,6:2100,7:2800,8:3600,9:4500,10:5500};

// ——— BALANCE CHECK + 0.003 SOL RESERVE ———
async function hasEnoughBalance(amountSOL) {
  try {
    const balance = await connection.getBalance(botKeypair.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    const required = amountSOL + 0.003; // gas reserve
    console.log(`Balance: ${balanceSOL.toFixed(4)} SOL | Need: ${required.toFixed(4)} SOL`);
    return balanceSOL >= required;
  } catch (e) {
    console.error("Balance check failed:", e.message);
    return false;
  }
}

// ——— JUPITER QUOTE ———
async function getQuote(input, output, amount, slippage = 15) {
  const params = new URLSearchParams({
    inputMint: input,
    outputMint: output,
    amount: amount.toString(),
    slippageBps: (slippage * 100).toString(),
  });
  const urls = ["https://lite-api.jup.ag/swap/v1/quote", "https://api.jup.ag/swap/v1/quote"];
  for (const url of urls) {
    try {
      const res = await axios.get(url + "?" + params, { timeout: 10000 });
      return res.data;
    } catch (e) {}
  }
  throw new Error("Jupiter quote failed");
}

// ——— JUPITER SWAP TX ———
async function getSwapTx(quote) {
  const urls = ["https://lite-api.jup.ag/swap/v1/swap", "https://api.jup.ag/swap/v1/swap"];
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
    } catch (e) {}
  }
  throw new Error("Jupiter swap failed");
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
      jsonrpc: "2.0", id: 1, method: "sendBundle", params: [serialized]
    }, { timeout: 20000 });
    console.log("JITO BUNDLE →", response.data.result || response.data.error);
    return response.data.result;
  } catch (e) {
    console.error("JITO FAILED →", e.response?.data || e.message);
    return null;
  }
}

// ——— CONSENSUS BUY — FINAL ———
async function executeBuy(tokenMint, alphaWallet) {
  // IGNORE SOL → SOL
  if (tokenMint === "So11111111111111111111111111111111111111112") return;

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
  if (alphaCount < 2) return;

  const currentBuy = db.get('settings.currentBuyAmount').value() || 0.5;

  if (!(await hasEnoughBalance(currentBuy))) {
    console.log("BUY SKIPPED — LOW BALANCE");
    sendTelegram(`BUY SKIPPED — LOW BALANCE\nNeed ${(currentBuy + 0.003).toFixed(4} SOL`);
    return;
  }

  console.log(`CONSENSUS BUY → ${alphaCount} ALPHAS → ${currentBuy} SOL`);
  try {
    const quote = await getQuote("So11111111111111111111111111111111111111112", tokenMint, BigInt(Math.floor(currentBuy * LAMPORTS_PER_SOL)));
    const swapData = await getSwapTx(quote);
    const swapTx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
    swapTx.sign([botKeypair]);
    await sendJitoBundle([swapTx]);

    db.set(`positions.${tokenMint}`, {
      amount: Number(quote.outAmount) / 1e9,
      avgBuyPrice: Number(quote.outAmount) / Number(quote.inAmount),
      alphaCount,
      targetMultiplier: MULTIPLIER_TABLE[alphaCount] || 5500
    }).write();

    db.get('trades').unshift({
      token: tokenMint.slice(0,8),
      type: "BUY",
      amount: currentBuy,
      alphas: alphaCount,
      multiplier: MULTIPLIER_TABLE[alphaCount] || 5500,
      time: new Date().toISOString()
    }).write();

    sendTelegram(`BUY FIRED\nToken: <code>${tokenMint}</code>\nAlphas: ${alphaCount}\nSize: ${currentBuy} SOL`);
    db.unset(`pendingBuys.${tokenMint}`).write();
  } catch (e) {
    console.error("BUY FAILED:", e.message);
  }
}

// ——— AUTO-SELL LOOP ———
function startAutoSell() {
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
          const newBuyAmount = Math.min(db.get('settings.currentBuyAmount').value() + (profitSOL * 0.profile0.5), 5);
          db.set('settings.currentBuyAmount', parseFloat(newBuyAmount.toFixed(3)))
            .set('totalProfit', (db.get('totalProfit').value() || 0) + profitSOL)
            .unset(`positions.${mint}`)
            .write();
          sendTelegram(`SOLD — TARGET HIT\nToken: ${mint.slice(0,8)}\nProfit: +${profitPct.toFixed(1)}% (${profitSOL.toFixed(3)} SOL)`);
        }
      } catch (e) {}
    }
  }, 8000);
}

module.exports = {
  executeBuy,
  startAutoSell,
  getQuote,
  getSwapTx,
  sendJitoBundle,
  hasEnoughBalance
};
