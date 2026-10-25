# Changelog

## 2.0.0, 2026-10-24

Rebuilt as a Node.js CLI. The old Python implementation is gone, nothing
in this folder runs on Python anymore.

What changed is the runtime only. The checks, the verdicts, the sample
file, the certificate report and the test count are the same: six sample
orders, three cleared to ship, three held, the duplicate phone still
caught, and the same twenty six checks passing.

## 1.0.0, 2026-10-24

First release as a Python CLI: Egyptian phone, governorate and landmark
checks, WhatsApp reply classification, batch CSV mode with duplicate and
malformed row handling, JSON and HTML certificate reports, strict mode.
