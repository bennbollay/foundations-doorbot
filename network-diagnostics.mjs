#!/usr/bin/env node
// One-off diagnostic: pull WiFi/network health data from the UniFi Network app
// on the Dream Machine and dump raw JSON into ./network-diag/ for analysis.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { mkdir, writeFile } from 'node:fs/promises';

const BASE = (process.env.UNIFI_NETWORK_HOST || 'https://192.168.1.1').replace(/\/+$/, '');
const USERNAME = process.env.UNIFI_CLOUD_USERNAME;
const PASSWORD = process.env.UNIFI_CLOUD_PASSWORD;
const OUT_DIR = new URL('./network-diag/', import.meta.url).pathname;

async function login() {
  const init = await fetch(`${BASE}/`, { method: 'GET', redirect: 'manual' });
  const initialCsrf = init.headers.get('x-csrf-token');

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (initialCsrf) headers['X-CSRF-Token'] = initialCsrf;

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, rememberMe: true, token: '' }),
  });
  if (!res.ok) {
    throw new Error(`Login failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const csrf = res.headers.get('x-updated-csrf-token') || res.headers.get('x-csrf-token') || initialCsrf;
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Login OK but no session cookie returned');

  const sessionHeaders = { Accept: 'application/json', Cookie: cookie };
  if (csrf) sessionHeaders['X-CSRF-Token'] = csrf;
  return sessionHeaders;
}

async function call(headers, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) return { __error: res.status, body: text.slice(0, 300) };
  try {
    return JSON.parse(text);
  } catch {
    return { __error: 'non-json', body: text.slice(0, 300) };
  }
}

const now = Math.floor(Date.now() / 1000);
const dayAgo = now - 24 * 3600;
const weekAgo = now - 7 * 24 * 3600;

const queries = [
  ['sysinfo', 'GET', '/proxy/network/api/s/default/stat/sysinfo'],
  ['health', 'GET', '/proxy/network/api/s/default/stat/health'],
  ['devices', 'GET', '/proxy/network/api/s/default/stat/device'],
  ['clients-active', 'GET', '/proxy/network/api/s/default/stat/sta'],
  ['wlanconf', 'GET', '/proxy/network/api/s/default/rest/wlanconf'],
  ['networkconf', 'GET', '/proxy/network/api/s/default/rest/networkconf'],
  ['settings', 'GET', '/proxy/network/api/s/default/get/setting'],
  ['alarms', 'POST', '/proxy/network/api/s/default/stat/alarm', { _limit: 500 }],
  ['events', 'POST', '/proxy/network/api/s/default/stat/event', { _limit: 1000, within: 168 }],
  ['rogueaps', 'POST', '/proxy/network/api/s/default/stat/rogueap', { within: 24 }],
  ['spectrum-scan', 'GET', '/proxy/network/api/s/default/stat/spectrumscan'],
  [
    'ap-hourly-7d',
    'POST',
    '/proxy/network/api/s/default/stat/report/hourly.ap',
    {
      attrs: ['bytes', 'num_sta', 'time', 'wifi_tx_attempts', 'tx_retries', 'wifi_tx_dropped'],
      start: weekAgo * 1000,
      end: now * 1000,
    },
  ],
  [
    'site-hourly-7d',
    'POST',
    '/proxy/network/api/s/default/stat/report/hourly.site',
    {
      attrs: ['bytes', 'wlan_bytes', 'num_sta', 'wlan-num_sta', 'time', 'wan-tx_bytes', 'wan-rx_bytes'],
      start: weekAgo * 1000,
      end: now * 1000,
    },
  ],
];

const headers = await login();
console.log('Login OK');
await mkdir(OUT_DIR, { recursive: true });

for (const [name, method, path, body] of queries) {
  const data = await call(headers, method, path, body);
  const count = Array.isArray(data?.data) ? data.data.length : data.__error ? `ERROR ${data.__error}` : 'ok';
  console.log(`${name}: ${count}`);
  await writeFile(`${OUT_DIR}${name}.json`, JSON.stringify(data, null, 2));
}
console.log(`Wrote output to ${OUT_DIR}`);
