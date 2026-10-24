#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from validator import batch_summary, check_address, check_order, check_phone, classify_reply, load_batch

RESULTS = []

def check(name, cond):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)

def write_csv(text):
    fh = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
    fh.write(text); fh.close()
    return fh.name

HEADER = "order_id,phone,governorate,city,address,reply\n"

def main():
    check("a normal mobile passes the phone check", check_phone("01012345678") == [])
    check("a short phone is flagged", any("digits" in i for i in check_phone("0114")))
    check("a landline is flagged for its length", any("digits" in i for i in check_phone("0223456789")))
    check("a non mobile prefix is flagged", any("prefix" in i for i in check_phone("01312345678")))
    check("country code numbers are normalised", check_phone("+201012345678") == [])
    check("an address with a landmark passes", check_address("Gharbia", "Tanta", "El Bahr street, next to the pharmacy") == [])
    check("a city in the wrong governorate is flagged", any("belongs to dakahlia" in i for i in check_address("Gharbia", "Mansoura", "a long enough street near the station")))
    check("a missing landmark is flagged", any("landmark" in i for i in check_address("Gharbia", "Tanta", "12 El Bahr street, flat four, second floor")))
    check("a missing governorate is flagged", any("missing" in i for i in check_address("", "Tanta", "El Bahr street near the pharmacy")))
    check("confirmed reply classifies as confirmed", classify_reply("تمام اكد الاوردر") == "confirmed")
    check("postpone reply classifies as postpone", classify_reply("خليه بكره احسن") == "postpone")
    check("cancel reply classifies as refused", classify_reply("الغاء") == "refused")
    check("silence classifies as needs_human", classify_reply("") == "needs_human")
    check("a clean order can ship", check_order({"order_id": 1, "phone": "01012345678", "governorate": "Gharbia", "city": "Tanta", "address": "El Bahr street next to the pharmacy"})["ship"] is True)

    batch = write_csv(HEADER +
        "1,01012345678,Gharbia,Tanta,El Bahr street next to the pharmacy,yes\n"
        "2,01123456789,Cairo,Nasr City,Makram Ebeid street behind City Stars,confirmed\n"
        "2,01234567890,Giza,Dokki,Tahrir street near the metro,yes\n"
        "3,01012345678,Gharbia,Zefta,Main road beside the post office,yes\n"
        "4,,Gharbia,Tanta,El Bahr street next to the pharmacy,yes\n")
    results, malformed, duplicates = load_batch(batch)
    summary = batch_summary(results, malformed, duplicates)
    check("duplicate order_id is reported and skipped", any(d["type"] == "order_id" for d in duplicates) and len(results) == 3)
    check("duplicate phone is reported and blocks shipping", any(d["type"] == "phone" for d in duplicates) and summary["ship"] == 2 and summary["no_ship"] == 1)
    check("a row with an empty phone is malformed with its row number", len(malformed) == 1 and malformed[0]["row"] == 6)
    check("issue types are counted for the report", summary["issue_types"].get("duplicate_phone") == 1)
    check("reply classification rides along in batch mode", results[0].get("reply_class") == "confirmed")

    try:
        load_batch(write_csv("order_id,phone\n1,01012345678\n")); raised = False
    except ValueError as exc:
        raised = "missing required columns" in str(exc)
    check("missing columns raise a clear error", raised)

    with tempfile.TemporaryDirectory() as td:
        out_json, out_html, out_log = os.path.join(td, "r.json"), os.path.join(td, "r.html"), os.path.join(td, "v.log")
        tool = os.path.join(os.path.dirname(__file__), "..", "validator.py")
        proc = subprocess.run([sys.executable, tool, batch, "--json", out_json, "--report", out_html, "--log", out_log],
                              capture_output=True, text=True)
        check("cli batch exits zero without strict", proc.returncode == 0)
        data = json.load(open(out_json, encoding="utf-8"))
        check("json carries duplicates and malformed rows", len(data["duplicates"]) == 2 and len(data["malformed_rows"]) == 1)
        doc = open(out_html, encoding="utf-8").read()
        check("html report is a certificate with verdict stamps", "Address Quality Certificate" in doc and "CLEARED" in doc and "NEEDS" in doc and "Newsreader" in doc)
        check("log file is written", os.path.exists(out_log) and "batch checked" in open(out_log, encoding="utf-8").read())
        strict = subprocess.run([sys.executable, tool, batch, "--strict", "--log", out_log], capture_output=True, text=True)
        check("strict mode exits nonzero on dirty input", strict.returncode == 2)
        demo = subprocess.run([sys.executable, tool], capture_output=True, text=True)
        check("demo mode still runs with no arguments", demo.returncode == 0 and "confirmed" in demo.stdout)

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} checks passed")
    return 0 if passed == len(RESULTS) else 1

if __name__ == "__main__":
    raise SystemExit(main())
