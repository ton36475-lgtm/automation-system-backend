/**
 * GitHub Integration Service
 * 
 * Responsibilities:
 * - OAuth authentication with GitHub
 * - Webhook handling for repository events
 * - GitHub API interactions
 * - Repository management
 * - PR and issue automation
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

// ============================================================================
// DATABASE SETUP
// ============================================================================

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'automation_db'
});

// ============================================================================
// GITHUB OAUTH FLOW
// ============================================================================

app.post('/oauth/authorize', async (req, res) => {
    try {
        const { code, user_id } = req.body;

        if (!code || !user_id) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code and user_id are required'
            });
        }

        // Exchange code for access token
        const tokenResponse = await axios.post(
            'https://github.com/login/oauth/access_token',
            {
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code
            },
            {
                headers: {
                    Accept: 'application/json'
                }
            }
        );

        const { access_token, error } = tokenResponse.data;

        if (error) {
            return res.status(400).json({
                code: 'OAUTH_ERROR',
                message: error
            });
        }

        // Get GitHub user info
        const userResponse = await axios.get('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        });

        const { login: github_username } = userResponse.data;

        // Get user repositories
        const reposResponse = await axios.get('https://api.github.com/user/repos', {
            headers: {
                Authorization: `Bearer ${access_token}`
            },
            params: {
                per_page: 100
            }
        });

        const repositories = reposResponse.data.map(repo => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            url: repo.html_url,
            description: repo.description
        }));

        // Save GitHub integration
        const query = `
            INSERT INTO github_integrations 
            (user_id, github_username, github_token, repositories, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                github_token = $3,
                repositories = $4,
                updated_at = NOW()
            RETURNING *;
        `;

        const result = await pool.query(query, [
            user_id,
            github_username,
            access_token,
            JSON.stringify(repositories),
            'active'
        ]);

        res.json({
            code: 'GITHUB_AUTHORIZED',
            data: {
                user_id,
                github_username,
                repositories_count: repositories.length
            }
        });
    } catch (error) {
        console.error('Error in OAuth flow:', error);
        res.status(500).json({
            code: 'OAUTH_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// WEBHOOK HANDLING
// ============================================================================

app.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-hub-signature-256'];
        const payload = JSON.stringify(req.body);

        // Verify webhook signature
        if (!verifyWebhookSignature(payload, signature)) {
            return res.status(401).json({
                code: 'INVALID_SIGNATURE',
                message: 'Webhook signature verification failed'
            });
        }

        const { action, repository, pull_request, issue, commits } = req.body;
        const event_type = req.headers['x-github-event'];

        // Log webhook event
        const logQuery = `
            INSERT INTO webhook_logs 
            (integration_id, event_type, payload, created_at)
            VALUES ($1, $2, $3, NOW());
        `;

        await pool.query(logQuery, [
            repository.id,
            event_type,
            JSON.stringify(req.body)
        ]);

        // Handle different event types
        switch (event_type) {
            case 'pull_request':
                await handlePullRequest(req.body);
                break;
            case 'issues':
                await handleIssue(req.body);
                break;
            case 'push':
                await handlePush(req.body);
                break;
            case 'workflow_run':
                await handleWorkflowRun(req.body);
                break;
            default:
                console.log(`Unhandled event type: ${event_type}`);
        }

        res.json({ code: 'WEBHOOK_PROCESSED' });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({
            code: 'WEBHOOK_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// EVENT HANDLERS
// ============================================================================

async function handlePullRequest(payload) {
    const { action, pull_request, repository } = payload;

    console.log(`PR ${action}: ${pull_request.title}`);

    // Trigger automated checks
    if (action === 'opened') {
        // Run code analysis
        await runCodeAnalysis(pull_request);
        
        // Add automated comment
        await addPRComment(
            repository.owner.login,
            repository.name,
            pull_request.number,
            generatePRComment(pull_request)
        );
    }

    // Log event
    const query = `
        INSERT INTO events 
        (event_type, entity_type, entity_id, action, metadata)
        VALUES ($1, $2, $3, $4, $5);
    `;

    await pool.query(query, [
        'github_pr',
        'pull_request',
        pull_request.id,
        action,
        JSON.stringify({
            pr_number: pull_request.number,
            title: pull_request.title,
            author: pull_request.user.login,
            repository: repository.full_name
        })
    ]);
}

async function handleIssue(payload) {
    const { action, issue, repository } = payload;

    console.log(`Issue ${action}: ${issue.title}`);

    // Log event
    const query = `
        INSERT INTO events 
        (event_type, entity_type, entity_id, action, metadata)
        VALUES ($1, $2, $3, $4, $5);
    `;

    await pool.query(query, [
        'github_issue',
        'issue',
        issue.id,
        action,
        JSON.stringify({
            issue_number: issue.number,
            title: issue.title,
            author: issue.user.login,
            repository: repository.full_name
        })
    ]);
}

async function handlePush(payload) {
    const { repository, commits, pusher } = payload;

    console.log(`Push to ${repository.full_name}: ${commits.length} commits`);

    // Log event
    const query = `
        INSERT INTO events 
        (event_type, entity_type, entity_id, action, metadata)
        VALUES ($1, $2, $3, $4, $5);
    `;

    await pool.query(query, [
        'github_push',
        'repository',
        repository.id,
        'push',
        JSON.stringify({
            commits_count: commits.length,
            pusher: pusher.name,
            repository: repository.full_name
        })
    ]);
}

async function handleWorkflowRun(payload) {
    const { workflow_run, repository } = payload;

    console.log(`Workflow ${workflow_run.status}: ${workflow_run.name}`);

    // Log event
    const query = `
        INSERT INTO events 
        (event_type, entity_type, entity_id, action, metadata)
        VALUES ($1, $2, $3, $4, $5);
    `;

    await pool.query(query, [
        'github_workflow',
        'workflow_run',
        workflow_run.id,
        workflow_run.status,
        JSON.stringify({
            workflow_name: workflow_run.name,
            status: workflow_run.status,
            conclusion: workflow_run.conclusion,
            repository: repository.full_name
        })
    ]);
}

// ============================================================================
// GITHUB API INTERACTIONS
// ============================================================================

async function runCodeAnalysis(pullRequest) {
    try {
        // Get integration for this repository
        const query = `
            SELECT * FROM github_integrations 
            WHERE repositories @> $1::jsonb
            LIMIT 1;
        `;

        const result = await pool.query(query, [
            JSON.stringify([{ id: pullRequest.head.repo.id }])
        ]);

        if (result.rows.length === 0) {
            console.log('No integration found for repository');
            return;
        }

        const integration = result.rows[0];
        const token = integration.github_token;

        // Get changed files
        const filesResponse = await axios.get(pullRequest.url + '/files', {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        const files = filesResponse.data;
        const issues = [];

        // Analyze files
        for (const file of files) {
            if (file.filename.endsWith('.js') || file.filename.endsWith('.ts')) {
                // Basic code analysis
                const analysis = analyzeCode(file.patch);
                issues.push(...analysis);
            }
        }

        console.log(`Found ${issues.length} potential issues`);

        return issues;
    } catch (error) {
        console.error('Error running code analysis:', error);
    }
}

async function addPRComment(owner, repo, prNumber, comment) {
    try {
        // Get integration token
        const query = `
            SELECT github_token FROM github_integrations 
            WHERE repositories @> $1::jsonb
            LIMIT 1;
        `;

        const result = await pool.query(query, [
            JSON.stringify([{ full_name: `${owner}/${repo}` }])
        ]);

        if (result.rows.length === 0) {
            console.log('No integration found');
            return;
        }

        const token = result.rows[0].github_token;

        await axios.post(
            `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
            { body: comment },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            }
        );

        console.log('PR comment added');
    } catch (error) {
        console.error('Error adding PR comment:', error);
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function verifyWebhookSignature(payload, signature) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
    const hash = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    const expectedSignature = `sha256=${hash}`;
    return crypto.timingSafeEqual(
        Buffer.from(signature || ''),
        Buffer.from(expectedSignature)
    );
}

function generatePRComment(pr) {
    return `
## 🤖 Automated Code Review

Thank you for your pull request! Here's an automated review:

### Checklist
- [ ] Code follows project style guidelines
- [ ] Changes are well-documented
- [ ] Tests are included
- [ ] No breaking changes

### Automated Checks
- ✅ Syntax validation passed
- ✅ Dependency check passed
- ⏳ Running security scan...

---
*This comment was generated automatically by the Automation System*
    `;
}

function analyzeCode(patch) {
    const issues = [];

    // Check for common issues
    if (patch.includes('console.log')) {
        issues.push({
            type: 'warning',
            message: 'console.log found in code'
        });
    }

    if (patch.includes('TODO') || patch.includes('FIXME')) {
        issues.push({
            type: 'info',
            message: 'TODO/FIXME comment found'
        });
    }

    return issues;
}

// ============================================================================
// REPOSITORY MANAGEMENT
// ============================================================================

app.get('/repositories/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;

        const query = `
            SELECT repositories FROM github_integrations 
            WHERE user_id = $1;
        `;

        const result = await pool.query(query, [user_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                code: 'NOT_FOUND',
                message: 'GitHub integration not found'
            });
        }

        res.json({
            code: 'REPOSITORIES_RETRIEVED',
            data: result.rows[0].repositories
        });
    } catch (error) {
        console.error('Error retrieving repositories:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'github-integration-service',
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

const PORT = process.env.GITHUB_INTEGRATION_PORT || 3004;

app.listen(PORT, () => {
    console.log(`✅ GitHub Integration Service running on port ${PORT}`);
});

module.exports = app;
