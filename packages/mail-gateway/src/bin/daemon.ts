#!/usr/bin/env node

import { loadGatewayHostConfig } from '../host/gateway-config';
import { startMailGateway } from '../host/gateway-service';

async function main(): Promise<void> {
  const service = await startMailGateway(loadGatewayHostConfig());
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().catch(error => {
      process.stderr.write(`Mail gateway shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(error => {
  process.stderr.write(`Mail gateway startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
