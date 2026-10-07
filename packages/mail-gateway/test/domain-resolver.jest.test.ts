import * as dns from 'node:dns';
import {
  normalizeDomain,
  resolveFrankDomain,
  FrankDomainResolution,
} from '../src/dns/domain-resolver';

describe('Dual-Protocol DNS Domain Resolver (SRV + MX)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('normalizeDomain', () => {
    it('normalizes domains by lowercasing and trimming trailing dots and whitespace', () => {
      expect(normalizeDomain('EXAMPLE.COM.')).toBe('example.com');
      expect(normalizeDomain('  Sub.Example.org... ')).toBe('sub.example.org');
    });

    it('rejects invalid or empty domain strings', () => {
      expect(() => normalizeDomain('')).toThrow('Domain must be a non-empty string');
      expect(() => normalizeDomain('   ')).toThrow('Domain must be a non-empty string');
      expect(() => normalizeDomain(null as unknown as string)).toThrow(
        'Domain must be a non-empty string',
      );
    });
  });

  describe('resolveFrankDomain with mocked dns.promises', () => {
    it('resolves both SRV and MX records when published by authoritative DNS', async () => {
      const mockSrvRecords: dns.SrvRecord[] = [
        { name: 'relay2.example.com.', port: 443, priority: 20, weight: 0 },
        { name: 'relay1.example.com.', port: 443, priority: 10, weight: 50 },
        { name: 'relay-alt.example.com.', port: 443, priority: 10, weight: 80 },
      ];
      const mockMxRecords: dns.MxRecord[] = [
        { exchange: 'mail2.example.com.', priority: 20 },
        { exchange: 'mail1.example.com.', priority: 10 },
      ];

      const srvSpy = jest
        .spyOn(dns.promises, 'resolveSrv')
        .mockResolvedValue(mockSrvRecords);
      const mxSpy = jest
        .spyOn(dns.promises, 'resolveMx')
        .mockResolvedValue(mockMxRecords);

      const res: FrankDomainResolution = await resolveFrankDomain('EXAMPLE.COM');

      expect(srvSpy).toHaveBeenCalledWith('_frank._tcp.example.com');
      expect(mxSpy).toHaveBeenCalledWith('example.com');

      expect(res.domain).toBe('example.com');
      // Priority 10, weight 80 should be selected over priority 10, weight 50 and priority 20
      expect(res.srvRelay).toEqual({
        name: 'relay-alt.example.com',
        port: 443,
        priority: 10,
        weight: 80,
      });
      expect(res.allSrvRelays).toEqual([
        { name: 'relay-alt.example.com', port: 443, priority: 10, weight: 80 },
        { name: 'relay1.example.com', port: 443, priority: 10, weight: 50 },
        { name: 'relay2.example.com', port: 443, priority: 20, weight: 0 },
      ]);
      // MX records sorted by priority ascending
      expect(res.mxHosts).toEqual([
        { exchange: 'mail1.example.com', priority: 10 },
        { exchange: 'mail2.example.com', priority: 20 },
      ]);
    });

    it('falls back to relay.<domain>:443 when SRV lookup fails with ENODATA', async () => {
      const srvError: NodeJS.ErrnoException = new Error('querySrv ENODATA _frank._tcp.frank.org');
      srvError.code = 'ENODATA';

      jest.spyOn(dns.promises, 'resolveSrv').mockRejectedValue(srvError);
      jest.spyOn(dns.promises, 'resolveMx').mockResolvedValue([
        { exchange: 'mx.frank.org', priority: 10 },
      ]);

      const res = await resolveFrankDomain('frank.org');

      expect(res.domain).toBe('frank.org');
      expect(res.srvRelay).toEqual({
        name: 'relay.frank.org',
        port: 443,
        priority: 10,
        weight: 0,
      });
      expect(res.mxHosts).toEqual([
        { exchange: 'mx.frank.org', priority: 10 },
      ]);
    });

    it('falls back to relay.<domain>:443 when SRV lookup fails with ENOTFOUND', async () => {
      const srvError: NodeJS.ErrnoException = new Error('querySrv ENOTFOUND _frank._tcp.nodomain.xyz');
      srvError.code = 'ENOTFOUND';

      jest.spyOn(dns.promises, 'resolveSrv').mockRejectedValue(srvError);
      jest.spyOn(dns.promises, 'resolveMx').mockResolvedValue([]);

      const res = await resolveFrankDomain('nodomain.xyz');

      expect(res.srvRelay).toEqual({
        name: 'relay.nodomain.xyz',
        port: 443,
        priority: 10,
        weight: 0,
      });
      expect(res.mxHosts).toEqual([]);
    });

    it('falls back when SRV resolution returns an empty array', async () => {
      jest.spyOn(dns.promises, 'resolveSrv').mockResolvedValue([]);
      jest.spyOn(dns.promises, 'resolveMx').mockResolvedValue([]);

      const res = await resolveFrankDomain('empty-srv.example');

      expect(res.srvRelay).toEqual({
        name: 'relay.empty-srv.example',
        port: 443,
        priority: 10,
        weight: 0,
      });
      expect(res.mxHosts).toEqual([]);
    });

    it('omits srvRelay when SRV is absent and disableFallback is true', async () => {
      jest.spyOn(dns.promises, 'resolveSrv').mockRejectedValue(new Error('ENODATA'));
      jest.spyOn(dns.promises, 'resolveMx').mockResolvedValue([]);

      const res = await resolveFrankDomain('strict.example', { disableFallback: true });

      expect(res.srvRelay).toBeUndefined();
      expect(res.allSrvRelays).toBeUndefined();
      expect(res.mxHosts).toEqual([]);
    });

    it('gracefully handles MX resolution failures without crashing', async () => {
      const mxError: NodeJS.ErrnoException = new Error('queryMx SERVFAIL error');
      mxError.code = 'SERVFAIL';

      jest.spyOn(dns.promises, 'resolveSrv').mockResolvedValue([
        { name: 'relay.company.com', port: 8443, priority: 5, weight: 10 },
      ]);
      jest.spyOn(dns.promises, 'resolveMx').mockRejectedValue(mxError);

      const res = await resolveFrankDomain('company.com');

      expect(res.domain).toBe('company.com');
      expect(res.srvRelay).toEqual({
        name: 'relay.company.com',
        port: 8443,
        priority: 5,
        weight: 10,
      });
      expect(res.mxHosts).toEqual([]);
    });

    it('gracefully handles simultaneous SRV and MX DNS server failures', async () => {
      jest.spyOn(dns.promises, 'resolveSrv').mockRejectedValue(new Error('Network timeout'));
      jest.spyOn(dns.promises, 'resolveMx').mockRejectedValue(new Error('Network timeout'));

      const res = await resolveFrankDomain('down.example');

      expect(res.domain).toBe('down.example');
      expect(res.srvRelay).toEqual({
        name: 'relay.down.example',
        port: 443,
        priority: 10,
        weight: 0,
      });
      expect(res.mxHosts).toEqual([]);
    });

    it('supports custom resolver functions and fallback options', async () => {
      const customResolveSrv = jest.fn().mockResolvedValue([
        { name: 'custom-relay.internal', port: 9443, priority: 1, weight: 0 },
      ]);
      const customResolveMx = jest.fn().mockResolvedValue([
        { exchange: 'custom-mail.internal', priority: 5 },
      ]);

      const res = await resolveFrankDomain('internal.corp', {
        resolveSrv: customResolveSrv,
        resolveMx: customResolveMx,
      });

      expect(customResolveSrv).toHaveBeenCalledWith('_frank._tcp.internal.corp');
      expect(customResolveMx).toHaveBeenCalledWith('internal.corp');
      expect(res.srvRelay).toEqual({
        name: 'custom-relay.internal',
        port: 9443,
        priority: 1,
        weight: 0,
      });
      expect(res.mxHosts).toEqual([
        { exchange: 'custom-mail.internal', priority: 5 },
      ]);
    });
  });
});
