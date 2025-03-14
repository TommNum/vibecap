import { activity_agent, telegramPlugin } from './agent';

// Track active conversations
const activeChats = new Map();

async function main() {
    try {
        console.log("Starting VibeCap Venture Analyst Bot...");
        
        // Initialize the agent
        await activity_agent.init();
        console.log("Agent initialized successfully");
        
        // ONLY ONE message handler to prevent duplicates
        telegramPlugin.onMessage(async (msg) => {
            try {
                // Skip messages without text
                if (!msg.text) return;
                
                const chatId = msg.chat.id.toString();
                console.log(`Received message from chat ID ${chatId}: "${msg.text}"`);
                
                // Track message in active chats
                if (!activeChats.has(chatId)) {
                    activeChats.set(chatId, {
                        lastMessageTime: Date.now(),
                        messageCount: 0
                    });
                }
                
                const chatState = activeChats.get(chatId);
                chatState.messageCount++;
                chatState.lastMessageTime = Date.now();
                
                // Get telegram worker
                const agentTgWorker = activity_agent.getWorkerById(telegramPlugin.getWorker().id);
                if (!agentTgWorker) {
                    console.error("Worker not found");
                    return;
                }
                
                // Create task with limited context (don't send full message content to avoid duplicating in logs)
                const task = `Process message from chat ${chatId} (${msg.from?.username || 'unknown'})`;
                
                // Add 10-second delay to respect rate limits
                console.log(`Waiting 10 seconds before processing message...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                // Process the message
                await agentTgWorker.runTask(task, {
                    verbose: true
                });
                
            } catch (error) {
                console.error("Error processing message:", error);
            }
        });
        
        // Handle poll answers if needed
        telegramPlugin.onPollAnswer((pollAnswer) => {
            console.log('Poll answer received:', pollAnswer);
        });
        
        console.log("Bot is running and ready to receive messages...");
        
        // Run the agent with error handling
        while (true) {
            try {
                await activity_agent.step({ verbose: true });
                // Add delay between steps to prevent hitting rate limits
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error("Error in agent step:", error);
                // Add longer delay after error
                await new Promise(resolve => setTimeout(resolve, 15000));
            }
        }
    } catch (error) {
        console.error("Critical error in main function:", error);
        // Try to restart the application after 30 seconds
        setTimeout(() => {
            console.log("Attempting to restart application...");
            main();
        }, 30000);
    }
}

// Start with error handling
main().catch(error => {
    console.error("Unhandled error:", error);
    process.exit(1);
}); 