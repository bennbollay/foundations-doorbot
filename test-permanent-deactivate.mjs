#!/usr/bin/env node

// Test script for permanent deactivation functionality
// This simulates a webhook response with permanentDeactivate field

import { sendDoorEventsToWebhook } from './webhook.mjs';

// Test function
const testPermanentDeactivate = async () => {
  console.log('Testing permanent deactivation functionality...\n');
  
  // Sample door events (minimal, just to trigger webhook)
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
  
  // Create a mock webhook server that responds with permanentDeactivate field
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
        
        // Simulate webhook response with permanentDeactivate field
        const response = {
          success: true,
          message: `Processed ${events.length} events`,
          results: {
            successful: events.length,
            total: events.length
          },
          // Test permanent deactivations
          permanentDeactivate: [
            "test.user1@example.com",
            "test.user2@example.com",
            "test.user3@example.com"
          ],
          // Also test regular deactivations for comparison
          managedAccess: {
            activate: [],
            deactivate: ["regular.deactivate@example.com"]
          }
        };
        
        console.log('\nWebhook responding with:');
        console.log('- permanentDeactivate:', response.permanentDeactivate.length, 'users');
        console.log('- managedAccess.deactivate:', response.managedAccess.deactivate.length, 'users\n');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  return new Promise((resolve) => {
    server.listen(3002, async () => {
      console.log('Mock webhook server running on http://localhost:3002/webhook');
      
      // Save original endpoint
      const originalEndpoint = process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT;
      
      // Set test endpoint
      process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT = 'http://localhost:3002/webhook';
      process.env.DOOR_ACCESS_WEBHOOK_API_KEY = 'test-key';
      
      try {
        console.log('\nSending door events to webhook...');
        const results = await sendDoorEventsToWebhook(testEvents);
        
        console.log('\n=== Full Processing Results ===');
        console.log(JSON.stringify(results, null, 2));
        
        // Display permanent deactivation results
        if (results.permanentDeactivations) {
          console.log('\n=== Permanent Deactivation Results ===');
          console.log('Deactivated:', results.permanentDeactivations.deactivated);
          console.log('Already Inactive:', results.permanentDeactivations.alreadyInactive);
          console.log('Failed:', results.permanentDeactivations.failed);
          
          console.log('\nSummary:');
          console.log(`  ✅ Deactivated: ${results.permanentDeactivations.deactivated.length}`);
          console.log(`  ⚠️  Already Inactive: ${results.permanentDeactivations.alreadyInactive.length}`);
          console.log(`  ❌ Failed: ${results.permanentDeactivations.failed.length}`);
        }
        
        // Display regular access management results
        if (results.accessManagement) {
          console.log('\n=== Regular Access Management Results ===');
          console.log('Deactivated:', results.accessManagement.deactivated);
          console.log('Already Inactive:', results.accessManagement.alreadyInactive);
          console.log('Failed:', results.accessManagement.failed);
        }
        
      } catch (error) {
        console.error('Test failed:', error);
      } finally {
        // Restore original endpoint
        if (originalEndpoint) {
          process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT = originalEndpoint;
        }
        server.close();
        resolve();
      }
    });
  });
};

// Run test
testPermanentDeactivate().then(() => {
  console.log('\n✨ Test complete!\n');
  process.exit(0);
}).catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
