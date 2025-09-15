# Enhanced Webhook Integration Guide

## Overview

The doorbot webhook integration has been enhanced to support bidirectional communication with the webhook service. When door access events are sent to the webhook, the service can now respond with instructions for:

1. **Creating new members** - Automatically provision new users in UniFi Access
2. **Managing access** - Activate or deactivate user access based on external criteria
3. **Resending invitations** - Resend invitation emails to existing users

## Webhook Response Format

The webhook service should return a JSON response with the following structure:

```json
{
  "success": true,
  "message": "Processed X of Y door access events successfully",
  "results": {
    "successful": 10,
    "total": 10
  },
  "newMembers": [
    {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john.doe@example.com"
    }
  ],
  "managedAccess": {
    "activate": ["user1@example.com", "user2@example.com"],
    "deactivate": ["user3@example.com", "user4@example.com"]
  },
  "newInvite": ["user5@example.com", "user6@example.com"]
}
```

## Field Descriptions

### Standard Response Fields
- `success` (boolean): Indicates if the webhook processed the events successfully
- `message` (string): Human-readable status message
- `results` (object): Processing statistics
  - `successful` (number): Count of successfully processed events
  - `total` (number): Total events received

### newMembers (optional)
Array of new member objects to create in UniFi Access. Each member object must contain:
- `firstName` (string): User's first name
- `lastName` (string): User's last name
- `email` (string): User's email address (used as unique identifier)

The system will:
1. Check if a user with this email already exists
2. Skip creation if user exists
3. Create new user if not found
4. Report results for each member

### managedAccess (optional)
Object containing arrays of emails for access management:
- `activate` (array): Email addresses of users to activate
- `deactivate` (array): Email addresses of users to deactivate/suspend

The system will:
1. Check current status of each user
2. Skip if already in desired state
3. Change status if needed
4. Report results for each operation

### newInvite (optional)
Array of email addresses to resend invitations to. Each email should belong to an existing user.

The system will:
1. Look up each user by email
2. Resend the invitation if user exists
3. Report if user not found
4. Track results for each invitation

## Processing Flow

1. **Door events are sent** to the webhook endpoint
2. **Webhook processes** the events and determines any needed actions
3. **Webhook responds** with standard fields plus optional `newMembers`, `managedAccess`, and/or `newInvite`
4. **Doorbot processes** the response:
   - Creates new members if specified
   - Manages access states if specified
   - Resends invitations if specified
   - Logs all results

## Implementation Details

### Member Creation Process
```javascript
// For each member in newMembers:
1. Check if user exists: getUserByEmail(email)
2. If exists: Log and skip
3. If not exists: createUser(firstName, lastName, email)
4. Track results (created/exists/failed)
```

### Access Management Process
```javascript
// For each email in activate array:
1. Check current status: getUserStatus(email)
2. If already ACTIVE: Log and skip
3. If not active: activateUser(email)
4. Track results

// For each email in deactivate array:
1. Check current status: getUserStatus(email)
2. If already INACTIVE/SUSPENDED: Log and skip
3. If active: deactivateUser(email)
4. Track results
```

### Invitation Resend Process
```javascript
// For each email in newInvite array:
1. Look up user: getUserByEmail(email)
2. If not found: Log and track as not found
3. If exists: resendInvitation(email)
4. Track results (sent/failed)
```

## Results Tracking

The enhanced webhook function returns detailed results:

```javascript
{
  webhookResponse: { /* original webhook response */ },
  memberCreation: {
    created: [ /* successfully created users */ ],
    alreadyExists: [ /* users that already existed */ ],
    failed: [ /* failed creation attempts */ ]
  },
  accessManagement: {
    activated: [ /* successfully activated users */ ],
    deactivated: [ /* successfully deactivated users */ ],
    alreadyActive: [ /* users already active */ ],
    alreadyInactive: [ /* users already inactive */ ],
    failed: [ /* failed operations */ ]
  },
  inviteResends: {
    sent: [ /* successfully sent invitations */ ],
    notFound: [ /* users not found */ ],
    failed: [ /* failed send attempts */ ]
  }
}
```

## Testing

### Test with Mock Server
```bash
# Start mock webhook server and run test
node test-webhook-enhanced.mjs --mock
```

### Test with Real Webhook
```bash
# Ensure .env has correct webhook settings
node test-webhook-enhanced.mjs
```

## Error Handling

- Each operation is wrapped in try-catch to prevent single failures from stopping the entire process
- Failed operations are logged and included in results
- The main webhook call will throw if the HTTP request itself fails
- Individual member/access operations fail gracefully

## Configuration

Required environment variables:
```bash
# Webhook endpoint
DOOR_ACCESS_WEBHOOK_ENDPOINT=https://your-webhook-service.com/endpoint
DOOR_ACCESS_WEBHOOK_API_KEY=your-api-key

# UniFi Access credentials (for user management)
UNIFI_ACCESS_USERNAME=your-username
UNIFI_ACCESS_PASSWORD=your-password
UNIFI_ACCESS_SITE_NAME=your-site-name
```

## Security Considerations

1. **API Key**: Always use the `x-api-key` header for webhook authentication
2. **Email Validation**: The webhook service should validate email formats
3. **Rate Limiting**: Consider implementing rate limits for user creation
4. **Audit Logging**: All operations are logged for audit purposes
5. **Idempotency**: Operations check current state before making changes

## Example Webhook Service Implementation

```javascript
// Example webhook endpoint that processes door events
app.post('/webhook', authenticate, async (req, res) => {
  const doorEvents = req.body;
  
  // Process door events...
  const results = await processDoorEvents(doorEvents);
  
  // Determine new members based on business logic
  const newMembers = await determineNewMembers(doorEvents);
  
  // Determine access changes based on business logic
  const managedAccess = await determineAccessChanges(doorEvents);
  
  // Return enhanced response
  return res.json({
    success: true,
    message: `Processed ${results.successful} of ${results.total} events`,
    results,
    newMembers,    // Optional: array of new users to create
    managedAccess  // Optional: access changes to apply
  });
});
```

## Troubleshooting

### User Creation Fails
- Check UniFi Access credentials in .env
- Verify user doesn't already exist with different email
- Check UniFi Access API is accessible

### Access Management Fails
- Verify user exists in UniFi Access
- Check user email is correct
- Ensure proper permissions for status changes

### Webhook Connection Fails
- Verify DOOR_ACCESS_WEBHOOK_ENDPOINT is correct
- Check DOOR_ACCESS_WEBHOOK_API_KEY is valid
- Test network connectivity to webhook service

## Future Enhancements

Potential future additions:
- Batch operations for better performance
- User group management
- Access schedule modifications
- Custom user attributes
- Webhook retry logic with exponential backoff
