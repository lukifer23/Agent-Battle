/* eslint-disable @typescript-eslint/no-require-imports -- executable fixture has no package.json and runs as CommonJS */
// Deterministic subprocess fixture. Never a production provider or qualification claim.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('fixture-cli 1'); process.exit(0); }
const prompt = process.argv.at(-1);
const observation = JSON.parse(prompt.slice(prompt.indexOf('{"observation":'))).observation;
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-config.json'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'observations.jsonl'), JSON.stringify({ executable: path.basename(process.argv[1]), observation }) + '\n');
const shared = observation.schemaVersion === 'hangman-shared-observation-v2' || observation.schemaVersion === 'hangman-shared-observation-v3';
const action = shared
  ? observation.playerId === 'player1' ? { type: 'guess_letter', payload: { letter: config.word[0] } } : { type: 'solve', payload: { word: config.word } }
  : config.invalid && observation.playerId === 'player1'
  ? { type: 'invalid', payload: {} }
  : observation.state.actionsTaken >= (observation.playerId === 'player1' ? 0 : 2)
    ? { type: 'solve', payload: { word: config.word } }
    : observation.legalActions[0];
setTimeout(() => {
  if (path.basename(process.argv[1]) === 'claude') {
    console.log(JSON.stringify({ structured_output: action, modelUsage: { 'fixture-b': {} }, usage: { input_tokens: 10, output_tokens: 5 } })); return;
  }
  const outputIndex = process.argv.indexOf('--output-last-message');
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(action));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}, config.delayMs ?? 100);
