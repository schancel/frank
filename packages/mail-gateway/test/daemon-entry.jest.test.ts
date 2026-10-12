import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('mail gateway executable', () => {
  it('refuses to start without an admitted wallet and host configuration', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'frank-mail-entry-'));
    const database = join(stateDir, 'mail.sqlite3');
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve(__dirname, '../src/bin/daemon.ts')],
        {
          cwd: resolve(__dirname, '..'),
          env: {
            ...process.env,
            GATEWAY_DB_PATH: database,
            GATEWAY_HTTP_PORT: '0',
            GATEWAY_SMTP_PORT: '0',
          },
          encoding: 'utf8',
          timeout: 15_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('FRANK_MAIL_WALLET_STATE_DIR is missing');
      expect(existsSync(database)).toBe(false);
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
