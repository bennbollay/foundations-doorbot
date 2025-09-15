#!/usr/bin/env node

// Test script for invitation resending functionality
// This tests both direct resending and webhook-based resending

import { resendInvitation } from './access.mjs';
import { sendDoorEventsToWebhook } from './webhook.mjs';

// Test direct invitation resending
const testDirectResend = async (email) => {
  console.log('\n=== Testing Direct Invitation Resend ===');
  console.log(`Email: ${email}\n`);
  
  try {
    const result = await resendInvitation(email);
    
    if (result.success) {
      console.log('✅ Invitation resent successfully!');
      console.log('Result:', JSON.stringify(result, null, 2));
    } else {
      console.log('❌ Failed to resend invitation');
      console.log('Error:', result.error);
    }
  } catch (error) {
    console.error('Exception occurred:', error);
  }
};

// Test webhook-based invitation resending
const testWebhookResend = async () => {
  console.log('\n=== Testing Webhook-Based Invitation Resend ===\n');
  
  // Create a mock webhook server that responds with newInvite field
  const http = require('http');
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        const events = JSON.parse(body);
        console.log(`Mock webhook received ${events.length} events`);
        
        // Simulate webhook response with newInvite field
        const response = {
          success: true,
          message: `Processed ${events.length} events`,
          results: {
            successful: events.length,
            total: events.length
          },
          // New field for invitation resends
          newInvite: [
            "test1@example.com",
            "test2@example.com",
            "nonexistent@example.com"  // This one might not exist
          ]
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  return new Promise((resolve) => {
    server.listen(3001, async () => {
      console.log('Mock webhook server running on http://localhost:3001/webhook');
      console.log('Set DOOR_ACCESS_WEBHOOK_ENDPOINT=http://localhost:3001/webhook to test\n');
      
      // Sample door events
      const testEvents = [
        {
          timestamp: Date.now(),
          userId: 'user123',
          userName: 'Test User',
          email: 'test@example.com',
          deviceName: 'Front Door',
          accessGranted: true
        }
      ];
      
      try {
        console.log('Sending door events to webhook...');
        const results = await sendDoorEventsToWebhook(testEvents);
        
        console.log('\n=== Processing Results ===');
        
        if (results.inviteResends) {
          console.log('\nInvitation Resend Results:');
          console.log('Sent:', results.inviteResends.sent);
          console.log('Not Found:', results.inviteResends.notFound);
          console.log('Failed:', results.inviteResends.failed);
          
          console.log('\nSummary:');
          console.log(`  ✅ Sent: ${results.inviteResends.sent.length}`);
          console.log(`  ⚠️  Not Found: ${results.inviteResends.notFound.length}`);
          console.log(`  ❌ Failed: ${results.inviteResends.failed.length}`);
        }
        
      } catch (error) {
        console.error('Test failed:', error);
      } finally {
        server.close();
        resolve();
      }
    });
  });
};

// Main test function
const runTests = async () => {
  console.log('🧪 Testing Invitation Resend Functionality\n');
  
  const testEmail = process.argv[2];
  const testMode = process.argv[3] || 'direct';
  
  if (!testEmail && testMode === 'direct') {
    console.error('Usage: node test-invite-resend.mjs <email> [direct|webhook]');
    console.error('Example: node test-invite-resend.mjs user@example.com');
    console.error('Example: node test-invite-resend.mjs mock webhook');
    process.exit(1);
  }
  
  if (testMode === 'webhook' || testEmail === 'mock') {
    // Test webhook-based resending
    await testWebhookResend();
  } else {
    // Test direct resending
    await testDirectResend(testEmail);
  }
  
  console.log('\n✨ Test complete!\n');
  process.exit(0);
};

// Run tests
runTests().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
