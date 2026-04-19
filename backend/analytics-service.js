/**
 * Analytics Service - Real-Time Metrics & Analytics Engine
 * 
 * Responsibilities:
 * - Collect and process events
 * - Calculate real-time metrics
 * - Provide analytics queries
 * - Generate reports and trends
 * - Integrate with time-series database (TimescaleDB/ClickHouse)
 */

const express = require('express');
const { Pool } = require('pg');
const Redis = require('redis');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

// ============================================================================
// DATABASE & CACHE SETUP
// ============================================================================

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'automation_db'
});

const redisClient = Redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect();

// ============================================================================
// EVENT COLLECTION
// ============================================================================

app.post('/events', async (req, res) => {
    try {
        const { event_type, user_id, entity_type, entity_id, action, metadata } = req.body;

        if (!event_type) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'event_type is required'
            });
        }

        const eventId = uuidv4();
        const query = `
            INSERT INTO events (id, event_type, user_id, entity_type, entity_id, action, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;

        const result = await pool.query(query, [
            eventId,
            event_type,
            user_id || null,
            entity_type || null,
            entity_id || null,
            action || null,
            metadata ? JSON.stringify(metadata) : null
        ]);

        // Publish event for real-time processing
        await publishEvent(result.rows[0]);

        res.status(201).json({
            code: 'EVENT_RECORDED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error recording event:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// METRICS RETRIEVAL
// ============================================================================

app.get('/metrics', async (req, res) => {
    try {
        const { metric_name, dimension_1, start_time, end_time, limit = 100 } = req.query;

        let query = 'SELECT * FROM analytics_metrics WHERE 1=1';
        const params = [];

        if (metric_name) {
            query += ` AND metric_name = $${params.length + 1}`;
            params.push(metric_name);
        }

        if (dimension_1) {
            query += ` AND dimension_1 = $${params.length + 1}`;
            params.push(dimension_1);
        }

        if (start_time) {
            query += ` AND timestamp >= $${params.length + 1}`;
            params.push(new Date(start_time));
        }

        if (end_time) {
            query += ` AND timestamp <= $${params.length + 1}`;
            params.push(new Date(end_time));
        }

        query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await pool.query(query, params);

        res.json({
            code: 'METRICS_RETRIEVED',
            data: result.rows,
            meta: {
                total: result.rows.length,
                limit
            }
        });
    } catch (error) {
        console.error('Error retrieving metrics:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// CUSTOM QUERY EXECUTION
// ============================================================================

app.post('/query', async (req, res) => {
    try {
        const { sql, params = [] } = req.body;

        if (!sql) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'sql query is required'
            });
        }

        // Validate query (prevent SQL injection)
        if (!isValidQuery(sql)) {
            return res.status(400).json({
                code: 'INVALID_QUERY',
                message: 'Query contains invalid operations'
            });
        }

        const result = await pool.query(sql, params);

        res.json({
            code: 'QUERY_EXECUTED',
            data: result.rows,
            meta: {
                rowCount: result.rowCount
            }
        });
    } catch (error) {
        console.error('Error executing query:', error);
        res.status(500).json({
            code: 'QUERY_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// EVENTS RETRIEVAL
// ============================================================================

app.get('/events', async (req, res) => {
    try {
        const { event_type, user_id, start_time, end_time, limit = 100, offset = 0 } = req.query;

        let query = 'SELECT * FROM events WHERE 1=1';
        const params = [];

        if (event_type) {
            query += ` AND event_type = $${params.length + 1}`;
            params.push(event_type);
        }

        if (user_id) {
            query += ` AND user_id = $${params.length + 1}`;
            params.push(user_id);
        }

        if (start_time) {
            query += ` AND created_at >= $${params.length + 1}`;
            params.push(new Date(start_time));
        }

        if (end_time) {
            query += ` AND created_at <= $${params.length + 1}`;
            params.push(new Date(end_time));
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        res.json({
            code: 'EVENTS_RETRIEVED',
            data: result.rows,
            meta: {
                total: result.rows.length,
                limit,
                offset
            }
        });
    } catch (error) {
        console.error('Error retrieving events:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// TRENDS & AGGREGATIONS
// ============================================================================

app.get('/trends', async (req, res) => {
    try {
        const { metric_name, interval = '1 hour', start_time, end_time } = req.query;

        if (!metric_name) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'metric_name is required'
            });
        }

        let query = `
            SELECT 
                DATE_TRUNC($1, timestamp) as time_bucket,
                AVG(metric_value) as avg_value,
                MAX(metric_value) as max_value,
                MIN(metric_value) as min_value,
                COUNT(*) as count
            FROM analytics_metrics
            WHERE metric_name = $2
        `;

        const params = [interval, metric_name];

        if (start_time) {
            query += ` AND timestamp >= $${params.length + 1}`;
            params.push(new Date(start_time));
        }

        if (end_time) {
            query += ` AND timestamp <= $${params.length + 1}`;
            params.push(new Date(end_time));
        }

        query += ` GROUP BY DATE_TRUNC($1, timestamp) ORDER BY time_bucket DESC`;

        const result = await pool.query(query, params);

        res.json({
            code: 'TRENDS_RETRIEVED',
            data: result.rows,
            meta: {
                metric_name,
                interval,
                count: result.rows.length
            }
        });
    } catch (error) {
        console.error('Error retrieving trends:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// SUMMARY STATISTICS
// ============================================================================

app.get('/summary', async (req, res) => {
    try {
        const { start_time, end_time } = req.query;

        let timeFilter = '';
        const params = [];

        if (start_time) {
            timeFilter += ` AND created_at >= $${params.length + 1}`;
            params.push(new Date(start_time));
        }

        if (end_time) {
            timeFilter += ` AND created_at <= $${params.length + 1}`;
            params.push(new Date(end_time));
        }

        // Get various statistics
        const queries = {
            totalEvents: `SELECT COUNT(*) as count FROM events WHERE 1=1 ${timeFilter}`,
            totalUsers: `SELECT COUNT(DISTINCT user_id) as count FROM events WHERE user_id IS NOT NULL ${timeFilter}`,
            totalWorkflows: `SELECT COUNT(*) as count FROM workflows WHERE deleted_at IS NULL`,
            totalExecutions: `SELECT COUNT(*) as count FROM workflow_executions WHERE 1=1 ${timeFilter}`,
            successfulExecutions: `SELECT COUNT(*) as count FROM workflow_executions WHERE status = 'completed' ${timeFilter}`,
            failedExecutions: `SELECT COUNT(*) as count FROM workflow_executions WHERE status = 'failed' ${timeFilter}`
        };

        const results = {};
        for (const [key, query] of Object.entries(queries)) {
            const result = await pool.query(query, params);
            results[key] = result.rows[0].count;
        }

        res.json({
            code: 'SUMMARY_RETRIEVED',
            data: results,
            meta: {
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error retrieving summary:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function publishEvent(event) {
    // Publish to message queue or WebSocket for real-time updates
    console.log(`Publishing event: ${event.event_type}`);
    
    // TODO: Implement actual event publishing
    // - Publish to Kafka/RabbitMQ
    // - Publish to WebSocket for real-time dashboards
    // - Trigger analytics calculations
}

function isValidQuery(sql) {
    // Basic validation - prevent dangerous operations
    const dangerousPatterns = [
        /DROP\s+TABLE/i,
        /DELETE\s+FROM/i,
        /TRUNCATE/i,
        /ALTER\s+TABLE/i,
        /CREATE\s+TABLE/i,
        /INSERT\s+INTO/i,
        /UPDATE\s+/i
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(sql)) {
            return false;
        }
    }

    return true;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'analytics-service',
        timestamp: new Date().toISOString()
    });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred'
    });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.ANALYTICS_SERVICE_PORT || 3002;

app.listen(PORT, () => {
    console.log(`✅ Analytics Service running on port ${PORT}`);
});

module.exports = app;
