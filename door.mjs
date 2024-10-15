const csv = require('csv-parse');

process.loadEnvFile();

const doorEndpoint = process.env.UNIFI_DOOR_API;
const doorAuthToken = process.env.UNIFI_DOOR_TOKEN;

const doorHeaders = {
  Authorization: `Bearer ${doorAuthToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
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
  for await (const record of data) {
    // Filter out failed entrance attempts (which don't have a user anyways)
    if (record['event.result'] != 'ACCESS') {
      continue;
    }
    const name = record['actor.display_name'];
    if (name in openings) {
      continue;
    }
    openings[name] = {
      name,
      doorId: record['actor.id'],
      ...((await fetchDoorUser(record['actor.id'])) || {}),
    };
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
