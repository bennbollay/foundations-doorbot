// UniFi Access user management
// This module provides the main interface for user activation/deactivation

import {
  findUserByEmail,
  setUserStatus,
  activateUserByEmail,
  deactivateUserByEmail,
  getUserStatus as getUserStatusByEmail
} from './direct_identity.mjs';

// Export main functions for email-based operations
export const activateUser = activateUserByEmail;
export const deactivateUser = deactivateUserByEmail;
export const getUserStatus = getUserStatusByEmail;

// Export ID-based operations
export const activateUserById = (userId) => setUserStatus(userId, true);
export const deactivateUserById = (userId) => setUserStatus(userId, false);

// Export user lookup
export const getUserByEmail = findUserByEmail;

// Status by ID
export async function getUserStatusById(userId) {
  // For now, just return basic info
  // Could enhance this to fetch full user details
  return {
    id: userId,
    status: 'UNKNOWN',
    message: 'Direct ID status lookup not yet implemented. Use email lookup instead.'
  };
}