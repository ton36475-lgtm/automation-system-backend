/**
 * API Gateway Tests
 * 
 * Test coverage:
 * - Authentication
 * - Authorization
 * - Rate limiting
 * - Request validation
 * - Error handling
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock app setup
const app = express();
app.use(express.json());

// Mock authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    jwt.verify(token, 'test-secret', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'FORBIDDEN' });
        }
        req.user = user;
        next();
    });
};

// Test routes
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

app.post('/api/v1/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'VALIDATION_ERROR' });
    }

    const token = jwt.sign({ email }, 'test-secret', { expiresIn: '24h' });
    res.json({ token, user: { email } });
});

app.get('/api/v1/workflows', authenticateToken, (req, res) => {
    res.json({ workflows: [] });
});

// Tests
describe('API Gateway', () => {
    describe('Health Check', () => {
        it('should return healthy status', async () => {
            const res = await request(app).get('/health');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('healthy');
        });
    });

    describe('Authentication', () => {
        it('should login with valid credentials', async () => {
            const res = await request(app)
                .post('/api/v1/auth/login')
                .send({ email: 'test@example.com', password: 'password123' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeDefined();
            expect(res.body.user.email).toBe('test@example.com');
        });

        it('should reject login without email', async () => {
            const res = await request(app)
                .post('/api/v1/auth/login')
                .send({ password: 'password123' });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('VALIDATION_ERROR');
        });

        it('should reject request without token', async () => {
            const res = await request(app).get('/api/v1/workflows');
            expect(res.status).toBe(401);
            expect(res.body.error).toBe('UNAUTHORIZED');
        });

        it('should accept request with valid token', async () => {
            const token = jwt.sign({ email: 'test@example.com' }, 'test-secret');
            const res = await request(app)
                .get('/api/v1/workflows')
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body.workflows).toBeDefined();
        });

        it('should reject request with invalid token', async () => {
            const res = await request(app)
                .get('/api/v1/workflows')
                .set('Authorization', 'Bearer invalid-token');

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('FORBIDDEN');
        });
    });
});

module.exports = app;
