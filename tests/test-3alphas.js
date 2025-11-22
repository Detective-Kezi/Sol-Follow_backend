// test-3-alphas.js — TRIGGERS 3 ALPHAS FAST
const fetch = require('node-fetch');
const BACKEND_URL = "http://localhost:3001/webhook";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const alphas = [
  "8F3sQ9x123456789abcdef123456789abcdef12",
  "Cm7pL2m987654321zyxwvutsrqponmlkjihgfedcba",
  "D1vA7z8k5m6n7b8v9c0x1y2z3a4s5d6f7g8h9j0kl"
];

async function fire() {
  for (let i = 0; i < alphas.length; i++) {
    const payload = [{
      type: "SWAP",
      feePayer: alphas[i],
      tokenTransfers: [{ mint: TOKEN_MINT }]
    }];

    await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    console.log(`Alpha ${i+1}/3 fired — ${alphas[i]}`);
    await new Promise(r => setTimeout(r, 800)); // small delay
  }
  console.log("\n3 ALPHAS FIRED — YOU SHOULD SEE 600%+ MULTIPLIER!");
}

fire();