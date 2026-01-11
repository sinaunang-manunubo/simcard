require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const Database = require('./database');
const simsimiRoutes = require('./routes/simsimi');

class SimSimiServer {
    constructor() {
        this.app = express();
        this.db = new Database();
        this.port = process.env.PORT || 3000;
        this.initMiddlewares();
        this.initRoutes();
        this.initErrorHandling();
    }

    initMiddlewares() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'", "'unsafe-inline'"],
                },
            },
        }));
        
        // Compression middleware
        this.app.use(compression());
        
        // Logging
        this.app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
        
        // Body parsing
        this.app.use(express.json({ limit: process.env.MAX_REQUEST_SIZE || '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        // CORS configuration
        const corsOptions = {
            origin: process.env.CORS_ORIGIN || '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            credentials: true,
            maxAge: 86400 // 24 hours
        };
        this.app.use(cors(corsOptions));
        
        // Static files
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Preflight requests
        this.app.options('*', cors(corsOptions));
    }

    initRoutes() {
        // API routes
        this.app.use(`/api/${process.env.API_VERSION || 'v1'}`, simsimiRoutes);
        
        // Health check endpoint for Render.com
        this.app.get('/health', (req, res) => {
            res.status(200).json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                service: 'SimSimi API',
                version: '1.0.0',
                uptime: process.uptime()
            });
        });
        
        // Serve frontend
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
        
        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Route not found',
                path: req.originalUrl,
                timestamp: new Date().toISOString()
            });
        });
    }

    initErrorHandling() {
        // Global error handler
        this.app.use((err, req, res, next) => {
            console.error('Unhandled error:', err);
            
            const statusCode = err.status || 500;
            const message = process.env.NODE_ENV === 'production' 
                ? 'Internal server error' 
                : err.message;
            
            res.status(statusCode).json({
                error: message,
                timestamp: new Date().toISOString(),
                path: req.originalUrl,
                ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
            });
        });
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error);
            // Don't exit in production, let the process continue
            if (process.env.NODE_ENV === 'production') {
                // Log to external service
            }
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        });
    }

    async start() {
        try {
            // Initialize database
            await this.db.connect();
            console.log('✅ Database initialized successfully');
            
            // Start server
            const server = this.app.listen(this.port, () => {
                console.log(`
                🚀 SimSimi API Server Started!
                📍 Port: ${this.port}
                🌐 Environment: ${process.env.NODE_ENV || 'development'}
                📅 ${new Date().toISOString()}
                🏠 Local: http://localhost:${this.port}
                🔧 API: http://localhost:${this.port}/api/${process.env.API_VERSION || 'v1'}
                ❤️ Health: http://localhost:${this.port}/health
                `);
            });
            
            // Graceful shutdown
            const gracefulShutdown = () => {
                console.log('\n🛑 Received shutdown signal, closing server gracefully...');
                
                server.close(async () => {
                    console.log('✅ HTTP server closed');
                    
                    // Close database connection
                    if (this.db) {
                        await this.db.close();
                        console.log('✅ Database connection closed');
                    }
                    
                    console.log('👋 SimSimi API shutdown complete');
                    process.exit(0);
                });
                
                // Force shutdown after 10 seconds
                setTimeout(() => {
                    console.error('⏰ Could not close connections in time, forcing shutdown');
                    process.exit(1);
                }, 10000);
            };
            
            process.on('SIGTERM', gracefulShutdown);
            process.on('SIGINT', gracefulShutdown);
            
            return server;
        } catch (error) {
            console.error('❌ Failed to start server:', error);
            process.exit(1);
        }
    }
}

// Start server if this file is run directly
if (require.main === module) {
    const server = new SimSimiServer();
    server.start();
}

module.exports = SimSimiServer;