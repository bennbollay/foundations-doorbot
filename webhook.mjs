process.loadEnvFile();

import { 
  getUserByEmail, 
  createUser, 
  activateUser, 
  deactivateUser,
  getUserStatus,
  resendInvitation,
  updateUserEmail
} from './access.mjs';
import {
  resolveFoundationsGroupId,
  addUserToFoundations,
  FOUNDATIONS_GROUP_NAME,
} from './groups.mjs';

// Door access webhook API endpoint and API key
const doorWebhookEndpoint = process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT;
const doorWebhookApiKey = process.env.DOOR_ACCESS_WEBHOOK_API_KEY;

/**
 * Processes new members from webhook response
 * @param {Array} newMembers - Array of new member objects with firstName, lastName, email
 * @returns {Object} Results of member creation
 */
export const processNewMembers = async (newMembers) => {
  const results = {
    created: [],
    alreadyExists: [],
    failed: []
  };

  // Resolve the Foundations group id once per batch. Every member AND employee
  // we provision must end up in this group, whether they're newly created or
  // already existed in UniFi. Best-effort: if resolution fails we still create
  // users (createUser also tries to assign the group at creation time).
  let foundationsGroupId = null;
  try {
    foundationsGroupId = await resolveFoundationsGroupId();
  } catch (e) {
    console.error(`⚠️  Could not resolve "${FOUNDATIONS_GROUP_NAME}" group; will create users without forcing group membership: ${e.message}`);
  }

  // Idempotently ensure a user is in the Foundations group. Safe to call for
  // both newly-created and pre-existing users (no-op if already a member).
  const ensureFoundationsGroup = async (userId, email) => {
    if (!foundationsGroupId || !userId) return;
    try {
      const added = await addUserToFoundations(userId, foundationsGroupId);
      if (added) {
        console.log(`   Added ${email} to "${FOUNDATIONS_GROUP_NAME}" group`);
      }
    } catch (e) {
      console.error(`   ⚠️  Failed to add ${email} to "${FOUNDATIONS_GROUP_NAME}" group: ${e.message}`);
    }
  };

  for (const member of newMembers) {
    try {
      // Check if user already exists by email
      const existingUser = await getUserByEmail(member.email);
      
      if (existingUser) {
        console.log(`User already exists: ${member.email}`);
        // Existing users may predate group assignment (or were created via
        // another flow), so always reconcile their group membership here.
        await ensureFoundationsGroup(existingUser.id, member.email);
        results.alreadyExists.push({
          email: member.email,
          userId: existingUser.id,
          message: 'User already exists'
        });
      } else {
        // Create new user (createUser also assigns the Foundations group on
        // creation; we reconcile again below as defense in depth).
        console.log(`Creating new user: ${member.firstName} ${member.lastName} (${member.email})`);
        const newUser = await createUser(member.firstName, member.lastName, member.email);
        const createdId = newUser?.user?.id || newUser?.id;
        await ensureFoundationsGroup(createdId, member.email);
        results.created.push({
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          userId: createdId,
          message: 'User created successfully'
        });
      }
    } catch (error) {
      console.error(`Failed to process member ${member.email}:`, error);
      results.failed.push({
        email: member.email,
        error: error.message,
        message: 'Failed to create user'
      });
    }
  }

  return results;
};

/**
 * Processes managed access changes from webhook response
 * @param {Object} managedAccess - Object with activate and deactivate arrays of emails
 * @returns {Object} Results of access management
 */
export const processManagedAccess = async (managedAccess) => {
  const results = {
    activated: [],
    deactivated: [],
    alreadyActive: [],
    alreadyInactive: [],
    failed: []
  };

  // Process activations
  if (managedAccess.activate && Array.isArray(managedAccess.activate)) {
    for (const email of managedAccess.activate) {
      try {
        // Check current status
        const currentStatus = await getUserStatus(email);
        
        if (currentStatus?.status === 'ACTIVE') {
          console.log(`User ${email} is already active`);
          results.alreadyActive.push({
            email,
            message: 'User already active'
          });
        } else {
          // Activate user
          console.log(`Activating user: ${email}`);
          const result = await activateUser(email);
          results.activated.push({
            email,
            message: 'User activated successfully'
          });
        }
      } catch (error) {
        console.error(`Failed to activate user ${email}:`, error);
        results.failed.push({
          email,
          action: 'activate',
          error: error.message,
          message: 'Failed to activate user'
        });
      }
    }
  }

  // Process deactivations
  if (managedAccess.deactivate && Array.isArray(managedAccess.deactivate)) {
    for (const email of managedAccess.deactivate) {
      try {
        // Check current status
        const currentStatus = await getUserStatus(email);
        
        if (currentStatus?.status === 'INACTIVE' || currentStatus?.status === 'SUSPENDED') {
          console.log(`User ${email} is already inactive`);
          results.alreadyInactive.push({
            email,
            message: 'User already inactive'
          });
        } else {
          // Deactivate user
          console.log(`Deactivating user: ${email}`);
          const result = await deactivateUser(email);
          results.deactivated.push({
            email,
            message: 'User deactivated successfully'
          });
        }
      } catch (error) {
        console.error(`Failed to deactivate user ${email}:`, error);
        results.failed.push({
          email,
          action: 'deactivate',
          error: error.message,
          message: 'Failed to deactivate user'
        });
      }
    }
  }

  return results;
};

/**
 * Process invitation resends from webhook response
 * @param {Array} newInvites - Array of email addresses to resend invitations to
 * @returns {Object} Results of invitation resending
 */
export const processInviteResends = async (newInvites) => {
  const results = {
    sent: [],
    failed: [],
    notFound: []
  };

  for (const email of newInvites) {
    try {
      console.log(`Resending invitation to: ${email}`);
      const result = await resendInvitation(email);
      
      if (result.success) {
        results.sent.push({
          email,
          userId: result.userId,
          message: 'Invitation resent successfully'
        });
      } else if (result.error === 'User not found') {
        // Self-heal: newInvite is also queued for people whose UniFi account
        // was never created (e.g. the scheduler's proactive create failed).
        // Dead-ending on "user not found" left them with no path to access at
        // all, so create the account (createUser assigns the Foundations
        // group) and then send the invitation.
        console.log(`User not found for ${email} — creating account before sending invitation`);
        const createResult = await createUser('', '', email);
        if (createResult?.success) {
          const retry = await resendInvitation(email);
          if (retry.success) {
            results.sent.push({
              email,
              userId: retry.userId,
              created: true,
              message: 'Account created and invitation sent'
            });
          } else {
            results.failed.push({
              email,
              created: true,
              error: retry.error,
              message: 'Account created but invitation send failed'
            });
          }
        } else {
          results.notFound.push({
            email,
            error: createResult?.error,
            message: 'User not found and account creation failed'
          });
        }
      } else {
        results.failed.push({
          email,
          error: result.error,
          message: 'Failed to resend invitation'
        });
      }
    } catch (error) {
      console.error(`Failed to resend invitation to ${email}:`, error);
      results.failed.push({
        email,
        error: error.message,
        message: 'Failed to resend invitation'
      });
    }
  }

  return results;
};

/**
 * Process email changes, e.g. when a member updates their email in the member
 * system. Each change carries the old email (the current lookup key) and the
 * new email to replace it with.
 * @param {Array} emailChanges - Array of { oldEmail, newEmail } objects
 * @returns {Object} Results of email changes
 */
export const processEmailChanges = async (emailChanges) => {
  const results = {
    changed: [],
    notFound: [],
    failed: []
  };

  for (const change of emailChanges) {
    const { oldEmail, newEmail } = change || {};
    try {
      console.log(`Changing email: ${oldEmail} -> ${newEmail}`);
      const result = await updateUserEmail(oldEmail, newEmail);

      if (result.success) {
        results.changed.push({
          oldEmail,
          newEmail,
          userId: result.userId,
          message: 'Email changed successfully'
        });
      } else if (result.error === 'User not found') {
        results.notFound.push({
          oldEmail,
          newEmail,
          message: 'User not found'
        });
      } else {
        results.failed.push({
          oldEmail,
          newEmail,
          error: result.error,
          message: 'Failed to change email'
        });
      }
    } catch (error) {
      console.error(`Failed to change email ${oldEmail} -> ${newEmail}:`, error);
      results.failed.push({
        oldEmail,
        newEmail,
        error: error.message,
        message: 'Failed to change email'
      });
    }
  }

  return results;
};

/**
 * Sends door access events to a webhook endpoint and processes the response
 * @param {Array} events - Array of door access events
 * @returns {Object} Response from webhook with processing results
 */
export const sendDoorEventsToWebhook = async (events) => {
  // Check if webhook is configured
  if (!doorWebhookEndpoint || !doorWebhookApiKey) {
    console.log('Webhook not configured (missing DOOR_ACCESS_WEBHOOK_ENDPOINT or DOOR_ACCESS_WEBHOOK_API_KEY)');
    return { webhookResponse: { skipped: true, reason: 'Not configured' } };
  }
  
  try {
    // Log when calling with empty events (for pending actions)
    if (events.length === 0) {
      console.log('Calling webhook with empty events array to check for pending actions...');
    }
    
    console.log(`Calling webhook at: ${doorWebhookEndpoint}`);
    const result = await fetch(doorWebhookEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': doorWebhookApiKey,
      },
      body: JSON.stringify(events),
    });

    // Check if response is ok and content type is JSON
    if (!result.ok) {
      const text = await result.text();
      console.error(`Webhook returned error ${result.status}: ${result.statusText}`);
      console.error('Response body:', text.substring(0, 500)); // First 500 chars
      throw new Error(`Webhook returned ${result.status}: ${result.statusText}`);
    }

    const contentType = result.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await result.text();
      console.error('Webhook returned non-JSON response. Content-Type:', contentType);
      console.error('Response body:', text.substring(0, 500)); // First 500 chars
      throw new Error('Webhook returned non-JSON response');
    }

    const response = await result.json();
    console.log('Door webhook response:', response);
    
    // Process additional fields if present in the response
    const processingResults = {
      webhookResponse: response
    };

    // Process new members if present
    if (response.newMembers && Array.isArray(response.newMembers)) {
      console.log(`Processing ${response.newMembers.length} new members...`);
      processingResults.memberCreation = await processNewMembers(response.newMembers);
    }

    // Process managed access changes if present
    if (response.managedAccess) {
      const totalChanges = 
        (response.managedAccess.activate?.length || 0) + 
        (response.managedAccess.deactivate?.length || 0);
      
      if (totalChanges > 0) {
        console.log(`Processing ${totalChanges} access management changes...`);
        processingResults.accessManagement = await processManagedAccess(response.managedAccess);
      }
    }

    // Process permanent deactivations if present (separate from managedAccess)
    if (response.permanentDeactivate && Array.isArray(response.permanentDeactivate)) {
      console.log(`Processing ${response.permanentDeactivate.length} permanent deactivations...`);
      
      // Create a managedAccess-like structure for permanent deactivations
      const permanentDeactivateAccess = {
        activate: [],
        deactivate: response.permanentDeactivate
      };
      
      processingResults.permanentDeactivations = await processManagedAccess(permanentDeactivateAccess);
    }

    // Process invitation resends if present
    if (response.newInvite && Array.isArray(response.newInvite)) {
      console.log(`Processing ${response.newInvite.length} invitation resends...`);
      processingResults.inviteResends = await processInviteResends(response.newInvite);
    }

    // Process email changes if present ([{ oldEmail, newEmail }, ...])
    if (response.emailChanges && Array.isArray(response.emailChanges)) {
      console.log(`Processing ${response.emailChanges.length} email changes...`);
      processingResults.emailChanges = await processEmailChanges(response.emailChanges);
    }

    // Log summary
    if (processingResults.memberCreation) {
      console.log('Member creation summary:', {
        created: processingResults.memberCreation.created.length,
        alreadyExists: processingResults.memberCreation.alreadyExists.length,
        failed: processingResults.memberCreation.failed.length
      });
    }

    if (processingResults.accessManagement) {
      console.log('Access management summary:', {
        activated: processingResults.accessManagement.activated.length,
        deactivated: processingResults.accessManagement.deactivated.length,
        alreadyActive: processingResults.accessManagement.alreadyActive.length,
        alreadyInactive: processingResults.accessManagement.alreadyInactive.length,
        failed: processingResults.accessManagement.failed.length
      });
    }

    if (processingResults.permanentDeactivations) {
      console.log('Permanent deactivation summary:', {
        deactivated: processingResults.permanentDeactivations.deactivated.length,
        alreadyInactive: processingResults.permanentDeactivations.alreadyInactive.length,
        failed: processingResults.permanentDeactivations.failed.length
      });
    }

    if (processingResults.inviteResends) {
      console.log('Invitation resend summary:', {
        sent: processingResults.inviteResends.sent.length,
        notFound: processingResults.inviteResends.notFound.length,
        failed: processingResults.inviteResends.failed.length
      });
    }

    if (processingResults.emailChanges) {
      console.log('Email change summary:', {
        changed: processingResults.emailChanges.changed.length,
        notFound: processingResults.emailChanges.notFound.length,
        failed: processingResults.emailChanges.failed.length
      });
    }

    return processingResults;
  } catch (error) {
    console.error('Error sending door events to webhook:', error);
    throw error;
  }
}; 