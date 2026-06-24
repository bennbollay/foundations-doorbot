#!/usr/bin/env node
// Follow-up: fetch alarms/events via the v2 API paths used by newer UniFi firmware.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { writeFile } from 'node:fs/promises';

const BASE = (process.env.UNIFI_NETWORK_HOST || 'https://192.168.4.1').replace(/\/+$/, '');
const OUT_DIR = new URL('./network-diag/', import.meta.url).pathname;

async function login() {
  const init = await fetch(`${BASE}/`, { method: 'GET', redirect: 'manual' });
  const initialCsrf = init.headers.get('x-csrf-token');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (initialCsrf) headers['X-CSRF-Token'] = initialCsrf;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: process.env.UNIFI_CLOUD_USERNAME,
      password: process.env.UNIFI_CLOUD_PASSWORD,
      rememberMe: true,
      token: '',
    }),
  });
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const csrf = res.headers.get('x-updated-csrf-token') || res.headers.get('x-csrf-token') || initialCsrf;
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const h = { Accept: 'application/json', Cookie: cookie };
  if (csrf) h['X-CSRF-Token'] = csrf;
  return h;
}

const headers = await login();
console.log('Login OK');

const queries = [
  ['alarms-v2', 'GET', '/proxy/network/v2/api/site/default/alarms?limit=500'],
  ['events-v2', 'GET', '/proxy/network/v2/api/site/default/events?limit=1000'],
  [
    'system-log-critical',
    'POST',
    '/proxy/network/v2/api/site/default/system-log/all',
    { pageNumber: 0, pageSize: 200, timestampFrom: Date.now() - 7 * 86400e3, timestampTo: Date.now() },
  ],
  ['notifications', 'GET', '/proxy/network/v2/api/site/default/notification?limit=200'],
  ['wifi-connectivity', 'GET', '/proxy/network/v2/api/site/default/aggregated-dashboard?historySeconds=86400'],
  ['clients-history', 'GET', '/proxy/network/v2/api/site/default/clients/history?withinHours=24&type=all'],
];

for (const [name, method, path, body] of queries) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`${name}: ERROR ${res.status} ${text.slice(0, 120)}`);
      continue;
    }
    const data = JSON.parse(text);
    const count = Array.isArray(data) ? data.length : Array.isArray(data?.data) ? data.data.length : 'ok';
    console.log(`${name}: ${count}`);
    await writeFile(`${OUT_DIR}${name}.json`, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`${name}: FAILED ${e.message}`);
  }
}
