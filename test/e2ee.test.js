import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  E2EE_CONSTANTS,
  ServerE2EESession,
  deriveKeyPBKDF2,
  deriveKeyECDH,
  createServerECDH,
  computeTranscriptChallenge,
  encryptPayload,
  decryptPayload,
  padPlaintext,
  unpadPlaintext,
  buildAAD,
} from '../src/e2ee.js';

describe('E2EE Cryptographic Primitives & Wire Framing', () => {
  it('pads 1-byte keystrokes and 50-byte inputs to identical 92-byte wire frames', async () => {
    const salt = Buffer.alloc(16, 0x42);
    const key = await deriveKeyPBKDF2('correct-horse-battery-staple', salt, 1000);

    const frame1Byte = encryptPayload(key, 'a', E2EE_CONSTANTS.DIR_C2S, 0);
    const frame50Bytes = encryptPayload(key, 'x'.repeat(50), E2EE_CONSTANTS.DIR_C2S, 1);

    // 12B IV + 64B padded ciphertext + 16B GCM tag = 92 bytes
    assert.equal(frame1Byte.length, 92);
    assert.equal(frame50Bytes.length, 92);

    assert.equal(
      decryptPayload(key, frame1Byte, E2EE_CONSTANTS.DIR_C2S, 0).toString('utf8'),
      'a'
    );
    assert.equal(
      decryptPayload(key, frame50Bytes, E2EE_CONSTANTS.DIR_C2S, 1).toString('utf8'),
      'x'.repeat(50)
    );
  });

  it('correctly handles inputs exceeding 64-byte block boundaries', async () => {
    const salt = Buffer.alloc(16, 0x77);
    const key = await deriveKeyPBKDF2('test-boundary', salt, 1000);

    // 61 bytes + 4 bytes length prefix = 65 bytes -> pads to 128 bytes
    // 12B IV + 128B ciphertext + 16B tag = 156 bytes
    const text61 = 'A'.repeat(61);
    const frame61 = encryptPayload(key, text61, E2EE_CONSTANTS.DIR_C2S, 0);
    assert.equal(frame61.length, 12 + 128 + 16);
    assert.equal(
      decryptPayload(key, frame61, E2EE_CONSTANTS.DIR_C2S, 0).toString('utf8'),
      text61
    );
  });

  it('rejects tampered or corrupt length prefixes in padding', () => {
    const badPadded = Buffer.alloc(64, 0);
    badPadded.writeUInt32BE(100, 0); // Claims 100 bytes of plaintext in 64-byte buffer
    assert.throws(() => unpadPlaintext(badPadded), /Corrupted E2EE length prefix/);

    const wrongBlock = Buffer.alloc(50, 0);
    assert.throws(() => unpadPlaintext(wrongBlock), /Invalid E2EE padded plaintext block size/);
  });

  it('rejects replayed, out-of-order, or reflected packets via AAD', async () => {
    const salt = Buffer.alloc(16, 0x11);
    const key = await deriveKeyPBKDF2('test-secret', salt, 1000);
    const frame = encryptPayload(key, 'sudo su -', E2EE_CONSTANTS.DIR_C2S, 5);

    // Wrong sequence number (replay/reorder)
    assert.throws(() => {
      decryptPayload(key, frame, E2EE_CONSTANTS.DIR_C2S, 6);
    });

    // Wrong direction (reflection attack: C2S frame reflected as S2C)
    assert.throws(() => {
      decryptPayload(key, frame, E2EE_CONSTANTS.DIR_S2C, 5);
    });
  });

  it('rejects frame modification or tag tampering', async () => {
    const salt = Buffer.alloc(16, 0x33);
    const key = await deriveKeyPBKDF2('tamper-test', salt, 1000);
    const frame = encryptPayload(key, 'hello world', E2EE_CONSTANTS.DIR_C2S, 0);

    // Flip a bit in the ciphertext
    frame[20] ^= 0x01;
    assert.throws(() => {
      decryptPayload(key, frame, E2EE_CONSTANTS.DIR_C2S, 0);
    });
  });
});

describe('E2EE Handshake & Ephemeral ECDH Interoperability', () => {
  it('agrees on shared key between Node crypto.createECDH and WebCrypto crypto.subtle (P-256)', async () => {
    const salt = crypto.randomBytes(16);
    
    // Server generates ECDH via Node crypto
    const { ecdh: serverEcdh, publicKey: serverEcdhPub } = createServerECDH();
    assert.equal(serverEcdhPub.length, 65);
    assert.equal(serverEcdhPub[0], 0x04);

    // Client generates ECDH via WebCrypto
    const clientKeyPair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const clientEcdhPubBuffer = await globalThis.crypto.subtle.exportKey('raw', clientKeyPair.publicKey);
    const clientEcdhPub = new Uint8Array(clientEcdhPubBuffer);
    assert.equal(clientEcdhPub.length, 65);

    // Server derives key via deriveKeyECDH
    const serverDerivedKey = await deriveKeyECDH(serverEcdh, serverEcdhPub, clientEcdhPub, salt);

    // Client derives key via WebCrypto
    const serverPubKeyImported = await globalThis.crypto.subtle.importKey(
      'raw',
      serverEcdhPub,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const clientSharedBits = await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverPubKeyImported },
      clientKeyPair.privateKey,
      256
    );

    // Client HKDF
    const hkdfBaseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      clientSharedBits,
      'HKDF',
      false,
      ['deriveBits']
    );
    const prefix = Buffer.from('wiredterm-e2ee-v1', 'utf8');
    const info = new Uint8Array(prefix.length + serverEcdhPub.length + clientEcdhPub.length);
    info.set(prefix, 0);
    info.set(serverEcdhPub, prefix.length);
    info.set(clientEcdhPub, prefix.length + serverEcdhPub.length);

    const clientDerivedBits = await globalThis.crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info,
      },
      hkdfBaseKey,
      256
    );
    const clientDerivedKey = Buffer.from(clientDerivedBits);

    // Keys MUST be cryptographically identical!
    assert.equal(serverDerivedKey.length, 32);
    assert.equal(clientDerivedKey.length, 32);
    assert.ok(crypto.timingSafeEqual(serverDerivedKey, clientDerivedKey));
  });

  it('computes transcript challenge binding all 4 parameters', () => {
    const sNonce = crypto.randomBytes(32);
    const sPub = Buffer.alloc(65, 0x01);
    const cPub = Buffer.alloc(65, 0x02);
    const salt = crypto.randomBytes(16);

    const challenge1 = computeTranscriptChallenge(sNonce, sPub, cPub, salt);
    assert.equal(typeof challenge1, 'string');
    assert.ok(challenge1.length > 0);

    // Modifying any parameter must alter the challenge
    const cPubMutated = Buffer.from(cPub);
    cPubMutated[10] ^= 0xff;
    const challenge2 = computeTranscriptChallenge(sNonce, sPub, cPubMutated, salt);
    assert.notEqual(challenge1, challenge2);
  });

  it('completes Mode B (Passphrase) handshake and cleans up state', async () => {
    const session = new ServerE2EESession(1000);
    const challengePayload = session.initChallenge('passphrase');
    assert.equal(challengePayload.mode, 'passphrase');

    const clientKey = await deriveKeyPBKDF2('my-secret-passphrase', challengePayload.salt, challengePayload.iterations);
    const encryptedProof = encryptPayload(clientKey, challengePayload.serverNonce, E2EE_CONSTANTS.DIR_HANDSHAKE, 0);

    const ok = await session.verifyPassphraseHandshake('my-secret-passphrase', encryptedProof);
    assert.equal(ok, true);
    assert.equal(session.isVerified, true);

    // Ephemeral parameters should be cleaned up
    assert.equal(session.serverNonce, null);
    assert.equal(session.salt, null);

    // Subsequent verify must be rejected
    await assert.rejects(
      async () => session.verifyPassphraseHandshake('my-secret-passphrase', encryptedProof),
      /E2EE session already verified/
    );

    // Can encrypt and decrypt stream
    const serverOut = session.encryptOutput('bash-5.2$ ');
    const decrypted = decryptPayload(clientKey, serverOut, E2EE_CONSTANTS.DIR_S2C, 0);
    assert.equal(decrypted.toString('utf8'), 'bash-5.2$ ');
  });

  it('completes Mode A (Passkey ECDH) handshake and cleans up state', async () => {
    const session = new ServerE2EESession();
    const challengePayload = session.initChallenge('passkey', { rpId: 'localhost' });
    assert.equal(challengePayload.mode, 'passkey');
    assert.equal(challengePayload.serverEcdhPub.length, 65);

    // Simulate client ECDH
    const { ecdh: clientEcdh, publicKey: clientEcdhPub } = createServerECDH();
    
    // Client derives key
    const sharedSecret = clientEcdh.computeSecret(challengePayload.serverEcdhPub);
    const info = Buffer.concat([
      Buffer.from('wiredterm-e2ee-v1', 'utf8'),
      challengePayload.serverEcdhPub,
      clientEcdhPub,
    ]);
    const hkdfAsync = promisify(crypto.hkdf);
    const clientKeyArrayBuffer = await hkdfAsync('sha256', sharedSecret, challengePayload.salt, info, 32);
    const clientKey = Buffer.from(clientKeyArrayBuffer);

    // Client encrypts serverNonce as proof
    const encryptedProof = encryptPayload(clientKey, challengePayload.serverNonce, E2EE_CONSTANTS.DIR_HANDSHAKE, 0);

    // Server verifies
    const ok = await session.verifyECDHKeyAndProof(clientEcdhPub, encryptedProof);
    assert.equal(ok, true);
    assert.equal(session.isVerified, true);

    // Ephemeral parameters should be cleaned up
    assert.equal(session.serverEcdh, null);
    assert.equal(session.serverEcdhPub, null);
    assert.equal(session.serverNonce, null);

    // Stream roundtrip works
    const clientInput = encryptPayload(clientKey, 'whoami\n', E2EE_CONSTANTS.DIR_C2S, 0);
    const serverRead = session.decryptInput(clientInput);
    assert.equal(serverRead.toString('utf8'), 'whoami\n');
  });

  it('runs complete end-to-end exchange between ClientE2EESession and ServerE2EESession (Mode B)', async () => {
    await import('../src/public/e2ee-client.js');
    const ClientE2EESession = globalThis.ClientE2EESession;

    const serverSession = new ServerE2EESession(1000);
    const clientSession = new ClientE2EESession();

    const challengePayload = serverSession.initChallenge('passphrase');
    const encryptedProof = await clientSession.completePassphraseChallenge(
      'super-passphrase',
      challengePayload.salt,
      challengePayload.serverNonce,
      challengePayload.iterations
    );

    const ok = await serverSession.verifyPassphraseHandshake('super-passphrase', encryptedProof);
    assert.equal(ok, true);
    clientSession.markReady();

    // Client -> Server input
    let clientWireBuffer = null;
    clientSession.enqueueEncryptInput('ls -la\n', (wireBuf) => {
      clientWireBuffer = Buffer.from(wireBuf);
    });
    // Wait for promise queue
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(clientWireBuffer);

    const decryptedByServer = serverSession.decryptInput(clientWireBuffer);
    assert.equal(decryptedByServer.toString('utf8'), 'ls -la\n');

    // Server -> Client output
    const serverWireBuffer = serverSession.encryptOutput('total 42\ndrwxr-xr-x ...');
    let clientReceivedText = null;
    clientSession.enqueueDecryptOutput(serverWireBuffer, (text) => {
      clientReceivedText = text;
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(clientReceivedText, 'total 42\ndrwxr-xr-x ...');
  });
});
