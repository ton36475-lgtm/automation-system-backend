/**
 * API Gateway - Main Entry Point for All Client Requests
 * 
 * Responsibilities:
 * - Request authentication and authorization
 * - Rate limiting per user/IP
 * - Request validation and sanitization
 * - Response compression
 * - CORS handling
 * - Request/response logging
 * - Load balancing across services
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Security middleware
app.use(helmet());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Logging middleware
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            success: false,
            error: {
                code: 'UNAUTHORIZED',
                message: 'Access token required'
            }
        });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: 'Invalid or expired token'
                }
            });
        }

        req.user = user;
        next();
    });
};

// ============================================================================
// REQUEST VALIDATION MIDDLEWARE
// ============================================================================

const validateRequest = (schema) => {
    return (req, res, next) => {
        try {
            // Basic validation - can be extended with Joi or Zod
            if (schema.body && req.method !== 'GET') {
                const required = schema.body.required || [];
                for (const field of required) {
                    if (!req.body[field]) {
                        return res.status(400).json({
                            success: false,
                            error: {
                                code: 'VALIDATION_ERROR',
                                message: `Missing required field: ${field}`
                            }
                        });
                    }
                }
            }
            next();
        } catch (error) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: error.message
                }
            });
        }
    };
};

// ============================================================================
// SERVICE ROUTING
// ============================================================================

const SERVICES = {
    automation: process.env.AUTOMATION_SERVICE_URL || 'http://localhost:3001',
    analytics: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3002',
    dashboard: process.env.DASHBOARD_SERVICE_URL || 'http://localhost:3003',
    integration: process.env.INTEGRATION_SERVICE_URL || 'http://localhost:3004',
    user: process.env.USER_SERVICE_URL || 'http://localhost:3005'
};

// Generic proxy function
const proxyRequest = async (req, res, serviceUrl) => {
    try {
        const config = {
            method: req.method,
            url: `${serviceUrl}${req.path}`,
            headers: {
                ...req.headers,
                'Authorization': req.headers.authorization || '',
                'X-User-ID': req.user?.id || 'anonymous'
            },
            data: req.body,
            params: req.query
        };

        const response = await axios(config);
        
        res.status(response.status).json({
            success: true,
            data: response.data,
            meta: {
                timestamp: new Date().toISOString(),
                version: '1.0'
            }
        });
    } catch (error) {
        const status = error.response?.status || 500;
        const errorData = error.response?.data || { message: error.message };

        res.status(status).json({
            success: false,
            error: {
                code: errorData.code || 'SERVICE_ERROR',
                message: errorData.message || 'Internal server error'
            }
        });
    }
};

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        success: true,
        data: {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: Object.keys(SERVICES)
        }
    });
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/v1/auth/login', validateRequest({
    body: { required: ['email', 'password'] }
}), async (req, res) => {
    try {
        const response = await axios.post(`${SERVICES.user}/auth/login`, req.body);
        const token = jwt.sign(
            { id: response.data.user.id, email: response.data.user.email },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            data: {
                token,
                user: response.data.user
            }
        });
    } catch (error) {
        res.status(401).json({
            success: false,
            error: {
                code: 'AUTHENTICATION_FAILED',
                message: 'Invalid credentials'
            }
        });
    }
});

app.post('/api/v1/auth/logout', authenticateToken, (req, res) => {
    res.json({
        success: true,
        data: { message: 'Logged out successfully' }
    });
});

// ============================================================================
// AUTOMATION SERVICE ROUTES
// ============================================================================

app.post('/api/v1/workflows', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.get('/api/v1/workflows', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.get('/api/v1/workflows/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.put('/api/v1/workflows/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.delete('/api/v1/workflows/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.post('/api/v1/workflows/:id/execute', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.get('/api/v1/executions', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

app.get('/api/v1/executions/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.automation);
});

// ============================================================================
// ANALYTICS SERVICE ROUTES
// ============================================================================

app.get('/api/v1/analytics/metrics', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.analytics);
});

app.post('/api/v1/analytics/query', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.analytics);
});

app.get('/api/v1/analytics/events', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.analytics);
});

app.get('/api/v1/analytics/trends', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.analytics);
});

// ============================================================================
// DASHBOARD SERVICE ROUTES
// ============================================================================

app.post('/api/v1/dashboards', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.dashboard);
});

app.get('/api/v1/dashboards', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.dashboard);
});

app.get('/api/v1/dashboards/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.dashboard);
});

app.put('/api/v1/dashboards/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.dashboard);
});

app.delete('/api/v1/dashboards/:id', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.dashboard);
});

// ============================================================================
// INTEGRATION SERVICE ROUTES
// ============================================================================

app.post('/api/v1/integrations/github', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.integration);
});

app.get('/api/v1/integrations/github', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.integration);
});

app.delete('/api/v1/integrations/github', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.integration);
});

app.post('/api/v1/integrations/api', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.integration);
});

app.get('/api/v1/integrations/api', authenticateToken, (req, res) => {
    proxyRequest(req, res, SERVICES.integration);
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: {
            code: 'NOT_FOUND',
            message: 'Endpoint not found'
        }
    });
});

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        success: false,
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred'
        }
    });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.API_GATEWAY_PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ API Gateway running on port ${PORT}`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Services:`);
    Object.entries(SERVICES).forEach(([name, url]) => {
        console.log(`   - ${name}: ${url}`);
    });
});

module.exports = app;
