#!/usr/bin/env node

// Script to refresh UniFi Identity authentication
// Run this when you get 401 errors

process.loadEnvFile();

import fs from 'fs';
import { getAuthToken } from './direct_identity.mjs';

const AUTH_CACHE_FILE = '.direct_identity_auth.json';

async function refreshAuth() {
  console.log('🔄 Refreshing UniFi Identity authentication...\n');
  
  // Check environment variables
  const username = process.env.UNIFI_CLOUD_USERNAME;
  const password = process.env.UNIFI_CLOUD_PASSWORD;
  
  if (!username || !password) {
    console.error('❌ Missing required environment variables:');
    if (!username) console.error('   - UNIFI_CLOUD_USERNAME');
    if (!password) console.error('   - UNIFI_CLOUD_PASSWORD');
    console.error('\nPlease set these in your .env file');
    process.exit(1);
  }
  
  console.log(`Username: ${username}`);
  console.log(`Password: ${password.substring(0, 3)}${'*'.repeat(Math.min(password.length - 3, 10))}`);
  
  // Clear existing cache
  try {
    if (fs.existsSync(AUTH_CACHE_FILE)) {
      fs.unlinkSync(AUTH_CACHE_FILE);
      console.log('✅ Cleared existing auth cache');
    }
  } catch (e) {
    console.error('Warning: Could not clear cache:', e.message);
  }
  
  // Get fresh authentication
  console.log('\n🔐 Authenticating with UniFi Identity...');
  try {
    const auth = await getAuthToken();
    
    if (auth && auth.token) {
      console.log('✅ Authentication successful!');
      console.log(`   Token: ${auth.token.substring(0, 20)}...`);
      if (auth.csrf) {
        console.log(`   CSRF: ${auth.csrf.substring(0, 20)}...`);
      }
      
      // Verify the cached file was created
      if (fs.existsSync(AUTH_CACHE_FILE)) {
        const cached = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'));
        console.log(`   Cached until: ${new Date(cached.timestamp + 8 * 60 * 60 * 1000).toLocaleString()}`);
      }
      
      console.log('\n✨ Authentication refreshed successfully!');
      console.log('You can now run the doorbot commands.');
    } else {
      console.error('❌ Authentication failed - no token received');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    console.error('\nPossible issues:');
    console.error('1. Check your UNIFI_CLOUD_USERNAME and UNIFI_CLOUD_PASSWORD');
    console.error('2. Ensure the account has proper permissions');
    console.error('3. Try logging in via unifi.ui.com to verify credentials');
    process.exit(1);
  }
}

// Run the refresh
refreshAuth().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
