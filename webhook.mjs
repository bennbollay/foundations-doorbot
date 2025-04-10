process.loadEnvFile();

// Door access webhook API endpoint and API key
const doorWebhookEndpoint = process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT;
const doorWebhookApiKey = process.env.DOOR_ACCESS_WEBHOOK_API_KEY;

/**
 * Sends door access events to a webhook endpoint
 * @param {Array} events - Array of door access events
 * @returns {Object} Response from webhook
 */
export const sendDoorEventsToWebhook = async (events) => {
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