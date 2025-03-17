import { Pool } from 'pg';

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.POSTGRES_PASSWORD,
    port: parseInt(process.env.PGPORT || '5432'),
});

export interface Conversation {
    app_id: string;
    user_id: string;
    telegram_id?: string;
    startup_name: string;
    startup_pitch: string;
    startup_links: string[];
    conversation_history: Array<{
        role: string;
        content: string;
        timestamp: number;
    }>;
    scores: {
        market: number;
        product: number;
        traction: number;
        financials: number;
        team: number;
    };
    status: string;
    created_at: Date;
    updated_at: Date;
}

export const dbService = {
    async initTables() {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        app_id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        telegram_id VARCHAR(255), 
        startup_name TEXT,
        startup_pitch TEXT,
        startup_links TEXT[],
        conversation_history JSONB,
        scores JSONB,
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        
        // Ensure we run the migration to add telegram_id if needed
        await this.migrateAddTelegramId();
    },
    
    // Migration to add telegram_id column if it doesn't exist
    async migrateAddTelegramId() {
        try {
            // Check if the telegram_id column exists
            const columnCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'conversations' 
                AND column_name = 'telegram_id';
            `);
            
            // If column doesn't exist, add it
            if (columnCheck.rows.length === 0) {
                console.log('Adding telegram_id column to conversations table...');
                await pool.query(`
                    ALTER TABLE conversations 
                    ADD COLUMN telegram_id VARCHAR(255);
                `);
                
                // Populate the new column with user_id as a default
                console.log('Populating telegram_id with existing user_id values...');
                await pool.query(`
                    UPDATE conversations 
                    SET telegram_id = user_id 
                    WHERE telegram_id IS NULL;
                `);
                
                console.log('telegram_id column added and populated successfully');
            } else {
                console.log('telegram_id column already exists in conversations table');
            }
        } catch (error) {
            console.error('Error in telegram_id migration:', error);
        }
    },

    async saveConversation(conversation: Conversation): Promise<void> {
        const query = `
      INSERT INTO conversations (
        app_id, user_id, telegram_id, startup_name, startup_pitch, startup_links,
        conversation_history, scores, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (app_id) DO UPDATE SET
        startup_name = EXCLUDED.startup_name,
        startup_pitch = EXCLUDED.startup_pitch,
        startup_links = EXCLUDED.startup_links,
        conversation_history = EXCLUDED.conversation_history,
        scores = EXCLUDED.scores,
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP;
    `;

        await pool.query(query, [
            conversation.app_id,
            conversation.user_id,
            conversation.telegram_id || conversation.user_id,
            conversation.startup_name,
            conversation.startup_pitch,
            conversation.startup_links,
            JSON.stringify(conversation.conversation_history),
            JSON.stringify(conversation.scores),
            conversation.status
        ]);
    },

    async getConversation(appId: string): Promise<Conversation | null> {
        const result = await pool.query(
            'SELECT * FROM conversations WHERE app_id = $1',
            [appId]
        );
        return result.rows[0] || null;
    }
}; 