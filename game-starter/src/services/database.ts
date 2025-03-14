import { Pool } from 'pg';

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.DATABASE_URL,
    password: process.env.POSTGRES_PASSWORD,
    port: parseInt(process.env.PGPORT || '5432'),
});

export interface Conversation {
    app_id: string;
    user_id: string;
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
    },

    async saveConversation(conversation: Conversation): Promise<void> {
        const query = `
      INSERT INTO conversations (
        app_id, user_id, startup_name, startup_pitch, startup_links,
        conversation_history, scores, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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