/**
 * personas/index.js
 *
 * Auto-discovers and loads all persona JSON files in this directory.
 *
 * To add a new persona:
 *   1. Drop a new .json file in this directory
 *   2. That's it — no registration needed
 *
 * Files starting with _ are ignored (use for drafts: _new-persona.json)
 * The README.md and any non-.json files are ignored automatically.
 */

const fs   = require('fs');
const path = require('path');

const personas = {};

fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.json') && !f.startsWith('_'))
  .forEach(f => {
    try {
      const id      = path.basename(f, '.json');
      const data    = require(path.join(__dirname, f));
      personas[id]  = data;
    } catch (e) {
      console.warn(`personas/index.js: failed to load ${f}:`, e.message);
    }
  });

console.log(`personas/index.js: loaded ${Object.keys(personas).length} personas`);
module.exports = personas;
