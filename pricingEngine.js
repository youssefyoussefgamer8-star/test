// pricingEngine.js

const MARKET_CONFIG = {
  OUTCOME_1X2: { k: 11.5, min: 10, max: 16 },
  EXACT_SCORE: { k: 18.0, min: 25, max: 113 },
  EXTRAS: {
    btts:                 { k: 14.0, min: 7, max: 28 },
    over_under_1_5:       { k: 14.0, min: 7, max: 28 },
    over_under_2_5:       { k: 14.0, min: 7, max: 28 },
    over_under_3_5:       { k: 14.0, min: 7, max: 32 },
    ht_leader:            { k: 13.5, min: 8, max: 30 },
    goal_both_halves:     { k: 14.5, min: 7, max: 28 },
    clean_sheet:          { k: 14.0, min: 7, max: 28 },
    win_by_2_plus:        { k: 14.5, min: 7, max: 32 },
    odd_even_goals:       { k: 14.5, min: 9, max: 16 },
    highest_scoring_half: { k: 13.5, min: 8, max: 32 }
  }
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function probToPoints(p, { k, min, max }) {
  const safeProb = Math.max(0.0005, Math.min(0.99, Number(p) || 0.5));
  const raw = Math.round(k * -Math.log(safeProb));
  return clamp(raw, min, max);
}

const FACTORIALS = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];
function poissonPmf(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / (FACTORIALS[k] || FACTORIALS[10]);
}

function generatePoissonModel(rawLambdaHome = 1.50, rawLambdaAway = 1.20) {
  const lambdaHome = clamp(Number(rawLambdaHome) || 1.50, 0.15, 5.00);
  const lambdaAway = clamp(Number(rawLambdaAway) || 1.20, 0.15, 5.00);

  const grid = {};
  let totalMass = 0;

  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const p = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      grid[`${h}-${a}`] = p;
      totalMass += p;
    }
  }

  let pHome = 0, pDraw = 0, pAway = 0, pBttsYes = 0, pOver15 = 0, pOver25 = 0, pOver35 = 0, pCleanSheetYes = 0, pWinBy2PlusYes = 0, pOddGoals = 0;

  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const key = `${h}-${a}`;
      grid[key] = grid[key] / totalMass;
      const p = grid[key];
      const totalGoals = h + a;

      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      if (h > 0 && a > 0) pBttsYes += p;
      if (totalGoals > 1.5) pOver15 += p;
      if (totalGoals > 2.5) pOver25 += p;
      if (totalGoals > 3.5) pOver35 += p;
      if (h === 0 || a === 0) pCleanSheetYes += p;
      if (Math.abs(h - a) >= 2) pWinBy2PlusYes += p;
      if (totalGoals % 2 === 1) pOddGoals += p;
    }
  }

  const lambdaH1Home = lambdaHome * 0.44;
  const lambdaH1Away = lambdaAway * 0.44;
  let htHome = 0, htDraw = 0, htAway = 0, htMass = 0;

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const p = poissonPmf(h, lambdaH1Home) * poissonPmf(a, lambdaH1Away);
      htMass += p;
      if (h > a) htHome += p;
      else if (h === a) htDraw += p;
      else htAway += p;
    }
  }
  htHome /= htMass;
  htDraw /= htMass;
  htAway /= htMass;

  const lambdaTotal = lambdaHome + lambdaAway;
  const lambdaH1 = lambdaTotal * 0.44;
  const lambdaH2 = lambdaTotal * 0.56;

  const pGoalH1 = 1 - Math.exp(-lambdaH1);
  const pGoalH2 = 1 - Math.exp(-lambdaH2);
  const pGoalBothHalves = pGoalH1 * pGoalH2;

  let pFirstHalfMore = 0, pSecondHalfMore = 0, pEqualHalves = 0, halfMass = 0;

  for (let g1 = 0; g1 <= 8; g1++) {
    const p1 = poissonPmf(g1, lambdaH1);
    for (let g2 = 0; g2 <= 8; g2++) {
      const p = p1 * poissonPmf(g2, lambdaH2);
      halfMass += p;
      if (g1 > g2) pFirstHalfMore += p;
      else if (g2 > g1) pSecondHalfMore += p;
      else pEqualHalves += p;
    }
  }
  pFirstHalfMore /= halfMass;
  pSecondHalfMore /= halfMass;
  pEqualHalves /= halfMass;

  return {
    outcome1x2: { HOME: pHome, DRAW: pDraw, AWAY: pAway },
    exactGrid: grid,
    extras: {
      btts:                 { YES: pBttsYes, NO: 1 - pBttsYes },
      over_under_1_5:       { OVER: pOver15, UNDER: 1 - pOver15 },
      over_under_2_5:       { OVER: pOver25, UNDER: 1 - pOver25 },
      over_under_3_5:       { OVER: pOver35, UNDER: 1 - pOver35 },
      ht_leader:            { HOME: htHome, DRAW: htDraw, AWAY: htAway },
      goal_both_halves:     { YES: pGoalBothHalves, NO: 1 - pGoalBothHalves },
      clean_sheet:          { YES: pCleanSheetYes, NO: 1 - pCleanSheetYes },
      win_by_2_plus:        { YES: pWinBy2PlusYes, NO: 1 - pWinBy2PlusYes },
      odd_even_goals:       { ODD: pOddGoals, EVEN: 1 - pOddGoals },
      highest_scoring_half: { FIRST: pFirstHalfMore, SECOND: pSecondHalfMore, EQUAL: pEqualHalves }
    }
  };
}

function buildMatchMarketsPoints(lambdaHome = 1.50, lambdaAway = 1.20) {
  const model = generatePoissonModel(lambdaHome, lambdaAway);

  const outcomePoints = {};
  for (const [k, p] of Object.entries(model.outcome1x2)) {
    outcomePoints[k] = probToPoints(p, MARKET_CONFIG.OUTCOME_1X2);
  }

  const exactScorePoints = {};
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const key = `${h}-${a}`;
      exactScorePoints[key] = probToPoints(model.exactGrid[key], MARKET_CONFIG.EXACT_SCORE);
    }
  }

  const extrasPoints = {};
  for (const [marketKey, selections] of Object.entries(model.extras)) {
    const cfg = MARKET_CONFIG.EXTRAS[marketKey];
    extrasPoints[marketKey] = {};
    for (const [selKey, p] of Object.entries(selections)) {
      extrasPoints[marketKey][selKey] = probToPoints(p, cfg);
    }
  }

  return {
    outcome_1x2: outcomePoints,
    exact_score: exactScorePoints,
    extras: extrasPoints
  };
}

function resolveMatchOutcomes(ftHome, ftAway, htHome, htAway) {
  const h = Number(ftHome);
  const a = Number(ftAway);
  const h1 = htHome != null ? Number(htHome) : 0;
  const a1 = htAway != null ? Number(htAway) : 0;

  const totalGoals = h + a;
  const goalsH1 = h1 + a1;
  const goalsH2 = Math.max(0, totalGoals - goalsH1);

  return {
    outcome_1x2: h > a ? 'HOME' : h === a ? 'DRAW' : 'AWAY',
    exact_score: `${h}-${a}`,
    extras: {
      btts:                 h > 0 && a > 0 ? 'YES' : 'NO',
      over_under_1_5:       totalGoals > 1.5 ? 'OVER' : 'UNDER',
      over_under_2_5:       totalGoals > 2.5 ? 'OVER' : 'UNDER',
      over_under_3_5:       totalGoals > 3.5 ? 'OVER' : 'UNDER',
      ht_leader:            h1 > a1 ? 'HOME' : h1 === a1 ? 'DRAW' : 'AWAY',
      goal_both_halves:     goalsH1 > 0 && goalsH2 > 0 ? 'YES' : 'NO',
      clean_sheet:          h === 0 || a === 0 ? 'YES' : 'NO',
      win_by_2_plus:        Math.abs(h - a) >= 2 ? 'YES' : 'NO',
      odd_even_goals:       totalGoals % 2 === 1 ? 'ODD' : 'EVEN',
      highest_scoring_half: goalsH1 > goalsH2 ? 'FIRST' : goalsH2 > goalsH1 ? 'SECOND' : 'EQUAL'
    }
  };
}


// ============================================================
//  Odds-based pricing (bookmaker odds -> points)
//  points = round(odd * POINTS_PER_ODD)  (e.g. 2.10 -> 21 points)
// ============================================================
const POINTS_PER_ODD = Number(process.env.POINTS_PER_ODD) > 0 ? Number(process.env.POINTS_PER_ODD) : 10;
const ODDS_MAX_POINTS = Number(process.env.ODDS_MAX_POINTS) > 0 ? Number(process.env.ODDS_MAX_POINTS) : 1000;
const FALLBACK_OVERROUND = 1.06;        // margin added to model probabilities for markets the bookmaker lacks
const FALLBACK_OVERROUND_EXACT = 1.15;  // exact-score books carry a bigger margin

function oddsToPoints(odd) {
  const n = Number(odd);
  if (!Number.isFinite(n) || n < 1.01) return null;
  return clamp(Math.round(n * POINTS_PER_ODD), 1, ODDS_MAX_POINTS);
}

function pointsFromModelProb(p, overround) {
  const safe = Math.max(0.00001, Math.min(0.99, Number(p) || 0.5));
  return oddsToPoints(1 / (safe * overround)) ?? 1;
}

// odds object {KEY: odd} -> probabilities with the bookmaker margin removed
function deMargin(oddsObj) {
  const inv = {};
  let sum = 0;
  for (const [k, o] of Object.entries(oddsObj)) {
    inv[k] = 1 / Number(o);
    sum += inv[k];
  }
  const out = {};
  for (const k of Object.keys(inv)) out[k] = inv[k] / sum;
  return out;
}

// Find the (lambdaHome, lambdaAway) whose Poisson model best reproduces the bookmaker's
// 1X2 (+ Over/Under 2.5 when available). Used to price markets the bookmaker doesn't list.
function calibrateLambdas(bundle) {
  const t = deMargin(bundle.outcome_1x2);
  const ou = bundle.extras?.over_under_2_5;
  const tOver = ou && ou.OVER && ou.UNDER ? deMargin({ OVER: ou.OVER, UNDER: ou.UNDER }).OVER : null;
  const N = 11;

  const pmf = lam => {
    const arr = new Array(N);
    for (let k = 0; k < N; k++) arr[k] = (Math.pow(lam, k) * Math.exp(-lam)) / FACTORIALS[k];
    return arr;
  };

  const loss = (lh, la) => {
    const ph = pmf(lh), pa = pmf(la);
    let H = 0, D = 0, A = 0, O = 0, mass = 0;
    for (let h = 0; h < N; h++) {
      for (let a = 0; a < N; a++) {
        const p = ph[h] * pa[a];
        mass += p;
        if (h > a) H += p; else if (h === a) D += p; else A += p;
        if (h + a > 2.5) O += p;
      }
    }
    H /= mass; D /= mass; A /= mass; O /= mass;
    let l = (H - t.HOME) ** 2 + (D - t.DRAW) ** 2 + (A - t.AWAY) ** 2;
    if (tOver !== null) l += (O - tOver) ** 2;
    l += 0.001 * ((lh + la - 2.7) / 2.7) ** 2; // weak prior, only matters when O/U is missing
    return l;
  };

  let best = { l: Infinity, lh: 1.5, la: 1.2 };
  for (let lh = 0.2; lh <= 4.6; lh += 0.05) {
    for (let la = 0.2; la <= 4.0; la += 0.05) {
      const l = loss(lh, la);
      if (l < best.l) best = { l, lh, la };
    }
  }
  const c = { ...best };
  for (let lh = c.lh - 0.05; lh <= c.lh + 0.05; lh += 0.01) {
    for (let la = c.la - 0.05; la <= c.la + 0.05; la += 0.01) {
      if (lh < 0.15 || la < 0.15) continue;
      const l = loss(lh, la);
      if (l < best.l) best = { l, lh, la };
    }
  }
  return { lambdaHome: Number(best.lh.toFixed(2)), lambdaAway: Number(best.la.toFixed(2)) };
}

/**
 * bundle = {
 *   outcome_1x2: { HOME, DRAW, AWAY },            // decimal odds (required)
 *   exact_score: { '1-0': 7.5, ... },
 *   extras: { btts:{YES,NO}, over_under_1_5:{OVER,UNDER}, over_under_2_5, over_under_3_5,
 *             ht_leader:{HOME,DRAW,AWAY}, odd_even_goals:{ODD,EVEN},
 *             highest_scoring_half:{FIRST,SECOND,EQUAL} }
 * }
 * Returns the same shape as buildMatchMarketsPoints (+ _meta), or null if 1X2 odds are missing.
 */
function buildMatchMarketsPointsFromOdds(bundle) {
  const o = bundle?.outcome_1x2;
  if (!o || !(o.HOME >= 1.01) || !(o.DRAW >= 1.01) || !(o.AWAY >= 1.01)) return null;

  const { lambdaHome, lambdaAway } = calibrateLambdas(bundle);
  const model = generatePoissonModel(lambdaHome, lambdaAway);
  const fallbackMarkets = [];

  const outcome_1x2 = {
    HOME: oddsToPoints(o.HOME),
    DRAW: oddsToPoints(o.DRAW),
    AWAY: oddsToPoints(o.AWAY)
  };

  const exact_score = {};
  let exactFromModel = 0;
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const key = `${h}-${a}`;
      const pts = oddsToPoints(bundle.exact_score?.[key]);
      if (pts !== null) {
        exact_score[key] = pts;
      } else {
        exact_score[key] = pointsFromModelProb(model.exactGrid[key], FALLBACK_OVERROUND_EXACT);
        exactFromModel++;
      }
    }
  }
  if (exactFromModel > 0) fallbackMarkets.push(`exact_score(${exactFromModel}/64)`);

  // "any clean sheet" (h==0 || a==0) is exactly the opposite of BTTS
  const btts = bundle.extras?.btts;
  const derivedClean = btts && btts.YES && btts.NO ? { YES: btts.NO, NO: btts.YES } : null;

  const extras = {};
  for (const [marketKey, selections] of Object.entries(model.extras)) {
    extras[marketKey] = {};
    const real = marketKey === 'clean_sheet' ? derivedClean : bundle.extras?.[marketKey];
    let usedModel = false;
    for (const [selKey, p] of Object.entries(selections)) {
      const pts = oddsToPoints(real?.[selKey]);
      if (pts !== null) {
        extras[marketKey][selKey] = pts;
      } else {
        extras[marketKey][selKey] = pointsFromModelProb(p, FALLBACK_OVERROUND);
        usedModel = true;
      }
    }
    if (usedModel) fallbackMarkets.push(marketKey);
  }

  return {
    outcome_1x2,
    exact_score,
    extras,
    lambdas: { home: lambdaHome, away: lambdaAway },
    _meta: { source: 'bookmaker', points_per_odd: POINTS_PER_ODD, model_priced: fallbackMarkets }
  };
}

module.exports = {
  MARKET_CONFIG,
  buildMatchMarketsPoints,
  buildMatchMarketsPointsFromOdds,
  oddsToPoints,
  resolveMatchOutcomes
};