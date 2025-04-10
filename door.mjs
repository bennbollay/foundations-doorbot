const csv = require('csv-parse');

process.loadEnvFile();

const doorEndpoint = process.env.UNIFI_DOOR_API;
const doorAuthToken = process.env.UNIFI_DOOR_TOKEN;
// Only use ACCESS events from these devices.
const allowedDoorDevices = process.env.UNIFI_DOOR_DEVICES.split(' ');
// Door access webhook API endpoint and API key
const doorWebhookEndpoint = process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT;
const doorWebhookApiKey = process.env.DOOR_ACCESS_WEBHOOK_API_KEY;

const doorHeaders = {
  Authorization: `Bearer ${doorAuthToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const sendDoorEventsToWebhook = async (events) => {
  if (!doorWebhookEndpoint || !doorWebhookApiKey) {
    console.log('Door webhook endpoint or API key not configured, skipping webhook call');
    return;
  }

  try {
    const result = await fetch(doorWebhookEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': doorWebhookApiKey,
      },
      body: JSON.stringify(events),
    });

    const response = await result.json();
    console.log('Door webhook response:', response);
    return response;
  } catch (error) {
    console.error('Error sending door events to webhook:', error);
  }
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

    const eventData = {
      user_name: record['actor.display_name'],
      user_email: userInfo.doorEmail,
      user_id: record['actor.id'],
      timestamp: timestamp,
      site: record['target2.display_name'] || '',
      site_id: record['target2.id'] || '',
      access_point: record['target4.display_name'] || '',
      access_point_id: record['target4.id'] || '',
      status: 'ACCESS', // We are filtering out denied events above
      method: record['authentication.credential_provider'] || 'Unknown',
      details: record['event.display_message'] || ''
    };
    
    successfulEvents.push(eventData);

    // Filter for only the front door of the space for the slack notifications
    if (!allowedDoorDevices.includes(record['target4.id'])) {
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

  // Send all successful events to webhook
  if (successfulEvents.length > 0) {
    await sendDoorEventsToWebhook(successfulEvents);
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
