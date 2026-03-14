/**
 * better-sqlite3 -> bun:sqlite shim
 *
 * Replaces the native better-sqlite3 addon (which cannot load in Bun)
 * with Bun's built-in SQLite driver. The APIs are nearly identical;
 * this shim bridges the minor differences so that mem0ai/oss works
 * out of the box under the Bun runtime.
 *
 * Usage: copy this file to node_modules/better-sqlite3/lib/database.js
 *        (automated via the postinstall script).
 */
'use strict';

const { Database: BunDatabase } = require('bun:sqlite');

// ---------------------------------------------------------------------------
// SqliteError - mirrors better-sqlite3's custom error class
// ---------------------------------------------------------------------------
function SqliteError(message, code) {
  if (new.target !== SqliteError) return new SqliteError(message, code);
  if (typeof code !== 'string') throw new TypeError('Expected second argument to be a string');
  Error.call(this, message);
  Object.defineProperty(this, 'message', {
    value: '' + message, writable: true, enumerable: false, configurable: true,
  });
  if (Error.captureStackTrace) Error.captureStackTrace(this, SqliteError);
  this.code = code;
}
Object.setPrototypeOf(SqliteError, Error);
Object.setPrototypeOf(SqliteError.prototype, Error.prototype);
Object.defineProperty(SqliteError.prototype, 'name', {
  value: 'SqliteError', writable: true, enumerable: false, configurable: true,
});

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------
function Database(filename, options) {
  if (new.target == null) return new Database(filename, options);

  if (filename == null) filename = ':memory:';
  if (typeof filename !== 'string') {
    if (Buffer.isBuffer(filename)) {
      filename = ':memory:';
    } else {
      throw new TypeError('Expected first argument to be a string');
    }
  }
  if (options == null) options = {};

  const bunOpts = {};
  if (options.readonly) bunOpts.readonly = true;
  if (options.fileMustExist === false || !options.fileMustExist) {
    bunOpts.create = true;
  }

  try {
    this._db = new BunDatabase(filename, bunOpts);
  } catch (err) {
    throw new SqliteError(err.message, 'SQLITE_CANTOPEN');
  }

  try { this._db.exec('PRAGMA journal_mode = WAL'); } catch (_) {}
}

Database.prototype.exec = function exec(sql) {
  this._db.exec(sql);
  return this;
};

Database.prototype.prepare = function prepare(sql) {
  const bunStmt = this._db.prepare(sql);
  return new Statement(bunStmt);
};

Database.prototype.transaction = function transaction(fn) {
  return this._db.transaction(fn);
};

Database.prototype.pragma = function pragma(pragmaStr, options) {
  var simple = options && options.simple;
  try {
    var rows = this._db.prepare('PRAGMA ' + pragmaStr).all();
    if (simple && rows.length > 0) {
      var keys = Object.keys(rows[0]);
      return keys.length > 0 ? rows[0][keys[0]] : undefined;
    }
    return rows;
  } catch (_) {
    return simple ? undefined : [];
  }
};

Database.prototype.close = function close() {
  this._db.close();
};

Database.prototype.defaultSafeIntegers = function defaultSafeIntegers() {
  return this;
};

Object.defineProperty(Database.prototype, 'open', {
  get: function() { return true; },
});

Object.defineProperty(Database.prototype, 'inTransaction', {
  get: function() { return this._db.inTransaction; },
});

// ---------------------------------------------------------------------------
// Statement wrapper
// ---------------------------------------------------------------------------
function Statement(bunStmt) {
  this._stmt = bunStmt;
}

Statement.prototype.run = function run() {
  return this._stmt.run.apply(this._stmt, arguments);
};

Statement.prototype.get = function get() {
  return this._stmt.get.apply(this._stmt, arguments);
};

Statement.prototype.all = function all() {
  return this._stmt.all.apply(this._stmt, arguments);
};

Statement.prototype.safeIntegers = function safeIntegers() {
  return this;
};

Statement.prototype.bind = function bind() {
  this._stmt.bind.apply(this._stmt, arguments);
  return this;
};

// ---------------------------------------------------------------------------
// Exports (match better-sqlite3's module.exports shape)
// ---------------------------------------------------------------------------
module.exports = Database;
module.exports.SqliteError = SqliteError;
