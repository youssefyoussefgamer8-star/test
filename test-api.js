require('dotenv').config();
fetch('https://v3.football.api-sports.io/fixtures?league=2&season=2024&from=2024-10-01&to=2024-10-31', {
  headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
}).then(r => r.json()).then(j => console.log('errors:', j.errors, 'results:', j.results));