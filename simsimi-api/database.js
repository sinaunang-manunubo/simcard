const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
    constructor() {
        // Use Render's persistent disk if available, otherwise local
        const dbDir = process.env.NODE_ENV === 'production' 
            ? '/data' 
            : path.join(__dirname, 'database');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        this.dbPath = path.join(dbDir, 'simsimi.db');
        this.db = null;
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = 3;
    }

    async connect() {
        try {
            return await this._connectWithRetry();
        } catch (error) {
            console.error('❌ Failed to connect to database after retries:', error);
            throw error;
        }
    }

    async _connectWithRetry() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => {
                if (err) {
                    this.retryCount++;
                    if (this.retryCount < this.maxRetries) {
                        console.log(`⚠️ Retrying database connection (${this.retryCount}/${this.maxRetries})...`);
                        await new Promise(resolve => setTimeout(resolve, 1000 * this.retryCount));
                        return this._connectWithRetry().then(resolve).catch(reject);
                    } else {
                        reject(err);
                    }
                } else {
                    console.log('✅ Connected to SQLite database:', this.dbPath);
                    this.isConnected = true;
                    
                    // Enable WAL mode for better concurrency
                    this.db.run('PRAGMA journal_mode = WAL;');
                    this.db.run('PRAGMA synchronous = NORMAL;');
                    this.db.run('PRAGMA foreign_keys = ON;');
                    this.db.run('PRAGMA busy_timeout = 5000;');
                    
                    try {
                        await this.initializeTables();
                        await this.seedDefaultData();
                        resolve();
                    } catch (initError) {
                        reject(initError);
                    }
                }
            });
        });
    }

    initializeTables() {
        return new Promise((resolve, reject) => {
            const createTables = `
                -- Enable case-insensitive search
                PRAGMA case_sensitive_like = OFF;

                -- Conversations table with full-text search capabilities
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL COLLATE NOCASE,
                    answer TEXT NOT NULL,
                    normalized_question TEXT GENERATED ALWAYS AS (LOWER(TRIM(question))) VIRTUAL,
                    teach_count INTEGER DEFAULT 1,
                    is_active BOOLEAN DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(normalized_question)
                );

                -- Create index for faster searches
                CREATE INDEX IF NOT EXISTS idx_conversations_normalized 
                ON conversations(normalized_question);

                CREATE INDEX IF NOT EXISTS idx_conversations_active 
                ON conversations(is_active);

                -- Conversation logs for analytics
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL,
                    normalized_question TEXT GENERATED ALWAYS AS (LOWER(TRIM(question))) VIRTUAL,
                    response TEXT,
                    is_taught BOOLEAN DEFAULT 0,
                    response_time_ms INTEGER,
                    user_agent TEXT,
                    ip_address TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                -- Create index for logs
                CREATE INDEX IF NOT EXISTS idx_logs_timestamp 
                ON logs(timestamp);

                CREATE INDEX IF NOT EXISTS idx_logs_taught 
                ON logs(is_taught);

                -- Triggers to update timestamps
                CREATE TRIGGER IF NOT EXISTS update_conversations_timestamp 
                AFTER UPDATE ON conversations
                BEGIN
                    UPDATE conversations 
                    SET updated_at = CURRENT_TIMESTAMP 
                    WHERE id = NEW.id;
                END;
            `;

            this.db.exec(createTables, (err) => {
                if (err) {
                    console.error('❌ Error creating tables:', err);
                    reject(err);
                } else {
                    console.log('✅ Database tables initialized');
                    resolve();
                }
            });
        });
    }

    async seedDefaultData() {
        const defaultResponses = [
            { question: 'hello', answer: 'Hello! How are you today?' },
            { question: 'hi', answer: 'Hi there! Nice to meet you!' },
            { question: 'how are you', answer: 'I\'m doing great! Thanks for asking!' },
            { question: 'what is your name', answer: 'I\'m SimSimi, your friendly chatbot!' },
            { question: 'bye', answer: 'Goodbye! See you again soon!' },
            { question: 'thank you', answer: 'You\'re welcome! 😊' },
            { question: 'good morning', answer: 'Good morning! Have a wonderful day!' },
            { question: 'good night', answer: 'Good night! Sweet dreams! 🌙' }
        ];

        try {
            for (const response of defaultResponses) {
                await this.upsertResponse(response.question, response.answer);
            }
            console.log('✅ Default responses seeded');
        } catch (error) {
            console.log('⚠️ Could not seed default data:', error.message);
        }
    }

    async findResponse(question) {
        return new Promise((resolve, reject) => {
            const normalizedQuestion = question.toLowerCase().trim();
            
            const query = `
                SELECT * FROM conversations 
                WHERE normalized_question = ? 
                AND is_active = 1
                LIMIT 1
            `;
            
            this.db.get(query, [normalizedQuestion], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async upsertResponse(question, answer) {
        return new Promise((resolve, reject) => {
            const normalizedQuestion = question.toLowerCase().trim();
            
            const query = `
                INSERT INTO conversations (question, answer, normalized_question)
                VALUES (?, ?, ?)
                ON CONFLICT(normalized_question) 
                DO UPDATE SET 
                    answer = excluded.answer,
                    teach_count = teach_count + 1,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            `;
            
            this.db.get(query, [question, answer, normalizedQuestion], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async logInteraction(question, response, isTaught = false, userAgent = '', ipAddress = '', responseTime = 0) {
        return new Promise((resolve, reject) => {
            const query = `
                INSERT INTO logs (question, response, is_taught, response_time_ms, user_agent, ip_address)
                VALUES (?, ?, ?, ?, ?, ?)
            `;
            
            this.db.run(query, [question, response, isTaught ? 1 : 0, responseTime, userAgent, ipAddress], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getStats() {
        return new Promise((resolve, reject) => {
            const query = `
                SELECT 
                    (SELECT COUNT(*) FROM conversations) as total_responses,
                    (SELECT COUNT(*) FROM logs) as total_interactions,
                    (SELECT COUNT(*) FROM logs WHERE is_taught = 1) as taught_responses,
                    (SELECT MAX(created_at) FROM conversations) as last_taught,
                    (SELECT AVG(response_time_ms) FROM logs WHERE response_time_ms > 0) as avg_response_time
            `;
            
            this.db.get(query, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    async searchResponses(searchTerm, limit = 10, offset = 0) {
        return new Promise((resolve, reject) => {
            const normalizedSearch = `%${searchTerm.toLowerCase().trim()}%`;
            
            const query = `
                SELECT * FROM conversations 
                WHERE normalized_question LIKE ? 
                OR answer LIKE ?
                AND is_active = 1
                ORDER BY teach_count DESC
                LIMIT ? OFFSET ?
            `;
            
            this.db.all(query, [normalizedSearch, normalizedSearch, limit, offset], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async close() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        this.isConnected = false;
                        console.log('✅ Database connection closed');
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }

    // Health check
    async healthCheck() {
        return new Promise((resolve) => {
            if (!this.db || !this.isConnected) {
                resolve({ healthy: false, error: 'Not connected' });
                return;
            }
            
            this.db.get('SELECT 1 as test', (err) => {
                if (err) {
                    resolve({ healthy: false, error: err.message });
                } else {
                    resolve({ healthy: true });
                }
            });
        });
    }
}

module.exports = Database;