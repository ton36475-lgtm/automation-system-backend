/**
 * Automation Service - Workflow Orchestration Engine
 * 
 * Responsibilities:
 * - Create and manage workflows
 * - Execute workflows with task orchestration
 * - Handle workflow state management
 * - Integrate with Temporal/Conductor for workflow execution
 * - Provide workflow execution history and monitoring
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
// WORKFLOW CREATION
// ============================================================================

app.post('/workflows', async (req, res) => {
    try {
        const { name, description, definition, owner_id } = req.body;

        if (!name || !definition || !owner_id) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'Missing required fields: name, definition, owner_id'
            });
        }

        const workflowId = uuidv4();
        const query = `
            INSERT INTO workflows (id, name, description, owner_id, definition, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;

        const result = await pool.query(query, [
            workflowId,
            name,
            description || null,
            owner_id,
            JSON.stringify(definition),
            'draft'
        ]);

        res.status(201).json({
            code: 'WORKFLOW_CREATED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating workflow:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// WORKFLOW RETRIEVAL
// ============================================================================

app.get('/workflows', async (req, res) => {
    try {
        const { owner_id, status, limit = 20, offset = 0 } = req.query;

        let query = 'SELECT * FROM workflows WHERE deleted_at IS NULL';
        const params = [];

        if (owner_id) {
            query += ` AND owner_id = $${params.length + 1}`;
            params.push(owner_id);
        }

        if (status) {
            query += ` AND status = $${params.length + 1}`;
            params.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        res.json({
            code: 'WORKFLOWS_RETRIEVED',
            data: result.rows,
            meta: {
                total: result.rows.length,
                limit,
                offset
            }
        });
    } catch (error) {
        console.error('Error retrieving workflows:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

app.get('/workflows/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Try to get from cache first
        const cached = await redisClient.get(`workflow:${id}`);
        if (cached) {
            return res.json({
                code: 'WORKFLOW_RETRIEVED',
                data: JSON.parse(cached),
                meta: { source: 'cache' }
            });
        }

        const query = 'SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL';
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'Workflow not found'
            });
        }

        // Cache the result
        await redisClient.setEx(`workflow:${id}`, 3600, JSON.stringify(result.rows[0]));

        res.json({
            code: 'WORKFLOW_RETRIEVED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error retrieving workflow:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// WORKFLOW EXECUTION
// ============================================================================

app.post('/workflows/:id/execute', async (req, res) => {
    try {
        const { id } = req.params;
        const { triggered_by, input_data } = req.body;

        // Get workflow definition
        const workflowQuery = 'SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL';
        const workflowResult = await pool.query(workflowQuery, [id]);

        if (workflowResult.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'Workflow not found'
            });
        }

        const workflow = workflowResult.rows[0];
        const executionId = uuidv4();

        // Create execution record
        const executionQuery = `
            INSERT INTO workflow_executions 
            (id, workflow_id, triggered_by, status, start_time)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *;
        `;

        const executionResult = await pool.query(executionQuery, [
            executionId,
            id,
            triggered_by || null,
            'running'
        ]);

        // Queue execution in message queue or Temporal
        await queueWorkflowExecution(executionId, workflow, input_data);

        res.status(202).json({
            code: 'EXECUTION_QUEUED',
            data: {
                execution_id: executionId,
                workflow_id: id,
                status: 'running'
            }
        });
    } catch (error) {
        console.error('Error executing workflow:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// EXECUTION MONITORING
// ============================================================================

app.get('/executions', async (req, res) => {
    try {
        const { workflow_id, status, limit = 20, offset = 0 } = req.query;

        let query = 'SELECT * FROM workflow_executions WHERE 1=1';
        const params = [];

        if (workflow_id) {
            query += ` AND workflow_id = $${params.length + 1}`;
            params.push(workflow_id);
        }

        if (status) {
            query += ` AND status = $${params.length + 1}`;
            params.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        res.json({
            code: 'EXECUTIONS_RETRIEVED',
            data: result.rows,
            meta: {
                total: result.rows.length,
                limit,
                offset
            }
        });
    } catch (error) {
        console.error('Error retrieving executions:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

app.get('/executions/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const executionQuery = `
            SELECT we.*, 
                   json_agg(json_build_object(
                       'id', wt.id,
                       'task_name', wt.task_name,
                       'status', wt.status,
                       'output_data', wt.output_data
                   )) as tasks
            FROM workflow_executions we
            LEFT JOIN workflow_tasks wt ON we.id = wt.execution_id
            WHERE we.id = $1
            GROUP BY we.id;
        `;

        const result = await pool.query(executionQuery, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'Execution not found'
            });
        }

        res.json({
            code: 'EXECUTION_RETRIEVED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error retrieving execution:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// WORKFLOW UPDATE
// ============================================================================

app.put('/workflows/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, definition, status } = req.body;

        const query = `
            UPDATE workflows 
            SET name = COALESCE($1, name),
                description = COALESCE($2, description),
                definition = COALESCE($3, definition),
                status = COALESCE($4, status),
                updated_at = NOW()
            WHERE id = $5 AND deleted_at IS NULL
            RETURNING *;
        `;

        const result = await pool.query(query, [
            name || null,
            description || null,
            definition ? JSON.stringify(definition) : null,
            status || null,
            id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'Workflow not found'
            });
        }

        // Invalidate cache
        await redisClient.del(`workflow:${id}`);

        res.json({
            code: 'WORKFLOW_UPDATED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating workflow:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// WORKFLOW DELETION
// ============================================================================

app.delete('/workflows/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const query = `
            UPDATE workflows 
            SET deleted_at = NOW()
            WHERE id = $1
            RETURNING *;
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'Workflow not found'
            });
        }

        // Invalidate cache
        await redisClient.del(`workflow:${id}`);

        res.json({
            code: 'WORKFLOW_DELETED',
            data: { id }
        });
    } catch (error) {
        console.error('Error deleting workflow:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function queueWorkflowExecution(executionId, workflow, inputData) {
    // This would integrate with Temporal, Conductor, or a message queue
    // For now, we'll just log it
    console.log(`Queuing execution ${executionId} for workflow ${workflow.id}`);
    
    // TODO: Implement actual workflow execution
    // - Send to Temporal/Conductor
    // - Or queue in message broker (Bull, RabbitMQ)
    // - Or execute directly (for simple workflows)
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'automation-service',
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

const PORT = process.env.AUTOMATION_SERVICE_PORT || 3001;

app.listen(PORT, () => {
    console.log(`✅ Automation Service running on port ${PORT}`);
});

module.exports = app;
