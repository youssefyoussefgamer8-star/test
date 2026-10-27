require('dotenv').config();
fetch('https://v3.football.api-sports.io/leagues?country=Tunisia', {
  headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
}).then(r => r.json()).then(j => {
  console.log('errors:', j.errors);
  for (const l of j.response || []) {
    const s = l.seasons[l.seasons.length - 1];
    console.log(l.league.id, l.league.name, s.year,
      'odds:', s.coverage.odds,
      'stats:', s.coverage.fixtures.statistics_fixtures,
      'events:', s.coverage.fixtures.events);
  }
});