import { randomUUID } from 'crypto';
import { pool } from './db.js';

const paytable = [
  { symbol: 'A', payoutX: 2 },
  { symbol: 'B', payoutX: 5 },
  { symbol: 'C', payoutX: 10 },
  { symbol: 'D', payoutX: 20 }
];
const baseWeights = { A: 50, B: 30, C: 15, D: 5 };

function weightedPick(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [sym, w] of Object.entries(weights)) {
    if (roll < w) return sym;
    roll -= w;
  }
  return 'A';
}

function adjustWeights(rtpCurrent, rtpTarget) {
  const gap = rtpTarget - rtpCurrent;
  const factor = Math.max(-0.5, Math.min(0.5, gap * 0.02));
  const w = { ...baseWeights };
  if (factor > 0) { w.A *= (1+factor); w.B *= (1+factor*0.6); }
  else { w.A *= (1+factor); w.B *= (1+factor*0.8); }
  return w;
}

function rollReels(weights) {
  return [weightedPick(weights), weightedPick(weights), weightedPick(weights)];
}

function computeWin(amount, reels) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    const entry = paytable.find(p => p.symbol === reels[0]);
    return amount * entry.payoutX;
  }
  return 0;
}

export async function playRound({ gameId, userId, amount }) {
  const g = await pool.query('SELECT rtp_target FROM games WHERE id=$1', [gameId]);
  const s = await pool.query('SELECT total_bet,total_payout FROM game_stats WHERE game_id=$1', [gameId]);
  const rtpTarget = g.rows[0]?.rtp_target || 95;
  const rtpCurrent = s.rows[0]?.total_bet ? (s.rows[0].total_payout/s.rows[0].total_bet)*100 : 0;

  const weights = adjustWeights(rtpCurrent, rtpTarget);
  const reels = rollReels(weights);
  const win = computeWin(amount, reels);

  await pool.query(`
    INSERT INTO game_stats (game_id,total_bet,total_payout,updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (game_id) DO UPDATE SET
      total_bet=game_stats.total_bet+$2,
      total_payout=game_stats.total_payout+$3,
      updated_at=NOW()
  `,[gameId,amount,win]);

  const betId = randomUUID();
  await pool.query(
    `INSERT INTO bets (id,game_id,user_id,amount,outcome,win_amount)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [betId,gameId,userId,amount,JSON.stringify({reels}),win]
  );

  return { betId, reels, win };
}
