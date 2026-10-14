import {
  clearDomainDiscoveryCache,
  createExternalNameClaim,
  DEFAULT_DOMAIN_CACHE_TTL_MS,
  discoverDomainRelay,
  inferExternalNameNamespace,
  normalizeDiscoveryDomain,
  parseFederatedIdentifier,
  resolveFederatedIdentifier,
  validateRelayOrigin,
  verifyExternalNameClaim,
} from './index';

describe('Single-Record Domain Discovery & External Naming Proofs (Issue #973)', () => {
  beforeEach(() => {
    clearDomainDiscoveryCache();
  });

  describe('normalizeDiscoveryDomain & validateRelayOrigin', () => {
    it('normalizes domains and rejects invalid hostnames or IP literals', () => {
      expect(normalizeDiscoveryDomain('  SIGNET.MX. ')).toBe('signet.mx');
      expect(normalizeDiscoveryDomain('@Example.COM')).toBe('example.com');
      expect(normalizeDiscoveryDomain('')).toBeUndefined();
      expect(normalizeDiscoveryDomain('localhost')).toBeUndefined();
      expect(normalizeDiscoveryDomain('127.0.0.1')).toBeUndefined();
      expect(normalizeDiscoveryDomain('https://signet.mx/path')).toBeUndefined();
    });

    it('accepts only clean HTTPS origins for relays', () => {
      expect(validateRelayOrigin('https://relay.signet.mx')).toBe('https://relay.signet.mx');
      expect(validateRelayOrigin('https://relay.signet.mx/')).toBe('https://relay.signet.mx');
      expect(validateRelayOrigin('http://relay.signet.mx')).toBeUndefined();
      expect(validateRelayOrigin('https://user:pass@relay.signet.mx')).toBeUndefined();
      expect(validateRelayOrigin('https://relay.signet.mx/subpath')).toBeUndefined();
      expect(validateRelayOrigin('https://192.168.1.1')).toBeUndefined();
    });
  });

  describe('discoverDomainRelay', () => {
    it('fetches /.well-known/cashweb.json, validates schema, and caches for 24h by default', async () => {
      let currentTime = 1_700_000_000_000;
      const mockFetch = jest.fn(async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('https://signet.mx/.well-known/cashweb.json');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 1,
            relay: 'https://relay.signet.mx/',
            mail_gateway: 'SIGNET.MX',
            network: 'monad-testnet',
          }),
        } as Response;
      });

      const first = await discoverDomainRelay('SIGNET.MX.', {
        fetch: mockFetch as unknown as typeof fetch,
        now: () => currentTime,
      });
      expect(first).toEqual({
        version: 1,
        relay: 'https://relay.signet.mx',
        mail_gateway: 'signet.mx',
        network: 'monad-testnet',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Within 24h TTL: served from cache without network call
      currentTime += DEFAULT_DOMAIN_CACHE_TTL_MS - 1000;
      const cached = await discoverDomainRelay('signet.mx', {
        fetch: mockFetch as unknown as typeof fetch,
        now: () => currentTime,
      });
      expect(cached).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 24h TTL: refetches
      currentTime += 2000;
      await discoverDomainRelay('signet.mx', {
        fetch: mockFetch as unknown as typeof fetch,
        now: () => currentTime,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns undefined when version !== 1, relay is non-HTTPS, or HTTP status is 404', async () => {
      const badVersionFetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: 2, relay: 'https://relay.signet.mx' }),
      })) as unknown as typeof fetch;
      expect(await discoverDomainRelay('signet.mx', { fetch: badVersionFetch })).toBeUndefined();

      const insecureRelayFetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: 1, relay: 'http://relay.signet.mx' }),
      })) as unknown as typeof fetch;
      expect(await discoverDomainRelay('signet.mx', { fetch: insecureRelayFetch })).toBeUndefined();

      const notFoundFetch = jest.fn(async () => ({
        ok: false,
        status: 404,
      })) as unknown as typeof fetch;
      expect(await discoverDomainRelay('signet.mx', { fetch: notFoundFetch })).toBeUndefined();
    });
  });

  describe('resolveFederatedIdentifier', () => {
    const ALICE_ADDRESS = '0x1111111111111111111111111111111111111111';
    const BOB_ADDRESS = '0x2222222222222222222222222222222222222222';

    it('parses alice@signet.mx and @alice@signet.mx', () => {
      expect(parseFederatedIdentifier('alice@signet.mx')).toEqual({
        username: 'alice',
        domain: 'signet.mx',
      });
      expect(parseFederatedIdentifier('@Alice@SIGNET.MX.')).toEqual({
        username: 'alice',
        domain: 'signet.mx',
      });
      expect(parseFederatedIdentifier('invalid-no-domain')).toBeUndefined();
    });

    it('resolves alice@signet.mx and @bob@signet.mx with O(1) domain discovery and GET /usernames/:name', async () => {
      const calls: string[] = [];
      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === 'https://signet.mx/.well-known/cashweb.json') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              version: 1,
              relay: 'https://relay.signet.mx',
              mail_gateway: 'signet.mx',
              network: 'monad-testnet',
            }),
          } as Response;
        }
        if (url === 'https://relay.signet.mx/usernames/alice') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              username: 'alice',
              address: ALICE_ADDRESS,
              subject: '02'.padEnd(66, 'a'),
              status: 'active',
              claim: 'deadbeef',
            }),
          } as Response;
        }
        if (url === 'https://relay.signet.mx/usernames/bob') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              username: 'bob',
              account_address: BOB_ADDRESS,
              status: 'active',
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      }) as unknown as typeof fetch;

      const alice = await resolveFederatedIdentifier('alice@signet.mx', { fetch: mockFetch });
      expect(alice).toEqual({
        address: ALICE_ADDRESS,
        relayUrl: 'https://relay.signet.mx',
        username: 'alice',
        domain: 'signet.mx',
        subject: '02'.padEnd(66, 'a'),
        claim: 'deadbeef',
      });

      const bob = await resolveFederatedIdentifier('@Bob@SIGNET.MX', { fetch: mockFetch });
      expect(bob).toEqual({
        address: BOB_ADDRESS,
        relayUrl: 'https://relay.signet.mx',
        username: 'bob',
        domain: 'signet.mx',
      });

      // Domain discovery happened only ONCE for signet.mx across multiple user lookups
      expect(calls).toEqual([
        'https://signet.mx/.well-known/cashweb.json',
        'https://relay.signet.mx/usernames/alice',
        'https://relay.signet.mx/usernames/bob',
      ]);
    });

    it('returns undefined when user does not exist or is tombstoned', async () => {
      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === 'https://signet.mx/.well-known/cashweb.json') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              version: 1,
              relay: 'https://relay.signet.mx',
              network: 'monad-testnet',
            }),
          } as Response;
        }
        if (url === 'https://relay.signet.mx/usernames/tombstoned') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              username: 'tombstoned',
              address: ALICE_ADDRESS,
              status: 'tombstoned',
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      }) as unknown as typeof fetch;

      expect(await resolveFederatedIdentifier('unknown@signet.mx', { fetch: mockFetch })).toBeUndefined();
      expect(await resolveFederatedIdentifier('tombstoned@signet.mx', { fetch: mockFetch })).toBeUndefined();
    });
  });

  describe('Cryptographic External Naming Proofs (.eth ENS & .sol SNS)', () => {
    const ALICE_FRANK_ADDRESS = '0x7484023b108dbd1620c7dd17b7ce6d5789d519a9';
    const ATTACKER_ADDRESS = '0x9999999999999999999999999999999999999999';

    it('infers .eth (ens), .sol (sns), and dns namespaces accurately', () => {
      expect(inferExternalNameNamespace('vitalik.eth')).toBe('ens');
      expect(inferExternalNameNamespace('toly.sol')).toBe('sns');
      expect(inferExternalNameNamespace('alice@signet.mx')).toBe('dns');
    });

    it('creates and bi-directionally verifies an ENS (.eth) claim with forward resolution', async () => {
      const claim = createExternalNameClaim({
        namespace: 'ens',
        name: 'Alice.ETH',
        ownerAddress: ALICE_FRANK_ADDRESS,
        timestamp: 1_700_000_000_000,
      });

      expect(claim.namespace).toBe('ens');
      expect(claim.name).toBe('alice.eth');
      expect(claim.ownerAddress).toBe(ALICE_FRANK_ADDRESS);
      expect(claim.chainId).toBe('eip155:1');
      expect(claim.proofSignature).toMatch(/^0x[0-9a-f]{128}$/);

      // Valid forward resolution matching Alice's canonical Frank address
      const valid = await verifyExternalNameClaim(claim, {
        resolveExternalName: async (name, namespace) => {
          expect(name).toBe('alice.eth');
          expect(namespace).toBe('ens');
          return ALICE_FRANK_ADDRESS.toUpperCase().replace('0X', '0x');
        },
      });
      expect(valid).toBe(true);

      // Fails when forward resolution points to a different address (spoofing attempt)
      const spoofed = await verifyExternalNameClaim(claim, {
        resolveExternalName: async () => ATTACKER_ADDRESS,
      });
      expect(spoofed).toBe(false);

      // Fails when claim payload is tampered with
      const tampered = { ...claim, ownerAddress: ATTACKER_ADDRESS };
      expect(
        await verifyExternalNameClaim(tampered, {
          resolveExternalName: async () => ATTACKER_ADDRESS,
        }),
      ).toBe(false);
    });

    it('creates and bi-directionally verifies an SNS (.sol) claim with forward resolution', async () => {
      const claim = createExternalNameClaim('toly.sol', ALICE_FRANK_ADDRESS, {
        timestamp: 1_700_000_000_000,
      });

      expect(claim.namespace).toBe('sns');
      expect(claim.name).toBe('toly.sol');
      expect(claim.chainId).toBe('solana:mainnet');

      const valid = await verifyExternalNameClaim(claim, async (name, namespace) => {
        expect(name).toBe('toly.sol');
        expect(namespace).toBe('sns');
        return {
          ownerAddress: ALICE_FRANK_ADDRESS,
          chainId: 'solana:mainnet',
          namespace: 'sns',
        };
      });
      expect(valid).toBe(true);

      // Unregistered name on-chain returns null -> fails verification
      const unregistered = await verifyExternalNameClaim(claim, async () => null);
      expect(unregistered).toBe(false);
    });
  });
});
