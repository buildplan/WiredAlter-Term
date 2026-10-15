import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(crypto.pbkdf2);
const hkdfAsync = promisify(crypto.hkdf);

export const E2EE_CONSTANTS = Object.freeze({
  PBKDF2_DEFAULT_ITERATIONS: 100_000,
  PBKDF2_DIGEST: 'sha256',
  KEY_BYTE_LEN: 32,       // 256 bits
  SALT_BYTE_LEN: 16,      // 128 bits
  NONCE_BYTE_LEN: 32,     // 256 bits
  IV_BYTE_LEN: 12,        // 96 bits (NIST SP 800-38D standard for AES-GCM)
  TAG_BYTE_LEN: 16,       // 128 bits
  PAD_BLOCK_SIZE: 64,     // Minimum 64-byte plaintext blocks to hide keystroke lengths
  MAX_SEQ: 0xffff_fffe,   // NIST 2^32-1 AES-GCM invocation limit per key
  DIR_HANDSHAKE: 0x00,
  DIR_C2S: 0x01,
  DIR_S2C: 0x02,
});

/**
 * Derives a 256-bit key asynchronously using PBKDF2-HMAC-SHA256.
 * @param {string} passphrase
 * @param {Buffer|Uint8Array} salt
 * @param {number} [iterations=100_000]
 * @returns {Promise<Buffer>}
 */
export async function deriveKeyPBKDF2(passphrase, salt, iterations = E2EE_CONSTANTS.PBKDF2_DEFAULT_ITERATIONS) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('E2EE passphrase must be a non-empty string');
  }
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  if (saltBuf.length !== E2EE_CONSTANTS.SALT_BYTE_LEN) {
    throw new Error(`Invalid salt length: expected ${E2EE_CONSTANTS.SALT_BYTE_LEN} bytes`);
  }
  const iter = Number.isInteger(iterations) && iterations > 0 ? iterations : E2EE_CONSTANTS.PBKDF2_DEFAULT_ITERATIONS;
  return pbkdf2Async(
    passphrase,
    saltBuf,
    iter,
    E2EE_CONSTANTS.KEY_BYTE_LEN,
    E2EE_CONSTANTS.PBKDF2_DIGEST
  );
}

/**
 * Generates an ephemeral P-256 ECDH keypair on the server.
 * publicKey is a 65-byte uncompressed point (0x04 || X || Y) matching WebCrypto 'raw' format.
 * @returns {{ ecdh: crypto.ECDH, publicKey: Buffer }}
 */
export function createServerECDH() {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys(); // 65-byte Buffer (0x04 || X || Y)
  return { ecdh, publicKey };
}

/**
 * Computes the base64url-encoded SHA-256 transcript hash used as the
 * WebAuthn challenge to bind both ECDH ephemeral public keys.
 * @param {Buffer|Uint8Array} serverNonce
 * @param {Buffer|Uint8Array} serverEcdhPub
 * @param {Buffer|Uint8Array} clientEcdhPub
 * @param {Buffer|Uint8Array} salt
 * @returns {string} Base64url-encoded hash
 */
export function computeTranscriptChallenge(serverNonce, serverEcdhPub, clientEcdhPub, salt) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(serverNonce))
    .update(Buffer.from(serverEcdhPub))
    .update(Buffer.from(clientEcdhPub))
    .update(Buffer.from(salt))
    .digest('base64url');
}

/**
 * Derives a 256-bit AES-GCM key from P-256 ECDH + HKDF-SHA256,
 * binding both public keys into the HKDF info context.
 * @param {crypto.ECDH} serverEcdh
 * @param {Buffer|Uint8Array} serverEcdhPub
 * @param {Buffer|Uint8Array} clientEcdhPub
 * @param {Buffer|Uint8Array} salt
 * @returns {Promise<Buffer>}
 */
export async function deriveKeyECDH(serverEcdh, serverEcdhPub, clientEcdhPub, salt) {
  const clientPubBuf = Buffer.isBuffer(clientEcdhPub) ? clientEcdhPub : Buffer.from(clientEcdhPub);
  if (clientPubBuf.length !== 65 || clientPubBuf[0] !== 0x04) {
    throw new Error('Invalid client P-256 ECDH uncompressed public key: must be 65 bytes starting with 0x04');
  }

  const sharedSecret = serverEcdh.computeSecret(clientPubBuf);
  const info = Buffer.concat([
    Buffer.from('wiredterm-e2ee-v1', 'utf8'),
    Buffer.from(serverEcdhPub),
    clientPubBuf,
  ]);

  const derivedArrayBuffer = await hkdfAsync(
    'sha256',
    sharedSecret,
    Buffer.from(salt),
    info,
    E2EE_CONSTANTS.KEY_BYTE_LEN
  );
  return Buffer.from(derivedArrayBuffer);
}

/**
 * Builds the 5-byte Additional Authenticated Data (AAD) buffer:
 * [1-byte direction][4-byte UInt32BE sequence number]
 * @param {number} direction
 * @param {number} seq
 * @returns {Buffer}
 */
export function buildAAD(direction, seq) {
  if (seq < 0 || seq > E2EE_CONSTANTS.MAX_SEQ) {
    throw new Error('E2EE sequence number exhausted; session must re-key');
  }
  const aad = Buffer.allocUnsafe(5);
  aad.writeUInt8(direction, 0);
  aad.writeUInt32BE(seq >>> 0, 1);
  return aad;
}

/**
 * Pads plaintext to a multiple of 64 bytes with a 4-byte UInt32BE length prefix:
 * [4-byte actualLen][plaintextBytes][0x00 padding...]
 * @param {Buffer|string|Uint8Array} plaintext
 * @returns {Buffer}
 */
export function padPlaintext(plaintext) {
  const rawBuf = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(plaintext);

  const totalRequired = 4 + rawBuf.length;
  const blockSize = E2EE_CONSTANTS.PAD_BLOCK_SIZE;
  const paddedLen = Math.max(
    blockSize,
    Math.ceil(totalRequired / blockSize) * blockSize
  );

  const padded = Buffer.alloc(paddedLen, 0); // Zero-filled
  padded.writeUInt32BE(rawBuf.length, 0);
  rawBuf.copy(padded, 4);
  return padded;
}

/**
 * Strips 64-byte padding and validates the 4-byte length prefix.
 * @param {Buffer} paddedBuf
 * @returns {Buffer}
 */
export function unpadPlaintext(paddedBuf) {
  const blockSize = E2EE_CONSTANTS.PAD_BLOCK_SIZE;
  if (paddedBuf.length < blockSize || paddedBuf.length % blockSize !== 0) {
    throw new Error('Invalid E2EE padded plaintext block size');
  }
  const actualLen = paddedBuf.readUInt32BE(0);
  if (actualLen > paddedBuf.length - 4) {
    throw new Error('Corrupted E2EE length prefix');
  }
  return paddedBuf.subarray(4, 4 + actualLen);
}

/**
 * Encrypts plaintext into wire format: [12-byte IV][Ciphertext][16-byte Auth Tag]
 * @param {Buffer} key - 32-byte AES-256 key
 * @param {Buffer|string|Uint8Array} plaintext
 * @param {number} direction - DIR_HANDSHAKE, DIR_C2S, or DIR_S2C
 * @param {number} seq - Monotonic sequence number
 * @returns {Buffer}
 */
export function encryptPayload(key, plaintext, direction, seq) {
  const iv = crypto.randomBytes(E2EE_CONSTANTS.IV_BYTE_LEN);
  const aad = buildAAD(direction, seq);
  const paddedPlaintext = padPlaintext(plaintext);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: E2EE_CONSTANTS.TAG_BYTE_LEN,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(paddedPlaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Wire layout matching WebCrypto: [12B IV][Ciphertext][16B Auth Tag]
  return Buffer.concat([iv, ciphertext, tag]);
}

/**
 * Decrypts wire format [12-byte IV][Ciphertext][16-byte Auth Tag] and strips padding.
 * @param {Buffer|ArrayBuffer|Uint8Array} key
 * @param {Buffer|ArrayBuffer|Uint8Array} wirePayload
 * @param {number} direction - Expected direction byte
 * @param {number} seq - Expected monotonic sequence number
 * @returns {Buffer} Unpadded plaintext buffer
 */
export function decryptPayload(key, wirePayload, direction, seq) {
  const buf = Buffer.isBuffer(wirePayload)
    ? wirePayload
    : Buffer.from(wirePayload);

  const minWireLen =
    E2EE_CONSTANTS.IV_BYTE_LEN +
    E2EE_CONSTANTS.PAD_BLOCK_SIZE +
    E2EE_CONSTANTS.TAG_BYTE_LEN;

  if (buf.length < minWireLen) {
    throw new Error('E2EE frame too short');
  }

  const iv = buf.subarray(0, E2EE_CONSTANTS.IV_BYTE_LEN);
  const tag = buf.subarray(buf.length - E2EE_CONSTANTS.TAG_BYTE_LEN);
  const ciphertext = buf.subarray(
    E2EE_CONSTANTS.IV_BYTE_LEN,
    buf.length - E2EE_CONSTANTS.TAG_BYTE_LEN
  );

  const aad = buildAAD(direction, seq);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: E2EE_CONSTANTS.TAG_BYTE_LEN,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const paddedPlaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return unpadPlaintext(paddedPlaintext);
}

/**
 * Stateful per-socket Server E2EE session manager.
 * Supports Mode A (Passkey-Authenticated Ephemeral ECDH) and Mode B (Passphrase PBKDF2).
 */
export class ServerE2EESession {
  constructor(iterations = E2EE_CONSTANTS.PBKDF2_DEFAULT_ITERATIONS) {
    this.salt = crypto.randomBytes(E2EE_CONSTANTS.SALT_BYTE_LEN);
    this.serverNonce = crypto.randomBytes(E2EE_CONSTANTS.NONCE_BYTE_LEN);
    this.iterations = iterations;
    
    // Ephemeral ECDH parameters (Mode A)
    this.serverEcdh = null;
    this.serverEcdhPub = null;

    // Session state
    this.key = null;
    this.isVerified = false;
    this.mode = null; // 'passkey' | 'passphrase'
    this.txSeq = 0;   // Server -> Client counter (DIR_S2C)
    this.rxSeq = 0;   // Client -> Server counter (DIR_C2S)
  }

  /**
   * Generates challenge payload for initialization.
   * @param {'passkey'|'passphrase'} mode
   * @param {object} [webauthnOptions=null]
   * @returns {object}
   */
  initChallenge(mode, webauthnOptions = null) {
    this.mode = mode;
    if (mode === 'passkey') {
      const { ecdh, publicKey } = createServerECDH();
      this.serverEcdh = ecdh;
      this.serverEcdhPub = publicKey;
      return {
        mode: 'passkey',
        salt: this.salt,
        serverNonce: this.serverNonce,
        serverEcdhPub: this.serverEcdhPub,
        webauthnOptions,
      };
    } else {
      return {
        mode: 'passphrase',
        salt: this.salt,
        serverNonce: this.serverNonce,
        iterations: this.iterations,
      };
    }
  }

  /**
   * Verifies Mode B (Passphrase) handshake.
   * @param {string} serverPassphrase
   * @param {Buffer|Uint8Array} encryptedChallengeResponse
   * @returns {Promise<boolean>}
   */
  async verifyPassphraseHandshake(serverPassphrase, encryptedChallengeResponse) {
    if (this.isVerified) {
      throw new Error('E2EE session already verified');
    }
    if (!this.salt || !this.serverNonce) {
      throw new Error('E2EE session not properly initialized');
    }

    const derivedKey = await deriveKeyPBKDF2(serverPassphrase, this.salt, this.iterations);
    try {
      const decrypted = decryptPayload(
        derivedKey,
        encryptedChallengeResponse,
        E2EE_CONSTANTS.DIR_HANDSHAKE,
        0
      );

      if (
        decrypted.length === this.serverNonce.length &&
        crypto.timingSafeEqual(decrypted, this.serverNonce)
      ) {
        this.key = derivedKey;
        this.isVerified = true;
        this._cleanupHandshakeState();
        return true;
      }
    } catch {
      // Decryption or auth tag verification failed
    }
    return false;
  }

  /**
   * Verifies Mode A (Passkey ECDH) handshake.
   * @param {Buffer|Uint8Array} clientEcdhPub - 65-byte uncompressed point
   * @param {Buffer|Uint8Array} encryptedProof - Proof that client derived the key
   * @returns {Promise<boolean>}
   */
  async verifyECDHKeyAndProof(clientEcdhPub, encryptedProof) {
    if (this.isVerified) {
      throw new Error('E2EE session already verified');
    }
    if (!this.serverEcdh || !this.serverEcdhPub || !this.salt || !this.serverNonce) {
      throw new Error('E2EE Passkey ECDH state not initialized');
    }

    try {
      const derivedKey = await deriveKeyECDH(
        this.serverEcdh,
        this.serverEcdhPub,
        clientEcdhPub,
        this.salt
      );

      const decryptedNonce = decryptPayload(
        derivedKey,
        encryptedProof,
        E2EE_CONSTANTS.DIR_HANDSHAKE,
        0
      );

      if (
        decryptedNonce.length === this.serverNonce.length &&
        crypto.timingSafeEqual(decryptedNonce, this.serverNonce)
      ) {
        this.key = derivedKey;
        this.isVerified = true;
        this._cleanupHandshakeState();
        return true;
      }
    } catch {
      // ECDH or proof decryption failed
    }
    return false;
  }

  /**
   * Zeroes out and nullifies ephemeral handshake secrets after successful verification.
   * Prevents private parameters from lingering in heap memory or being re-verified.
   * @private
   */
  _cleanupHandshakeState() {
    this.serverEcdh = null;
    this.serverEcdhPub = null;
    this.serverNonce = null;
    this.salt = null;
  }

  encryptOutput(data) {
    if (!this.isVerified || !this.key) {
      throw new Error('Cannot encrypt: E2EE session not verified');
    }
    const seq = this.txSeq++;
    return encryptPayload(this.key, data, E2EE_CONSTANTS.DIR_S2C, seq);
  }

  decryptInput(wireBuffer) {
    if (!this.isVerified || !this.key) {
      throw new Error('Cannot decrypt: E2EE session not verified');
    }
    const seq = this.rxSeq++;
    return decryptPayload(this.key, wireBuffer, E2EE_CONSTANTS.DIR_C2S, seq);
  }
}
