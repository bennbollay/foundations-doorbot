#!/usr/bin/env node

import { Command } from 'commander';
import { activateUser, deactivateUser, getUserStatus, activateUserById, deactivateUserById, getUserStatusById, createUser, resendInvitation } from './access.mjs';

const program = new Command();

const isUuid = (s) => /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/.test(s);

program
  .name('doorbot')
  .description('UniFi Access door management CLI')
  .version('1.0.0');

// Activate user command (email or UUID)
program
  .command('activate <emailOrId>')
  .description("Activate a user's door access by email address or user ID")
  .action(async (emailOrId) => {
    console.log(`\n🔓 Activating access for: ${emailOrId}\n`);

    const byId = isUuid(emailOrId);
    const success = byId ? await activateUserById(emailOrId) : await activateUser(emailOrId);

    if (success) {
      console.log(`✅ Successfully activated access for ${emailOrId}\n`);
      process.exit(0);
    } else {
      console.error(`❌ Failed to activate access for ${emailOrId}\n`);
      process.exit(1);
    }
  });

// Deactivate user command (email or UUID)
program
  .command('deactivate <emailOrId>')
  .description("Deactivate a user's door access by email address or user ID")
  .action(async (emailOrId) => {
    console.log(`\n🔒 Deactivating access for: ${emailOrId}\n`);

    const byId = isUuid(emailOrId);
    const success = byId ? await deactivateUserById(emailOrId) : await deactivateUser(emailOrId);

    if (success) {
      console.log(`✅ Successfully deactivated access for ${emailOrId}\n`);
      process.exit(0);
    } else {
      console.error(`❌ Failed to deactivate access for ${emailOrId}\n`);
      process.exit(1);
    }
  });

// Status command (email or UUID)
program
  .command('status <emailOrId>')
  .description("Check a user's door access status by email address or user ID")
  .action(async (emailOrId) => {
    console.log(`\n🔍 Checking status for: ${emailOrId}\n`);

    const byId = isUuid(emailOrId);
    const status = byId ? await getUserStatusById(emailOrId) : await getUserStatus(emailOrId);

    if (status) {
      console.log('User Status:');
      console.log(`  Name: ${status.name}`);
      console.log(`  Email: ${status.email}`);
      console.log(`  User ID: ${status.id}`);
      console.log(`  Active: ${status.isActive ? '✅ Yes' : '❌ No'}`);
      console.log(`  Status: ${status.status}\n`);
      process.exit(0);
    } else {
      console.error(`❌ User not found: ${emailOrId}\n`);
      process.exit(1);
    }
  });

// Create user command
program
  .command('create <firstName> <lastName> <email>')
  .description('Create a new user with door access')
  .action(async (firstName, lastName, email) => {
    console.log(`\n👤 Creating user: ${firstName} ${lastName} (${email})\n`);
    const result = await createUser(firstName, lastName, email);
    if (result && result.success) {
      console.log(`✅ Successfully created user: ${result.user.fullName}`);
      console.log(`  Email: ${result.user.email}`);
      console.log(`  User ID: ${result.user.id}`);
      console.log(`  Status: ${result.user.status}\n`);
      process.exit(0);
    } else {
      console.error(`❌ Failed to create user: ${result?.error || 'Unknown error'}\n`);
      process.exit(1);
    }
  });

// Resend invitation command
program
  .command('resend-invite <email>')
  .description('Resend invitation email to a user')
  .action(async (email) => {
    console.log(`\n📧 Resending invitation to: ${email}\n`);
    const result = await resendInvitation(email);
    if (result && result.success) {
      console.log(`✅ Successfully resent invitation to: ${email}`);
      console.log(`  User ID: ${result.userId}`);
      if (result.invitationCode) {
        console.log(`  Invitation Code: ${result.invitationCode}`);
      }
      console.log(`  Message: ${result.message}\n`);
      process.exit(0);
    } else {
      console.error(`❌ Failed to resend invitation: ${result?.error || 'Unknown error'}\n`);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
