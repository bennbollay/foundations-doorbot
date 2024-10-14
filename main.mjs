#!/usr/bin/env zx

const csv = require('csv-parse');

// Load configuration files from a .env file:
//   # Slack Configuration Values
//   SLACK_OAUTH_BOT_TOKEN=xoxb-...
//   SLACK_CHANNEL_ID=C...
//
//   # Unifi Door Endpoint Configuration
//   UNIFI_DOOR_API=https://192.168.1.1:12445
//   UNIFI_DOOR_TOKEN=Wh...
process.loadEnvFile();

import {
  getSlackStatus,
  writeSlackStatus,
  fetchSlackUser,
  fetchSlackProfile,
  createSlackMessageBlock,
  updateSlackMessage,
  postSlackMessage,
} from './slack.mjs';

import { fetchDoorOpenings } from './door.mjs';

// The Unifi API endpoint doesn't offer a valid SSL certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

const getTimeBracket = () => {
  const now = new Date();
  const later = new Date();

  // Include all events in this chronological hour.  Set the rest of the values to
  // zero to simplify reuse of an existing message for a given hour.
  now.setMinutes(0);
  now.setSeconds(0);
  now.setMilliseconds(0);
  later.setMinutes(59);
  later.setSeconds(59);
  later.setMilliseconds(0);

  return [now.getTime(), later.getTime()];
};

const pollDoor = async (timeBracket) => {
  const openings = await fetchDoorOpenings(timeBracket);

  const users = [];
  for (let user of openings.data) {
    const data = {
      ...user,
      // Get the Slack userId
      ...((await fetchSlackUser(user.doorEmail)) || {}),
    };

    // Enrich again from Slack based on the userId found
    users.push({ ...data, ...((await fetchSlackProfile(data.slackId)) || {}) });
  }

  // No users; don't create a message.
  if (users.length == 0) {
    return { when: `${timeBracket[0]}`, users: [] };
  }

  const message = await createSlackMessageBlock(openings.timeBracket[0], users);

  return { when: `${timeBracket[0]}`, message, users };
};

// Query the door, enrich with values from Slack, and then publish the message (or update an
// existing message) in the specified Slack channel.  Use the messageId stored in
// `writeSlackStatus` to identify if there's already been a message created for this hour.
const poll = async () => {
  const timeBracket = getTimeBracket();

  const doorResult = await pollDoor(timeBracket);
  if (doorResult.users.length == 0) {
    console.log(`${new Date().toLocaleTimeString('en-US')}: No entries`);
    return;
  }

  const status = getSlackStatus()[doorResult.when];
  const newStr = new Date().toLocaleTimeString('en-US');
  if (status) {
    console.log(`${nowStr}: Updating ${doorResult.users.length} entries`);
    await updateSlackMessage(status.ts, doorResult.message);
  } else {
    console.log(`${nowStr}: Creating ${doorResult.users.length} entries`);
    const res = await postSlackMessage(doorResult.message);
    writeSlackStatus(doorResult.when, res);
  }
};

await poll();
