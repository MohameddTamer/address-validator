#!/usr/bin/env node
// A COD order gets checked before dispatch, not after the courier fails.
// Same rules as the old Python version, just a different runtime.

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_COLUMNS = ["order_id", "phone", "governorate", "city", "address"];
const EG_PREFIXES = new Set(["010", "011", "012", "015"]);
const GOVERNORATES = {
  gharbia: ["tanta", "el mahalla", "kafr el zayat", "zefta", "santa", "basyoun"],
  cairo: ["nasr city", "heliopolis", "maadi", "dokki", "shubra"],
  giza: ["dokki", "mohandessin", "6th of october", "sheikh zayed", "haram"],
  alexandria: ["smouha", "sidi gaber", "montaza", "agami"],
  dakahlia: ["mansoura", "talkha", "mit ghamr"],
};
const LANDMARK_HINTS = ["next to", "behind", "in front of", "near", "beside", "opposite",
  "بجوار", "امام", "أمام", "خلف", "جنب", "عند"];

const CONFIRMED = ["تمام", "اكد", "أكد", "confirmed", "yes", "ايوه", "أيوه", "ماشي", "اوكي", "ok"];
const POSTPONE = ["بكره", "بكرة", "بعدين", "الاسبوع الجاي", "later", "tomorrow", "مش دلوقتي"];
const REFUSED = ["الغاء", "إلغاء", "مش عايز", "cancel", "لا شكرا", "لأ"];

// Logging goes to a file, stdout stays clean for the dispatch list.
let logStream = null;
function logLine(level, msg) {
  if (!logStream) return;
  const now = new Date();
  const stamp = now.toISOString().replace("T", " ").slice(0, 19);
  logStream.write(`${stamp} ${level} ${msg}\n`);
}

function minAddressLen() {
  return parseInt(process.env.VALIDATOR_MIN_ADDRESS_LEN || "12", 10);
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("20") && digits.length > 11) digits = digits.slice(2);
  if (digits && !digits.startsWith("0")) digits = "0" + digits;
  return digits;
}

function checkPhone(phone) {
  const issues = [];
  const digits = normalizePhone(phone);
  if (digits.length !== 11) {
    issues.push(`phone has ${digits.length} digits, Egyptian mobiles have 11`);
  } else if (!EG_PREFIXES.has(digits.slice(0, 3))) {
    issues.push(`prefix ${digits.slice(0, 3)} is not an Egyptian mobile prefix (010/011/012/015)`);
  }
  return issues;
}

function checkAddress(governorate, city, address, minLen) {
  const issues = [];
  const limit = minLen === undefined ? minAddressLen() : minLen;
  const gov = String(governorate || "").trim().toLowerCase();
  const cty = String(city || "").trim().toLowerCase();
  const addr = String(address || "").trim().toLowerCase();
  if (!gov) {
    issues.push("governorate is missing");
  } else if (GOVERNORATES[gov] && cty && !GOVERNORATES[gov].includes(cty)) {
    const elsewhere = Object.keys(GOVERNORATES).find((g) => GOVERNORATES[g].includes(cty));
    if (elsewhere) {
      issues.push(`city '${city}' belongs to ${elsewhere}, not ${governorate}`);
    } else {
      issues.push(`city '${city}' is not a known city in ${governorate}, verify manually`);
    }
  }
  if (addr.length < limit) issues.push("address is too short to deliver to");
  if (!LANDMARK_HINTS.some((h) => addr.includes(h))) {
    issues.push("no landmark in address, add one (next to / behind / near ...) or the courier will call and fail");
  }
  return issues;
}

function classifyReply(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return "needs_human";
  if (REFUSED.some((w) => t.includes(w))) return "refused";
  if (POSTPONE.some((w) => t.includes(w))) return "postpone";
  if (CONFIRMED.some((w) => t.includes(w))) return "confirmed";
  return "needs_human";
}

function checkOrder(order) {
  const issues = checkPhone(order.phone || "").concat(
    checkAddress(order.governorate || "", order.city || "", order.address || ""));
  return { order_id: order.order_id, ship: issues.length === 0, issues };
}

function issueCategory(issue) {
  const text = issue.toLowerCase();
  if (text.includes("also appears")) return "duplicate_phone";
  if (text.includes("phone") || text.includes("prefix") || text.includes("digits")) return "phone";
  if (text.includes("city")) return "city_governorate";
  if (text.includes("governorate is missing")) return "governorate_missing";
  if (text.includes("too short")) return "address_too_short";
  if (text.includes("landmark")) return "no_landmark";
  return "other";
}

// A small CSV reader that respects quoted fields, so a comma inside an
// address does not split the row. Returns an array of field arrays.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // Carriage returns are skipped; the newline does the work.
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function rowProblem(header, fields) {
  if (fields.length !== header.length) return "wrong number of fields for the header";
  const row = Object.fromEntries(header.map((h, i) => [h, fields[i]]));
  if (!String(row.order_id || "").trim()) return "order_id is empty";
  if (!String(row.phone || "").trim()) return "phone is empty";
  return null;
}

function loadBatch(csvPath) {
  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("file is empty, no header row found");
  const header = rows[0].map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error("missing required columns: " + missing.join(", "));
  const results = [];
  const malformed = [];
  const duplicates = [];
  const seenOrders = new Map();
  const seenPhones = new Map();
  for (let idx = 1; idx < rows.length; idx++) {
    const lineno = idx + 1;
    const fields = rows[idx];
    const reason = rowProblem(header, fields);
    if (reason) {
      const data = {};
      header.forEach((h, i) => { if (i < fields.length) data[h] = fields[i]; });
      malformed.push({ row: lineno, reason, data });
      logLine("WARNING", `malformed row ${lineno}: ${reason}`);
      continue;
    }
    const raw = Object.fromEntries(header.map((h, i) => [h, fields[i]]));
    const oid = raw.order_id.trim();
    if (seenOrders.has(oid)) {
      duplicates.push({ row: lineno, type: "order_id", value: oid, first_row: seenOrders.get(oid) });
      logLine("WARNING", `duplicate order_id ${oid} on row ${lineno}`);
      continue;
    }
    seenOrders.set(oid, lineno);
    const result = checkOrder(raw);
    result.phone = raw.phone || "";
    result.governorate = raw.governorate || "";
    result.city = raw.city || "";
    result.address = raw.address || "";
    const phoneKey = normalizePhone(raw.phone || "");
    if (phoneKey && seenPhones.has(phoneKey)) {
      duplicates.push({ row: lineno, type: "phone", value: phoneKey, first_row: seenPhones.get(phoneKey), order_id: oid });
      result.issues.push(`phone also appears on the order from row ${seenPhones.get(phoneKey)}`);
      result.ship = false;
      logLine("WARNING", `duplicate phone ${phoneKey} on row ${lineno}`);
    } else {
      if (!seenPhones.has(phoneKey)) seenPhones.set(phoneKey, lineno);
    }
    if (header.includes("reply")) result.reply_class = classifyReply(raw.reply || "");
    result.row = lineno;
    results.push(result);
  }
  return { results, malformed, duplicates };
}

function batchSummary(results, malformed, duplicates) {
  const counts = new Map();
  for (const r of results) {
    for (const issue of r.issues) {
      const cat = issueCategory(issue);
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }
  const issueTypes = {};
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => { issueTypes[k] = v; });
  const ship = results.filter((r) => r.ship).length;
  return {
    total_orders: results.length,
    ship,
    no_ship: results.length - ship,
    issue_types: issueTypes,
    results,
    malformed_rows: malformed,
    duplicates,
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CHECKS = [
  ["phone", "Phone", "eleven digits, an Egyptian mobile prefix"],
  ["city_governorate", "City and governorate", "the city sits inside the stated governorate"],
  ["governorate_missing", "Governorate", "stated"],
  ["address_too_short", "Address length", "long enough to deliver to"],
  ["no_landmark", "Landmark", "a landmark is named"],
  ["duplicate_phone", "Phone appears once", "this order only"],
];

function stampSvg(ship) {
  const [wordA, wordB] = ship ? ["CLEARED", "TO SHIP"] : ["NEEDS", "REVIEW"];
  return `<svg class="stamp" width="104" height="104" viewBox="0 0 104 104" xmlns="http://www.w3.org/2000/svg" ` +
    `role="img" aria-label="verdict stamp: ${wordA} ${wordB}">` +
    `<g transform="rotate(-6 52 52)" fill="none" stroke="#C73E1D">` +
    `<circle cx="52" cy="52" r="47" stroke-width="2.6"/>` +
    `<circle cx="52" cy="52" r="38" stroke-width="1"/>` +
    `<text x="52" y="50" text-anchor="middle" fill="#C73E1D" stroke="none" ` +
    `font-family="IBM Plex Mono, monospace" font-size="12.5" letter-spacing="1.5">${wordA}</text>` +
    `<text x="52" y="68" text-anchor="middle" fill="#C73E1D" stroke="none" ` +
    `font-family="IBM Plex Mono, monospace" font-size="12.5" letter-spacing="1.5">${wordB}</text>` +
    `</g></svg>`;
}

function sheetHtml(result) {
  const byCat = {};
  for (const issue of result.issues) {
    const cat = issueCategory(issue);
    (byCat[cat] = byCat[cat] || []).push(issue);
  }
  const rows = [];
  const known = new Set(CHECKS.map((c) => c[0]));
  for (const [key, label, clearText] of CHECKS) {
    if (byCat[key]) {
      for (const issue of byCat[key]) {
        rows.push(`<div class="check"><span class="clab">${label}</span>` +
          `<span class="cfind bad"><i class="tick"></i>${escapeHtml(issue)}</span></div>`);
      }
    } else {
      rows.push(`<div class="check"><span class="clab">${label}</span>` +
        `<span class="cfind">${clearText}</span></div>`);
    }
  }
  for (const [key, issues] of Object.entries(byCat)) {
    if (!known.has(key)) {
      for (const issue of issues) {
        rows.push(`<div class="check"><span class="clab">Finding</span>` +
          `<span class="cfind bad"><i class="tick"></i>${escapeHtml(issue)}</span></div>`);
      }
    }
  }
  const ship = result.ship;
  const verdict = ship ? "This address may ship." : "Held. A human should look before anything is dispatched.";
  const place = [result.city || "", result.governorate || ""].filter(Boolean).join(", ");
  return `<section class="sheet">
<p class="slabel">Order ${escapeHtml(result.order_id ?? "")} · inspected from row ${result.row ?? "-"}</p>
<p class="addr">${escapeHtml(result.address || "")}</p>
<p class="meta">${escapeHtml(result.phone || "")} · ${escapeHtml(place)}</p>
<div class="checks">${rows.join("")}</div>
<div class="verdict"><p class="vtext">${verdict}</p>${stampSvg(ship)}</div>
</section>`;
}

function writeHtmlReport(summary, outPath) {
  const findings = Object.entries(summary.issue_types).map(([k, v]) =>
    `<div class="fline"><span class="clab">${escapeHtml(k.replace(/_/g, " "))}</span>` +
    `<span class="cfind">${v}</span></div>`).join("") ||
    '<p class="quiet">No findings. Every address passed inspection.</p>';
  const sheets = summary.results.map(sheetHtml).join("\n");
  const aside = [];
  for (const m of summary.malformed_rows) aside.push(`row ${m.row} set aside: ${escapeHtml(m.reason)}`);
  for (const d of summary.duplicates) {
    aside.push(`row ${d.row} duplicate ${escapeHtml(d.type)} ${escapeHtml(d.value)}, first seen on row ${d.first_row}`);
  }
  const annex = aside.map((a) => `<p>${a}</p>`).join("") || "<p>Nothing was set aside.</p>";
  const mark = '<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg" role="img" ' +
    'aria-label="address validator seal"><rect x="2" y="2" width="30" height="30" rx="7" fill="#C73E1D"/>' +
    '<path d="M10 17.5 L15 22 L24 11.5" fill="none" stroke="#F4F1EA" stroke-width="3" stroke-linecap="round"/></svg>';
  const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Address Quality Certificate</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;background:#F4F1EA;color:#1A1A18;font-family:"Newsreader",Georgia,serif;font-weight:300;
font-variant-numeric:tabular-nums}
.page{max-width:640px;margin:0 auto;padding:88px 28px 120px}
.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
.clab{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.18em;
text-transform:uppercase;color:#8A8578}
header{margin-bottom:96px}
header .markrow{display:flex;align-items:center;gap:14px;margin-bottom:44px}
header .markrow span{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.22em;color:#8A8578}
h1{font-size:40px;font-weight:300;line-height:1.12;margin:0 0 22px}
.lede{font-size:19px;line-height:1.65;margin:0;max-width:34em}
h2{font-size:13px;font-family:"IBM Plex Mono",monospace;font-weight:500;letter-spacing:.22em;
text-transform:uppercase;color:#8A8578;margin:0 0 26px}
.findings{margin-bottom:110px}
.fline,.check{display:flex;gap:24px;padding:7px 0;align-items:baseline}
.fline .clab,.check .clab{flex:0 0 21ch}
.cfind{font-size:16.5px;line-height:1.55}
.cfind.bad{font-weight:400}
.tick{display:inline-block;width:7px;height:7px;background:#C73E1D;margin-right:10px}
.sheet{margin-bottom:104px}
.slabel{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.2em;color:#8A8578;
text-transform:uppercase;margin:0 0 30px}
.addr{font-size:23px;line-height:1.45;margin:0 0 8px}
.meta{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#8A8578;margin:0 0 38px}
.checks{margin-bottom:8px}
.verdict{border-top:1px solid #D8D2C4;margin-top:30px;padding-top:26px;display:flex;
justify-content:space-between;align-items:center;gap:28px}
.vtext{font-size:19px;font-style:italic;line-height:1.5;margin:0;max-width:22em}
.stamp{flex:0 0 auto;animation:seal .6s cubic-bezier(.3,.7,.3,1) both}
@keyframes seal{from{opacity:0;transform:scale(1.35)} to{opacity:1;transform:scale(1)}}
.annex{border-top:1px solid #D8D2C4;padding-top:30px;font-family:"IBM Plex Mono",monospace;
font-size:12px;line-height:1.9;color:#8A8578}
.annex h2{margin-bottom:14px}
.annex p{margin:0}
.quiet{font-size:17px}
@media (prefers-reduced-motion: reduce){.stamp{animation:none}}
@media print{body{background:#fff} .stamp{animation:none}}
</style></head><body>
<main class="page">
<header>
<div class="markrow">${mark}<span>ADDRESS VALIDATOR</span></div>
<h1>Address Quality<br>Certificate</h1>
<p class="lede">${summary.total_orders} addresses were inspected before dispatch.
${summary.ship} cleared to ship. ${summary.no_ship} held for review.</p>
</header>
<section class="findings"><h2>Findings across the batch</h2>${findings}</section>
${sheets}
<footer class="annex"><h2>Set aside before inspection</h2>${annex}</footer>
</main></body></html>`;
  fs.writeFileSync(outPath, doc, "utf-8");
}

const DEMO = [
  { order_id: 1, phone: "01012345678", governorate: "Gharbia", city: "Tanta",
    address: "El Bahr street, next to El Tawfiq pharmacy" },
  { order_id: 2, phone: "0223456789", governorate: "Gharbia", city: "Mansoura",
    address: "street 5" },
  { order_id: 3, phone: "0114", governorate: "", city: "Tanta", address: "house 12" },
];

function runDemo() {
  for (const order of DEMO) {
    const r = checkOrder(order);
    console.log(`{ order_id: ${r.order_id}, ship: ${r.ship}, issues: ${JSON.stringify(r.issues)} }`);
  }
  console.log();
  for (const reply of ["Confirmed, ship the order", "Leave it for tomorrow instead", "Cancel the order", "How much is shipping?", ""]) {
    console.log(`${JSON.stringify(reply).padEnd(28)} -> ${classifyReply(reply)}`);
  }
  return 0;
}

function parseArgs(argv) {
  const args = { csvFile: null, jsonOut: null, reportOut: null, strict: false, logFile: process.env.VALIDATOR_LOG_FILE || "validator.log" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.jsonOut = argv[++i];
    else if (a === "--report") args.reportOut = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--log") args.logFile = argv[++i];
    else if (a.startsWith("--")) { console.error(`error: unknown option ${a}`); process.exit(2); }
    else if (!args.csvFile) args.csvFile = a;
    else { console.error(`error: unexpected argument ${a}`); process.exit(2); }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  logStream = fs.createWriteStream(args.logFile, { flags: "a" });
  logLine("INFO", "run started");
  if (!args.csvFile) return runDemo();
  let batch;
  try {
    batch = loadBatch(args.csvFile);
  } catch (err) {
    logLine("ERROR", `cannot read input: ${err.message}`);
    console.error(`error: ${err.message}`);
    return 2;
  }
  const { results, malformed, duplicates } = batch;
  const summary = batchSummary(results, malformed, duplicates);
  for (const r of results) {
    const state = r.ship ? "SHIP" : "NO-SHIP";
    console.log(`${r.order_id}  ${state}  issues=${r.issues.length}`);
    for (const issue of r.issues) console.log(`  - ${issue}`);
  }
  if (malformed.length > 0) {
    console.log(`\nMalformed rows skipped: ${malformed.length}`);
    for (const m of malformed) console.log(`  row ${m.row}: ${m.reason}`);
  }
  if (duplicates.length > 0) {
    console.log(`\nDuplicates found: ${duplicates.length}`);
    for (const d of duplicates) console.log(`  row ${d.row}: ${d.type} ${d.value} first seen on row ${d.first_row}`);
  }
  console.log(`\n${summary.total_orders} orders, ${summary.ship} can ship, ${summary.no_ship} cannot.`);
  logLine("INFO", `batch checked ${results.length} orders, ${malformed.length} malformed, ${duplicates.length} duplicates`);
  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`JSON report written to ${args.jsonOut}`);
  }
  if (args.reportOut) {
    writeHtmlReport(summary, args.reportOut);
    console.log(`HTML report written to ${args.reportOut}`);
  }
  if (args.strict && (malformed.length > 0 || duplicates.length > 0)) return 2;
  return 0;
}

module.exports = { normalizePhone, checkPhone, checkAddress, classifyReply, checkOrder, loadBatch, batchSummary, issueCategory };

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (logStream) logStream.end(() => process.exit(code));
  else process.exit(code);
}
