const express = require('express');
const router = express.Router();
const Database = require('../database');

// Initialize database
const db = new Database();
db.connect().catch(console.error);

// Rate limiting in-memory store (for simple implementation)
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests per minute
const RATE_LIMIT_WINDOW = 60000; // 1 minute

// Rate limiting middleware
const rateLimit = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    
    // Clean old entries
    if (requestCounts.has(ip)) {
        requestCounts.set(ip, requestCounts.get(ip).filter(time => time > windowStart));
    }
    
    const requests = requestCounts.get(ip) || [];
    
    if (requests.length >= RATE_LIMIT) {
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Please slow down!',
            retryAfter: Math.ceil((requests[0] + RATE_LIMIT_WINDOW - now) / 1000)
        });
    }
    
    requests.push(now);
    requestCounts.set(ip, requests);
    
    // Set rate limit headers
    res.set({
        'X-RateLimit-Limit': RATE_LIMIT,
        'X-RateLimit-Remaining': RATE_LIMIT - requests.length,
        'X-RateLimit-Reset': new Date(now + RATE_LIMIT_WINDOW).toISOString()
    });
    
    next();
};

// Apply rate limiting to all routes
router.use(rateLimit);

// Logging middleware
const logRequest = (req, res, next) => {
    req.startTime = Date.now();
    next();
};

// API Documentation at root
router.get('/', (req, res) => {
    res.json({
        message: '🤖 SimSimi API v1.0',
        description: 'A smart chatbot that learns from conversations',
        endpoints: {
            ask: {
                method: 'GET',
                path: '/ask',
                description: 'Ask SimSimi a question',
                parameters: {
                    q: 'The question to ask (required)'
                },
                example: '/ask?q=hello'
            },
            teach: {
                method: 'POST',
                path: '/teach',
                description: 'Teach SimSimi a new response',
                body: {
                    question: 'The question (required)',
                    answer: 'The answer (required)'
                }
            },
            stats: {
                method: 'GET',
                path: '/stats',
                description: 'Get API statistics'
            },
            search: {
                method: 'GET',
                path: '/search',
                description: 'Search responses',
                parameters: {
                    q: 'Search term (required)',
                    limit: 'Results per page (default: 10)',
                    page: 'Page number (default: 1)'
                }
            }
        },
        github: 'https://github.com/yourusername/simsimi-api',
        documentation: 'https://your-docs-url.com'
    });
});

// Ask endpoint
router.get('/ask', logRequest, async (req, res) => {
    try {
        const question = req.query.q;
        
        if (!question || question.trim() === '') {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Question parameter (q) is required',
                example: '/api/v1/ask?q=hello'
            });
        }
        
        const startTime = Date.now();
        const response = await db.findResponse(question);
        const responseTime = Date.now() - startTime;
        
        // Log the interaction
        await db.logInteraction(
            question,
            response ? response.answer : null,
            !!response,
            req.headers['user-agent'] || '',
            req.ip || '',
            responseTime
        );
        
        if (response) {
            res.json({
                status: 'success',
                question: question,
                response: response.answer,
                is_taught: true,
                teach_count: response.teach_count,
                response_time_ms: responseTime,
                timestamp: new Date().toISOString()
            });
        } else {
            // If no response found, provide a default
            const defaultResponses = [
                "I don't know how to respond to that yet. Can you teach me?",
                "Hmm, I'm not sure about that one. Want to teach me the answer?",
                "That's a new one for me! What should I say to that?",
                "I'm still learning! Could you teach me how to respond to that?",
                "I don't have an answer for that. Would you like to teach me?"
            ];
            
            const randomResponse = defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
            
            res.json({
                status: 'success',
                question: question,
                response: randomResponse,
                is_taught: false,
                needs_teaching: true,
                response_time_ms: responseTime,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error in /ask:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Something went wrong while processing your request',
            timestamp: new Date().toISOString()
        });
    }
});

// Teach endpoint
router.post('/teach', logRequest, async (req, res) => {
    try {
        const { question, answer } = req.body;
        
        if (!question || !answer) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Both question and answer are required',
                example: { question: 'hello', answer: 'Hello there!' }
            });
        }
        
        if (question.length > 500 || answer.length > 1000) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Question or answer too long. Max 500 chars for question, 1000 for answer'
            });
        }
        
        const startTime = Date.now();
        const result = await db.upsertResponse(question, answer);
        const responseTime = Date.now() - startTime;
        
        // Log the teaching
        await db.logInteraction(
            question,
            answer,
            true,
            req.headers['user-agent'] || '',
            req.ip || '',
            responseTime
        );
        
        res.status(201).json({
            status: 'success',
            message: 'Successfully taught SimSimi!',
            data: {
                id: result.id,
                question: result.question,
                answer: result.answer,
                teach_count: result.teach_count,
                created_at: result.created_at,
                updated_at: result.updated_at
            },
            response_time_ms: responseTime,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /teach:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to save the response',
            timestamp: new Date().toISOString()
        });
    }
});

// Stats endpoint
router.get('/stats', async (req, res) => {
    try {
        const stats = await db.getStats();
        
        res.json({
            status: 'success',
            data: {
                total_responses: stats.total_responses || 0,
                total_interactions: stats.total_interactions || 0,
                taught_responses: stats.taught_responses || 0,
                last_taught: stats.last_taught,
                avg_response_time_ms: Math.round(stats.avg_response_time || 0),
                uptime: process.uptime(),
                memory_usage: process.memoryUsage()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /stats:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to retrieve statistics',
            timestamp: new Date().toISOString()
        });
    }
});

// Search endpoint
router.get('/search', async (req, res) => {
    try {
        const searchTerm = req.query.q;
        const limit = parseInt(req.query.limit) || 10;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;
        
        if (!searchTerm || searchTerm.trim() === '') {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Search term (q) is required',
                example: '/api/v1/search?q=hello'
            });
        }
        
        const results = await db.searchResponses(searchTerm, limit, offset);
        
        res.json({
            status: 'success',
            data: {
                results: results,
                pagination: {
                    page: page,
                    limit: limit,
                    total_results: results.length,
                    has_more: results.length === limit
                },
                search_term: searchTerm
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /search:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'Failed to search responses',
            timestamp: new Date().toISOString()
        });
    }
});

// Health check endpoint
router.get('/health', async (req, res) => {
    try {
        const dbHealth = await db.healthCheck();
        
        res.json({
            status: dbHealth.healthy ? 'healthy' : 'degraded',
            service: 'SimSimi API',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            database: dbHealth.healthy ? 'connected' : 'disconnected',
            uptime: process.uptime(),
            memory: process.memoryUsage()
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            service: 'SimSimi API',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;