import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import supertest from 'supertest';
import { app } from '../src/index.js';

describe('WiredAlter-Term Full Suite', () => {
    const agent = supertest.agent(app);
    const CORRECT_PIN = "123456"; // matches default in index.js

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
        const response = await agent
            .post('/upload')
            .attach('files', Buffer.from('test content'), 'ci-test.txt');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
    });
});
