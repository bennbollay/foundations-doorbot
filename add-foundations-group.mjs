#!/usr/bin/env node

// One-time backfill: add the "Foundations" group to every existing UniFi Access user.
//
// Existing group memberships are preserved (Foundations is added, not substituted).
//
// Usage:
//   node add-foundations-group.mjs              # apply to all users missing the group
//   node add-foundations-group.mjs --dry-run    # report what would change, make no writes
//   node add-foundations-group.mjs --limit 5    # only update the first N users (safe test)

import {
  FOUNDATIONS_GROUP_NAME,
  fetchAllUsers,
  findFoundationsGroupId,
  setUserGroups,
} from './groups.mjs';

const CONCURRENCY = 5;

function parseLimit() {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return Infinity;
  const value = Number(process.argv[idx + 1]);
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  const results = [];
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limit = parseLimit();

  console.log(`\n🏢 Backfilling the "${FOUNDATIONS_GROUP_NAME}" group onto all UniFi Access users${dryRun ? ' (dry run)' : ''}\n`);

  const users = await fetchAllUsers();
  const groupId = findFoundationsGroupId(users);

  if (!groupId) {
    throw new Error(`Could not find a user group named "${FOUNDATIONS_GROUP_NAME}". Create it in UniFi Access first.`);
  }
  console.log(`Group "${FOUNDATIONS_GROUP_NAME}" id: ${groupId}`);

  const missing = users.filter((u) => u.unique_id && !(u.groups || []).some((g) => g.unique_id === groupId));

  console.log(`Total users: ${users.length}`);
  console.log(`Already in group: ${users.length - missing.length}`);
  console.log(`To assign: ${missing.length}`);

  const targets = missing.slice(0, limit);
  if (limit !== Infinity) {
    console.log(`(limited to first ${targets.length})`);
  }
  console.log('');

  if (targets.length === 0) {
    console.log('✅ Every targeted user is already in the group. Nothing to do.\n');
    return;
  }

  if (dryRun) {
    console.log('Dry run — no changes made. Re-run without --dry-run to apply.\n');
    return;
  }

  let succeeded = 0;
  const failures = [];

  await runPool(
    targets,
    async (user) => {
      const existing = (user.groups || []).map((g) => g.unique_id).filter(Boolean);
      try {
        await setUserGroups(user.unique_id, [...existing, groupId]);
        succeeded += 1;
      } catch (e) {
        failures.push({ user, error: e.message });
      }
    },
    CONCURRENCY,
  );

  console.log(`✅ Assigned ${succeeded} user(s) to the "${FOUNDATIONS_GROUP_NAME}" group.`);
  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} user(s) failed:`);
    for (const { user, error } of failures) {
      console.log(`   ${user.full_name || user.unique_id}: ${error}`);
    }
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((error) => {
  console.error(`❌ Backfill failed: ${error.message}`);
  process.exit(1);
});
