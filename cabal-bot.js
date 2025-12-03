// cabal-bot.js — CABAL GHOST PROTOCOL v1
require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const connection = new Connection("https://api.mainnet-beta.solana.com");
const CABAL_GROUPS = process.env.CABAL_GROUPS.split(','); // e.g. -1001234567890,-1009876543210
const ADMIN_CANDIDATES = new Map(); // wallet → count of early buys

// Detect Solana CA (44 chars base58)
const CA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

// When a message contains a CA
bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  const match = text.match(CA_REGEX);
  if (!match || !CABAL_GROUPS.includes(ctx.chat.id.toString())) return;

  const ca = match[0];
  console.log(`CABAL CALL DETECTED → ${ca.slice(0,8)}...`);

  const earlyBuyers = await getEarlyBuyers(ca);
  if (earlyBuyers.length === 0) return;

  // Count how many times each wallet appears in early window
  earlyBuyers.forEach(wallet => {
    ADMIN_CANDIDATES.set(wallet, (ADMIN_CANDIDATES.get(wallet) || 0) + 1);
  });

  // Crown GHOSTS after 5+ appearances
  const goldenGhosts = [...ADMIN_CANDIDATES.entries()]
    .filter(([_, count]) => count >= 5)
    .map(([wallet]) => wallet);

  if (goldenGhosts.length > 0) {
    const msg = `GOLDEN CABAL GHOSTS CROWNED\n${goldenGhosts.map(w => w.slice(0,8)+"...").join("\n")}`;
    console.log(msg);
    await axios.post("https://sol-followbackend-production.up.railway.app/api/auto-add-ghosts", { ghosts: goldenGhosts });
  }

  console.log(`Early buyers: ${earlyBuyers.length} | Total tracked: ${ADMIN_CANDIDATES.size}`);
});

// Get wallets that bought within 5 minutes BEFORE the message
async function getEarlyBuyers(ca) {
  const buyers = new Set();
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(ca), { limit: 500 });
    const now = Date.now() / 1000;
    const fiveMinsAgo = now - 300;

    for (const sig of sigs) {
      if (!sig.blockTime || sig.blockTime < fiveMinsAgo) break; // too old

      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) continue;

      const instructions = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
      ];

      for (const ix of instructions) {
        if (ix.parsed?.type === "transfer" &&
            ix.parsed.info.source === "So11111111111111111111111111111111111111112") {
          const buyer = ix.parsed.info.destination;
          const amount = ix.parsed.info.lamports / LAMPORTS_PER_SOL;
          if (amount >= 0.5) buyers.add(buyer); // real alpha size
        }
      }
    }
  } catch (e) { console.error("Early scan failed:", e.message); }
  return [...buyers];
}

bot.launch();
console.log("CABAL GHOST PROTOCOL v1 LIVE — HUNTING GHOSTS");
