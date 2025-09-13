#!/usr/bin/env node

// Test script for enhanced webhook functionality
// This simulates a webhook response with newMembers and managedAccess fields

import { sendDoorEventsToWebhook } from './webhook.mjs';

// Mock webhook server that returns enhanced response
const createMockWebhookServer = () => {
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
        
        // Simulate webhook response with new fields
        const response = {
          success: true,
          message: `Processed ${events.length} of ${events.length} door access events successfully`,
          results: {
            successful: events.length,
            total: events.length
          },
          // New fields for member creation
          newMembers: [
            {
              firstName: "John",
              lastName: "Doe",
              email: "john.doe@example.com"
            },
            {
              firstName: "Jane",
              lastName: "Smith",
              email: "jane.smith@example.com"
            }
          ],
          // New fields for access management
          managedAccess: {
            activate: [
              "existing.user1@example.com",
              "existing.user2@example.com"
            ],
            deactivate: [
              "inactive.user1@example.com",
              "inactive.user2@example.com"
            ]
          }
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  return server;
};

// Test function
const testEnhancedWebhook = async () => {
  console.log('Testing enhanced webhook functionality...\n');
  
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
    
    console.log('\n=== Full Processing Results ===');
    console.log(JSON.stringify(results, null, 2));
    
    // Display member creation results
    if (results.memberCreation) {
      console.log('\n=== Member Creation Results ===');
      console.log('Created:', results.memberCreation.created);
      console.log('Already Exists:', results.memberCreation.alreadyExists);
      console.log('Failed:', results.memberCreation.failed);
    }
    
    // Display access management results
    if (results.accessManagement) {
      console.log('\n=== Access Management Results ===');
      console.log('Activated:', results.accessManagement.activated);
      console.log('Deactivated:', results.accessManagement.deactivated);
      console.log('Already Active:', results.accessManagement.alreadyActive);
      console.log('Already Inactive:', results.accessManagement.alreadyInactive);
      console.log('Failed:', results.accessManagement.failed);
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  }
};

// Check if we should use mock server or real webhook
const useMockServer = process.argv.includes('--mock');

if (useMockServer) {
  console.log('Starting mock webhook server on port 3000...');
  const server = createMockWebhookServer();
  
  server.listen(3000, () => {
    console.log('Mock server running on http://localhost:3000/webhook');
    console.log('Set DOOR_ACCESS_WEBHOOK_ENDPOINT=http://localhost:3000/webhook in your .env file\n');
    
    // Run test after server starts
    setTimeout(() => {
      testEnhancedWebhook().then(() => {
        console.log('\nTest complete. Press Ctrl+C to stop the mock server.');
      });
    }, 1000);
  });
} else {
  // Run test with real webhook endpoint
  testEnhancedWebhook().then(() => {
    console.log('\nTest complete.');
    process.exit(0);
  });
}
