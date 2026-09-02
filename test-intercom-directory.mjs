#!/usr/bin/env node

// Test script for the UniFi Access intercom directory sync (intercom.mjs).
//
//   node test-intercom-directory.mjs            mock mode: spins up a fake
//                                               Identity/Access proxy and
//                                               exercises upsert + replace
//   node test-intercom-directory.mjs --list     read the live directory
//   node test-intercom-directory.mjs --live <email>
//                                               reversible live check against the
//                                               real intercom: create a clearly
//                                               named test entry with <email> as
//                                               the receiver, update it, delete it
//
// Mock mode touches no hardware and uses a throwaway state/auth cache dir.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const mode = args.includes('--live') ? 'live' : args.includes('--list') ? 'list' : 'mock';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};

try {
  if (mode === 'mock') {
    await runMock();
  } else if (mode === 'list') {
    const intercom = await import('./intercom.mjs');
    const dir = await intercom.getIntercomDirectory();
    console.log(JSON.stringify(dir, null, 2));
  } else {
    const email = args[args.indexOf('--live') + 1];
    if (!email || email.startsWith('--')) {
      throw new Error('usage: node test-intercom-directory.mjs --live <receiver-email>');
    }
    await runLive(email);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------

async function runLive(email) {
  const intercom = await import('./intercom.mjs');
  const testCompany = `ZZ Root Sync Test ${Date.now().toString(36)}`;

  const before = await intercom.getIntercomDirectory();
  console.log(`Intercom: ${before.callerName} (${before.callerId}), ${before.rooms.length} rooms`);
  for (const room of before.rooms) {
    console.log(`  - ${room.name} [${room.managed ? 'managed' : 'unmanaged'}] receivers=${room.receivers.map((r) => r.name).join(', ')}`);
  }
  const preexisting = new Set(
    before.rooms.filter((r) => !r.name.startsWith('ZZ Root Sync Test')).map((r) => r.id),
  );

  let roomId = null;
  try {
    console.log(`\nCreating test entry "${testCompany}" → ${email}`);
    const created = await intercom.syncIntercomDirectory({
      entries: [{ company: testCompany, contacts: [{ name: 'Test Receiver', email }] }],
      mode: 'upsert',
    });
    console.log(JSON.stringify(created, null, 2));
    assert(created.failed.length === 0, 'create sync reported no failures');
    assert(created.synced[0]?.status === 'created', 'entry was created');
    roomId = created.synced[0].roomId;

    const afterCreate = await intercom.getIntercomDirectory();
    const room = afterCreate.rooms.find((r) => r.id === roomId);
    assert(room, 'created room is visible in the directory');
    assert(room.name === testCompany, `room name is "${testCompany}"`);
    assert(room.receivers.length === 1, 'room has exactly one receiver');
    assert(room.managed, 'room is tracked as managed');

    const renamed = `${testCompany} B`;
    console.log(`\nRenaming to "${renamed}" (managed room must be reused)`);
    // Simulate a company rename: the state maps the OLD company name to this
    // room, so drive the update via updateRoom, then re-sync under the new name.
    await intercom.updateRoom(afterCreate.callerId, roomId, { name: renamed });
    const afterRename = await intercom.getIntercomDirectory();
    assert(afterRename.rooms.find((r) => r.id === roomId)?.name === renamed, 'rename applied');

    const unchanged = await intercom.syncIntercomDirectory({
      entries: [{ company: renamed, contacts: [{ name: 'Test Receiver', email }] }],
      mode: 'upsert',
    });
    assert(unchanged.synced[0]?.roomId === roomId, 're-sync under the new name adopted the same room');
    assert(unchanged.synced[0]?.status === 'unchanged', 're-sync with identical data is a no-op');

    console.log('\nRemoving via replace mode (only managed rooms are eligible)');
    const replaced = await intercom.syncIntercomDirectory({ entries: [], mode: 'replace' });
    console.log(JSON.stringify(replaced, null, 2));
    assert(replaced.removed.some((r) => r.roomId === roomId), 'test room removed');
    roomId = null;

    const afterDelete = await intercom.getIntercomDirectory();
    assert(!afterDelete.rooms.some((r) => r.name.startsWith('ZZ Root Sync Test')), 'no test rooms remain');
    for (const id of preexisting) {
      assert(afterDelete.rooms.some((r) => r.id === id), `pre-existing room ${id} untouched`);
    }
    console.log('\nLive check passed.');
  } finally {
    // Remove every test room, whatever state the run ended in.
    try {
      const current = await intercom.getIntercomDirectory(before.callerId);
      for (const room of current.rooms) {
        if (!room.name.startsWith('ZZ Root Sync Test')) continue;
        console.log(`Cleaning up test room "${room.name}" (${room.id})`);
        await intercom.deleteRoom(before.callerId, room.id);
      }
    } catch (e) {
      console.error(`cleanup failed: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function runMock() {
  const MOCK_PORT = 3004;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intercom-test-'));
  // The modules read their caches relative to cwd; isolate them.
  process.chdir(tmp);
  fs.writeFileSync('.direct_identity_auth.json', JSON.stringify({ token: 'mock-token', csrf: 'mock-csrf', timestamp: Date.now() }));
  fs.writeFileSync('.env', '');
  process.env.UNIFI_IDENTITY_BASE_URL = `http://localhost:${MOCK_PORT}`;
  process.env.UNIFI_CLOUD_PASSWORD = 'unused';

  const users = [
    { unique_id: 'u-alice', full_name: 'Alice Admin', user_email: 'alice@example.com', status: 'ACTIVE' },
    { unique_id: 'u-bob', full_name: 'Bob Builder', user_email: 'bob@example.com', status: 'ACTIVE' },
    { unique_id: 'u-carol', full_name: 'Carol Gone', user_email: 'carol@example.com', status: 'DEACTIVATED' },
  ];
  const callerId = 'intercom-1';
  const rooms = new Map([
    ['room-admins', { name: 'Building Admins', receivers: ['u-alice'] }],
    ['room-legacy', { name: 'Legacy Co', receivers: ['u-alice'] }],
  ]);
  let nextRoom = 1;
  const log = [];

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (data, extra = {}) => send(200, { code: 1, codeS: 'SUCCESS', msg: 'success', data, ...extra });
    log.push(`${req.method} ${url.pathname}`);

    if (!/TOKEN=mock-token/.test(req.headers.cookie || '')) return send(401, { code: 401 });

    if (url.pathname === '/proxy/users/api/v2/users' && url.searchParams.has('email')) {
      const email = url.searchParams.get('email').toLowerCase();
      return ok(users.filter((u) => u.user_email === email));
    }
    if (url.pathname.startsWith('/proxy/users/api/v2/')) return ok([]);

    const access = url.pathname.replace('/proxy/access/api/v2', '');
    if (req.method === 'GET' && access === '/callers') {
      return ok([
        { unique_id: 'reader-1', name: 'UA G3 Pro', device_type: 'UA-G3-Pro' },
        { unique_id: callerId, name: 'UA G3 Intercom', alias: 'Building Door', device_type: 'UA-G3-Intercom' },
      ]);
    }
    if (req.method === 'GET' && access === `/callers/${callerId}`) {
      return ok({
        unique_id: callerId,
        alias: 'Building Door',
        rooms: [...rooms].map(([id, r]) => ({ unique_id: id, room_name: r.name, room: '' })),
      });
    }
    if (req.method === 'GET' && access === `/callers/${callerId}/topology`) {
      const vertices = [{ node_id: 'n-caller', type: 'caller', extra: {} }];
      const edges = [];
      for (const [id, r] of rooms) {
        vertices.push({ node_id: `n-${id}`, type: 'directory', extra: { name: r.name, room_id: id } });
        edges.push({ uplink_id: 'n-caller', downlink_id: `n-${id}` });
        r.receivers.forEach((uid, i) => {
          const node = `n-${id}-${i}`;
          vertices.push({ node_id: node, type: 'admin', extra: { id: uid, name: users.find((u) => u.unique_id === uid)?.full_name } });
          edges.push({ uplink_id: `n-${id}`, downlink_id: node });
        });
      }
      return ok({ vertices, edges });
    }
    if (req.method === 'POST' && access === `/callers/${callerId}/rooms/receivers`) {
      const body = await readBody(req);
      if (!body.name || !Array.isArray(body.receiver_groups)) return send(400, { code: 400, msg: 'bad body' });
      const id = `room-${nextRoom++}`;
      rooms.set(id, { name: body.name, receivers: body.receiver_groups.flatMap((g) => g.admins) });
      return ok({ id });
    }
    const roomMatch = access.match(new RegExp(`^/callers/${callerId}/rooms/([^/]+)$`));
    if (roomMatch && req.method === 'POST') {
      const room = rooms.get(roomMatch[1]);
      if (!room) return send(404, { code: 404, codeS: 'CODE_NOT_FOUND', msg: 'no room' });
      const body = await readBody(req);
      if (body.name !== undefined) room.name = body.name;
      if (body.receiver_groups) room.receivers = body.receiver_groups.flatMap((g) => g.admins);
      return ok({});
    }
    if (roomMatch && req.method === 'DELETE') {
      if (!rooms.delete(roomMatch[1])) return send(404, { code: 404, codeS: 'CODE_NOT_FOUND', msg: 'no room' });
      return ok({});
    }
    return send(404, { code: 404, codeS: 'CODE_NOT_FOUND', msg: 'The API was not found.' });
  });

  await new Promise((r) => server.listen(MOCK_PORT, r));

  try {
    const intercom = await import('./intercom.mjs');

    const dir = await intercom.getIntercomDirectory();
    assert(dir.callerId === callerId, 'auto-detected the intercom among callers');
    assert(dir.rooms.length === 2 && dir.rooms.every((r) => !r.managed), 'existing rooms read as unmanaged');
    assert(dir.rooms[0].receivers[0]?.id === 'u-alice', 'receivers resolved from topology');

    // Upsert: create one, adopt one by name, fail one with no active receivers.
    const r1 = await intercom.syncIntercomDirectory({
      entries: [
        { company: 'Acme Corp', contacts: [{ name: 'Alice', email: 'alice@example.com' }, { name: 'Bob', email: 'bob@example.com' }, { name: 'Nobody', email: 'nobody@example.com' }] },
        { company: 'legacy co', contacts: [{ name: 'Bob', email: 'bob@example.com' }] },
        { company: 'Ghost LLC', contacts: [{ name: 'Carol', email: 'carol@example.com' }, { name: 'No Email' }] },
      ],
    });
    const acme = r1.synced.find((s) => s.company === 'Acme Corp');
    assert(acme?.status === 'created' && acme.receiverCount === 2, 'Acme created with 2 receivers');
    assert(acme.unresolvedContacts.length === 1 && acme.unresolvedContacts[0].reason === 'no_unifi_account', 'missing account reported as unresolved');
    const legacy = r1.synced.find((s) => s.company === 'legacy co');
    assert(legacy?.roomId === 'room-legacy' && legacy.status === 'updated', 'existing room adopted by name (case-insensitive) and updated');
    assert(rooms.get('room-legacy').receivers.join() === 'u-bob', 'adopted room receivers replaced');
    assert(rooms.get('room-legacy').name === 'legacy co', 'adopted room renamed to the canonical company name');
    const ghost = r1.failed.find((f) => f.company === 'Ghost LLC');
    assert(ghost && ghost.unresolvedContacts.length === 2, 'entry with no active receivers fails with details');
    assert(ghost.unresolvedContacts.some((c) => c.reason === 'unifi_account_inactive'), 'inactive account reason surfaced');
    assert(r1.ok === false, 'partial failure sets ok=false');
    assert(r1.unmanaged.length === 1 && r1.unmanaged[0].roomId === 'room-admins', 'Building Admins stays unmanaged');
    assert(r1.unmanaged[0].name === '* Building Admins', 'Building Admins is renamed so it sorts first');
    assert(rooms.get('room-admins').name === '* Building Admins', 'pin is written to the live room');

    // Idempotent re-run.
    const r2 = await intercom.syncIntercomDirectory({
      entries: [{ company: 'Acme Corp', contacts: [{ email: 'bob@example.com' }, { email: 'alice@example.com' }] }],
    });
    assert(r2.synced[0].status === 'unchanged', 're-sync with same receivers (different order) is unchanged');

    // A managed room renamed on the device (or a company renamed in Foundations)
    // is re-matched by live name instead of duplicated.
    const acmeRoomId = r2.synced[0].roomId;
    rooms.get(acmeRoomId).name = 'Acme Corporation';
    const r2b = await intercom.syncIntercomDirectory({
      entries: [{ company: 'Acme Corporation', contacts: [{ email: 'bob@example.com' }, { email: 'alice@example.com' }] }],
    });
    assert(r2b.synced[0].roomId === acmeRoomId && r2b.synced[0].status === 'unchanged', 'renamed managed room re-matched by live name');
    assert([...rooms.values()].filter((r) => /acme/i.test(r.name)).length === 1, 'no duplicate room after rename');
    // With a stable key, a company renamed in the caller's system updates the
    // same room even though neither the state nor the live name matches.
    const keyed = await intercom.syncIntercomDirectory({
      entries: [{ key: 'company:1', company: 'Acme Corporation', contacts: [{ email: 'alice@example.com' }] }],
    });
    assert(keyed.synced[0].roomId === acmeRoomId, 'key attached to the existing managed room');
    const r2c = await intercom.syncIntercomDirectory({
      entries: [{ key: 'company:1', company: 'Acme Corp', contacts: [{ email: 'bob@example.com' }, { email: 'alice@example.com' }] }],
    });
    assert(r2c.synced[0].roomId === acmeRoomId && r2c.synced[0].status === 'updated', 'rename via stable key updates the same room');
    assert(rooms.get(acmeRoomId).name === 'Acme Corp', 'room renamed on the device');

    // Replace: removes managed rooms not listed, never Building Admins.
    const r3 = await intercom.syncIntercomDirectory({
      entries: [{ company: 'Acme Corp', contacts: [{ email: 'alice@example.com' }] }],
      mode: 'replace',
    });
    assert(r3.synced[0].status === 'updated', 'receiver removal detected as update');
    assert(r3.removed.length === 1 && r3.removed[0].roomId === 'room-legacy', 'replace removed the other managed room');
    assert(rooms.has('room-admins'), 'replace left Building Admins alone');
    assert(r3.unmanaged.every((r) => r.roomId !== 'room-legacy'), 'removed room is not listed as unmanaged');
    assert(!rooms.has('room-legacy'), 'legacy room deleted on the device');

    // Concurrency: overlapping syncs serialize.
    const [c1, c2] = await Promise.all([
      intercom.syncIntercomDirectory({ entries: [{ company: 'Par A', contacts: [{ email: 'alice@example.com' }] }] }),
      intercom.syncIntercomDirectory({ entries: [{ company: 'Par B', contacts: [{ email: 'bob@example.com' }] }] }),
    ]);
    assert(c1.synced[0].status === 'created' && c2.synced[0].status === 'created', 'concurrent syncs both succeed');
    assert(new Set([...rooms.values()].map((r) => r.name)).size === rooms.size, 'no duplicate rooms from concurrent syncs');

    // Hand-deleted managed room is forgotten, not double-deleted.
    const parA = [...rooms].find(([, r]) => r.name === 'Par A')[0];
    rooms.delete(parA);
    const r4 = await intercom.syncIntercomDirectory({ entries: [], mode: 'replace' });
    assert(!r4.failed.length, 'replace after a hand-deleted managed room reports no failure');
    assert(r4.removed.every((r) => r.roomId !== parA), 'hand-deleted room is not reported as removed');

    console.log('\nAll mock tests passed.');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
