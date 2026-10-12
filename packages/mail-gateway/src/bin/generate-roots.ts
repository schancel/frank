#!/usr/bin/env node
import { generateGatewayRoots } from '../host/gateway-roots-generator';

if (process.argv.slice(2).join(' ') !== '--confirm-new-unfunded-testnet-identity') {
  process.stderr.write('Refusing: pass --confirm-new-unfunded-testnet-identity for a new, unfunded testnet identity.\n');
  process.exitCode = 2;
} else {
  try {
    const primaryFile = process.env.FRANK_MAIL_ROOTS_FILE;
    const backupFile = process.env.FRANK_MAIL_ROOTS_BACKUP_FILE;
    if (!primaryFile || !backupFile) throw new Error('Both private roots file paths are required');
    const identity = generateGatewayRoots({ primaryFile, backupFile });
    process.stdout.write(`Gateway public identity: ${identity}\n`);
  } catch {
    process.stderr.write('Gateway roots generation failed; inspect private destination paths. Existing or partial files were not removed.\n');
    process.exitCode = 1;
  }
}
