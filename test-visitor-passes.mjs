#!/usr/bin/env node

// Test script for visitor pass management.
// Spins up a mock UniFi Access developer API and exercises visitors.mjs
// against it: pass creation (with generated + explicit PINs), time parsing,
// fetch, and revocation. No real UniFi hardware is touched.
//
// Usage: node test-visitor-passes.mjs

import http from 'http';

const MOCK_PORT = 3003;

// Point visitors.mjs at the mock before importing it. process.loadEnvFile()
// inside the module will not overwrite these existing values.
process.env.UNIFI_DOOR_API = `http://localhost:${MOCK_PORT}`;
process.env.UNIFI_DOOR_TOKEN = 'test-token';

const visitors = new Map();
let nextVisitorId = 1;
let pinAssignmentShouldFail = false;
let topologyRequestCount = 0;

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${MOCK_PORT}`);
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.headers.authorization !== 'Bearer test-token') {
    return send({ code: 'CODE_ACCESS_TOKEN_INVALID', msg: 'invalid token' });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/developer/credentials/pin_codes') {
    return send({ code: 'SUCCESS', data: '67203419', msg: 'success' });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/developer/door_groups/topology') {
    topologyRequestCount++;
    return send({
      code: 'SUCCESS',
      data: [
        {
          id: 'building-group-1',
          name: 'All Locations',
          type: 'building',
          resource_topologies: [],
        },
        {
          id: 'custom-group-1',
          name: 'customized group',
          type: 'access',
          resource_topologies: [],
        },
      ],
      msg: 'success',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/developer/visitors') {
    const body = await readBody(req);
    const visitor = {
      id: `visitor-${nextVisitorId++}`,
      first_name: body.first_name,
      last_name: body.last_name,
      remarks: body.remarks,
      start_time: body.start_time,
      end_time: body.end_time,
      status: 'UPCOMING',
      pin_code: null,
      requested_resources: body.resources,
    };
    visitors.set(visitor.id, visitor);
    return send({ code: 'SUCCESS', data: visitor, msg: 'success' });
  }

  const pinMatch = url.pathname.match(/^\/api\/v1\/developer\/visitors\/([^/]+)\/pin_codes$/);
  if (req.method === 'PUT' && pinMatch) {
    if (pinAssignmentShouldFail) {
      return send({ code: 'CODE_SYSTEM_ERROR', msg: 'simulated pin failure' });
    }
    const visitor = visitors.get(pinMatch[1]);
    if (!visitor) return send({ code: 'CODE_NOT_EXISTS', msg: 'not found' });
    const body = await readBody(req);
    visitor.pin_code = { token: `hash-of-${body.pin_code}` };
    return send({ code: 'SUCCESS', msg: 'success' });
  }

  const visitorMatch = url.pathname.match(/^\/api\/v1\/developer\/visitors\/([^/]+)$/);
  if (req.method === 'GET' && visitorMatch) {
    const visitor = visitors.get(visitorMatch[1]);
    if (!visitor) return send({ code: 'CODE_NOT_EXISTS', msg: 'not found' });
    return send({ code: 'SUCCESS', data: visitor, msg: 'success' });
  }

  if (req.method === 'DELETE' && visitorMatch) {
    const visitor = visitors.get(visitorMatch[1]);
    if (!visitor) return send({ code: 'CODE_NOT_EXISTS', msg: 'not found' });
    if (url.searchParams.get('is_force') === 'true') {
      visitors.delete(visitorMatch[1]);
    } else {
      visitor.status = 'CANCELLED';
    }
    return send({ code: 'SUCCESS', msg: 'success' });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/developer/visitors') {
    return send({ code: 'SUCCESS', data: [...visitors.values()], msg: 'success' });
  }

  return send({ code: 'CODE_RESOURCE_NOT_FOUND', msg: 'not found' });
});

let failures = 0;
const check = (label, condition) => {
  console.log(`${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures++;
};

const runTests = async () => {
  const { createVisitorPass, fetchVisitor, fetchAllVisitors, deleteVisitor, toEpochSeconds } =
    await import('./visitors.mjs');

  console.log('\n=== toEpochSeconds ===');
  check('epoch seconds pass through', toEpochSeconds(1751500800) === 1751500800);
  check('epoch ms are converted', toEpochSeconds(1751500800000) === 1751500800);
  check('numeric strings work', toEpochSeconds('1751500800') === 1751500800);
  check(
    'ISO 8601 strings work',
    toEpochSeconds('2026-07-02T17:00:00Z') === Math.floor(Date.parse('2026-07-02T17:00:00Z') / 1000)
  );
  check('garbage returns undefined', toEpochSeconds('not-a-date') === undefined);

  console.log('\n=== Create pass with generated PIN ===');
  const start = Math.floor(Date.now() / 1000);
  const end = start + 4 * 3600;
  const pass = await createVisitorPass({
    firstName: 'Open House',
    lastName: 'Guest',
    startTime: start,
    endTime: end,
    remarks: 'July open house event',
  });
  check('pass has an id', Boolean(pass.id));
  check('pass returns generated plaintext PIN', pass.pinCode === '67203419');
  check('mock recorded the PIN assignment', visitors.get(pass.id)?.pin_code?.token === 'hash-of-67203419');
  check('window stored as epoch seconds', visitors.get(pass.id)?.start_time === start && visitors.get(pass.id)?.end_time === end);
  check(
    'All Locations door group requested',
    JSON.stringify(visitors.get(pass.id)?.requested_resources) ===
      JSON.stringify([{ id: 'building-group-1', type: 'door_group' }])
  );

  console.log('\n=== Create pass with explicit PIN ===');
  const pass2 = await createVisitorPass({
    firstName: 'Board',
    lastName: 'Meeting',
    startTime: start,
    endTime: end,
    pinCode: '12345678',
  });
  check('explicit PIN is used', pass2.pinCode === '12345678');
  check('mock recorded explicit PIN', visitors.get(pass2.id)?.pin_code?.token === 'hash-of-12345678');
  check(
    'second pass also gets All Locations',
    JSON.stringify(visitors.get(pass2.id)?.requested_resources) ===
      JSON.stringify([{ id: 'building-group-1', type: 'door_group' }])
  );
  check('topology is cached across passes', topologyRequestCount === 1);

  console.log('\n=== Fetch and list ===');
  const fetched = await fetchVisitor(pass.id);
  check('fetchVisitor returns the pass', fetched.first_name === 'Open House');
  const all = await fetchAllVisitors();
  check('fetchAllVisitors lists both passes', all.length === 2);

  console.log('\n=== Revoke (soft) and delete (force) ===');
  await deleteVisitor(pass.id);
  check('soft delete cancels the visit', visitors.get(pass.id)?.status === 'CANCELLED');
  await deleteVisitor(pass2.id, { force: true });
  check('force delete removes the visitor', !visitors.has(pass2.id));

  console.log('\n=== PIN assignment failure cleans up visitor ===');
  pinAssignmentShouldFail = true;
  let threw = false;
  try {
    await createVisitorPass({ firstName: 'Doomed', startTime: start, endTime: end });
  } catch (error) {
    threw = /PIN assignment failed/.test(error.message);
  }
  pinAssignmentShouldFail = false;
  check('createVisitorPass throws on PIN failure', threw);
  check('orphaned visitor was force-deleted', ![...visitors.values()].some((v) => v.first_name === 'Doomed'));
};

mockServer.listen(MOCK_PORT, async () => {
  console.log(`Mock UniFi Access API running on port ${MOCK_PORT}`);
  try {
    await runTests();
  } catch (error) {
    console.error('\nTest run crashed:', error);
    failures++;
  } finally {
    mockServer.close();
    console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  }
});
