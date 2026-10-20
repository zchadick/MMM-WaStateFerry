// Writes raw WSDOT API responses to a MariaDB database for later post-processing.
// Enabled only when all required DB keys exist in the module config (values are not checked;
// a bad value shows up as a failed connection). Never throws to the caller.

const REQUIRED_KEYS = ["predictionDbUser", "predictionDbPass", "predictionDbHost", "predictionDbName"];
const DEFAULT_PORT = 3306;
const TABLE_NAME = "api_snapshots";
// About one day of fetches at the default 5-minute update interval
const MAX_QUEUED_BATCHES = 288;
const CONNECT_TIMEOUT_MS = 10000;

const MISSING_PACKAGE_MESSAGE = "[MMM-WaStateFerry] Database logging is configured, but the \"mariadb\" package is not installed. "
  + "Run \"npm install\" in modules/MMM-WaStateFerry. The ferry display will keep working without database logging.";

// All four keys must exist in config.js (even as empty strings) to enable DB logging
function isDbConfigured(dbConfig) {
  return Boolean(dbConfig) && REQUIRED_KEYS.every(key => key in dbConfig);
}

// Quote a database/table name for use in SQL
function escapeId(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

// Format a Date as a MariaDB DATETIME(3) string in UTC: "YYYY-MM-DD HH:MM:SS.mmm"
function toUtcString(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function createDatabaseSql(dbName) {
  return `CREATE DATABASE IF NOT EXISTS ${escapeId(dbName)}`;
}

// qualifiedTable is already escaped, e.g. `FERRY`.`api_snapshots`
function createTableSql(qualifiedTable, { temporary = false } = {}) {
  return `CREATE ${temporary ? "TEMPORARY " : ""}TABLE IF NOT EXISTS ${qualifiedTable} (
    id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    snapshot_utc           DATETIME(3) NOT NULL,
    endpoint               VARCHAR(64) NOT NULL,
    departing_terminal_id  INT NULL,
    arriving_terminal_id   INT NULL,
    http_status            SMALLINT NULL,
    body                   LONGTEXT NULL,
    KEY idx_snapshot (snapshot_utc),
    KEY idx_endpoint_snapshot (endpoint, snapshot_utc)
  ) DEFAULT CHARSET=utf8mb4`;
}

// Insert one batch of snapshot rows: { snapshotTime, endpoint, departingTerminalID, arrivingTerminalID, httpStatus, body }
async function insertSnapshots(conn, qualifiedTable, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const sql = `INSERT INTO ${qualifiedTable}
    (snapshot_utc, endpoint, departing_terminal_id, arriving_terminal_id, http_status, body)
    VALUES (?, ?, ?, ?, ?, ?)`;
  await conn.batch(sql, rows.map(row => [
    toUtcString(row.snapshotTime),
    row.endpoint,
    row.departingTerminalID ?? null,
    row.arrivingTerminalID ?? null,
    row.httpStatus ?? null,
    row.body ?? null
  ]));
}

// Create a writer that queues batches in memory and flushes them to MariaDB
function createDbWriter(Log) {
  let mariadb = null;
  let disabled = false;
  let schemaReady = false;
  let flushing = false;
  let failing = false;
  let lastSuccess = null;
  const queue = [];

  // Load the mariadb package only when DB logging is actually configured
  function loadMariadb() {
    if (mariadb) return true;
    try {
      mariadb = require("mariadb");
      return true;
    } catch (error) {
      disabled = true;
      Log.error(MISSING_PACKAGE_MESSAGE);
      return false;
    }
  }

  async function flush(dbConfig) {
    const dbName = dbConfig.predictionDbName;
    const qualifiedTable = `${escapeId(dbName)}.${escapeId(TABLE_NAME)}`;
    let conn = null;
    let written = 0;

    try {
      conn = await mariadb.createConnection({
        host: dbConfig.predictionDbHost,
        port: Number(dbConfig.predictionDbPort) || DEFAULT_PORT,
        user: dbConfig.predictionDbUser,
        password: dbConfig.predictionDbPass,
        connectTimeout: CONNECT_TIMEOUT_MS
      });
      // Swallow late socket errors so they can't crash MagicMirror
      conn.on("error", error => Log.debug(`[MMM-WaStateFerry] DB connection error: ${error.message}`));

      // Create database and table on first successful connection
      if (!schemaReady) {
        await conn.query(createDatabaseSql(dbName));
        await conn.query(createTableSql(qualifiedTable));
        schemaReady = true;
      }

      // Write oldest batches first; a batch leaves the queue only after it is written
      while (queue.length > 0) {
        await insertSnapshots(conn, qualifiedTable, queue[0]);
        queue.shift();
        written++;
      }

      lastSuccess = new Date();
      if (failing) {
        failing = false;
        Log.info(`[MMM-WaStateFerry] DB writes recovered; wrote ${written} queued batch(es).`);
      } else {
        Log.debug(`[MMM-WaStateFerry] DB write ok (${written} batch(es)).`);
      }
    } catch (error) {
      if (!failing) {
        failing = true;
        const last = lastSuccess ? lastSuccess.toISOString() : "never";
        Log.warn(`[MMM-WaStateFerry] DB writes failing: ${error.message}. Last successful write: ${last}. `
          + `Queuing up to ${MAX_QUEUED_BATCHES} batches and retrying each update.`);
      } else {
        Log.debug(`[MMM-WaStateFerry] DB write still failing (${queue.length} batch(es) queued): ${error.message}`);
      }
    } finally {
      if (conn) {
        try {
          await conn.end();
        } catch (error) {
          conn.destroy();
        }
      }
    }
  }

  // Queue one fetch's rows and try to flush everything queued. Never throws.
  async function write(dbConfig, rows) {
    try {
      if (disabled || !isDbConfigured(dbConfig)) return;
      if (!loadMariadb()) return;

      queue.push(rows);
      if (queue.length > MAX_QUEUED_BATCHES) {
        queue.shift();
        Log.debug("[MMM-WaStateFerry] DB queue full; dropped oldest batch.");
      }

      // A flush already in progress will pick up this batch on the next update
      if (flushing) return;
      flushing = true;
      try {
        await flush(dbConfig);
      } finally {
        flushing = false;
      }
    } catch (error) {
      Log.error(`[MMM-WaStateFerry] Unexpected DB writer error: ${error.message}`);
    }
  }

  return {
    write,
    getStatus: () => ({ failing, lastSuccess, queued: queue.length })
  };
}

module.exports = {
  REQUIRED_KEYS,
  DEFAULT_PORT,
  TABLE_NAME,
  isDbConfigured,
  escapeId,
  toUtcString,
  createDatabaseSql,
  createTableSql,
  insertSnapshots,
  createDbWriter
};
