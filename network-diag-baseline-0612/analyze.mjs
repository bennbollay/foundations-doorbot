#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const load = async (name) => JSON.parse(await readFile(new URL(`./${name}.json`, import.meta.url), 'utf8'));

const sysinfo = (await load('sysinfo')).data[0];
const health = (await load('health')).data;
const devices = (await load('devices')).data;
const clients = (await load('clients-active')).data;
const wlans = (await load('wlanconf')).data;
const rogues = (await load('rogueaps')).data;
const syslog = await load('system-log-critical');

console.log('=== SYSINFO ===');
console.log({
  version: sysinfo.version,
  uptime_days: (sysinfo.uptime / 86400).toFixed(1),
  update_available: sysinfo.update_available,
});

console.log('\n=== HEALTH ===');
for (const h of health) {
  console.log(h.subsystem, h.status, JSON.stringify({ num_user: h.num_user, num_ap: h.num_ap, num_adopted: h.num_adopted, num_disconnected: h.num_disconnected, drops: h['speedtest_ping'] }));
}

console.log('\n=== DEVICES ===');
for (const d of devices) {
  const base = {
    type: d.type,
    model: d.model,
    name: d.name,
    state: d.state,
    version: d.version,
    uptime_d: d.uptime ? (d.uptime / 86400).toFixed(1) : null,
    cpu: d['system-stats']?.cpu,
    mem: d['system-stats']?.mem,
    clients: d.num_sta,
    satisfaction: d.satisfaction,
    upgradable: d.upgradable || false,
    ip: d.ip,
  };
  if (d.type === 'uap') {
    base.radios = (d.radio_table_stats || []).map((r) => ({
      radio: r.radio,
      channel: r.channel,
      ht: d.radio_table?.find((x) => x.radio === r.radio)?.ht,
      tx_power: r.tx_power,
      tx_power_mode: d.radio_table?.find((x) => x.radio === r.radio)?.tx_power_mode,
      sta: r.num_sta,
      cu_total: r.cu_total,
      cu_self_tx: r.cu_self_tx,
      cu_self_rx: r.cu_self_rx,
      satisfaction: r.satisfaction,
    }));
    base.uplink = d.uplink?.type;
    base.uplink_speed = d.uplink?.speed;
  }
  console.log(JSON.stringify(base));
}

console.log('\n=== WLANS ===');
for (const w of wlans) {
  console.log(JSON.stringify({
    name: w.name,
    enabled: w.enabled,
    security: w.security,
    wpa_mode: w.wpa_mode,
    pmf: w.pmf_mode,
    bands: w.wlan_bands ?? w.wlan_band,
    band_steering: w.band_steering_mode ?? undefined,
    minrate_2g: w.minrate_ng_data_rate_kbps,
    minrate_5g: w.minrate_na_data_rate_kbps,
    minrate_setting_pref: w.minrate_setting_preference,
    dtim_2g: w.dtim_ng,
    dtim_5g: w.dtim_na,
    hide_ssid: w.hide_ssid,
    l2_isolation: w.l2_isolation,
    proxy_arp: w.proxy_arp,
    bss_transition: w.bss_transition,
    fast_roaming: w.fast_roaming_enabled,
    uapsd: w.uapsd_enabled,
    mcast_enhance: w.mcastenhance_enabled,
    networkconf_id: w.networkconf_id,
    ap_group_ids: w.ap_group_ids,
  }));
}

console.log('\n=== CLIENT RSSI / band distribution ===');
const wireless = clients.filter((c) => !c.is_wired);
const wired = clients.filter((c) => c.is_wired);
console.log(`total: ${clients.length}, wireless: ${wireless.length}, wired: ${wired.length}`);
const byRadio = {};
for (const c of wireless) {
  const r = c.radio_proto || c.radio || '?';
  byRadio[r] = (byRadio[r] || 0) + 1;
}
console.log('by radio proto:', byRadio);
const buckets = { 'good(>-65)': 0, 'ok(-65..-72)': 0, 'weak(-72..-80)': 0, 'bad(<-80)': 0 };
const weakClients = [];
for (const c of wireless) {
  const rssi = c.rssi ? -(95 - c.rssi) : c.signal; // unifi rssi is positive offset sometimes
  const signal = c.signal ?? rssi;
  if (signal == null) continue;
  if (signal > -65) buckets['good(>-65)']++;
  else if (signal > -72) buckets['ok(-65..-72)']++;
  else if (signal > -80) buckets['weak(-72..-80)']++;
  else {
    buckets['bad(<-80)']++;
  }
  if (signal <= -72) weakClients.push({ name: c.name || c.hostname || c.oui, ap: c.ap_mac, signal, satisfaction: c.satisfaction, proto: c.radio_proto });
}
console.log('signal buckets:', buckets);
console.log('weak clients:', JSON.stringify(weakClients.slice(0, 30), null, 1));

const lowSat = wireless.filter((c) => c.satisfaction != null && c.satisfaction < 70)
  .map((c) => ({ name: c.name || c.hostname || c.oui, sat: c.satisfaction, signal: c.signal, proto: c.radio_proto, tx_retries_pct: c['tx_retries_percentage'] }));
console.log('low satisfaction (<70):', JSON.stringify(lowSat.slice(0, 30), null, 1));

console.log('\n=== ROGUE/NEIGHBOR AP SUMMARY ===');
console.log('total neighbor BSSIDs seen:', rogues.length);
const byChan = {};
for (const r of rogues) {
  const band = r.channel > 14 ? '5g' : '2g';
  const key = `${band} ch${r.channel}`;
  byChan[key] = byChan[key] || { count: 0, strong: 0 };
  byChan[key].count++;
  if ((r.signal ?? -100) > -70) byChan[key].strong++;
}
const sorted = Object.entries(byChan).sort((a, b) => b[1].strong - a[1].strong);
for (const [k, v] of sorted.slice(0, 25)) console.log(k, v);

console.log('\n=== SYSTEM LOG (last 7d, first 50) ===');
const entries = syslog.data || syslog;
console.log('total entries:', Array.isArray(entries) ? entries.length : 'n/a');
if (Array.isArray(entries)) {
  const counts = {};
  for (const e of entries) counts[e.key || e.message_key || e.type] = (counts[e.key || e.message_key || e.type] || 0) + 1;
  console.log('by type:', JSON.stringify(counts, null, 1));
  for (const e of entries.slice(0, 25)) {
    console.log(new Date(e.timestamp || e.time).toISOString(), e.key || e.type, JSON.stringify(e.parameters || e.message || '').slice(0, 200));
  }
}
