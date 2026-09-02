// UniFi Access intercom directory management.
//
// The entry intercom (UA-G3-Intercom at the building door) shows visitors a
// searchable directory: each entry is a "room" on the caller device with one
// or more "receivers" (UniFi Access users who get the call on the Identity
// Endpoint app). UniFi publishes no API for this — everything below was
// reverse-engineered from the UniFi Access web UI (caller-topology and
// callReceiver bundles) and validated against the live console:
//
//   GET    /v2/callers                         list caller devices
//   GET    /v2/callers/:callerId               caller detail incl. rooms[]
//   GET    /v2/callers/:callerId/topology      call-flow graph (directories → receivers)
//   POST   /v2/callers/:callerId/rooms/receivers   create a directory entry
//   POST   /v2/callers/:callerId/rooms/:roomId     update an entry (name / receivers)
//   DELETE /v2/callers/:callerId/rooms/:roomId     remove an entry
//
// Receivers are addressed by the user's `unique_id` from the Identity users
// API — the same id direct_identity.findUserByEmail() returns — under the
// (historically named) `admins` bucket; plain Access users are valid there.
//
// Sync semantics: this module only ever deletes rooms it created itself (or
// explicitly adopted by name), tracked in a local state file, so hand-built
// entries like "Building Admins" are never touched by a `replace` sync.

process.loadEnvFile();

import fs from 'fs';
import { getAuthToken, clearAuthCache, findUserByEmail, IDENTITY_BASE } from './direct_identity.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ACCESS_API = `${IDENTITY_BASE}/proxy/access/api/v2`;
const STATE_FILE = process.env.INTERCOM_DIRECTORY_STATE_FILE || '.intercom_directory_state.json';
const MAX_ROOM_NAME_LENGTH = 64;

// Topology vertex types that represent something a call rings.
const RECEIVER_NODE_TYPES = new Set([
  'admin', 'viewer', 'chime', 'phone_number', 'third_party_sip', 'third_party_viewer',
]);

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function accessRequest(path, { method = 'GET', body, query } = {}, retryOnAuth = true) {
  const auth = await getAuthToken();
  const url = new URL(`${ACCESS_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://unifi.ui.com',
    Referer: 'https://unifi.ui.com/',
    Cookie: `TOKEN=${auth.token}`,
  };
  if (auth.csrf) headers['X-Csrf-Token'] = auth.csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retryOnAuth) {
    console.log('[intercom] 401 from UniFi Access, re-authenticating once');
    clearAuthCache();
    return accessRequest(path, { method, body, query }, false);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch {}

  const apiOk = json && (json.code === 1 || json.codeS === 'SUCCESS');
  if (!res.ok || !apiOk) {
    const detail = json?.msg || json?.codeS || text.slice(0, 200) || res.statusText;
    const err = new Error(`UniFi Access ${method} ${path} failed (${res.status}): ${detail}`);
    err.status = res.status;
    err.codeS = json?.codeS;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Managed-room state (which rooms this module owns)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {
    console.log(`[intercom] could not read ${STATE_FILE}: ${e.message}`);
  }
  return { callers: {} };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.log(`[intercom] could not write ${STATE_FILE}: ${e.message}`);
  }
}

function managedRoomsFor(state, callerId) {
  if (!state.callers) state.callers = {};
  if (!state.callers[callerId]) state.callers[callerId] = { rooms: {} };
  if (!state.callers[callerId].rooms) state.callers[callerId].rooms = {};
  return state.callers[callerId].rooms;
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

export async function listCallers() {
  const { data } = await accessRequest('/callers');
  return Array.isArray(data) ? data : [];
}

function isIntercom(device) {
  const type = `${device.device_type || ''} ${device.display_model || ''} ${device.name || ''}`;
  return /intercom/i.test(type);
}

/**
 * The caller device whose directory we manage. Explicit override via
 * UNIFI_INTERCOM_DEVICE_ID; otherwise the single intercom-class caller.
 */
export async function resolveIntercomCallerId() {
  const explicit = (process.env.UNIFI_INTERCOM_DEVICE_ID || '').trim();
  if (explicit) return explicit;

  const intercoms = (await listCallers()).filter(isIntercom);
  if (intercoms.length === 1) return intercoms[0].unique_id;
  if (intercoms.length === 0) {
    throw new Error('No UniFi Access intercom found among caller devices; set UNIFI_INTERCOM_DEVICE_ID');
  }
  const names = intercoms.map((d) => `${d.alias || d.name} (${d.unique_id})`).join(', ');
  throw new Error(`Multiple intercoms found — set UNIFI_INTERCOM_DEVICE_ID to one of: ${names}`);
}

// ---------------------------------------------------------------------------
// Reading the directory
// ---------------------------------------------------------------------------

function receiverIdFromNode(node) {
  const extra = node.extra || {};
  return extra.id || extra.userId || extra.device_id || extra.unique_id || null;
}

/**
 * Current directory on the intercom: every room with its receivers, flagged
 * with whether this module manages it.
 */
export async function getIntercomDirectory(callerId) {
  const resolvedCallerId = callerId || (await resolveIntercomCallerId());
  const [detail, topology] = await Promise.all([
    accessRequest(`/callers/${resolvedCallerId}`),
    accessRequest(`/callers/${resolvedCallerId}/topology`, { query: { flow: 'true', support_delivery: 'true' } }),
  ]);

  const caller = detail.data || {};
  const vertices = topology.data?.vertices || [];
  const edges = topology.data?.edges || [];

  const byNode = new Map(vertices.map((v) => [v.node_id, v]));
  const children = new Map();
  for (const edge of edges) {
    if (!children.has(edge.uplink_id)) children.set(edge.uplink_id, []);
    children.get(edge.uplink_id).push(edge.downlink_id);
  }

  // Receivers may sit directly under the directory or nest under receiver
  // groups / timeouts, so walk all descendants of each directory vertex.
  const receiversByRoom = new Map();
  for (const vertex of vertices) {
    if (vertex.type !== 'directory') continue;
    const roomId = vertex.extra?.room_id;
    if (!roomId) continue;
    const receivers = [];
    const seen = new Set();
    const stack = [...(children.get(vertex.node_id) || [])];
    while (stack.length) {
      const nodeId = stack.pop();
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const node = byNode.get(nodeId);
      if (!node) continue;
      if (RECEIVER_NODE_TYPES.has(node.type)) {
        receivers.push({ id: receiverIdFromNode(node), type: node.type, name: node.extra?.name || '' });
      }
      for (const child of children.get(nodeId) || []) stack.push(child);
    }
    receiversByRoom.set(roomId, receivers);
  }

  const state = loadState();
  const managed = managedRoomsFor(state, resolvedCallerId);

  const rooms = (caller.rooms || []).map((room) => {
    const id = room.unique_id || room.id;
    return {
      id,
      name: room.room_name || room.name || '',
      dialCode: room.room || room.room_number || '',
      receivers: receiversByRoom.get(id) || [],
      managed: Boolean(managed[id]),
      company: managed[id]?.company || null,
    };
  });

  const callerVertex = vertices.find((v) => v.type === 'caller');
  return {
    callerId: resolvedCallerId,
    callerName: caller.alias || caller.name || callerVertex?.extra?.name || '',
    rooms,
  };
}

// ---------------------------------------------------------------------------
// Receiver resolution
// ---------------------------------------------------------------------------

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isActiveUser(user) {
  const status = String(user?.status || user?.raw?.user_status || '').toUpperCase();
  return status === '' || status === 'ACTIVE';
}

/**
 * Map directory contacts ({ name, email }) to Access user ids. Contacts with
 * no email, no Access account, or a deactivated account are reported back as
 * unresolved rather than dropped silently.
 */
async function resolveReceivers(contacts, cache) {
  const receiverIds = [];
  const resolved = [];
  const unresolved = [];
  const seenIds = new Set();

  for (const contact of contacts || []) {
    const name = String(contact?.name || '').trim();
    const email = normalizeEmail(contact?.email);
    if (!email) {
      unresolved.push({ name, email: null, reason: 'no_email' });
      continue;
    }

    let user = cache.get(email);
    if (user === undefined) {
      try {
        user = await findUserByEmail(email);
      } catch (e) {
        user = { lookupError: e.message };
      }
      cache.set(email, user);
    }

    if (!user) {
      unresolved.push({ name, email, reason: 'no_unifi_account' });
      continue;
    }
    if (user.lookupError) {
      unresolved.push({ name, email, reason: `lookup_failed: ${user.lookupError}` });
      continue;
    }
    if (!isActiveUser(user)) {
      unresolved.push({ name, email, reason: 'unifi_account_inactive' });
      continue;
    }
    if (!user.id) {
      unresolved.push({ name, email, reason: 'no_user_id' });
      continue;
    }
    if (seenIds.has(user.id)) continue;
    seenIds.add(user.id);
    receiverIds.push(user.id);
    resolved.push({ name: name || user.name || '', email, userId: user.id });
  }

  return { receiverIds, resolved, unresolved };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function receiverGroups(receiverIds) {
  return [{
    viewers: [],
    admins: [...receiverIds],
    chimes: [],
    phone_numbers: [],
    third_party_sips: [],
    third_party_viewers: [],
  }];
}

function cleanRoomName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME_LENGTH);
}

export async function createRoom(callerId, { name, receiverIds }) {
  const body = {
    disable_directory: false,
    receiver_groups: receiverGroups(receiverIds),
    name: cleanRoomName(name),
    room: '',
    number_check: false,
  };
  const res = await accessRequest(`/callers/${callerId}/rooms/receivers`, { method: 'POST', body });
  return res.data?.id || res.data?.unique_id || null;
}

export async function updateRoom(callerId, roomId, { name, receiverIds }) {
  const body = {};
  if (name !== undefined) body.name = cleanRoomName(name);
  if (receiverIds !== undefined) body.receiver_groups = receiverGroups(receiverIds);
  await accessRequest(`/callers/${callerId}/rooms/${roomId}`, { method: 'POST', body });
}

export async function deleteRoom(callerId, roomId) {
  await accessRequest(`/callers/${callerId}/rooms/${roomId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((id) => sa.has(id));
}

function companyKey(name) {
  return cleanRoomName(name).toLowerCase();
}

// Directory syncs are serialized: two concurrent syncs would race on the
// room list and the state file.
let syncChain = Promise.resolve();

/**
 * Push company directory entries onto the intercom.
 *
 * @param {object} opts
 * @param {Array<{ key?: string, company: string, contacts: Array<{ name?: string, email?: string }> }>} opts.entries
 *   `key` is an optional caller-owned stable id (e.g. "company:42") so a
 *   renamed company updates its existing room instead of creating a new one
 * @param {'upsert'|'replace'} [opts.mode] upsert (default) creates/updates the
 *   given entries and leaves everything else alone; replace additionally
 *   removes rooms this module previously created that are not in `entries`.
 * @param {string} [opts.callerId] caller device override
 */
export function syncIntercomDirectory(opts) {
  const run = syncChain.then(() => syncIntercomDirectoryUnlocked(opts));
  syncChain = run.catch(() => {});
  return run;
}

async function syncIntercomDirectoryUnlocked({ entries, mode = 'upsert', callerId } = {}) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  if (mode !== 'upsert' && mode !== 'replace') throw new Error(`unknown mode "${mode}"`);

  const directory = await getIntercomDirectory(callerId);
  const resolvedCallerId = directory.callerId;
  const state = loadState();
  const managed = managedRoomsFor(state, resolvedCallerId);

  // Forget managed rooms that no longer exist on the device (deleted by hand).
  const liveRoomIds = new Set(directory.rooms.map((r) => r.id));
  for (const roomId of Object.keys(managed)) {
    if (!liveRoomIds.has(roomId)) delete managed[roomId];
  }

  const roomsById = new Map(directory.rooms.map((r) => [r.id, r]));
  const managedByKey = new Map();
  const managedByCompany = new Map();
  for (const [roomId, info] of Object.entries(managed)) {
    if (info?.key) managedByKey.set(info.key, roomId);
    if (info?.company) managedByCompany.set(companyKey(info.company), roomId);
  }
  // Live room names — lets a sync re-match a room whose company was renamed
  // (in Foundations or in the UniFi console) and adopt hand-made entries.
  const roomsByLiveName = new Map();
  for (const room of directory.rooms) {
    if (!roomsByLiveName.has(companyKey(room.name))) roomsByLiveName.set(companyKey(room.name), room.id);
  }

  const synced = [];
  const failed = [];
  const removed = [];
  const userCache = new Map();
  const touchedCompanies = new Set();

  for (const entry of entries) {
    const company = cleanRoomName(entry?.company);
    if (!company) {
      failed.push({ company: '', error: 'entry is missing a company name' });
      continue;
    }
    const key = companyKey(company);
    const stableKey = entry?.key ? String(entry.key).trim() : '';
    if (touchedCompanies.has(key)) {
      failed.push({ company, error: 'duplicate company in the same sync' });
      continue;
    }
    touchedCompanies.add(key);

    const { receiverIds, resolved, unresolved } = await resolveReceivers(entry.contacts, userCache);
    if (receiverIds.length === 0) {
      failed.push({
        company,
        error: 'none of the listed contacts has an active UniFi Access account to receive calls',
        unresolvedContacts: unresolved,
      });
      continue;
    }

    // Match order: the caller's stable key (survives company renames) → the
    // room we manage under this company name → any room currently named after
    // the company (a renamed managed room, or a hand-made entry, which gets
    // adopted).
    let roomId = (stableKey && managedByKey.get(stableKey))
      || managedByCompany.get(key)
      || roomsByLiveName.get(key)
      || null;
    if (roomId && managed[roomId] && companyKey(managed[roomId].company) !== key) {
      managedByCompany.delete(companyKey(managed[roomId].company));
    }
    const existing = roomId ? roomsById.get(roomId) : null;

    try {
      let status;
      if (!existing) {
        roomId = await createRoom(resolvedCallerId, { name: company, receiverIds });
        if (!roomId) {
          // The create succeeded but returned no id — find it by name.
          const refreshed = await getIntercomDirectory(resolvedCallerId);
          roomId = refreshed.rooms.find((r) => companyKey(r.name) === key)?.id || null;
        }
        if (!roomId) throw new Error('room created but its id could not be determined');
        status = 'created';
      } else {
        const currentReceiverIds = existing.receivers
          .filter((r) => r.type === 'admin' && r.id)
          .map((r) => r.id);
        const nameChanged = cleanRoomName(existing.name) !== company;
        const receiversChanged = !sameIdSet(currentReceiverIds, receiverIds);
        if (nameChanged || receiversChanged) {
          await updateRoom(resolvedCallerId, roomId, {
            ...(nameChanged ? { name: company } : {}),
            ...(receiversChanged ? { receiverIds } : {}),
          });
          status = 'updated';
        } else {
          status = 'unchanged';
        }
      }

      managed[roomId] = {
        company,
        key: stableKey || managed[roomId]?.key || null,
        syncedAt: new Date().toISOString(),
      };
      if (managed[roomId].key) managedByKey.set(managed[roomId].key, roomId);
      managedByCompany.set(key, roomId);
      roomsByLiveName.set(key, roomId);
      saveState(state);

      synced.push({
        company,
        roomId,
        status,
        receiverCount: receiverIds.length,
        resolvedContacts: resolved,
        unresolvedContacts: unresolved,
      });
    } catch (e) {
      console.log(`[intercom] sync failed for "${company}": ${e.message}`);
      failed.push({ company, error: e.message, unresolvedContacts: unresolved });
    }
  }

  if (mode === 'replace') {
    for (const [roomId, info] of Object.entries(managed)) {
      if (touchedCompanies.has(companyKey(info?.company))) continue;
      try {
        await deleteRoom(resolvedCallerId, roomId);
        delete managed[roomId];
        saveState(state);
        removed.push({ company: info?.company || roomsById.get(roomId)?.name || '', roomId });
      } catch (e) {
        console.log(`[intercom] failed to remove room ${roomId}: ${e.message}`);
        failed.push({ company: info?.company || '', roomId, error: `remove failed: ${e.message}` });
      }
    }
  }

  const removedIds = new Set(removed.map((r) => r.roomId));
  const unmanaged = directory.rooms
    .filter((r) => !managed[r.id] && !removedIds.has(r.id))
    .map((r) => ({ roomId: r.id, name: r.name }));

  return {
    ok: failed.length === 0,
    callerId: resolvedCallerId,
    callerName: directory.callerName,
    mode,
    synced,
    removed,
    failed,
    unmanaged,
  };
}
