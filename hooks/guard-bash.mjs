// PreToolUse: Bash
//
// Three refusals, in order of severity:
//   1. destructive commands that cannot be undone
//   2. any mutation aimed at OneDrive (iron rule)
//   3. reading a secrets file into context — deleting a leaked key does not
//      revoke it, so the cheapest fix is never to load one
//
// The patterns are case-insensitive because PowerShell's -match was, and this
// script has to refuse everything its predecessor refused.

import { readPayload, block, ONEDRIVE } from './_lib.mjs';

const command = readPayload().tool_input?.command ?? '';

if (/rm -rf|reset --hard|drop table/i.test(command)) {
  block('BLOCKED: destructive command');
}

const MUTATES =
  /(Move-Item|Remove-Item|Copy-Item|Set-Content|Out-File|New-Item|Rename-Item|\bmv\b|\bcp\b|\brm\b|\bdel\b)/i;

if (MUTATES.test(command) && ONEDRIVE.test(command)) {
  block('BLOCKED: OneDrive is read-only (iron rule)');
}

const READS = /(cat|type|Get-Content|notepad|more|head|tail|Select-String)/i;
const SECRETS = /\.env(?!\.example)|session\.json|client_secret/i;

if (READS.test(command) && SECRETS.test(command)) {
  block('BLOCKED: secrets file must not enter context');
}

process.exit(0);
