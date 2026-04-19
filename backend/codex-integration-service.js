/**
 * Codex Integration Service
 * 
 * Responsibilities:
 * - OpenAI Codex API integration
 * - Code generation from natural language
 * - Code completion
 * - Documentation generation
 * - Test generation
 * - Code review suggestions
 */

const express = require('express');
const axios = require('axios');
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
// CODEX API CLIENT
// ============================================================================

const codexClient = axios.create({
    baseURL: 'https://api.openai.com/v1',
    headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

// ============================================================================
// CODE GENERATION
// ============================================================================

app.post('/generate-code', async (req, res) => {
    try {
        const { description, language = 'javascript', context = '' } = req.body;

        if (!description) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'description is required'
            });
        }

        const prompt = `
Generate ${language} code for the following requirement:

${description}

${context ? `Context:\n${context}` : ''}

Code:
        `;

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens: 2000,
            temperature: 0.7,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const generatedCode = response.data.choices[0].text.trim();

        res.json({
            code: 'CODE_GENERATED',
            data: {
                language,
                code: generatedCode,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error generating code:', error);
        res.status(500).json({
            code: 'GENERATION_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// CODE COMPLETION
// ============================================================================

app.post('/complete-code', async (req, res) => {
    try {
        const { code, language = 'javascript' } = req.body;

        if (!code) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code is required'
            });
        }

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt: code,
            max_tokens: 1000,
            temperature: 0.5,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const completedCode = response.data.choices[0].text.trim();

        res.json({
            code: 'CODE_COMPLETED',
            data: {
                original: code,
                completed: code + completedCode,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error completing code:', error);
        res.status(500).json({
            code: 'COMPLETION_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// TEST GENERATION
// ============================================================================

app.post('/generate-tests', async (req, res) => {
    try {
        const { code, framework = 'jest', language = 'javascript' } = req.body;

        if (!code) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code is required'
            });
        }

        const prompt = `
Generate ${framework} tests for the following ${language} code:

\`\`\`${language}
${code}
\`\`\`

Generate comprehensive unit tests:
        `;

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens: 2000,
            temperature: 0.7,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const generatedTests = response.data.choices[0].text.trim();

        res.json({
            code: 'TESTS_GENERATED',
            data: {
                framework,
                language,
                tests: generatedTests,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error generating tests:', error);
        res.status(500).json({
            code: 'GENERATION_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// DOCUMENTATION GENERATION
// ============================================================================

app.post('/generate-documentation', async (req, res) => {
    try {
        const { code, language = 'javascript', style = 'jsdoc' } = req.body;

        if (!code) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code is required'
            });
        }

        const prompt = `
Generate ${style} documentation for the following ${language} code:

\`\`\`${language}
${code}
\`\`\`

Generate clear and comprehensive documentation:
        `;

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens: 1500,
            temperature: 0.5,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const documentation = response.data.choices[0].text.trim();

        res.json({
            code: 'DOCUMENTATION_GENERATED',
            data: {
                style,
                language,
                documentation,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error generating documentation:', error);
        res.status(500).json({
            code: 'GENERATION_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// CODE REVIEW
// ============================================================================

app.post('/review-code', async (req, res) => {
    try {
        const { code, language = 'javascript', focus = 'general' } = req.body;

        if (!code) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code is required'
            });
        }

        const focusAreas = {
            general: 'code quality, readability, and best practices',
            performance: 'performance optimization opportunities',
            security: 'security vulnerabilities and improvements',
            testing: 'test coverage and testing strategies'
        };

        const prompt = `
Review the following ${language} code focusing on ${focusAreas[focus] || focusAreas.general}:

\`\`\`${language}
${code}
\`\`\`

Provide specific, actionable feedback:
        `;

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens: 1500,
            temperature: 0.7,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const review = response.data.choices[0].text.trim();

        // Parse review into structured format
        const issues = parseReview(review);

        res.json({
            code: 'CODE_REVIEWED',
            data: {
                language,
                focus,
                review,
                issues,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error reviewing code:', error);
        res.status(500).json({
            code: 'REVIEW_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// REFACTORING SUGGESTIONS
// ============================================================================

app.post('/suggest-refactoring', async (req, res) => {
    try {
        const { code, language = 'javascript' } = req.body;

        if (!code) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'code is required'
            });
        }

        const prompt = `
Suggest refactoring improvements for the following ${language} code:

\`\`\`${language}
${code}
\`\`\`

Provide refactored code with explanations:
        `;

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens: 2000,
            temperature: 0.7,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const refactoredCode = response.data.choices[0].text.trim();

        res.json({
            code: 'REFACTORING_SUGGESTED',
            data: {
                language,
                original: code,
                refactored: refactoredCode,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error suggesting refactoring:', error);
        res.status(500).json({
            code: 'REFACTORING_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// QUERY CODEX WITH CUSTOM PROMPT
// ============================================================================

app.post('/query', async (req, res) => {
    try {
        const { prompt, max_tokens = 1000, temperature = 0.7 } = req.body;

        if (!prompt) {
            return res.status(400).json({
                code: 'VALIDATION_ERROR',
                message: 'prompt is required'
            });
        }

        const response = await codexClient.post('/completions', {
            model: 'text-davinci-003',
            prompt,
            max_tokens,
            temperature,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        });

        const result = response.data.choices[0].text.trim();

        res.json({
            code: 'QUERY_COMPLETED',
            data: {
                result,
                tokens_used: response.data.usage.total_tokens
            }
        });
    } catch (error) {
        console.error('Error querying Codex:', error);
        res.status(500).json({
            code: 'QUERY_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// USAGE TRACKING
// ============================================================================

app.get('/usage/:user_id', async (req, res) => {
    try {
        const { user_id } = req.params;
        const { start_date, end_date } = req.query;

        let query = `
            SELECT 
                COUNT(*) as total_requests,
                SUM(CAST(metadata->>'tokens_used' AS INTEGER)) as total_tokens,
                AVG(CAST(metadata->>'tokens_used' AS INTEGER)) as avg_tokens
            FROM events
            WHERE event_type = 'codex_usage' AND user_id = $1
        `;

        const params = [user_id];

        if (start_date) {
            query += ` AND created_at >= $${params.length + 1}`;
            params.push(new Date(start_date));
        }

        if (end_date) {
            query += ` AND created_at <= $${params.length + 1}`;
            params.push(new Date(end_date));
        }

        const result = await pool.query(query, params);

        res.json({
            code: 'USAGE_RETRIEVED',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error retrieving usage:', error);
        res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: error.message
        });
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function parseReview(review) {
    const issues = [];
    const lines = review.split('\n');

    for (const line of lines) {
        if (line.includes('Issue') || line.includes('Problem') || line.includes('Warning')) {
            issues.push({
                type: 'issue',
                message: line.trim()
            });
        } else if (line.includes('Suggestion') || line.includes('Improvement')) {
            issues.push({
                type: 'suggestion',
                message: line.trim()
            });
        }
    }

    return issues;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'codex-integration-service',
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

const PORT = process.env.CODEX_SERVICE_PORT || 3006;

app.listen(PORT, () => {
    console.log(`✅ Codex Integration Service running on port ${PORT}`);
});

module.exports = app;
