// index.ts (or your main file)
import dotenv from "dotenv";
import { startVibeCap } from "./agent";
import { dbService } from './services/database';

dotenv.config();

/**
 * Main function to run the application
 */
async function main() {
    try {
        console.log("Initializing database...");
        await dbService.initTables();

        console.log("Starting VibeCap Venture Analyst application...");

        // Start the VibeCap system (handles all Telegram interactions)
        const vibecap = await startVibeCap();

        console.log("VibeCap started successfully!");

        // Keep the process running
        process.on('SIGINT', () => {
            console.log('Shutting down...');
            vibecap.stop();
            process.exit(0);
        });

        // Log startup complete
        console.log("System ready and listening for Telegram messages");

    } catch (error) {
        console.error("Critical error in main function:", error);
        process.exit(1);
    }
}

// Start the application
main().catch(error => {
    console.error("Fatal error in application:", error);
    process.exit(1);
});