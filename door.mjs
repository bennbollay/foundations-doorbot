const csv = require('csv-parse');
import { sendDoorEventsToWebhook } from './webhook.mjs';

process.loadEnvFile();

const doorEndpoint = process.env.UNIFI_DOOR_API;
const doorAuthToken = process.env.UNIFI_DOOR_TOKEN;
// Only use ACCESS events from these devices.
const allowedDoorDevices = process.env.UNIFI_DOOR_DEVICES.split(' ');
// Door access webhook API endpoint and API key
// Removed doorWebhookEndpoint and doorWebhookApiKey as they're now in webhook.mjs

const doorHeaders = {
  Authorization: `Bearer ${doorAuthToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

// Removed sendDoorEventsToWebhook function as it's now in webhook.mjs
let doorAccessMetadataPromise;

const getNonEmptyRecordValue = (record, keys) => {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }

    const normalized = String(value).trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
};

const getDoorAccessMethod = (record) => {
  const knownValue = getNonEmptyRecordValue(record, [
    'authentication.credential_provider',
    'authentication.credential_provider.display_name',
    'authentication.provider',
    'authentication.provider.display_name',
    'credential_provider',
    'credential_provider.display_name',
    'credential.display_name',
    'credential.type',
    'authentication.method',
    'authentication.type',
    'access.method',
    'access_method',
    'unlock_method',
  ]);

  if (knownValue) {
    return knownValue;
  }

  const discoveredValue = Object.entries(record).find(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return false;
    }

    return /(credential|provider|unlock_method|access_method|authentication\.method)/i.test(key);
  });

  return discoveredValue?.[1] ? String(discoveredValue[1]).trim() : 'Unknown';
};

const isNonAccessTargetType = (type) => {
  if (!type) {
    return false;
  }

  return /^(device_config|reason_code|three_button_method)$/i.test(type) || /^UA-G\d/i.test(type);
};

const flattenDeviceGroups = (data) => {
  const devices = [];

  for (const item of data || []) {
    if (Array.isArray(item)) {
      devices.push(...item);
      continue;
    }

    devices.push(item);
  }

  return devices;
};

const fetchDoorAccessMetadata = async () => {
  if (!doorAccessMetadataPromise) {
    doorAccessMetadataPromise = (async () => {
      const [doorsResponse, devicesResponse] = await Promise.all([
        fetch(`${doorEndpoint}/api/v1/developer/doors`, { headers: { ...doorHeaders } }),
        fetch(`${doorEndpoint}/api/v1/developer/devices`, { headers: { ...doorHeaders } }),
      ]);

      const doorsResult = await doorsResponse.json();
      const devicesResult = await devicesResponse.json();

      if (doorsResult.code !== 'SUCCESS' || devicesResult.code !== 'SUCCESS') {
        throw new Error('Failed to fetch door access metadata');
      }

      const doors = doorsResult.data || [];
      const devices = flattenDeviceGroups(devicesResult.data);
      const doorById = new Map(doors.map((door) => [door.id, door]));
      const doorLookup = new Map();

      for (const device of devices) {
        const alias = typeof device.alias === 'string' ? device.alias.trim() : '';
        const mappedDoor = doorById.get(device.location_id);
        const name = alias || mappedDoor?.name || device.name || '';
        const logicalDoorId = mappedDoor?.id || '';
        const entry = {
          name,
          id: logicalDoorId || device.id || '',
        };

        for (const key of [device.id, device.connected_uah_id, device.location_id]) {
          if (!key || !name || doorLookup.has(key)) {
            continue;
          }

          doorLookup.set(key, entry);
        }
      }

      for (const door of doors) {
        if (!doorLookup.has(door.id)) {
          doorLookup.set(door.id, { name: door.name || door.full_name || '', id: door.id });
        }
      }

      return { doorLookup };
    })().catch((error) => {
      doorAccessMetadataPromise = undefined;
      throw error;
    });
  }

  return doorAccessMetadataPromise;
};

const getDoorAccessPoint = (record, doorLookup) => {
  const candidates = [
    {
      name: getNonEmptyRecordValue(record, ['target5.display_name']),
      id: getNonEmptyRecordValue(record, ['target5.id']),
      type: getNonEmptyRecordValue(record, ['target5.type']),
    },
    {
      name: getNonEmptyRecordValue(record, ['target1.display_name']),
      id: getNonEmptyRecordValue(record, ['target1.id']),
      type: getNonEmptyRecordValue(record, ['target1.type']),
    },
    {
      name: getNonEmptyRecordValue(record, ['target4.display_name']),
      id: getNonEmptyRecordValue(record, ['target4.id']),
      type: getNonEmptyRecordValue(record, ['target4.type']),
    },
  ];

  for (const candidate of candidates) {
    const mappedDoor = candidate.id ? doorLookup.get(candidate.id) : undefined;
    if (mappedDoor?.name) {
      return {
        accessPoint: mappedDoor.name,
        accessPointId: mappedDoor.id || candidate.id,
      };
    }
  }

  const preferredCandidate = candidates.find((candidate) => candidate.name && !isNonAccessTargetType(candidate.type));
  if (preferredCandidate) {
    return {
      accessPoint: preferredCandidate.name,
      accessPointId: preferredCandidate.id || '',
    };
  }

  const fallbackCandidate = candidates.find((candidate) => candidate.name);
  return {
    accessPoint: fallbackCandidate?.name || '',
    accessPointId: fallbackCandidate?.id || '',
  };
};

const fetchDoorOpenings = async (timeBracket) => {
  const body = {
    topic: 'door_openings',
    since: Math.floor(timeBracket[0] / 1000),
    until: Math.floor(timeBracket[1] / 1000),
    timezone: 'America/Los_Angeles',
  };

  const result = await fetch(`${doorEndpoint}/api/v1/developer/system/logs/export`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { ...doorHeaders },
  });

  const text = await result.text();

  const data = csv.parse(text, { columns: true });
  const { doorLookup } = await fetchDoorAccessMetadata();

  const openings = {};
  const successfulEvents = [];
  
  for await (const record of data) {
    // Filter out failed entrance attempts (which don't have a user anyways)
    if (record['event.result'] != 'ACCESS') {
      continue;
    }

    // Prepare event data for webhook for all successful events
    const userInfo = await fetchDoorUser(record['actor.id']) || {};

    // Format time field for webhook API
    const time = record['time'] || record['event.time'];
    const timestamp = time ? new Date(time).toISOString() : new Date().toISOString();
    const { accessPoint, accessPointId } = getDoorAccessPoint(record, doorLookup);

    const eventData = {
      user_name: record['actor.display_name'],
      user_email: userInfo.doorEmail,
      user_id: record['actor.id'],
      timestamp: timestamp,
      site: record['target2.display_name'] || '',
      site_id: record['target2.id'] || '',
      access_point: accessPoint,
      access_point_id: accessPointId,
      status: 'ACCESS', // We are filtering out denied events above
      method: getDoorAccessMethod(record),
      details: record['event.display_message'] || ''
    };
    
    successfulEvents.push(eventData);

    // Filter for only the Building Door of the space for the slack notifications
    if (!allowedDoorDevices.includes(accessPointId)) {
      continue;
    }

    const name = record['actor.display_name'];
    if (name in openings) {
      continue;
    }
    openings[name] = {
      name,
      doorId: record['actor.id'],
      ...(userInfo || {}),
    };
  }

  // Always send events to webhook (even if empty array)
  // The webhook may have pending actions to return regardless of new events
  try {
    await sendDoorEventsToWebhook(successfulEvents);
  } catch (error) {
    console.error('Warning: Webhook call failed, continuing without webhook processing');
    console.error('Webhook error:', error.message);
    // Continue execution even if webhook fails
  }

  return { data: Object.values(openings).reverse(), timeBracket };
};

const fetchDoorUser = async (userId) => {
  const result = await fetch(`${doorEndpoint}/api/v1/developer/users/${userId}`, { headers: { ...doorHeaders } });

  const res = await result.json();

  if (res.code != 'SUCCESS') {
    return undefined;
  }

  return {
    doorEmail: res.data.user_email,
    firstName: res.data.first_name,
    lastName: res.data.last_name,
    fullName: res.data.full_name,
  };
};

export { fetchDoorOpenings };
