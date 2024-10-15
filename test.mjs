const csv = require('csv-parse');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

import { fetchDoorOpenings } from './door.mjs';
import { getTimeBracket } from './poll.mjs';

console.log(await fetchDoorOpenings(getTimeBracket()));
