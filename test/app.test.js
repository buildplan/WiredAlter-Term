import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import supertest from 'supertest';
import { app, isForceE2EE, getEffectiveE2EEPassphrase, activeTabSessions, DISCONNECT_GRACE_MS } from '../src/index.js';

describe('WiredAlter-Term Full Suite', () => {
    const agent = supertest.agent(app);
    const CORRECT_PIN = "123456"; // matches default in index.js

    // Force process exit to clear dangling intervals
    after(() => {
        setTimeout(() => process.exit(0), 10);
    });

    // --- 1. PUBLIC ACCESS TESTS ---

    it('GET /login should load correctly', async () => {
        const response = await agent.get('/login');
        assert.strictEqual(response.status, 200);
        assert.match(response.text, /Restricted Access/);
    });

    it('GET / should redirect to login (Unauthenticated)', async () => {
        const response = await agent.get('/');
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.header.location, '/login');
    });

    it('GET /auth-methods should return auth config', async () => {
        const response = await agent.get('/auth-methods');
        assert.strictEqual(response.status, 200);
        assert.strictEqual(typeof response.body.disablePin, 'boolean');
    });

    // --- 2. AUTHENTICATION LOGIC ---

    it('POST /verify-pin should reject WRONG pin', async () => {
        const response = await agent
            .post('/verify-pin')
            .send({ pin: "000000" }); // Wrong PIN

        assert.strictEqual(response.status, 401);
        assert.match(response.body.error, /ACCESS DENIED/);
    });

    it('POST /verify-pin should accept CORRECT pin', async () => {
        const response = await agent
            .post('/verify-pin')
            .send({ pin: CORRECT_PIN });

        // Should return success JSON
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);

        // Check if a cookie was set
        const cookies = response.headers['set-cookie'];
        assert.ok(cookies, 'Session cookie should be set');
    });

    // --- 3. PROTECTED ROUTES ---

    it('GET / should allow access now (Authenticated)', async () => {
        // Since 'agent' remembered the cookie from the previous test, this should pass
        const response = await agent.get('/');
        assert.strictEqual(response.status, 200);
        // Expect the main terminal page, which usually has the "WiredTerm" title
        assert.match(response.text, /WiredTerm/);
    });

    it('POST /upload should succeed now (Authenticated)', async () => {
        const csrfRes = await agent.get('/api/csrf-token');
        const token = csrfRes.body.token;

        const response = await agent
            .post('/upload')
            .set('x-csrf-token', token)
            .attach('files', Buffer.from('test content'), 'ci-test.txt');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
    });

    // --- 4. SETTINGS API TESTS ---

    it('GET /api/settings should return security configuration', async () => {
        const response = await agent.get('/api/settings');
        assert.strictEqual(response.status, 200);
        assert.strictEqual(typeof response.body.disablePin, 'boolean');
        assert.strictEqual(typeof response.body.forceE2EE, 'boolean');
        assert.strictEqual(typeof response.body.disablePassphrase, 'boolean');
        assert.strictEqual(typeof response.body.passkeyCount, 'number');
    });

    it('POST /api/settings should reject disabling PIN when 0 passkeys exist', async () => {
        const csrfRes = await agent.get('/api/csrf-token');
        const token = csrfRes.body.token;

        const response = await agent
            .post('/api/settings')
            .set('x-csrf-token', token)
            .send({ disablePin: true });

        // Since no passkeys are registered in test db, disabling PIN must be rejected
        assert.strictEqual(response.status, 400);
        assert.match(response.body.error, /no passkeys are registered/);
    });

    it('POST /api/settings should reject enforcing E2EE when no passkeys or passphrase exist', async () => {
        const csrfRes = await agent.get('/api/csrf-token');
        const token = csrfRes.body.token;

        const response = await agent
            .post('/api/settings')
            .set('x-csrf-token', token)
            .send({ forceE2EE: true });

        // Since no passkeys and no E2EE_PASSPHRASE in test env, enforcing E2EE must be rejected
        assert.strictEqual(response.status, 400);
        assert.match(response.body.error, /Cannot enforce E2EE/);
    });

    it('isForceE2EE and getEffectiveE2EEPassphrase should return correct defaults', () => {
        // In test mode without FORCE_E2EE or E2EE_PASSPHRASE env vars
        assert.strictEqual(typeof isForceE2EE(), 'boolean');
        assert.strictEqual(getEffectiveE2EEPassphrase(), null);
    });

    it('activeTabSessions map and DISCONNECT_GRACE_MS should be configured for resilience', () => {
        assert.ok(activeTabSessions instanceof Map, 'activeTabSessions should be a Map');
        assert.strictEqual(DISCONNECT_GRACE_MS, 60000, 'DISCONNECT_GRACE_MS should be 60 seconds');
    });
});

