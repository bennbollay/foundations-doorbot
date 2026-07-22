/**
 * Costco Same-Day (sameday.costco.com) automation — SINGLE-FILE library,
 * HTTP server, and CLI.
 *
 * Ported from the reference TypeScript implementation into this repo's plain
 * ESM style. It must run on a RESIDENTIAL/OFFICE network: Costco's identity
 * provider (signin.costco.com, Azure B2C behind PerimeterX) 403-blocks logins
 * from datacenter IPs, which is why the earlier Browserbase approach failed
 * and why this runs on the office Mac mini instead.
 *
 * Dependencies: `playwright` and `express` (both in package.json).
 * Playwright drives the INSTALLED Google Chrome (channel: "chrome"), so
 * `npx playwright install` is NOT required.
 *
 * ── Design ──────────────────────────────────────────────────────────────────
 *   - Persistent Chrome profile + cookie snapshots. The signed-in session
 *     lives in SESSION cookies (X-IC-bcx, BCO, …) that Chrome deletes on
 *     close, so ALL cookies are snapshotted to disk after every successful
 *     operation and re-injected on launch. The values stay valid server-side
 *     for weeks — this is what keeps the automation signed in across
 *     restarts.
 *   - Login is NEVER scripted. PerimeterX silently swallows credential POSTs
 *     from any CDP-instrumented browser, even with a human typing. The
 *     `login` CLI command spawns a REAL, un-instrumented Chrome (only a debug
 *     port open), a human signs in once, then the cookies are copied out via
 *     the debug port. Session recovery ladder: restored cookies → silent SSO
 *     re-handoff ("Sign in via Costco.com" completes formlessly while the
 *     costco.com identity cookies live) → human re-bootstrap.
 *   - One browser operation at a time (in-process serialization); concurrent
 *     HTTP requests queue.
 *   - Heuristic selectors (visible-text / aria-label needles). On failure a
 *     screenshot + HTML dump is written to COSTCO_DEBUG_DIR.
 *   - Checkout hard gates: the delivery address must match the office needle,
 *     the designated card's last-4 must be found and selected, and dryRun
 *     stops before the final "Place order" click.
 *
 * ── HTTP endpoints (all JSON; auth: `x-api-key: $COSTCO_AUTOMATION_API_KEY`,
 *    falling back to CAMERA_API_KEY — the doorbot key — when unset)
 *   GET  /health                 → { ok: true } (no auth)
 *   GET  /api/costco/session     → { logged_in }
 *   POST /api/costco/orders/sync { max_orders? } → { orders: [...] }
 *   POST /api/costco/search      { query, limit? } → { results: [...] }
 *   POST /api/costco/order       { address_needle, address_label,
 *                                  items: [{ name, product_url?, quantity }],
 *                                  card_last4, dry_run } → submit result
 *   Callers should use LONG timeouts: ~3 min (search), ~10 min (orders/sync),
 *   ~15 min (order). dry_run defaults to TRUE when absent.
 *
 * ── CLI ─────────────────────────────────────────────────────────────────────
 *   node costco-automation.mjs login            # real-Chrome sign-in bootstrap (once per machine)
 *   node costco-automation.mjs login-open       # non-interactive: just open the login Chrome
 *   node costco-automation.mjs login-capture    # non-interactive: capture cookies + verify
 *   node costco-automation.mjs status           # is the persistent session signed in?
 *   node costco-automation.mjs orders [n]       # scrape the last n orders
 *   node costco-automation.mjs search "<query>" # storefront search
 *   node costco-automation.mjs submit-test      # dry-run checkout rehearsal (never places an order)
 *   node costco-automation.mjs explore <storefront|orders|search|url>
 *   node costco-automation.mjs serve            # start the HTTP server
 *
 * ── Env (see .env.sample) ───────────────────────────────────────────────────
 *   COSTCO_AUTOMATION_API_KEY — shared secret for the HTTP server
 *                               (defaults to CAMERA_API_KEY)
 *   COSTCO_AUTOMATION_PORT    — HTTP port (default 8789)
 *   COSTCO_PROFILE_DIR        — persistent Chrome profile (default ~/.costco-automation-profile)
 *   COSTCO_HEADLESS           — "false" for a visible window (default headless)
 *   COSTCO_DEBUG_DIR          — failure artifacts (default ~/costco-debug)
 *   COSTCO_TIMEOUT_MS         — navigation timeout (default 60000)
 *   COSTCO_LOGIN_DEBUG_PORT   — debug port for the login Chrome (default 9223)
 *   CHROME_PATH               — Chrome binary for the login bootstrap
 *                               (default the standard macOS install path)
 *   COSTCO_ALERT_SLACK_CHANNEL_ID — optional; post an admin alert here (via
 *                               SLACK_OAUTH_BOT_TOKEN) when the session dies
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import readline from 'readline';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import express from 'express';
import { chromium } from 'playwright';

try {
  process.loadEnvFile();
} catch {
  /* no .env — env comes from the process */
}

export const BASE_URL = 'https://sameday.costco.com';
const ORDERS_URL = `${BASE_URL}/store/account/orders`;
const STOREFRONT_URL = `${BASE_URL}/store/costco/storefront`;

// ============================================================================
// Logging (repo convention: prefixed console.*; launchd captures the streams)
// ============================================================================

const log = (...args) => console.log('[costco]', ...args);
const logError = (...args) => console.error('[costco]', ...args);

// ============================================================================
// Config helpers
// ============================================================================

function env(name) {
  return (process.env[name] || '').trim();
}

function timeoutMs() {
  const n = Number(env('COSTCO_TIMEOUT_MS'));
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function profileDir() {
  return env('COSTCO_PROFILE_DIR') || path.join(os.homedir(), '.costco-automation-profile');
}

function debugDir() {
  return env('COSTCO_DEBUG_DIR') || path.join(os.homedir(), 'costco-debug');
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Admin alerting — best-effort Slack post when the session needs a human
// re-bootstrap. Only active when COSTCO_ALERT_SLACK_CHANNEL_ID is set (the
// default doorbot channel is a presence feed, not an ops channel). Throttled
// so a burst of failing operations produces one alert per hour.
// ============================================================================

const SESSION_EXPIRED_MESSAGE =
  'The Costco session has expired and could not be re-established silently. ' +
  'Re-bootstrap once on this machine: run `node costco-automation.mjs login` ' +
  '(opens a real Chrome — sign in by hand there, then press Enter in the terminal).';

let lastSessionAlertAt = 0;

async function alertSessionExpired() {
  const token = env('SLACK_OAUTH_BOT_TOKEN');
  const channel = env('COSTCO_ALERT_SLACK_CHANNEL_ID');
  if (!token || !channel) return;
  if (Date.now() - lastSessionAlertAt < 60 * 60 * 1000) return;
  lastSessionAlertAt = Date.now();
  try {
    const result = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        text: `:rotating_light: Costco automation on the office Mac mini: ${SESSION_EXPIRED_MESSAGE}`,
      }),
    });
    const res = await result.json();
    if (!res.ok) logError('Slack session-expired alert failed:', res.error);
  } catch (error) {
    logError('Slack session-expired alert failed:', error.message);
  }
}

// ============================================================================
// Context lifecycle — one persistent context, one operation at a time.
// ============================================================================

let chain = Promise.resolve();
let sharedContext = null;

function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function getContext(options) {
  if (sharedContext) return sharedContext;
  const headless = options?.headed ? false : env('COSTCO_HEADLESS') !== 'false';
  const ctx = await chromium.launchPersistentContext(profileDir(), {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 900 },
    // PerimeterX keys on navigator.webdriver + the automation infobar flags.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  ctx.setDefaultTimeout(timeoutMs());
  ctx.setDefaultNavigationTimeout(timeoutMs());
  ctx.on('close', () => {
    sharedContext = null;
  });
  sharedContext = ctx;
  await restoreSessionCookies(ctx);
  return ctx;
}

// ----------------------------------------------------------------------------
// Session-cookie persistence.
//
// The signed-in sameday.costco.com session lives in SESSION cookies (X-IC-bcx,
// BCO, __Host-instacart_sid…) that Chrome deletes on browser close — a
// persistent profile alone is NOT enough to stay signed in across restarts.
// The cookie values stay valid server-side for weeks, so we snapshot ALL
// cookies to disk after every successful signed-in operation and re-inject
// them when a fresh context launches.
// ----------------------------------------------------------------------------

function cookieFile() {
  return path.join(profileDir(), 'session-cookies.json');
}

async function saveSessionCookies(page) {
  try {
    const cookies = await page.context().cookies();
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(cookieFile(), JSON.stringify(cookies, null, 2));
  } catch {
    /* best-effort */
  }
}

async function restoreSessionCookies(ctx) {
  try {
    if (!fs.existsSync(cookieFile())) return;
    const cookies = JSON.parse(fs.readFileSync(cookieFile(), 'utf8'));
    if (Array.isArray(cookies) && cookies.length > 0) {
      await ctx.addCookies(cookies);
    }
  } catch {
    /* corrupt snapshot — a fresh login will rewrite it */
  }
}

export async function closeCostcoBrowser() {
  const ctx = sharedContext;
  sharedContext = null;
  if (ctx) await ctx.close().catch(() => {});
}

async function getPage(ctx) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}

async function saveArtifacts(page, label) {
  try {
    fs.mkdirSync(debugDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(debugDir(), `${stamp}-${label}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${base}.html`, await page.content());
    return base;
  } catch {
    return null;
  }
}

async function runOp(label, fn, options) {
  return serialize(async () => {
    const started = Date.now();
    log(`op "${label}" started`);
    const ctx = await getContext({ headed: options?.headed });
    const page = await getPage(ctx);
    try {
      if (options?.requireLogin !== false) {
        await ensureLoggedIn(page);
      }
      const result = await fn(page);
      // Sliding session refresh — see the session-cookie persistence note.
      if (options?.requireLogin !== false) {
        await saveSessionCookies(page);
      }
      log(`op "${label}" finished in ${Math.round((Date.now() - started) / 1000)}s`);
      return result;
    } catch (error) {
      const base = await saveArtifacts(page, label);
      const message = error instanceof Error ? error.message : String(error);
      logError(`op "${label}" failed after ${Math.round((Date.now() - started) / 1000)}s: ${message}`);
      if (message.includes('could not be re-established silently')) {
        alertSessionExpired().catch(() => {});
      }
      throw new Error(base ? `${message} (debug artifacts: ${base}.png/.html)` : message);
    }
  });
}

async function waitForQuiet(page, settleMs = 1500) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await delay(settleMs);
}

async function pageText(page) {
  return (await page.evaluate(() => document.body?.innerText || '')).toLowerCase();
}

// ============================================================================
// Login
// ============================================================================

async function looksSignedOut(page) {
  const text = await pageText(page);
  return text.includes('sign in via costco.com') || text.includes('browse as a guest');
}

export async function isLoggedIn() {
  return runOp(
    'session-check',
    async (page) => {
      await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
      await waitForQuiet(page);
      if (await looksSignedOut(page)) return false;
      const url = page.url().toLowerCase();
      return url.includes('sameday.costco.com');
    },
    { requireLogin: false }
  );
}

/**
 * Ensure the sameday session is live. NO scripted credential entry —
 * PerimeterX silently swallows credential POSTs from any CDP-instrumented
 * browser (even with a human typing), so passwords are never typed here.
 * Recovery ladder:
 *   1. Already signed in (restored session cookies) → done.
 *   2. Silent SSO: click "Sign in via Costco.com" — while the captured
 *      costco.com identity cookies are still valid, the whole OAuth chain
 *      completes without ever showing a credential form.
 *   3. Otherwise: human re-bootstrap via the `login` CLI command (real Chrome).
 */
async function ensureLoggedIn(page) {
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  await waitForQuiet(page);
  if (!(await looksSignedOut(page))) return;

  // Silent SSO attempt (no credentials involved).
  await page
    .getByRole('button', { name: /sign in via costco/i })
    .or(page.getByText(/sign in via costco/i))
    .first()
    .click()
    .catch(() => {});
  await page.waitForURL(/sameday\.costco\.com/i, { timeout: 30_000 }).catch(() => {});
  await waitForQuiet(page, 2500);

  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  await waitForQuiet(page);
  if (await looksSignedOut(page)) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  await saveSessionCookies(page);
}

/**
 * Login bootstrap via a REAL, un-instrumented Chrome.
 *
 * PerimeterX detects CDP-instrumented browsers (Playwright/Puppeteer) even
 * when a human does the typing — the credential POST is silently swallowed.
 * A plain locally-launched Chrome passes. So: spawn normal Chrome with only a
 * debug port (+ its own profile dir), let a human sign in, and ONLY THEN
 * attach to the debug port to copy the session cookies out into the snapshot
 * file the automation contexts restore from.
 *
 * `spawnLoginChrome` starts the browser; `captureSessionFromChrome` is called
 * after the human confirms they're signed in.
 */
export function spawnLoginChrome() {
  const port = Number(env('COSTCO_LOGIN_DEBUG_PORT')) || 9223;
  const chromePath =
    env('CHROME_PATH') || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const loginProfile = `${profileDir()}-login-chrome`;
  fs.mkdirSync(loginProfile, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${loginProfile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      `${BASE_URL}/store/account/orders`,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  return { pid: child.pid, port };
}

export async function captureSessionFromChrome(port) {
  const debugPort = port || Number(env('COSTCO_LOGIN_DEBUG_PORT')) || 9223;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
    timeout: 15_000,
  });
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('No browser context found on the login Chrome.');
    const cookies = await ctx.cookies();
    if (cookies.length === 0) throw new Error('The login Chrome has no cookies yet.');
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(cookieFile(), JSON.stringify(cookies, null, 2));
    const samedaySession = cookies.some(
      (c) =>
        c.domain.includes('sameday.costco.com') && !/^(ahoy|_ga|_gcl|AMCV|kndctr)/i.test(c.name)
    );
    return { cookieCount: cookies.length, samedaySession };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ============================================================================
// Order history
// ============================================================================

export async function fetchOrderHistory(maxOrders = 10) {
  const cap = Math.max(1, Math.min(maxOrders, 30));
  return runOp('order-history', async (page) => {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page, 2000);

    const orderLinks = await page.evaluate(() => {
      const seen = new Set();
      const links = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        if (!/\/orders?\//i.test(a.href) || seen.has(a.href)) return;
        seen.add(a.href);
        const card = a.closest('li, article, section, div');
        links.push({ href: a.href, text: (card?.textContent || '').trim().slice(0, 300) });
      });
      return links;
    });

    const orders = [];
    for (const link of orderLinks.slice(0, cap)) {
      await page.goto(link.href, { waitUntil: 'domcontentloaded' });
      await waitForQuiet(page, 2000);
      const items = await page.evaluate(() => {
        const results = [];
        const seen = new Set();
        document.querySelectorAll("a[href*='/products/']").forEach((a) => {
          const img = a.querySelector('img');
          const name = (img?.alt || a.getAttribute('aria-label') || a.textContent || '')
            .trim()
            .replace(/\s+/g, ' ');
          if (!name || name.length < 3) return;
          if (/powered by|headshot|shopper tier|badge|logo|avatar/i.test(name)) return;
          const key = name.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          const container = a.closest('li, article, div');
          const priceMatch = (container?.textContent || '').match(/\$\d[\d,]*\.?\d{0,2}/);
          results.push({
            name: name.slice(0, 200),
            productUrl: a.href,
            imageUrl: img?.src || undefined,
            priceText: priceMatch ? priceMatch[0] : undefined,
          });
        });
        if (results.length === 0) {
          document.querySelectorAll('img[alt]').forEach((img) => {
            const name = img.alt.trim().replace(/\s+/g, ' ');
            if (
              name.length < 8 ||
              /logo|costco|avatar|icon|powered by|headshot|shopper tier|badge/i.test(name)
            )
              return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            results.push({ name, imageUrl: img.src || undefined });
          });
        }
        return results;
      });
      const refMatch = link.href.match(/orders?\/([A-Za-z0-9-]+)/i);
      orders.push({
        orderRef: refMatch ? refMatch[1] : undefined,
        orderUrl: link.href,
        placedText: link.text.match(/(delivered|placed|arriv\w+)[^$•|]*/i)?.[0]?.trim(),
        items,
      });
    }
    return orders;
  });
}

// ============================================================================
// Search
// ============================================================================

function searchUrl(query) {
  return `${BASE_URL}/store/costco/s?k=${encodeURIComponent(query)}`;
}

async function scrapeSearchResults(page, limit) {
  return page.evaluate((max) => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll("a[href*='/products/']").forEach((a) => {
      if (results.length >= max) return;
      const img = a.querySelector('img');
      const name = (img?.alt || a.getAttribute('aria-label') || a.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        // Tiles without an image alt lead with pricing text:
        // "Current price: $6.80$680Kirkland Signature…"
        .replace(/^current price:\s*\$[\d,.]+\$?\d*\s*/i, '');
      if (!name || name.length < 3) return;
      if (/powered by|headshot|shopper tier|badge|logo|avatar/i.test(name)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const text = a.closest('li, article, div')?.textContent || '';
      const priceMatch = text.match(/\$\d[\d,]*\.?\d{0,2}/);
      const sizeMatch = text.match(
        /\d+(\.\d+)?\s?(ct|oz|lb|lbs|fl oz|gal|qt|pk|count|pack|kg|g|ml|l)\b/i
      );
      results.push({
        name: name.slice(0, 200),
        productUrl: a.href,
        imageUrl: img?.src || undefined,
        priceText: priceMatch ? priceMatch[0] : undefined,
        sizeText: sizeMatch ? sizeMatch[0] : undefined,
      });
    });
    return results;
  }, limit);
}

export async function searchProducts(query, limit = 8) {
  const cap = Math.max(1, Math.min(limit, 20));
  return runOp('search', async (page) => {
    await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page, 2000);
    return scrapeSearchResults(page, cap);
  });
}

// ============================================================================
// Cart + checkout
// ============================================================================

async function clickByText(page, needles, options) {
  for (const needle of needles) {
    const candidates = page
      .locator("button, a, [role='button'], [role='radio'], label")
      .filter({ hasText: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      const el = candidates.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = ((await el.textContent().catch(() => '')) || '').trim();
      if (options?.exclude && options.exclude.test(text)) continue;
      try {
        await el.click({ timeout: 5_000 });
        return true;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return false;
}

async function addCurrentProductToCart(page, quantity) {
  const added = await clickByText(page, ['add to cart', 'add 1', 'add to order', 'add item'], {
    exclude: /added|add to list/i,
  });
  if (!added) return false;
  await waitForQuiet(page, 1200);
  for (let i = 1; i < quantity; i++) {
    const bumped =
      (await page
        .locator("[aria-label*='ncrement' i], [aria-label*='ncrease' i]")
        .first()
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false)) || (await clickByText(page, ['+'], { exclude: /-/ }));
    if (!bumped) break;
    await delay(500);
  }
  return true;
}

async function addItemToCart(page, item) {
  if (item.productUrl) {
    try {
      await page.goto(item.productUrl, { waitUntil: 'domcontentloaded' });
      await waitForQuiet(page, 1500);
      const text = await pageText(page);
      if (
        !text.includes('out of stock') &&
        !text.includes('currently unavailable') &&
        (await addCurrentProductToCart(page, item.quantity))
      ) {
        return { name: item.name, quantity: item.quantity, added: true, via: 'product_url' };
      }
    } catch {
      /* fall through to search */
    }
  }
  try {
    await page.goto(searchUrl(item.name), { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page, 2000);
    const results = await scrapeSearchResults(page, 5);
    const target = results.find((r) => r.productUrl);
    if (!target?.productUrl) {
      return {
        name: item.name,
        quantity: item.quantity,
        added: false,
        via: 'failed',
        detail: 'No usable search results',
      };
    }
    await page.goto(target.productUrl, { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page, 1500);
    if (await addCurrentProductToCart(page, item.quantity)) {
      return {
        name: item.name,
        quantity: item.quantity,
        added: true,
        via: 'search',
        detail: `Matched search result: ${target.name}`,
      };
    }
    return {
      name: item.name,
      quantity: item.quantity,
      added: false,
      via: 'failed',
      detail: 'No add-to-cart control found',
    };
  } catch (err) {
    return {
      name: item.name,
      quantity: item.quantity,
      added: false,
      via: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function openCart(page) {
  // The header cart control is an icon button with an aria-label, not text.
  const iconBtn = page
    .locator("[aria-label*='cart' i]:not([aria-label*='add' i]), [data-testid*='cart' i]")
    .first();
  if (await iconBtn.isVisible().catch(() => false)) {
    try {
      await iconBtn.click({ timeout: 5_000 });
      await waitForQuiet(page, 1500);
      return true;
    } catch {
      /* fall through */
    }
  }
  const ok = await clickByText(page, ['view cart', 'cart'], { exclude: /add to cart/i });
  if (ok) await waitForQuiet(page, 1500);
  return ok;
}

async function emptyCart(page) {
  await openCart(page);
  for (let i = 0; i < 40; i++) {
    // Cart rows use icon buttons (trash) with aria-labels, not text buttons.
    const trash = page
      .locator("[aria-label*='remove' i], [aria-label*='delete' i], [data-testid*='remove' i]")
      .first();
    if (await trash.isVisible().catch(() => false)) {
      const clicked = await trash
        .click({ timeout: 4_000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        await delay(1200);
        continue;
      }
    }
    const removed = await clickByText(page, ['remove'], { exclude: /remove all/i });
    if (!removed) break;
    await delay(800);
  }
}

async function selectDeliveryAddress(page, needle) {
  const lcNeedle = needle.toLowerCase();
  if ((await pageText(page)).includes(lcNeedle)) return true;
  const openers = [
    ['change address', 'change delivery address'],
    ['delivery address', 'deliver to'],
    ['change'],
  ];
  for (const opener of openers) {
    await clickByText(page, opener);
    await waitForQuiet(page, 1200);
    if (await clickByText(page, [needle])) {
      await waitForQuiet(page, 1200);
      await clickByText(page, ['save', 'confirm', 'use this address', 'apply']);
      await waitForQuiet(page, 1500);
      return (await pageText(page)).includes(lcNeedle);
    }
  }
  return false;
}

async function selectCard(page, cardLast4) {
  // Already the selected card in the "Pay with" section?
  if ((await pageText(page)).includes(cardLast4)) return true;

  // Open the payment sheet. The checkout "Pay with" section renders the
  // current card as a clickable row ("Visa *3572 ›") with an "Edit" link —
  // there is no "change payment" button.
  const openedSheet = async () => {
    // The sheet lists the saved cards; visible = our target appears, or at
    // least an "add payment method" affordance shows up.
    const text = await pageText(page);
    return text.includes(cardLast4) || /add\s+(a\s+)?(new\s+)?(credit|payment|card)/i.test(text);
  };

  const currentCardRow = page
    .locator("button, a, [role='button'], div[tabindex]")
    .filter({ hasText: /(visa|mastercard|amex|american express|discover)\s*[•*x]*\s*\d{4}/i })
    .first();
  if (await currentCardRow.isVisible().catch(() => false)) {
    await currentCardRow.click({ timeout: 5_000 }).catch(() => {});
    await waitForQuiet(page, 1500);
  }
  if (!(await openedSheet())) {
    // Exact "Edit" link (avoid substring matches like "credit").
    const editLink = page
      .locator("button, a, [role='button']")
      .filter({ hasText: /^\s*edit\s*$/i })
      .first();
    if (await editLink.isVisible().catch(() => false)) {
      await editLink.click({ timeout: 5_000 }).catch(() => {});
      await waitForQuiet(page, 1500);
    }
  }
  if (!(await openedSheet())) {
    await clickByText(page, ['payment method', 'change payment', 'edit payment', 'pay with']);
    await waitForQuiet(page, 1500);
  }

  if (!(await pageText(page)).includes(cardLast4)) {
    await saveArtifacts(page, 'payment-sheet-no-card');
    return false;
  }

  // Pick the row/radio showing our last-4, then confirm.
  const cardOption = page
    .locator("label, [role='radio'], button, [role='button'], li, div[tabindex]")
    .filter({ hasText: new RegExp(`\\d*${cardLast4}`) })
    .last();
  await cardOption.click({ timeout: 5_000 }).catch(() => {});
  await delay(800);
  await clickByText(page, ['save', 'confirm', 'continue', 'apply', 'done', 'select'], {
    exclude: /add/i,
  });
  await waitForQuiet(page, 1500);

  const selected = (await pageText(page)).includes(cardLast4);
  if (!selected) await saveArtifacts(page, 'payment-select-failed');
  return selected;
}

export async function submitOrder(params) {
  if (!params.cardLast4 && !params.dryRun) {
    return {
      success: false,
      dryRun: params.dryRun,
      items: [],
      addressVerified: false,
      cardVerified: false,
      error: 'cardLast4 is required — refusing to check out without a designated card to verify.',
    };
  }
  if (params.items.length === 0) {
    return {
      success: false,
      dryRun: params.dryRun,
      items: [],
      addressVerified: false,
      cardVerified: false,
      error: 'No items to order.',
    };
  }

  return runOp('submit-order', async (page) => {
    const result = {
      success: false,
      dryRun: params.dryRun,
      items: [],
      addressVerified: false,
      cardVerified: false,
    };

    // 1. Address first — availability/pricing are address-scoped.
    await page.goto(STOREFRONT_URL, { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page);
    result.addressVerified = await selectDeliveryAddress(page, params.addressNeedle);
    if (!result.addressVerified) {
      result.error =
        `Could not select the ${params.addressLabel} delivery address ` +
        `(needle "${params.addressNeedle}"). Make sure it is saved on the account.`;
      return result;
    }

    // 2. Rebuild the cart from scratch.
    await emptyCart(page);
    for (const item of params.items) {
      result.items.push(await addItemToCart(page, item));
    }
    if (!result.items.some((i) => i.added)) {
      result.error = 'No items could be added to the cart.';
      return result;
    }

    // 3. Checkout.
    await openCart(page);
    const cartText = await pageText(page);
    const minMatch = cartText.match(/\$\d+\s*min\.?\s*to\s*checkout/i);
    if (minMatch) {
      result.error =
        `The cart is under Costco Same-Day's order minimum ("${minMatch[0]}") — add more items ` +
        'before submitting.';
      return result;
    }
    if (!(await clickByText(page, ['go to checkout', 'checkout', 'continue to checkout']))) {
      await saveArtifacts(page, 'cart-no-checkout-button');
      result.error = 'Could not find the checkout button.';
      return result;
    }
    await waitForQuiet(page, 2500);

    // Click through upsell interstitials ("Get everything you need?" →
    // "Continue to checkout") until the real checkout page appears.
    for (let i = 0; i < 3; i++) {
      const text = await pageText(page);
      const onCheckout =
        page.url().toLowerCase().includes('checkout') &&
        (text.includes('delivery address') ||
          text.includes('payment') ||
          text.includes('place order'));
      if (onCheckout) break;
      if (!(await clickByText(page, ['continue to checkout', 'go to checkout', 'checkout']))) break;
      await waitForQuiet(page, 2500);
    }

    if (!(await pageText(page)).includes(params.addressNeedle.toLowerCase())) {
      result.addressVerified = await selectDeliveryAddress(page, params.addressNeedle);
      if (!result.addressVerified) {
        await saveArtifacts(page, 'checkout-wrong-address');
        result.error = 'Checkout page is not showing the expected delivery address — aborting.';
        return result;
      }
    }

    // 4. Card — hard gate (dry runs without a configured card run in
    // DISCOVERY mode instead: report which saved cards checkout offers).
    if (params.cardLast4) {
      result.cardVerified = await selectCard(page, params.cardLast4);
      if (!result.cardVerified) {
        result.error = `The designated card ending in ${params.cardLast4} was not found/selectable at checkout — aborting.`;
        return result;
      }
    } else {
      await clickByText(page, ['payment', 'change payment', 'edit payment']);
      await waitForQuiet(page, 1200);
      // Checkout renders cards like "Visa *3572" / "ending in 3572" / "•••• 3572".
      const cardMatches = (await pageText(page)).match(/(?:ending in|[•*x]{1,4})\s*(\d{4})\b/gi);
      result.availableCards = Array.from(
        new Set((cardMatches || []).map((m) => m.replace(/\D/g, '')))
      );
    }

    const totalMatch = (await pageText(page)).match(
      /(order total|total)[^$]*(\$\d[\d,]*\.?\d{0,2})/i
    );
    result.subtotalText = totalMatch ? totalMatch[2] : undefined;

    if (params.dryRun) {
      result.success = true;
      result.confirmationText = 'Dry run — stopped before placing the order.';
      await saveArtifacts(page, 'checkout-dry-run');
      return result;
    }

    // 5. Place the order.
    if (!(await clickByText(page, ['place order', 'confirm order', 'submit order']))) {
      result.error = 'Could not find the Place Order button.';
      return result;
    }
    await waitForQuiet(page, 5000);
    const confirmation = await pageText(page);
    const confirmed =
      confirmation.includes('order placed') ||
      confirmation.includes('thank you') ||
      confirmation.includes('order confirmed') ||
      confirmation.includes('preparing your order');
    result.success = confirmed;
    result.confirmationText = confirmed ? confirmation.slice(0, 400) : undefined;
    if (!confirmed) {
      result.error =
        'Clicked Place Order but could not confirm success — check the debug artifacts and the ' +
        "account's order history before retrying.";
      await saveArtifacts(page, 'checkout-unconfirmed');
    }
    return result;
  });
}

// ============================================================================
// Explore (selector tuning)
// ============================================================================

export async function explorePage(target) {
  const urls = {
    storefront: STOREFRONT_URL,
    orders: ORDERS_URL,
    search: searchUrl('paper towels'),
  };
  const url = urls[target] || (target.startsWith('http') ? target : STOREFRONT_URL);
  return runOp(`explore-${target.replace(/\W+/g, '-')}`, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForQuiet(page, 2500);
    const dump = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        title: document.title,
        buttons: Array.from(document.querySelectorAll("button, [role='button']"))
          .filter(visible)
          .map((b) =>
            (b.textContent || b.getAttribute('aria-label') || '')
              .trim()
              .replace(/\s+/g, ' ')
              .slice(0, 100)
          )
          .filter(Boolean)
          .slice(0, 60),
        links: Array.from(document.querySelectorAll('a[href]'))
          .filter(visible)
          .map(
            (a) =>
              `${(a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)} -> ${a.href.slice(0, 120)}`
          )
          .slice(0, 80),
        textSample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
      };
    });
    const artifactBase = await saveArtifacts(page, `explore-${target.replace(/\W+/g, '-')}`);
    return { url, ...dump, artifactBase };
  });
}

// ============================================================================
// HTTP server
// ============================================================================

// The foundations client sends COSTCO_AUTOMATION_API_KEY when configured, and
// falls back to the doorbot key (CAMERA_API_KEY) otherwise — accept either
// convention by defaulting to the doorbot key when no dedicated key is set.
function serverApiKey() {
  return env('COSTCO_AUTOMATION_API_KEY') || env('CAMERA_API_KEY');
}

export function createCostcoServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'costco-automation' });
  });

  app.use((req, res, next) => {
    const key = serverApiKey();
    const presented = String(req.headers['x-api-key'] || '');
    const ok =
      key.length > 0 &&
      presented.length === key.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(key));
    if (!ok) {
      res.status(401).json({ error: 'Invalid or missing x-api-key' });
      return;
    }
    next();
  });

  app.get('/api/costco/session', async (_req, res) => {
    try {
      res.json({ logged_in: await isLoggedIn() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/costco/orders/sync', async (req, res) => {
    try {
      const maxOrders = Number(req.body?.max_orders) || 10;
      const orders = await fetchOrderHistory(maxOrders);
      res.json({
        orders: orders.map((o) => ({
          order_ref: o.orderRef,
          order_url: o.orderUrl,
          placed_text: o.placedText,
          items: o.items.map((i) => ({
            name: i.name,
            product_url: i.productUrl,
            image_url: i.imageUrl,
            price_text: i.priceText,
            size_text: i.sizeText,
            external_id: i.externalId,
          })),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/costco/search', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const results = await searchProducts(query, Number(req.body?.limit) || 8);
      res.json({
        results: results.map((r) => ({
          name: r.name,
          product_url: r.productUrl,
          image_url: r.imageUrl,
          price_text: r.priceText,
          size_text: r.sizeText,
          external_id: r.externalId,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/costco/order', async (req, res) => {
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : [];
      const result = await submitOrder({
        addressNeedle: String(body.address_needle || ''),
        addressLabel: String(body.address_label || body.address_needle || ''),
        items: items.map((i) => ({
          name: String(i.name || ''),
          productUrl: i.product_url ? String(i.product_url) : undefined,
          quantity: Math.max(1, Number(i.quantity) || 1),
        })),
        cardLast4: String(body.card_last4 || ''),
        dryRun: body.dry_run !== false, // dry run unless explicitly disabled
      });
      res.json({
        success: result.success,
        dry_run: result.dryRun,
        address_verified: result.addressVerified,
        card_verified: result.cardVerified,
        subtotal_text: result.subtotalText,
        confirmation_text: result.confirmationText,
        error: result.error,
        available_cards: result.availableCards,
        items: result.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          added: i.added,
          via: i.via,
          detail: i.detail,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

export function startCostcoServer() {
  if (!serverApiKey()) {
    logError(
      'Neither COSTCO_AUTOMATION_API_KEY nor CAMERA_API_KEY is set — refusing to start without auth.'
    );
    process.exit(1);
  }
  const port = Number(process.env.COSTCO_AUTOMATION_PORT || 8789);
  const server = createCostcoServer().listen(port, () => {
    log(`Costco automation server listening on http://localhost:${port}`);
    log('  GET  /api/costco/session');
    log('  POST /api/costco/orders/sync { max_orders? }');
    log('  POST /api/costco/search      { query, limit? }');
    log('  POST /api/costco/order       { address_needle, address_label, items, card_last4, dry_run }');
  });
  // These are multi-minute browser flows — never kill the sockets server-side.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('error', (error) => {
    logError(`Costco automation server failed to start: ${error.message}`);
    process.exit(1);
  });
}

// ============================================================================
// CLI
// ============================================================================

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function cliMain() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'login': {
      // PerimeterX blocks credential POSTs from ANY automation-instrumented
      // browser (even with a human typing), so the login happens in a REAL
      // Chrome with nothing attached. We only connect to its debug port
      // AFTERWARDS to copy the session cookies out.
      const { port } = spawnLoginChrome();
      console.log(
        '\nA regular Chrome window just opened on the Costco Same-Day orders page.' +
          '\n  1. Click “Sign in via Costco.com” and sign in (check “Keep me signed in”).' +
          "\n  2. Wait until you're back on sameday.costco.com and signed in." +
          '\n  3. Come back here.\n'
      );
      await waitForEnter("Press Enter when you're signed in… ");
      const captured = await captureSessionFromChrome(port);
      console.log(
        `Captured ${captured.cookieCount} cookies` +
          (captured.samedaySession
            ? ' (sameday session present).'
            : ' — WARNING: no sameday session cookie seen.')
      );
      console.log('You can close that Chrome window. Verifying headless…');
      const ok = await isLoggedIn();
      console.log(ok ? '✅ Headless automation is signed in.' : '❌ Still signed out — try again.');
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'login-open': {
      // Non-interactive variant of `login` step 1: just spawn the real Chrome.
      const { port } = spawnLoginChrome();
      console.log(`Login Chrome opened (debug port ${port}). Sign in, then run: login-capture`);
      break;
    }
    case 'login-capture': {
      // Non-interactive variant of `login` step 2: capture cookies + verify.
      const captured = await captureSessionFromChrome();
      console.log(
        `Captured ${captured.cookieCount} cookies` +
          (captured.samedaySession
            ? ' (sameday session present).'
            : ' — WARNING: no sameday session cookie seen.')
      );
      const ok = await isLoggedIn();
      console.log(ok ? '✅ Headless automation is signed in.' : '❌ Still signed out.');
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'status': {
      const ok = await isLoggedIn();
      console.log(ok ? '✅ Session is signed in.' : '❌ Signed out — run the login command.');
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'orders': {
      const orders = await fetchOrderHistory(Number(rest[0]) || 5);
      console.log(`Found ${orders.length} order(s):`);
      for (const o of orders) {
        console.log(`\n— ${o.orderRef || o.orderUrl} ${o.placedText ? `(${o.placedText})` : ''}`);
        for (const item of o.items) {
          console.log(`   • ${item.name}${item.priceText ? ` — ${item.priceText}` : ''}`);
        }
      }
      break;
    }
    case 'search': {
      const query = rest.join(' ').trim();
      if (!query) throw new Error('Usage: search "<query>"');
      const results = await searchProducts(query, 8);
      console.log(`Found ${results.length} result(s) for "${query}":`);
      for (const r of results) {
        console.log(
          ` • ${r.name}${r.priceText ? ` — ${r.priceText}` : ''}\n   ${r.productUrl || ''}`
        );
      }
      break;
    }
    case 'submit-test': {
      // Safe end-to-end checkout rehearsal, always dry-run. Uses two staple
      // items so the cart clears Costco Same-Day's $35 order minimum.
      const queries =
        rest.length > 0 ? [rest.join(' ')] : ['kirkland paper towels', 'spindrift sparkling water'];
      const items = [];
      for (const q of queries) {
        const [candidate] = await searchProducts(q, 1);
        if (candidate)
          items.push({ name: candidate.name, productUrl: candidate.productUrl, quantity: 1 });
      }
      if (items.length === 0) throw new Error('No products found for the test queries');
      console.log(`Dry-run ordering: ${items.map((i) => i.name).join(' + ')}`);
      const result = await submitOrder({
        addressNeedle: process.env.COSTCO_TEST_ADDRESS_NEEDLE || 'boylston',
        addressLabel: 'test office',
        items,
        cardLast4: process.env.COSTCO_CARD_LAST4 || '',
        dryRun: true,
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'explore': {
      const dump = await explorePage(rest[0] || 'storefront');
      console.log(JSON.stringify(dump, null, 2));
      break;
    }
    case 'serve': {
      startCostcoServer();
      return; // keep the process alive
    }
    default:
      console.log(
        'Commands: login | login-open | login-capture | status | orders [n] | search "<q>" | ' +
          'submit-test [query] | explore <target> | serve'
      );
  }
  await closeCostcoBrowser();
}

// Run the CLI only when executed directly (importing this file as a library
// must not trigger it).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  cliMain().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeCostcoBrowser();
    process.exit(1);
  });
}
