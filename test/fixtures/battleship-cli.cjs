/* eslint-disable @typescript-eslint/no-require-imports -- executable CommonJS subprocess fixture */
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('fixture-battleship-cli 1'); process.exit(0); }
const prompt = process.argv.at(-1);
const observation = JSON.parse(prompt.slice(prompt.indexOf('{"observation":'))).observation;
const ships = [
  { ship: 'carrier', start: 'a1', orientation: 'horizontal' },
  { ship: 'battleship', start: 'a2', orientation: 'horizontal' },
  { ship: 'cruiser', start: 'a3', orientation: 'horizontal' },
  { ship: 'submarine', start: 'a4', orientation: 'horizontal' },
  { ship: 'destroyer', start: 'a5', orientation: 'horizontal' },
];
const targets = ships.flatMap((ship) => Array.from({ length: ({ carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 })[ship.ship] }, (_, index) => `${String.fromCharCode(ship.start.charCodeAt(0) + index)}${ship.start.slice(1)}`));
const action = observation.state.phase === 'placement' ? { type: 'place_fleet', payload: { ships } }
  : { type: 'fire', payload: { coordinate: targets.find((target) => !observation.state.ownShots.some((shot) => shot.coordinate === target)) } };
setTimeout(() => {
  const outputIndex = process.argv.indexOf('--output-last-message');
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(action));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }));
}, 30);
