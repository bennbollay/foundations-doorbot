# UniFi Access Authentication Guide

## Overview

This guide explains how to properly authenticate with your UniFi Access system to enable user activation/deactivation features.

## Current Status

Your current token (from `.env` file) has **VIEW-only permissions**. To activate/deactivate users, you need **WRITE permissions** on "User & Group" in UniFi Access.

## Step-by-Step Setup

### 1. Create/Update Admin Account in UniFi OS Console

1. **Access your UniFi Console:**
   - Navigate to `https://192.168.1.1` (or your console's IP)
   - Login with an Owner or Super Admin account

2. **Create a dedicated API admin (recommended):**
   - Go to **Settings > Admins & Users > Admins**
   - Click **Create New User**
   - Set a strong username/password (e.g., `doorbot-admin`)
   - Check **Admin** checkbox
   - Uncheck **Remote Access** (keeps it local-only)
   - Save the user

3. **Set proper permissions:**
   - Go to **Settings > Admins & Users > Roles**
   - Find or create the role for your API account
   - In **Application Permissions**, find **UniFi Access**
   - Set to **Administrator** (full read/write access)
   - Ensure these are enabled:
     - User Management (create, edit, delete, activate/deactivate) ✅
     - Group Management (assign users, update permissions) ✅
   - Save changes

### 2. Authenticate Using the Doorbot CLI

Once your admin account is ready with proper permissions:

```bash
# Run the authentication command
npm run doorbot auth
```

This will:
1. Prompt for your admin username and password
2. Connect to your UniFi OS Console
3. Obtain a session token with proper permissions
4. Save it locally in `.token.json` (git-ignored)
5. Test the permissions automatically

**Example session:**
```
🔐 UniFi Access Authentication

Please enter your UniFi OS Console admin credentials.
Note: Use a local admin account with full UniFi Access permissions.

Username: doorbot-admin
Password: ********

Authenticating...

✅ Login successful!
   User: doorbot-admin
   Token obtained: eyJhbGciOiJIUzI1NiIs...
   Auth data saved to: /Users/you/foundations-doorbot/.token.json
✅ Authentication test successful - token has valid permissions

✅ Authentication successful and saved!
   You can now use activate/deactivate commands.
```

### 3. Verify Authentication

Check that your authentication is working:

```bash
npm run doorbot auth-status
```

You should see:
```
🔐 Authentication Status

✅ Saved authentication found
   User: doorbot-admin
   Login time: 2025-09-12T23:45:00.000Z
   Status: Valid and working
```

### 4. Test User Management

Now you can test the commands:

```bash
# Check user status (works with VIEW permissions)
npm run doorbot status test@seattlefoundations.org

# Deactivate user (requires WRITE permissions)
npm run doorbot deactivate test@seattlefoundations.org

# Activate user (requires WRITE permissions)
npm run doorbot activate test@seattlefoundations.org
```

## Troubleshooting

### "Permission Denied" Errors

If you still get permission errors after authentication:
1. Verify the admin account has **Administrator** role in UniFi Access
2. Check that the role includes write permissions on User & Group
3. Try logging out and re-authenticating:
   ```bash
   npm run doorbot logout
   npm run doorbot auth
   ```

### Certificate Errors

The tool automatically handles self-signed certificates. If you see warnings about `NODE_TLS_REJECT_UNAUTHORIZED`, these can be safely ignored.

### Token Expiration

Sessions typically expire after 2 hours of inactivity. If commands stop working:
```bash
# Check if token is still valid
npm run doorbot auth-status

# Re-authenticate if needed
npm run doorbot auth
```

## Security Notes

1. **Use local admin accounts** - Avoid cloud-linked accounts to prevent MFA interruptions
2. **Token storage** - The `.token.json` file is automatically git-ignored
3. **Permissions** - Only grant the minimum permissions needed
4. **Regular rotation** - Consider rotating the API admin password periodically

## API Endpoints Used

The tool uses these UniFi Access API endpoints:

- **Login:** `POST /api/auth/login`
- **List Users:** `GET /api/v1/developer/users`
- **Get User:** `GET /api/v1/developer/users/{id}`
- **Update User:** `PUT /api/v1/developer/users/{id}`
  - Body: `{"is_active": true/false, "status": "ACTIVE"/"INACTIVE"}`

## Support

If you encounter issues:
1. Check the UniFi Access system logs: **UniFi Access > Settings > System Log**
2. Look for permission denials or API errors
3. Verify network connectivity to your UniFi Console
4. Ensure the console is running the latest UniFi OS version
