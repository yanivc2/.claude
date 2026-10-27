// 🔁 הסוכן עולה שוב לבד אם נפל (בעלים 27/10). עם "רק פעמון" אין בדיקה קבועה שתגלה סוכן כבוי —
// לכן `npm start` מריץ את agent/run-forever.mjs, שמעלה אותו שוב אחרי קריסה ועוצר ביציאה מכוונת.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nextDelayMs, MAX_DELAY_MS, HEALTHY_RUN_MS } from '../agent/run-forever.mjs';

const SUPERVISOR = path.resolve('agent/run-forever.mjs');

test('restart delay: 10s first, doubling on quick crashes up to 5 minutes, reset after a healthy run', () => {
  const base = 10_000;
  assert.equal(nextDelayMs(0, 1_000, base), 10_000);
  assert.equal(nextDelayMs(10_000, 1_000, base), 20_000);
  assert.equal(nextDelayMs(160_000, 1_000, base), MAX_DELAY_MS);
  assert.equal(nextDelayMs(MAX_DELAY_MS, 1_000, base), MAX_DELAY_MS, 'never more than 5 minutes');
  assert.equal(nextDelayMs(MAX_DELAY_MS, HEALTHY_RUN_MS, base), 10_000, 'ran 10 minutes → a new problem, start over');
});

function runSupervisor(agentScript) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SUPERVISOR], {
      env: { ...process.env, BANK_AGENT_SCRIPT: agentScript, BANK_AGENT_RESTART_MS: '50' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.on('exit', (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

test('a crashed agent is started again; a deliberate exit (code 0) stops everything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sup-'));
  const marker = path.join(dir, 'runs.txt');
  const fake = path.join(dir, 'fake-agent.mjs');
  // ריצה 1 ו-2 קורסות, ריצה 3 יוצאת כמו Ctrl+C (קוד 0).
  fs.writeFileSync(fake, `import fs from 'node:fs';
const f = ${JSON.stringify(marker)};
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
fs.writeFileSync(f, String(n));
console.log('run ' + n);
process.exit(n < 3 ? 1 : 0);
`);
  const { code, out } = await runSupervisor(fake);
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), '3', 'started three times');
  assert.equal((out.match(/מפעיל אותו שוב/g) || []).length, 2, out);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an agent that stops on purpose is not restarted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sup-'));
  const fake = path.join(dir, 'fake-agent.mjs');
  fs.writeFileSync(fake, `console.log('bye'); process.exit(0);\n`);
  const { code, out } = await runSupervisor(fake);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /מפעיל אותו שוב/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm start runs the supervisor; the batch file calls npm so it resumes', () => {
  const pkg = JSON.parse(fs.readFileSync('agent/package.json', 'utf8'));
  assert.equal(pkg.scripts.start, 'node run-forever.mjs');
  assert.equal(pkg.scripts['agent-once'], 'node bank-agent.mjs');
  const bat = fs.readFileSync('agent/start-agent.bat', 'utf8');
  assert.match(bat, /^call npm start\r?$/m, 'without "call" a batch never returns from npm.cmd');
});

test('Ctrl+C (SIGINT) to the supervisor stops the agent and does not restart it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sup-'));
  const fake = path.join(dir, 'fake-agent.mjs');
  fs.writeFileSync(fake, `process.on('SIGINT', () => process.exit(0)); console.log('up'); setInterval(() => {}, 1000);\n`);
  const p = spawn(process.execPath, [SUPERVISOR], { env: { ...process.env, BANK_AGENT_SCRIPT: fake, BANK_AGENT_RESTART_MS: '50' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => { const t = setInterval(() => { if (out.includes('up')) { clearInterval(t); r(); } }, 20); });
  p.kill('SIGINT');
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 0);
  assert.doesNotMatch(out, /מפעיל אותו שוב/);
  fs.rmSync(dir, { recursive: true, force: true });
});
