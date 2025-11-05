process.loadEnvFile();

import { 
  getUserByEmail, 
  createUser, 
  activateUser, 
  deactivateUser,
  getUserStatus,
  resendInvitation 
} from './access.mjs';

// Door access webhook API endpoint and API key
const doorWebhookEndpoint = process.env.DOOR_ACCESS_WEBHOOK_ENDPOINT;
const doorWebhookApiKey = process.env.DOOR_ACCESS_WEBHOOK_API_KEY;

/**
 * Processes new members from webhook response
 * @param {Array} newMembers - Array of new member objects with firstName, lastName, email
 * @returns {Object} Results of member creation
 */
const processNewMembers = async (newMembers) => {
  const results = {
    created: [],
    alreadyExists: [],
    failed: []
  };

  for (const member of newMembers) {
    try {
      // Check if user already exists by email
      const existingUser = await getUserByEmail(member.email);
      
      if (existingUser) {
        console.log(`User already exists: ${member.email}`);
        results.alreadyExists.push({
          email: member.email,
          userId: existingUser.id,
          message: 'User already exists'
        });
      } else {
        // Create new user
        console.log(`Creating new user: ${member.firstName} ${member.lastName} (${member.email})`);
        const newUser = await createUser(member.firstName, member.lastName, member.email);
        results.created.push({
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          userId: newUser?.id,
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
const processManagedAccess = async (managedAccess) => {
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
const processInviteResends = async (newInvites) => {
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
        results.notFound.push({
          email,
          message: 'User not found'
        });
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
 * Sends door access events to a webhook endpoint and processes the response
 * @param {Array} events - Array of door access events
 * @returns {Object} Response from webhook with processing results
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

    return processingResults;
  } catch (error) {
    console.error('Error sending door events to webhook:', error);
    throw error;
  }
}; 