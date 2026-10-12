#!/usr/bin/env node

import { loadGatewayProvisionConfig } from '../host/gateway-config';
import { provisionNewMailGateway } from '../host/gateway-provision';

if (process.argv.length !== 3 || process.argv[2] !== '--confirm-new-unfunded-testnet-wallet') {
  process.stderr.write('Explicit --confirm-new-unfunded-testnet-wallet is required.\n');
  process.exitCode = 1;
} else {
  void Promise.resolve().then(() => provisionNewMailGateway(loadGatewayProvisionConfig())).then(() => {
    process.stdout.write('New testnet mail wallet and journal provisioned. Keep both root files and all state volumes.\n');
  }).catch(error => {
    process.stderr.write(`Mail provisioning refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
