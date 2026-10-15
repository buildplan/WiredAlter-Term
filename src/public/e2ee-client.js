(function (root, factory) {
  const exportsObj = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exportsObj;
  }
  if (root) {
    root.ClientE2EESession = exportsObj.ClientE2EESession;
    root.E2EE_CONFIG = exportsObj.E2EE_CONFIG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const E2EE_CONFIG = Object.freeze({
    PBKDF2_DEFAULT_ITERATIONS: 100_000,
    IV_BYTE_LEN: 12,
    TAG_BYTE_LEN: 16,
    PAD_BLOCK_SIZE: 64,
    MAX_SEQ: 0xffff_fffe,
    DIR_HANDSHAKE: 0x00,
    DIR_C2S: 0x01,
    DIR_S2C: 0x02,
  });

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const cryptoObj = (typeof window !== 'undefined' && window.crypto) ? window.crypto : globalThis.crypto;
  const btoaFn = typeof btoa === 'function' ? btoa : (b) => Buffer.from(b, 'binary').toString('base64');

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') return textEncoder.encode(data);
    throw new Error('Unsupported data type for E2EE conversion');
  }

  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoaFn(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildAAD(direction, seq) {
    if (seq < 0 || seq > E2EE_CONFIG.MAX_SEQ) {
      throw new Error('E2EE sequence number exhausted; reload session');
    }
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, direction);
    view.setUint32(1, seq >>> 0, false); // Big-endian
    return new Uint8Array(buf);
  }

  function padPlaintext(payloadBytes) {
    const totalRequired = 4 + payloadBytes.byteLength;
    const blockSize = E2EE_CONFIG.PAD_BLOCK_SIZE;
    const paddedLen = Math.max(
      blockSize,
      Math.ceil(totalRequired / blockSize) * blockSize
    );

    const padded = new Uint8Array(paddedLen); // Zero-filled by spec
    const view = new DataView(padded.buffer);
    view.setUint32(0, payloadBytes.byteLength, false); // Big-endian length header
    padded.set(payloadBytes, 4);
    return padded;
  }

  function unpadPlaintext(paddedArrayBuffer) {
    const bytes = new Uint8Array(paddedArrayBuffer);
    const blockSize = E2EE_CONFIG.PAD_BLOCK_SIZE;

    if (bytes.byteLength < blockSize || bytes.byteLength % blockSize !== 0) {
      throw new Error('Invalid E2EE padded plaintext length');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const actualLen = view.getUint32(0, false);

    if (actualLen > bytes.byteLength - 4) {
      throw new Error('Corrupted E2EE length prefix');
    }

    return bytes.subarray(4, 4 + actualLen);
  }

  /**
   * Computes base64url(SHA256(serverNonce || serverEcdhPub || clientEcdhPub || salt))
   */
  async function computeClientTranscriptChallenge(serverNonce, serverEcdhPub, clientEcdhPub, salt) {
    const sNonce = toUint8Array(serverNonce);
    const sPub = toUint8Array(serverEcdhPub);
    const cPub = toUint8Array(clientEcdhPub);
    const sSalt = toUint8Array(salt);

    const combined = new Uint8Array(
      sNonce.byteLength + sPub.byteLength + cPub.byteLength + sSalt.byteLength
    );
    let offset = 0;
    for (const part of [sNonce, sPub, cPub, sSalt]) {
      combined.set(part, offset);
      offset += part.byteLength;
    }

    const digest = await cryptoObj.subtle.digest('SHA-256', combined);
    return bufferToBase64Url(digest);
  }

  /**
   * Derives a non-extractable AES-GCM-256 CryptoKey using WebCrypto PBKDF2.
   * @param {string} passphrase
   * @param {Uint8Array|ArrayBuffer} salt
   * @param {number} [iterations=100_000]
   * @returns {Promise<CryptoKey>}
   */
  async function deriveClientKeyPBKDF2(passphrase, salt, iterations = E2EE_CONFIG.PBKDF2_DEFAULT_ITERATIONS) {
    const baseKey = await cryptoObj.subtle.importKey(
      'raw',
      textEncoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return cryptoObj.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: toUint8Array(salt),
        iterations: Number.isInteger(iterations) && iterations > 0 ? iterations : E2EE_CONFIG.PBKDF2_DEFAULT_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false, // extractable: false — prevents export from browser memory
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypts payload into wire format: [12-byte IV][Ciphertext][16-byte Auth Tag]
   */
  async function encryptFrame(cryptoKey, plaintext, direction, seq) {
    const iv = cryptoObj.getRandomValues(new Uint8Array(E2EE_CONFIG.IV_BYTE_LEN));
    const aad = buildAAD(direction, seq);
    const padded = padPlaintext(toUint8Array(plaintext));

    // WebCrypto AES-GCM automatically appends the 16-byte Auth Tag to the end of ciphertext
    const encryptedBuffer = await cryptoObj.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad,
        tagLength: E2EE_CONFIG.TAG_BYTE_LEN * 8,
      },
      cryptoKey,
      padded
    );

    const ciphertextWithTag = new Uint8Array(encryptedBuffer);
    const wireFrame = new Uint8Array(iv.byteLength + ciphertextWithTag.byteLength);
    wireFrame.set(iv, 0);
    wireFrame.set(ciphertextWithTag, iv.byteLength);

    return wireFrame.buffer;
  }

  /**
   * Decrypts [12-byte IV][Ciphertext][16-byte Auth Tag] and removes 64-byte padding.
   */
  async function decryptFrame(cryptoKey, wireData, direction, seq) {
    const bytes = toUint8Array(wireData);
    const minLen =
      E2EE_CONFIG.IV_BYTE_LEN +
      E2EE_CONFIG.PAD_BLOCK_SIZE +
      E2EE_CONFIG.TAG_BYTE_LEN;

    if (bytes.byteLength < minLen) {
      throw new Error('E2EE wire frame too short');
    }

    const iv = bytes.subarray(0, E2EE_CONFIG.IV_BYTE_LEN);
    const ciphertextWithTag = bytes.subarray(E2EE_CONFIG.IV_BYTE_LEN);
    const aad = buildAAD(direction, seq);

    const decryptedPaddedBuffer = await cryptoObj.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aad,
        tagLength: E2EE_CONFIG.TAG_BYTE_LEN * 8,
      },
      cryptoKey,
      ciphertextWithTag
    );

    return unpadPlaintext(decryptedPaddedBuffer);
  }

  /**
   * Stateful per-tab Browser E2EE Session with strict FIFO Promise ordering.
   */
  class ClientE2EESession {
    #cryptoKey = null;
    #txSeq = 0;
    #rxSeq = 0;
    #txQueue = Promise.resolve();
    #rxQueue = Promise.resolve();
    isReady = false;
    mode = null; // 'passkey' | 'passphrase'

    /**
     * Mode B: Derives key via PBKDF2 and generates encrypted challenge proof.
     * @param {string} passphrase
     * @param {ArrayBuffer|Uint8Array} salt
     * @param {ArrayBuffer|Uint8Array} serverNonce
     * @param {number} [iterations=100_000]
     * @returns {Promise<ArrayBuffer>} Encrypted serverNonce proof
     */
    async completePassphraseChallenge(passphrase, salt, serverNonce, iterations = E2EE_CONFIG.PBKDF2_DEFAULT_ITERATIONS) {
      this.mode = 'passphrase';
      this.#cryptoKey = await deriveClientKeyPBKDF2(passphrase, salt, iterations);
      this.#txSeq = 0;
      this.#rxSeq = 0;

      return encryptFrame(
        this.#cryptoKey,
        toUint8Array(serverNonce),
        E2EE_CONFIG.DIR_HANDSHAKE,
        0
      );
    }

    /**
     * Mode A: Performs P-256 ECDH + WebAuthn Passkey assertion + HKDF-SHA256 key derivation.
     * @param {object} challengePayload - { salt, serverNonce, serverEcdhPub, webauthnOptions }
     * @param {Function} startAuthentication - from @simplewebauthn/browser
     * @returns {Promise<{ mode: string, clientEcdhPub: ArrayBuffer, webauthnAssertion: object, encryptedProof: ArrayBuffer }>}
     */
    async completePasskeyChallenge(
      { salt, serverNonce, serverEcdhPub, webauthnOptions },
      startAuthentication
    ) {
      this.mode = 'passkey';

      // 1. Generate ephemeral P-256 ECDH keypair in WebCrypto
      const clientEcdhKeyPair = await cryptoObj.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false, // private key non-extractable
        ['deriveBits']
      );

      // Export 65-byte uncompressed public key (0x04 || X || Y)
      const clientEcdhPubBuffer = await cryptoObj.subtle.exportKey(
        'raw',
        clientEcdhKeyPair.publicKey
      );
      const clientEcdhPub = new Uint8Array(clientEcdhPubBuffer);

      // 2. Bind full ECDH transcript into WebAuthn challenge
      const boundChallenge = await computeClientTranscriptChallenge(
        serverNonce,
        serverEcdhPub,
        clientEcdhPub,
        salt
      );

      const optionsJSON = {
        ...webauthnOptions,
        challenge: boundChallenge,
      };

      // 3. Prompt Phone Passkey (QR / Bluetooth) or Hardware Security Key
      const webauthnAssertion = await startAuthentication(optionsJSON);

      // 4. Import server's 65-byte uncompressed P-256 public key & compute ECDH shared secret
      const serverPubKey = await cryptoObj.subtle.importKey(
        'raw',
        toUint8Array(serverEcdhPub),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      const sharedSecretBits = await cryptoObj.subtle.deriveBits(
        { name: 'ECDH', public: serverPubKey },
        clientEcdhKeyPair.privateKey,
        256
      );

      // 5. Derive non-extractable AES-GCM-256 session key via HKDF-SHA256
      const hkdfBaseKey = await cryptoObj.subtle.importKey(
        'raw',
        sharedSecretBits,
        'HKDF',
        false,
        ['deriveKey']
      );

      const prefix = textEncoder.encode('wiredterm-e2ee-v1');
      const sPubBytes = toUint8Array(serverEcdhPub);
      const info = new Uint8Array(prefix.byteLength + sPubBytes.byteLength + clientEcdhPub.byteLength);
      info.set(prefix, 0);
      info.set(sPubBytes, prefix.byteLength);
      info.set(clientEcdhPub, prefix.byteLength + sPubBytes.byteLength);

      this.#cryptoKey = await cryptoObj.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: toUint8Array(salt),
          info,
        },
        hkdfBaseKey,
        { name: 'AES-GCM', length: 256 },
        false, // extractable: false
        ['encrypt', 'decrypt']
      );

      this.#txSeq = 0;
      this.#rxSeq = 0;

      // 6. Encrypt serverNonce with the derived AES-GCM key as key-confirmation proof
      const encryptedProof = await encryptFrame(
        this.#cryptoKey,
        toUint8Array(serverNonce),
        E2EE_CONFIG.DIR_HANDSHAKE,
        0
      );

      return {
        mode: 'passkey',
        clientEcdhPub: clientEcdhPub.buffer,
        webauthnAssertion,
        encryptedProof,
      };
    }

    markReady() {
      if (!this.#cryptoKey) throw new Error('Key not initialized');
      this.isReady = true;
    }

    /**
     * Queues and encrypts client-to-server input in strict sequence order.
     * @param {string|Uint8Array} inputData
     * @param {(wireBuffer: ArrayBuffer) => void} emitCallback
     */
    enqueueEncryptInput(inputData, emitCallback) {
      if (!this.isReady || !this.#cryptoKey) return;
      const seq = this.#txSeq++;

      this.#txQueue = this.#txQueue
        .then(async () => {
          const wireBuffer = await encryptFrame(
            this.#cryptoKey,
            inputData,
            E2EE_CONFIG.DIR_C2S,
            seq
          );
          emitCallback(wireBuffer);
        })
        .catch((err) => {
          console.error('[E2EE] Input encryption failure:', err);
        });
    }

    /**
     * Queues and decrypts server-to-client output in strict sequence order.
     * @param {ArrayBuffer|Uint8Array} wireBuffer
     * @param {(decryptedText: string, rawBytes: Uint8Array) => void} writeCallback
     */
    enqueueDecryptOutput(wireBuffer, writeCallback) {
      if (!this.isReady || !this.#cryptoKey) return;
      const seq = this.#rxSeq++;

      this.#rxQueue = this.#rxQueue
        .then(async () => {
          const unpaddedBytes = await decryptFrame(
            this.#cryptoKey,
            wireBuffer,
            E2EE_CONFIG.DIR_S2C,
            seq
          );
          writeCallback(textDecoder.decode(unpaddedBytes), unpaddedBytes);
        })
        .catch((err) => {
          console.error('[E2EE] Output decryption/authentication failure:', err);
        });
    }
  }

  return { ClientE2EESession, E2EE_CONFIG };
});
