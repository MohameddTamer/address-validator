#!/usr/bin/env node
// Same twenty six checks the old suite covered, rewritten for the Node build.
// No test framework, just a list that has to come back clean.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const { checkAddress, checkOrder, checkPhone, classifyReply, loadBatch, batchSummary } =
  require(path.join(root, "validator.js"));

const RESULTS = [];
function check(name, cond) {
  RESULTS.push([name, Boolean(cond)]);
  console.log((cond ? "PASS " : "FAIL ") + name);
}

function writeCsv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validator-test-"));
  const file = path.join(dir, "batch.csv");
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

const HEADER = "order_id,phone,governorate,city,address,reply\n";

function main() {
  check("a normal mobile passes the phone check", JSON.stringify(checkPhone("01012345678")) === "[]");
  check("a short phone is flagged", checkPhone("0114").some((i) => i.includes("digits")));
  check("a landline is flagged for its length", checkPhone("0223456789").some((i) => i.includes("digits")));
  check("a non mobile prefix is flagged", checkPhone("01312345678").some((i) => i.includes("prefix")));
  check("country code numbers are normalised", JSON.stringify(checkPhone("+201012345678")) === "[]");
  check("an address with a landmark passes", JSON.stringify(checkAddress("Gharbia", "Tanta", "El Bahr street, next to the pharmacy")) === "[]");
  check("a city in the wrong governorate is flagged", checkAddress("Gharbia", "Mansoura", "a long enough street near the station").some((i) => i.includes("belongs to dakahlia")));
  check("a missing landmark is flagged", checkAddress("Gharbia", "Tanta", "12 El Bahr street, flat four, second floor").some((i) => i.includes("landmark")));
  check("a missing governorate is flagged", checkAddress("", "Tanta", "El Bahr street near the pharmacy").some((i) => i.includes("missing")));
  check("confirmed reply classifies as confirmed", classifyReply("تمام اكد الاوردر") === "confirmed");
  check("postpone reply classifies as postpone", classifyReply("خليه بكره احسن") === "postpone");
  check("cancel reply classifies as refused", classifyReply("الغاء") === "refused");
  check("silence classifies as needs_human", classifyReply("") === "needs_human");
  check("a clean order can ship", checkOrder({ order_id: 1, phone: "01012345678", governorate: "Gharbia", city: "Tanta", address: "El Bahr street next to the pharmacy" }).ship === true);

  const batch = writeCsv(HEADER +
    "1,01012345678,Gharbia,Tanta,El Bahr street next to the pharmacy,yes\n" +
    "2,01123456789,Cairo,Nasr City,Makram Ebeid street behind City Stars,confirmed\n" +
    "2,01234567890,Giza,Dokki,Tahrir street near the metro,yes\n" +
    "3,01012345678,Gharbia,Zefta,Main road beside the post office,yes\n" +
    "4,,Gharbia,Tanta,El Bahr street next to the pharmacy,yes\n");
  const { results, malformed, duplicates } = loadBatch(batch);
  const summary = batchSummary(results, malformed, duplicates);
  check("duplicate order_id is reported and skipped", duplicates.some((d) => d.type === "order_id") && results.length === 3);
  check("duplicate phone is reported and blocks shipping", duplicates.some((d) => d.type === "phone") && summary.ship === 2 && summary.no_ship === 1);
  check("a row with an empty phone is malformed with its row number", malformed.length === 1 && malformed[0].row === 6);
  check("issue types are counted for the report", summary.issue_types.duplicate_phone === 1);
  check("reply classification rides along in batch mode", results[0].reply_class === "confirmed");

  let raised = false;
  try {
    loadBatch(writeCsv("order_id,phone\n1,01012345678\n"));
  } catch (err) {
    raised = err.message.includes("missing required columns");
  }
  check("missing columns raise a clear error", raised);

  const td = fs.mkdtempSync(path.join(os.tmpdir(), "validator-test-"));
  const outJson = path.join(td, "r.json");
  const outHtml = path.join(td, "r.html");
  const outLog = path.join(td, "v.log");
  const tool = path.join(root, "validator.js");
  const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf-8" });
  const proc = run([batch, "--json", outJson, "--report", outHtml, "--log", outLog]);
  check("cli batch exits zero without strict", proc.status === 0);
  const data = JSON.parse(fs.readFileSync(outJson, "utf-8"));
  check("json carries duplicates and malformed rows", data.duplicates.length === 2 && data.malformed_rows.length === 1);
  const doc = fs.readFileSync(outHtml, "utf-8");
  check("html report is a certificate with verdict stamps", doc.includes("Address Quality Certificate") && doc.includes("CLEARED") && doc.includes("NEEDS") && doc.includes("Newsreader"));
  check("log file is written", fs.existsSync(outLog) && fs.readFileSync(outLog, "utf-8").includes("batch checked"));
  const strict = run([batch, "--strict", "--log", outLog]);
  check("strict mode exits nonzero on dirty input", strict.status === 2);
  const demo = run([]);
  check("demo mode still runs with no arguments", demo.status === 0 && demo.stdout.includes("confirmed"));

  const passed = RESULTS.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${RESULTS.length} checks passed`);
  return passed === RESULTS.length ? 0 : 1;
}

process.exit(main());
