'use strict';
const fs = require('fs');
const path = require('path');

const shimSrc  = path.resolve(__dirname, '..', 'shims', 'better-sqlite3-bun.js');
const targetIndex = path.resolve(__dirname, '..', 'node_modules', 'better-sqlite3', 'lib', 'index.js');
const targetDb    = path.resolve(__dirname, '..', 'node_modules', 'better-sqlite3', 'lib', 'database.js');
const backupDb    = targetDb + '.original';

if (!fs.existsSync(shimSrc)) {
  console.error('[patch] Shim not found:', shimSrc);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(targetDb))) {
  console.log('[patch] better-sqlite3 not installed - skipping.');
  process.exit(0);
}

if (fs.existsSync(targetDb) && !fs.existsSync(backupDb)) {
  fs.copyFileSync(targetDb, backupDb);
  console.log('[patch] Backed up original database.js');
}

fs.copyFileSync(shimSrc, targetDb);
console.log('[patch] Replaced database.js with bun:sqlite shim');

var indexContent = "'use strict';\nconst Database = require('./database');\nmodule.exports = Database;\nmodule.exports.SqliteError = Database.SqliteError;\n";
fs.writeFileSync(targetIndex, indexContent, 'utf8');
console.log('[patch] Rewrote index.js to export shim correctly');
console.log('[patch] Done - better-sqlite3 is now shimmed to bun:sqlite');
