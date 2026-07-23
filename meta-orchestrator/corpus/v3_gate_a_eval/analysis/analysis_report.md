# V3 Gate-A — Output-Contract Qualification Report

## 1. Integrity
{"arms": ["OLD", "NEW"], "cells": 18, "experiment": "V3_GATE_A_OUTPUT_CONTRACT", "tasks": 9}

## 2. Summary
- OLD valid-applied = 4/9 · NEW valid-applied = 0/9
- NEW − OLD = -4 · paired improvement = -4
- silent_partial = 0 · ambiguous_accepted = 0 · replay_fail = 0

## 3. CLASSIFICATION = FAIL

## 4. Per-task
- black-133: OLD=0 (OLD_PATCH_SCHEMA_INVALID) NEW=0 (NEW_MALFORMED)
- black-1632: OLD=1 (VALID_APPLIED_PATCH) NEW=0 (NEW_MALFORMED)
- black-183: OLD=0 (OLD_PATCH_SCHEMA_INVALID) NEW=0 (NEW_MALFORMED)
- black-234: OLD=1 (VALID_APPLIED_PATCH) NEW=0 (NEW_MALFORMED)
- black-329: OLD=0 (OLD_PATCH_SCHEMA_INVALID) NEW=0 (NEW_MALFORMED)
- black-60: OLD=0 (OLD_PATCH_SCHEMA_INVALID) NEW=0 (NEW_MALFORMED)
- black-74: OLD=0 (OLD_PATCH_SCHEMA_INVALID) NEW=0 (NEW_MALFORMED)
- black-95: OLD=1 (VALID_APPLIED_PATCH) NEW=0 (NEW_MALFORMED)
- cookiecutter-18: OLD=1 (VALID_APPLIED_PATCH) NEW=0 (NEW_MALFORMED)

## 5. Secondary (hidden solve; does not change the class)
{"NEW_hidden_pass": 0, "OLD_hidden_pass": 3}
