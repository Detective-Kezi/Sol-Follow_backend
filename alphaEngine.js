// Simple Golden Alpha scoring
function calculateScore(walletData) {
  const earlyScore = (10 - walletData.avgBuyPosition) * 10; // lower position = higher score
  const winScore = walletData.winRate * 100;
  const jitoScore = walletData.jitoRate * 100;
  const volumeScore = Math.min(walletData.volume24h / 10, 100);

  return ((earlyScore * 0.4) + (winScore * 0.3) + (jitoScore * 0.2) + (volumeScore * 0.1)).toFixed(1);
}

module.exports = { calculateScore };