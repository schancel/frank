'use strict';

var crypto = require('crypto');
var should = require('chai').should();
var bitcore = require('../..');
var PrivateKey = bitcore.PrivateKey;
var PublicKey = bitcore.PublicKey;

// frank #309: the ECDH shared point (`peer.point.mul(priv)`) must serialize identically on both
// sides. Its x coordinate comes out of elliptic as a BN from a different bn.js copy than bitcore's
// patched one, so an unpadded encoding dropped a leading zero byte (about 1 pair in 256).
describe('ECDH shared point serialization (frank #309)', function() {

  // 142 keys = 10,011 unordered pairs. About 3 minutes; FRANK_ECDH_KEYS=30 for a quick run.
  var KEYS = Number(process.env.FRANK_ECDH_KEYS || 142);

  it('both parties serialize the same 33-byte point, and x equals OpenSSL\'s, for ' + KEYS + ' seeded keys', function() {
    this.timeout(30 * 60 * 1000);
    var secrets = [];
    var privates = [];
    var rawPublics = [];
    var publics = [];
    for (var i = 0; i < KEYS; i++) {
      var secret = bitcore.crypto.Hash.sha256(Buffer.from('frank-309-key-' + i));
      while (!PrivateKey.isValid(secret.toString('hex'))) {
        secret = bitcore.crypto.Hash.sha256(secret);
      }
      var key = PrivateKey.fromBuffer(secret);
      secrets.push(secret);
      privates.push(key);
      // Compressed, like the registered identity keys.
      rawPublics.push(PublicKey.fromPoint(key.toPublicKey().point, true).toBuffer());
      publics.push(PublicKey.fromBuffer(rawPublics[i]));
    }

    var pairs = 0;
    var leadingZero = 0;
    for (var a = 0; a < KEYS; a++) {
      for (var b = a + 1; b < KEYS; b++) {
        var ab = PublicKey.fromPoint(publics[b].point.mul(privates[a].toBigNumber())).toBuffer();
        var ba = PublicKey.fromPoint(publics[a].point.mul(privates[b].toBigNumber())).toBuffer();
        if (ab.length !== 33 || !ab.equals(ba)) {
          throw new Error('pair ' + a + ',' + b + ': ' + ab.toString('hex') + ' vs ' + ba.toString('hex'));
        }
        var ecdh = crypto.createECDH('secp256k1');
        ecdh.setPrivateKey(secrets[a]);
        if (!ecdh.computeSecret(rawPublics[b]).equals(ab.slice(1))) {
          throw new Error('pair ' + a + ',' + b + ': x differs from OpenSSL');
        }
        pairs++;
        if (ab[1] === 0) leadingZero++;
      }
    }
    pairs.should.equal(KEYS * (KEYS - 1) / 2);
    // The sample must actually contain the trigger (expected pairs/256).
    leadingZero.should.be.above(Math.floor(pairs / 256 / 3));
  });

});
