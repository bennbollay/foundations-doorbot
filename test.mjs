const csv = require('csv-parse');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

import { fetchDoorOpenings } from './door.mjs';
import { pollDoor, getTimeBracket } from './poll.mjs';
import { createSlackMessageBlock } from './slack.mjs';

console.log(JSON.stringify(await pollDoor(getTimeBracket()), null, 2));
