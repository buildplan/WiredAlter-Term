import { test, describe, it } from 'node:test';
import assert from 'node:assert';
import supertest from 'supertest';
import { app } from '../src/index.js'; // Imports your app

describe('WiredAlter-Term Security Checks', () => {

    // 1. Test that the Login Page loads (Public Access)
    it('GET /login should return 200 OK', async () => {
        const response = await supertest(app).get('/login');
        assert.strictEqual(response.status, 200);
        assert.match(response.text, /WiredTerm/); // Checks if HTML contains app title
    });

    // 2. Test that protected routes Redirect to Login (Auth Guard)
    it('GET / (Root) should redirect to /login if not authenticated', async () => {
        const response = await supertest(app).get('/');
        assert.strictEqual(response.status, 302); // 302 = Redirect
        assert.strictEqual(response.header.location, '/login');
    });

    // 3. Test Upload Security
    it('POST /upload should be blocked without session', async () => {
        const response = await supertest(app)
            .post('/upload')
            .attach('files', Buffer.from('dummy content'), 'test.txt');

        // Should redirect (302) because we didn't log in
        assert.strictEqual(response.status, 302);
    });
});
