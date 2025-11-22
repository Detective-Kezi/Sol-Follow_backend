// test-buy.js — PERFECT FAKE BUY FOR TESTING (RUN THIS ANYTIME)
const fetch = require('node-fetch');

// CONFIG — CHANGE THESE
const BACKEND_URL = "http://localhost:3001/webhook";  // your server
const ALPHA_WALLET = "8F3sQ9x123456789abcdef123456789abcdef12"; // any fake alpha
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // any real or fake mint

// Fake Helius webhook payload (exactly what Helius sends)
const fakePayload = [
  {
    type: "SWAP",
    feePayer: ALPHA_WALLET,
    tokenTransfers: [
      {
        mint: TOKEN_MINT,
        tokenAmount: 1000000
      }
    ],
    signature: "fake_sig_" + Date.now(),
    slot: 999999999,
    timestamp: Math.floor(Date.now() / 1000)
  }
];

console.log("Sending FAKE alpha buy to your bot...");
console.log("Alpha wallet:", ALPHA_WALLET);
console.log("Token mint:   ", TOKEN_MINT);
console.log("Backend URL:  ", BACKEND_URL);
console.log("---");

fetch(BACKEND_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(fakePayload)
})
.then(res => res.text())
.then(text => {
  console.log("Backend response:", text || "200 OK");
  console.log("\nFAKE BUY SENT — CHECK YOUR DASHBOARD & CONSOLE!");
  console.log("→ You should see: CONSENSUS BUY — 1 ALPHAS → 100% TP");
  console.log("→ New trade appears on Dashboard");
})
.catch(err => {
  console.error("Failed to send:", err.message);
});