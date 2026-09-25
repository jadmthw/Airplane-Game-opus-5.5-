#!/usr/bin/env node
/*
 * Ridgeline headless test harness (Playwright + SwiftShader WebGL2).
 *
 * Usage:
 *   node tests/harness.js [--params "autostart&noaudio&quality=low"] [--wait 1500]
 *                         [--eval "<js expression, awaited, result printed as JSON>"]...
 *                         [--shot out.png] [--size 1280x720] [--keys "KeyW:2000,Space:500"]
 *                         [--page other.html]
 *
 * Steps run in order: load -> wait for RL.ready -> --wait ms -> each --eval (in order, with
 * --shot/--keys interleaved in the order given on the command line). Always prints console
 * errors/warnings and RL.errors at the end; exits 1 if any page errors occurred.
 *
 * Examples:
 *   node tests/harness.js --shot /tmp/title.png
 *   node tests/harness.js --params "autostart&noaudio" --eval "RL.debug.simulate(20,{throttle:1,pitch:0.3})" --shot /tmp/air.png
 */
'use strict';
const path = require('path');
let playwright;
try { playwright = require('playwright'); }
catch (e) { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const args = process.argv.slice(2);
const steps = [];
let params = 'noaudio';
let size = [1280, 720];
let pageFile = 'index.html';
let initialWait = 800;
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1];
  if (a === '--params') { params = v; i++; }
  else if (a === '--size') { size = v.split('x').map(Number); i++; }
  else if (a === '--page') { pageFile = v; i++; }
  else if (a === '--wait') { steps.push({ wait: Number(v) }); i++; }
  else if (a === '--eval') { steps.push({ evalExpr: v }); i++; }
  else if (a === '--shot') { steps.push({ shot: v }); i++; }
  else if (a === '--keys') { steps.push({ keys: v }); i++; }
  else if (a === '--click') { steps.push({ click: v }); i++; }
  else if (a === '--initial-wait') { initialWait = Number(v); i++; }
  else { console.error('unknown arg ' + a); process.exit(2); }
}

(async () => {
  const browser = await playwright.chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push('[' + t + '] ' + m.text());
    else if (process.env.VERBOSE) console.log('[console.' + t + '] ' + m.text());
  });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + (e && e.stack || e)));
  const url = 'file://' + path.resolve(__dirname, '..', pageFile) + (params ? '?' + params : '');
  await page.goto(url);
  try {
    await page.waitForFunction(() => window.RL && window.RL.ready === true, null, { timeout: 60000 });
  } catch (e) {
    logs.push('[harness] RL.ready never became true');
  }
  await page.waitForTimeout(initialWait);
  for (const s of steps) {
    if (s.wait) await page.waitForTimeout(s.wait);
    if (s.evalExpr) {
      try {
        const r = await page.evaluate(`(async () => { return (${s.evalExpr}); })()`);
        console.log('eval> ' + s.evalExpr.slice(0, 80) + '\n  = ' + JSON.stringify(r, (k, v) =>
          typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
      } catch (e) {
        console.log('eval> ' + s.evalExpr.slice(0, 80) + '\n  ! ' + e.message);
        logs.push('[eval error] ' + e.message);
      }
    }
    if (s.keys) {
      for (const part of s.keys.split(',')) {
        const [key, ms] = part.split(':');
        await page.keyboard.down(key);
        await page.waitForTimeout(Number(ms || 100));
        await page.keyboard.up(key);
      }
    }
    if (s.click) {
      const [x, y] = s.click.split(',').map(Number);
      await page.mouse.click(x, y);
    }
    if (s.shot) {
      await page.screenshot({ path: s.shot, timeout: 180000 });
      console.log('shot> ' + s.shot);
    }
  }
  const rlErrors = await page.evaluate(() => (window.RL && window.RL.errors) ? window.RL.errors.slice() : ['RL missing']);
  const fps = await page.evaluate(() => window.RL && window.RL.fps);
  console.log('fps (swiftshader): ' + (fps ? fps.toFixed(1) : 'n/a'));
  const all = logs.concat(rlErrors.map((e) => '[RL.errors] ' + e));
  // Missing-file noise is expected while modules are being written in parallel.
  const filtered = all.filter((l) => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(l));
  if (filtered.length) {
    console.log('---- problems (' + filtered.length + ') ----');
    filtered.forEach((l) => console.log(l));
  } else {
    console.log('---- no errors ----');
  }
  const missing = all.filter((l) => /ERR_FILE_NOT_FOUND|Failed to load resource/.test(l)).length;
  if (missing) console.log('(' + missing + ' missing-file messages ignored)');
  await browser.close();
  process.exit(filtered.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(3); });
