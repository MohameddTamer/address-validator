#!/usr/bin/env python3
import argparse, csv, html, json, logging, os, re, sys
from collections import Counter

REQUIRED_COLUMNS = ["order_id", "phone", "governorate", "city", "address"]
EG_PREFIXES = {"010", "011", "012", "015"}
GOVERNORATES = {
    "gharbia": ["tanta", "el mahalla", "kafr el zayat", "zefta", "santa", "basyoun"],
    "cairo": ["nasr city", "heliopolis", "maadi", "dokki", "shubra"],
    "giza": ["dokki", "mohandessin", "6th of october", "sheikh zayed", "haram"],
    "alexandria": ["smouha", "sidi gaber", "montaza", "agami"],
    "dakahlia": ["mansoura", "talkha", "mit ghamr"],
}
LANDMARK_HINTS = ["next to", "behind", "in front of", "near", "beside", "opposite",
                  "بجوار", "امام", "أمام", "خلف", "جنب", "عند"]
log = logging.getLogger("address_validator")


def min_address_len():
    return int(os.environ.get("VALIDATOR_MIN_ADDRESS_LEN", "12"))


def normalize_phone(phone):
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("20") and len(digits) > 11:
        digits = digits[2:]
    if digits and not digits.startswith("0"):
        digits = "0" + digits
    return digits


def check_phone(phone):
    issues = []
    digits = normalize_phone(phone)
    if len(digits) != 11:
        issues.append(f"phone has {len(digits)} digits, Egyptian mobiles have 11")
    elif digits[:3] not in EG_PREFIXES:
        issues.append(f"prefix {digits[:3]} is not an Egyptian mobile prefix (010/011/012/015)")
    return issues


def check_address(governorate, city, address, min_len=None):
    issues = []
    min_len = min_address_len() if min_len is None else min_len
    gov = (governorate or "").strip().lower()
    cty = (city or "").strip().lower()
    addr = (address or "").strip().lower()
    if not gov:
        issues.append("governorate is missing")
    elif gov in GOVERNORATES and cty and cty not in GOVERNORATES[gov]:
        known_elsewhere = [g for g, cities in GOVERNORATES.items() if cty in cities]
        if known_elsewhere:
            issues.append(f"city '{city}' belongs to {known_elsewhere[0]}, not {governorate}")
        else:
            issues.append(f"city '{city}' is not a known city in {governorate}, verify manually")
    if len(addr) < min_len:
        issues.append("address is too short to deliver to")
    if not any(h in addr for h in LANDMARK_HINTS):
        issues.append("no landmark in address, add one (next to / behind / near ...) or the courier will call and fail")
    return issues


CONFIRMED = ["تمام", "اكد", "أكد", "confirmed", "yes", "ايوه", "أيوه", "ماشي", "اوكي", "ok"]
POSTPONE = ["بكره", "بكرة", "بعدين", "الاسبوع الجاي", "later", "tomorrow", "مش دلوقتي"]
REFUSED = ["الغاء", "إلغاء", "مش عايز", "cancel", "لا شكرا", "لأ"]


def classify_reply(text):
    t = (text or "").strip().lower()
    if not t:
        return "needs_human"
    if any(w in t for w in REFUSED):
        return "refused"
    if any(w in t for w in POSTPONE):
        return "postpone"
    if any(w in t for w in CONFIRMED):
        return "confirmed"
    return "needs_human"


def check_order(order):
    issues = check_phone(order.get("phone", "")) + check_address(
        order.get("governorate", ""), order.get("city", ""), order.get("address", ""))
    return {"order_id": order.get("order_id"), "ship": len(issues) == 0, "issues": issues}


def issue_category(issue):
    text = issue.lower()
    if "also appears" in text:
        return "duplicate_phone"
    if "phone" in text or "prefix" in text or "digits" in text:
        return "phone"
    if "city" in text:
        return "city_governorate"
    if "governorate is missing" in text:
        return "governorate_missing"
    if "too short" in text:
        return "address_too_short"
    if "landmark" in text:
        return "no_landmark"
    return "other"


def row_problem(raw):
    if None in raw or any(v is None for v in raw.values()):
        return "wrong number of fields for the header"
    if not (raw.get("order_id") or "").strip():
        return "order_id is empty"
    if not (raw.get("phone") or "").strip():
        return "phone is empty"
    return None


def load_batch(path):
    # Duplicate order ids are skipped. A repeated phone is kept but flagged on the later order.
    results, malformed, duplicates = [], [], []
    seen_orders, seen_phones = {}, {}
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise ValueError("file is empty, no header row found")
        missing = [c for c in REQUIRED_COLUMNS if c not in reader.fieldnames]
        if missing:
            raise ValueError("missing required columns: " + ", ".join(missing))
        for lineno, raw in enumerate(reader, start=2):
            reason = row_problem(raw)
            if reason:
                malformed.append({"row": lineno, "reason": reason, "data": {k: v for k, v in raw.items() if k}})
                log.warning("malformed row %s: %s", lineno, reason)
                continue
            oid = raw["order_id"].strip()
            if oid in seen_orders:
                duplicates.append({"row": lineno, "type": "order_id", "value": oid, "first_row": seen_orders[oid]})
                log.warning("duplicate order_id %s on row %s", oid, lineno)
                continue
            seen_orders[oid] = lineno
            result = check_order(raw)
            # The certificate prints what was inspected, so the report needs the address itself.
            result.update({"phone": raw.get("phone", ""), "governorate": raw.get("governorate", ""),
                           "city": raw.get("city", ""), "address": raw.get("address", "")})
            phone_key = normalize_phone(raw.get("phone", ""))
            if phone_key and phone_key in seen_phones:
                duplicates.append({"row": lineno, "type": "phone", "value": phone_key,
                                   "first_row": seen_phones[phone_key], "order_id": oid})
                result["issues"].append(f"phone also appears on the order from row {seen_phones[phone_key]}")
                result["ship"] = False
                log.warning("duplicate phone %s on row %s", phone_key, lineno)
            else:
                seen_phones.setdefault(phone_key, lineno)
            if "reply" in reader.fieldnames:
                result["reply_class"] = classify_reply(raw.get("reply", ""))
            result["row"] = lineno
            results.append(result)
    return results, malformed, duplicates


def batch_summary(results, malformed, duplicates):
    categories = Counter()
    for r in results:
        for issue in r["issues"]:
            categories[issue_category(issue)] += 1
    ship = sum(1 for r in results if r["ship"])
    return {
        "total_orders": len(results),
        "ship": ship,
        "no_ship": len(results) - ship,
        "issue_types": dict(categories.most_common()),
        "results": results,
        "malformed_rows": malformed,
        "duplicates": duplicates,
    }


CHECKS = [
    ("phone", "Phone", "eleven digits, an Egyptian mobile prefix"),
    ("city_governorate", "City and governorate", "the city sits inside the stated governorate"),
    ("governorate_missing", "Governorate", "stated"),
    ("address_too_short", "Address length", "long enough to deliver to"),
    ("no_landmark", "Landmark", "a landmark is named"),
    ("duplicate_phone", "Phone appears once", "this order only"),
]


def stamp_svg(ship):
    word_a, word_b = ("CLEARED", "TO SHIP") if ship else ("NEEDS", "REVIEW")
    return (f'<svg class="stamp" width="104" height="104" viewBox="0 0 104 104" xmlns="http://www.w3.org/2000/svg" '
            f'role="img" aria-label="verdict stamp: {word_a} {word_b}">'
            '<g transform="rotate(-6 52 52)" fill="none" stroke="#C73E1D">'
            '<circle cx="52" cy="52" r="47" stroke-width="2.6"/>'
            '<circle cx="52" cy="52" r="38" stroke-width="1"/>'
            f'<text x="52" y="50" text-anchor="middle" fill="#C73E1D" stroke="none" '
            f'font-family="IBM Plex Mono, monospace" font-size="12.5" letter-spacing="1.5">{word_a}</text>'
            f'<text x="52" y="68" text-anchor="middle" fill="#C73E1D" stroke="none" '
            f'font-family="IBM Plex Mono, monospace" font-size="12.5" letter-spacing="1.5">{word_b}</text>'
            '</g></svg>')


def sheet_html(result):
    by_cat = {}
    for issue in result["issues"]:
        by_cat.setdefault(issue_category(issue), []).append(issue)
    rows = []
    for key, label, clear_text in CHECKS:
        if key in by_cat:
            for issue in by_cat[key]:
                rows.append(f'<div class="check"><span class="clab">{label}</span>'
                            f'<span class="cfind bad"><i class="tick"></i>{html.escape(issue)}</span></div>')
        else:
            rows.append(f'<div class="check"><span class="clab">{label}</span>'
                        f'<span class="cfind">{clear_text}</span></div>')
    for key, issues in by_cat.items():
        if key not in {c[0] for c in CHECKS}:
            for issue in issues:
                rows.append(f'<div class="check"><span class="clab">Finding</span>'
                            f'<span class="cfind bad"><i class="tick"></i>{html.escape(issue)}</span></div>')
    ship = result["ship"]
    verdict = "This address may ship." if ship else "Held. A human should look before anything is dispatched."
    place = ", ".join(x for x in [result.get("city", ""), result.get("governorate", "")] if x)
    return f"""<section class="sheet">
<p class="slabel">Order {html.escape(str(result.get("order_id", "")))} · inspected from row {result.get("row", "—")}</p>
<p class="addr">{html.escape(result.get("address", ""))}</p>
<p class="meta">{html.escape(result.get("phone", ""))} · {html.escape(place)}</p>
<div class="checks">{''.join(rows)}</div>
<div class="verdict"><p class="vtext">{verdict}</p>{stamp_svg(ship)}</div>
</section>"""


def write_html_report(summary, path):
    findings = "".join(
        f'<div class="fline"><span class="clab">{html.escape(k.replace("_", " "))}</span>'
        f'<span class="cfind">{v}</span></div>'
        for k, v in summary["issue_types"].items()) or '<p class="quiet">No findings. Every address passed inspection.</p>'
    sheets = "\n".join(sheet_html(r) for r in summary["results"])
    aside = []
    for m in summary["malformed_rows"]:
        aside.append(f"row {m['row']} set aside: {html.escape(m['reason'])}")
    for d in summary["duplicates"]:
        aside.append(f"row {d['row']} duplicate {html.escape(d['type'])} {html.escape(d['value'])}, first seen on row {d['first_row']}")
    annex = "".join(f"<p>{a}</p>" for a in aside) or "<p>Nothing was set aside.</p>"
    mark = ('<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg" role="img" '
            'aria-label="address validator seal"><rect x="2" y="2" width="30" height="30" rx="7" fill="#C73E1D"/>'
            '<path d="M10 17.5 L15 22 L24 11.5" fill="none" stroke="#F4F1EA" stroke-width="3" stroke-linecap="round"/></svg>')
    doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Address Quality Certificate</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#F4F1EA;color:#1A1A18;font-family:"Newsreader",Georgia,serif;font-weight:300;
font-variant-numeric:tabular-nums}}
.page{{max-width:640px;margin:0 auto;padding:88px 28px 120px}}
.mono{{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}}
.clab{{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.18em;
text-transform:uppercase;color:#8A8578}}
header{{margin-bottom:96px}}
header .markrow{{display:flex;align-items:center;gap:14px;margin-bottom:44px}}
header .markrow span{{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.22em;color:#8A8578}}
h1{{font-size:40px;font-weight:300;line-height:1.12;margin:0 0 22px}}
.lede{{font-size:19px;line-height:1.65;margin:0;max-width:34em}}
h2{{font-size:13px;font-family:"IBM Plex Mono",monospace;font-weight:500;letter-spacing:.22em;
text-transform:uppercase;color:#8A8578;margin:0 0 26px}}
.findings{{margin-bottom:110px}}
.fline,.check{{display:flex;gap:24px;padding:7px 0;align-items:baseline}}
.fline .clab,.check .clab{{flex:0 0 21ch}}
.cfind{{font-size:16.5px;line-height:1.55}}
.cfind.bad{{font-weight:400}}
.tick{{display:inline-block;width:7px;height:7px;background:#C73E1D;margin-right:10px}}
.sheet{{margin-bottom:104px}}
.slabel{{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.2em;color:#8A8578;
text-transform:uppercase;margin:0 0 30px}}
.addr{{font-size:23px;line-height:1.45;margin:0 0 8px}}
.meta{{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#8A8578;margin:0 0 38px}}
.checks{{margin-bottom:8px}}
.verdict{{border-top:1px solid #D8D2C4;margin-top:30px;padding-top:26px;display:flex;
justify-content:space-between;align-items:center;gap:28px}}
.vtext{{font-size:19px;font-style:italic;line-height:1.5;margin:0;max-width:22em}}
.stamp{{flex:0 0 auto;animation:seal .6s cubic-bezier(.3,.7,.3,1) both}}
@keyframes seal{{from{{opacity:0;transform:scale(1.35)}} to{{opacity:1;transform:scale(1)}}}}
.annex{{border-top:1px solid #D8D2C4;padding-top:30px;font-family:"IBM Plex Mono",monospace;
font-size:12px;line-height:1.9;color:#8A8578}}
.annex h2{{margin-bottom:14px}}
.annex p{{margin:0}}
.quiet{{font-size:17px}}
@media (prefers-reduced-motion: reduce){{.stamp{{animation:none}}}}
@media print{{body{{background:#fff}} .stamp{{animation:none}}}}
</style></head><body>
<main class="page">
<header>
<div class="markrow">{mark}<span>ADDRESS VALIDATOR</span></div>
<h1>Address Quality<br>Certificate</h1>
<p class="lede">{summary['total_orders']} addresses were inspected before dispatch.
{summary['ship']} cleared to ship. {summary['no_ship']} held for review.</p>
</header>
<section class="findings"><h2>Findings across the batch</h2>{findings}</section>
{sheets}
<footer class="annex"><h2>Set aside before inspection</h2>{annex}</footer>
</main></body></html>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)


DEMO = [
    {"order_id": 1, "phone": "01012345678", "governorate": "Gharbia", "city": "Tanta",
     "address": "El Bahr street, next to El Tawfiq pharmacy"},
    {"order_id": 2, "phone": "0223456789", "governorate": "Gharbia", "city": "Mansoura",
     "address": "street 5"},
    {"order_id": 3, "phone": "0114", "governorate": "", "city": "Tanta", "address": "house 12"},
]


def run_demo():
    for order in DEMO:
        print(check_order(order))
    print()
    for reply in ["Confirmed, ship the order", "Leave it for tomorrow instead", "Cancel the order", "How much is shipping?", ""]:
        print(f"{reply!r:28} -> {classify_reply(reply)}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate COD order addresses, one demo or a CSV batch.")
    ap.add_argument("csv_file", nargs="?", help="CSV with order_id, phone, governorate, city, address and optional reply")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--report", dest="report_out", help="write a standalone HTML report, batch mode only")
    ap.add_argument("--strict", action="store_true", help="exit with code 2 when malformed or duplicate rows are found")
    ap.add_argument("--log", dest="log_file", default=os.environ.get("VALIDATOR_LOG_FILE", "validator.log"))
    args = ap.parse_args(argv)
    logging.basicConfig(filename=args.log_file, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    log.info("run started")
    if not args.csv_file:
        return run_demo()
    try:
        results, malformed, duplicates = load_batch(args.csv_file)
    except (OSError, ValueError) as exc:
        log.error("cannot read input: %s", exc)
        print(f"error: {exc}", file=sys.stderr)
        return 2
    summary = batch_summary(results, malformed, duplicates)
    for r in results:
        state = "SHIP" if r["ship"] else "NO-SHIP"
        print(f"{r['order_id']}  {state}  issues={len(r['issues'])}")
        for issue in r["issues"]:
            print(f"  - {issue}")
    if malformed:
        print(f"\nMalformed rows skipped: {len(malformed)}")
        for m in malformed:
            print(f"  row {m['row']}: {m['reason']}")
    if duplicates:
        print(f"\nDuplicates found: {len(duplicates)}")
        for d in duplicates:
            print(f"  row {d['row']}: {d['type']} {d['value']} first seen on row {d['first_row']}")
    print(f"\n{summary['total_orders']} orders, {summary['ship']} can ship, {summary['no_ship']} cannot.")
    log.info("batch checked %s orders, %s malformed, %s duplicates", len(results), len(malformed), len(duplicates))
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2)
        print(f"JSON report written to {args.json_out}")
    if args.report_out:
        write_html_report(summary, args.report_out)
        print(f"HTML report written to {args.report_out}")
    if args.strict and (malformed or duplicates):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
