# Redesign Critique, Address Validator (Ma certificate + English pass)

Redesign executed 2026-10-24 against `DESIGN-RESEARCH.md` §3.11 and the
18-item anti-list. This file is the evidence record.

## What changed

- `validator.py`: the HTML report was rebuilt from a Georgia-and-cards page
  with two SVG bar charts into a Japanese Ma inspection certificate, bone
  `#F4F1EA`, sumi `#1A1A18`, stone `#8A8578`, one hairline `#D8D2C4`,
  vermillion `#C73E1D` rationed to the seal mark, the failed-finding ticks
  and the verdict stamp. Newsreader light sets everything read slowly;
  IBM Plex Mono sets labels and the annex. One sheet per order: the address
  as inspected, six inspection lines with quiet findings, a single hairline,
  the verdict sentence, and the vermillion stamp (CLEARED TO SHIP /
  NEEDS REVIEW) settling in over 600ms, the only motion on the page.
  Batch findings are a list of lines with counts; there are no charts.
  Malformed and duplicate rows are filed in a mono annex, "Set aside
  before inspection".
- To let the certificate print what was inspected, `load_batch` results now
  also carry the order's phone, governorate, city and address (additive
  fields only; every pre-existing field, verdict and count is unchanged,
  and the JSON simply gains the same fields).
- English conversion: the one Arabic string in an output message (the
  landmark hint) is now English; the demo replies and the sample CSV's
  reply column were translated to English equivalents. Deliberate exception,
  recorded not smuggled: the reply classifier and the landmark hints still
  *recognise* Arabic customer messages, because that is input the tool
  exists to read, not interface. README states this in plain words.
- `tests/test_validator.py`: the one HTML assertion updated from "SVG bars
  and the ship split" to the certificate's real markers (title, both stamp
  verdicts, Newsreader).
- `README.md`: `--report` description rewritten; classifier section now
  states the English-interface / Arabic-input line explicitly.
- `DESIGN.md`: added.

## Evidence

- Tests: **26/26 before, 26/26 after** (`python3 tests/test_validator.py`).
- Verdicts unchanged, three ways:
  - Batch run on `sample_orders.csv`: terminal output identical to the
    pre-redesign baseline except the translated landmark-hint wording and
    the report-written notice, same orders, same issue lists, same
    **3 ship / 3 no-ship** split, same duplicate phone caught.
  - Demo mode: the five reply classifications come back in the identical
    order, confirmed, postpone, refused, needs_human, needs_human.
  - The generated certificate contains both stamps (3 × CLEARED TO SHIP,
    3 × NEEDS REVIEW across the sample's six sheets), matching the split.
- Judgment logic untouched: `check_phone`, `check_address` (one message
  string aside), `check_order`, `classify_reply` and the duplicate handling
  in `load_batch` compute exactly what they computed before.

## Anti-list items killed in this project

KPI stat-card row (5), card stack (6), rounded-everything + soft shadow (4),
traffic-light palette (7), pill badges (8), centred-everything (10,
margin-led, off-centre composition), proportional numbers (16), no brand
mark (17, the vermillion seal), decorative/absent motion (18, one stamp,
one reason), filler copy (15, findings are written as short verdicts).

## Honest gaps

- Newsreader and IBM Plex Mono load from Google Fonts; offline the
  certificate falls back to Georgia/system mono and keeps its layout, but
  the light-serif quiet depends on Newsreader landing.
- Headless Chromium in this VM hangs on screenshot capture (two attempts),
  so the certificate was verified by markup inspection and test assertions,
  not by a rendered screenshot. The composition risk of the Ma direction,
  emptiness reading as unfinished, can only be fully judged on a render;
  spacing follows the shared token rhythm and the stamp/hairline land in
  the same place on every sheet to hold that rhythm.
- The certificate shows the address exactly as supplied in the CSV. That is
  the point of an inspection document, but it means a report file carries
  customer addresses, same exposure the JSON already had, worth knowing
  before anyone emails one around.
