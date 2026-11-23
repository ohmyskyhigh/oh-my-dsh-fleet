import { FleetStore } from '../src/fleet-store.js';
const rootPath = process.argv[2];
if (!rootPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/fleet-unlock.mjs <absolute Fleet Root path>');
  process.exitCode = 2;
} else {
  try {
    const reclaimed = await FleetStore.reclaimStaleLock({ rootPath });
    console.log(JSON.stringify({ reclaimed, rootPath, message: reclaimed ? 'Confirmed stale writer lock removed. You may restart the same Profile.' : 'No writer lock exists.' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
