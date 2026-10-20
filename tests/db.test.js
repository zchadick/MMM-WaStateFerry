// Database tests for the prediction DB writer. Run from the module directory: node --test
// Uses the MMM-WaStateFerry entry in MagicMirror's config/config.js; skipped if DB keys are missing.
// Set KEEP_TEST_TABLE=1 to write to a normal test_* table that is kept for inspection.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const mariadb = require("mariadb");
const {
  DEFAULT_PORT,
  isDbConfigured,
  escapeId,
  toUtcString,
  createDatabaseSql,
  createTableSql,
  insertSnapshots
} = require("../predictive_helpers/dbWriter");

const KEEP_TEST_TABLE = process.env.KEEP_TEST_TABLE === "1";

// Read this module's config from MagicMirror's config.js (three levels up from tests/)
function loadModuleConfig() {
  try {
    const config = require(path.resolve(__dirname, "../../../config/config.js"));
    const entry = config.modules.find(m => m.module === "MMM-WaStateFerry");
    return entry ? entry.config : null;
  } catch (error) {
    return null;
  }
}

const dbConfig = loadModuleConfig();
const skip = isDbConfigured(dbConfig) ? false : "DB settings not found in config/config.js";

function connect(options = {}) {
  return mariadb.createConnection({
    host: dbConfig.predictionDbHost,
    port: Number(dbConfig.predictionDbPort) || DEFAULT_PORT,
    user: dbConfig.predictionDbUser,
    password: dbConfig.predictionDbPass,
    connectTimeout: 10000,
    ...options
  });
}

test("connects to the prediction DB and closes cleanly", { skip }, async () => {
  const conn = await connect();
  try {
    const rows = await conn.query("SELECT 1 AS ok");
    assert.strictEqual(Number(rows[0].ok), 1);
  } finally {
    await conn.end();
  }
});

test("writes snapshot rows to a test table and reads them back", { skip }, async (t) => {
  // dateStrings keeps DATETIME values as written (UTC strings) instead of converting to local Dates
  const conn = await connect({ dateStrings: true });
  try {
    const dbName = dbConfig.predictionDbName;
    const tableName = KEEP_TEST_TABLE
      ? `test_api_snapshots_${toUtcString(new Date()).replace(/\D/g, "").slice(0, 14)}`
      : "test_api_snapshots";
    const qualifiedTable = `${escapeId(dbName)}.${escapeId(tableName)}`;

    await conn.query(createDatabaseSql(dbName));
    await conn.query(createTableSql(qualifiedTable, { temporary: !KEEP_TEST_TABLE }));

    const snapshotTime = new Date(Date.UTC(2026, 9, 20, 21, 5, 30, 123));
    const rows = [
      {
        snapshotTime,
        endpoint: "vessellocations",
        departingTerminalID: 3,
        arrivingTerminalID: 7,
        httpStatus: 200,
        body: "[{\"VesselID\":37,\"VesselName\":\"Wenatchee\",\"Note\":\"quotes ' \\\" ` and unicode → é\"}]"
      },
      {
        // Simulates a request that never got a response
        snapshotTime,
        endpoint: "terminalsailingspace",
        departingTerminalID: 3,
        arrivingTerminalID: 7,
        httpStatus: null,
        body: null
      }
    ];

    await insertSnapshots(conn, qualifiedTable, rows);
    const saved = await conn.query(`SELECT * FROM ${qualifiedTable} ORDER BY id`);

    assert.strictEqual(saved.length, rows.length);
    saved.forEach((row, i) => {
      assert.strictEqual(row.snapshot_utc, "2026-10-20 21:05:30.123");
      assert.strictEqual(row.endpoint, rows[i].endpoint);
      assert.strictEqual(row.departing_terminal_id, rows[i].departingTerminalID);
      assert.strictEqual(row.arriving_terminal_id, rows[i].arrivingTerminalID);
      assert.strictEqual(row.http_status, rows[i].httpStatus);
      assert.strictEqual(row.body, rows[i].body);
    });

    if (KEEP_TEST_TABLE) t.diagnostic(`Kept test table: ${dbName}.${tableName}`);
  } finally {
    // A TEMPORARY table is dropped automatically when the connection closes
    await conn.end();
  }
});
