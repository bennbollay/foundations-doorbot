process.loadEnvFile();

const slackOAuthToken = process.env.SLACK_OAUTH_BOT_TOKEN;
const slackChannelId = process.env.SLACK_CHANNEL_ID;

// These were experimentally identified by looking at response payloads.
const slackLinkedInProfileId = 'Xf07RM6SNW3W';
const slackBlurbProfileId = 'Xf07RC36BECE';

const slackHeaders = { Authorization: `Bearer ${slackOAuthToken}`, 'content-type': 'application/json; charset=utf-8' };

const fetchSlackUser = async (email) => {
  if (!email) {
    return undefined;
  }
  const url = new URL('https://slack.com/api/users.lookupByEmail');
  url.searchParams.set('email', email);

  const result = await fetch(url, { headers: { ...slackHeaders } });

  const res = await result.json();

  if (!res.ok) {
    return undefined;
  }

  return { slackId: res.user.id, pictureUrl: res.user.profile.image_24 };
};

const fetchSlackProfile = async (userId) => {
  if (!userId) {
    return undefined;
  }
  const url = new URL('https://slack.com/api/users.profile.get');
  url.searchParams.set('user', userId);

  const result = await fetch(url, { headers: { ...slackHeaders } });

  const res = await result.json();

  const linkedInUrl = res.profile?.fields?.[slackLinkedInProfileId]?.value;
  const details = res.profile?.fields?.[slackBlurbProfileId]?.value;

  if (!res.ok) {
    return undefined;
  }

  return { profileUrl: linkedInUrl, details };
};

const createSlackMessageBlock = async (time, users) => {
  const when = new Date(time);
  const whenStr = when.toLocaleTimeString('en-US');

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${whenStr}`,
        },
      },
      ...users.map((user) => ({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ' -',
          },
          ...[
            user.pictureUrl
              ? {
                  type: 'image',
                  image_url: user.pictureUrl,
                  alt_text: user.name,
                }
              : {},
          ],
          {
            type: 'mrkdwn',
            text: `${user.slackId ? `<@${user.slackId}>${user.profileUrl ? ` (<${user.profileUrl}|LI>)` : ''}` : user.name}${user.details ? `: ${user.details}` : ''}`,
          },
        ],
      })),
    ],
  };

  return payload;
};

const updateSlackMessage = async (ts, message) => {
  const body = { channel: slackChannelId, ts, unfurl_links: false, blocks: message.blocks };
  const result = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { ...slackHeaders },
    body: JSON.stringify(body),
  });

  const res = await result.json();
  if (!res.ok) {
    console.log(JSON.stringify({ body, result: res }, null, 2));
  }
};

const postSlackMessage = async (message) => {
  const body = { channel: slackChannelId, unfurl_links: false, blocks: message.blocks };
  const result = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { ...slackHeaders },
    body: JSON.stringify(body),
  });

  const res = await result.json();
  if (!res.ok) {
    console.log(JSON.stringify({ body, result: res }, null, 2));
    return undefined;
  }
  return { ts: res.ts };
};

const getSlackStatus = () => JSON.parse(fs.readFileSync('doorlog.json', 'utf8'));
const writeSlackStatus = (when, status) => fs.writeFileSync('doorlog.json', JSON.stringify({ [when]: status }));

export {
  getSlackStatus,
  writeSlackStatus,
  fetchSlackUser,
  fetchSlackProfile,
  createSlackMessageBlock,
  updateSlackMessage,
  postSlackMessage,
};
