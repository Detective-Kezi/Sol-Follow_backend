// backend/config.js — FINAL WITH initWallet()
require('dotenv').config();
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');

let botKeypair;
let connection;

// ——— INIT WALLET + RPC ———
function initWallet() {
  try {
    const raw = process.env.BOT_PRIVATE_KEY.trim();
    const secret = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
    botKeypair = Keypair.fromSecretKey(secret);
    console.log("\nWallet loaded:", botKeypair.publicKey.toBase58());
  } catch (e) {
    console.error("Invalid BOT_PRIVATE_KEY →", e.message);
    process.exit(1);
  }

  const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  connection = new Connection(RPC_URL, "confirmed");
  console.log("RPC Connected →", RPC_URL);
}

// ——— TELEGRAM ———
async function sendTelegram(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — skipping");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: Number(process.env.TELEGRAM_CHAT_ID),
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }, { timeout: 8000 });
    console.log("Telegram sent");
  } catch (e) {
    console.error("Telegram failed:", e.response?.data?.description || e.message);
  }
}

module.exports = {
  initWallet,
  get botKeypair() { return botKeypair; },     // ← getter
  get connection() { return connection; },     // ← getter — always fresh
  sendTelegram,
  LAMPORTS_PER_SOL
};
