require('dotenv').config();
const { Pool } = require('pg');
const { buildMatchMarketsPoints } = require('./pricingEngine');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function teamStrengthOffset(teamName, externalId) {
  let hash = Number(externalId) || 0;
  const str = String(teamName || 'Team');
  for (let i = 0; i < str.length; i++) hash = (hash * 33 + str.charCodeAt(i)) % 10000;
  return ((hash % 100) - 45) / 100;
}

async function syncTunisia() {
  console.log('🧹 Cleaning up old 2024 Tunisian matches from database...');
  
  try {
    // مسح مباريات تونس القديمة من قاعدة البيانات
    await pool.query(`DELETE FROM matches WHERE competition_code = 'TU1'`);
    
    console.log('📦 Generating New Scheduled Matches for Current Round...');
    
    let matches = [];
    const tunisianTeams = [
      'Espérance de Tunis', 'Club Africain',
      'Étoile du Sahel', 'CS Sfaxien',
      'US Monastir', 'Stade Tunisien',
      'Olympique Béja', 'ES Zarzis',
      'CA Bizertin', 'US Ben Guerdane',
      'AS Soliman', 'EGS Gafsa',
      'JS Omrane', 'AS Gabès',
      'US Tataouine', 'ES Métlaoui'
    ];

    // توليد 8 مباريات للجولة الأولى لكي تظهر فوراً
    for (let i = 0; i < tunisianTeams.length; i += 2) {
      const date = new Date();
      date.setHours(date.getHours() + (i * 2) + 24); // مباريات قادمة

      matches.push({
        id: 2025000 + i,
        home: tunisianTeams[i],
        away: tunisianTeams[i+1],
        date: date.toISOString(),
        homeScore: null,
        awayScore: null,
        status: 'SCHEDULED',
        matchday: 1 
      });
    }

    let updatedCount = 0;

    for (const m of matches) {
      const roundKey = `MD-${m.matchday}`;
      let ftHome = m.homeScore !== null ? parseInt(m.homeScore, 10) : null;
      let ftAway = m.awayScore !== null ? parseInt(m.awayScore, 10) : null;

      const hOffset = teamStrengthOffset(m.home, m.id);
      const aOffset = teamStrengthOffset(m.away, m.id + 1);
      const lambdaHome = Number(Math.max(0.45, Math.min(3.50, 1.45 + hOffset)).toFixed(2));
      const lambdaAway = Number(Math.max(0.35, Math.min(3.10, 1.15 + aOffset)).toFixed(2));
      const marketsPoints = buildMatchMarketsPoints(lambdaHome, lambdaAway);

      await pool.query(
        `INSERT INTO matches (
           external_id, competition_code, stage, matchday, round_key,
           home_team, away_team,
           utc_date, status, home_score, away_score,
           home_goals_avg, away_goals_avg, markets_points, updated_at
         ) VALUES (
           $1, 'TU1', 'REGULAR_SEASON', $2, $3,
           $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12::jsonb, NOW()
         )
         ON CONFLICT (external_id) DO UPDATE SET
           status = EXCLUDED.status,
           home_score = EXCLUDED.home_score,
           away_score = EXCLUDED.away_score,
           utc_date = EXCLUDED.utc_date,
           updated_at = NOW()`,
        [
          m.id, m.matchday, roundKey,
          m.home, m.away,
          m.date, m.status, ftHome, ftAway,
          lambdaHome, lambdaAway, JSON.stringify(marketsPoints)
        ]
      );
      updatedCount++;
    }

    console.log(`✅ Successfully wiped old data and created ${updatedCount} NEW Scheduled matches!`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

syncTunisia();