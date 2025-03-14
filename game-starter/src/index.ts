import dotenv from "dotenv";
import { handleRateLimitError, signalApiSuccess, telegramPlugin, initializeAgent } from "./agent";
import { Message } from "node-telegram-bot-api";

dotenv.config();

// Map to track active chats
const activeChats = new Map<number, { count: number, lastTimestamp: number, isProcessing: boolean }>();

// Flag to indicate if any message is currently being processed
let isProcessingAnyMessage = false;

// Define the interface for poll answers
interface PollAnswer {
  poll_id: string;
  user: {
    id: number;
  };
  option_ids: number[];
}

// Global environment object to pass message context to the agent
const messageContext: Record<string, any> = {};

// Function to get a consistent environment for workers
const getSharedEnvironment = async () => {
  // Instead of creating a new object, return a direct reference to the messageContext
  // This ensures any updates to messageContext are immediately available to workers
  return messageContext;
};

/**
 * Main function to run the agent
 */
async function main() {
  try {
    // Initialize the agent with our shared environment getter
    console.log("Starting agent...");
    const activity_agent = initializeAgent();
    await activity_agent.init();
    console.log("Agent started successfully!");

    // Register a single message handler for the telegramPlugin
    telegramPlugin.onMessage(async (message: Message) => {
      try {
        // Skip messages without text
        if (!message.text) {
          return;
        }

        const chatId = message.chat.id;
        console.log(`Received message from chat ${chatId}: ${message.text.substring(0, 20)}...`);
        
        // Initialize chat tracking if doesn't exist
        if (!activeChats.has(chatId)) {
          activeChats.set(chatId, { count: 0, lastTimestamp: Date.now(), isProcessing: false });
        }

        const chatData = activeChats.get(chatId)!;
        
        // Check if we're already processing a message from this chat
        if (chatData.isProcessing) {
          console.log(`Already processing a message for chat ${chatId}, skipping this one`);
          return;
        }
        
        // Check if any message is being processed at all (globally)
        if (isProcessingAnyMessage) {
          console.log(`Another message is being processed, skipping this one for chat ${chatId}`);
          return;
        }

        // Set processing flags
        chatData.isProcessing = true;
        isProcessingAnyMessage = true;
        
        // Increment message count for this chat
        chatData.count += 1;
        chatData.lastTimestamp = Date.now();

        try {
          console.log(`Processing message #${chatData.count} for chat ${chatId}`);
          
          // IMPORTANT: Clear previous context data to avoid stale information
          Object.keys(messageContext).forEach(key => delete messageContext[key]);
          
          // Update the message context for the agent - always set both chatId and chat_id formats
          messageContext.currentMessage = message;
          messageContext.chatId = chatId.toString();
          messageContext.chat_id = chatId.toString(); // Set chat_id directly
          messageContext.username = message.from?.username || 'unknown';
          messageContext.messageText = message.text;
          messageContext.messageType = 'text';
          
          // Debug log to confirm environment context  
          console.log(`Updated message context with chat_id: ${messageContext.chat_id}`);
          
          // Run the agent step to process this message
          await activity_agent.step({ verbose: true });
          
          // Signal API success after successful processing
          signalApiSuccess();
          
        } catch (apiError: unknown) {
          console.error("Error processing message:", apiError);
          
          // Check for rate limiting error
          if (apiError instanceof Error && 
              (apiError.message.includes("429") || 
               apiError.message.includes("rate limit") || 
               apiError.message.includes("too many requests"))) {
            handleRateLimitError();
          }
          
          // Wait after an error to prevent rapid retries
          await new Promise(resolve => setTimeout(resolve, 15000));
        } finally {
          // Clear processing flags
          chatData.isProcessing = false;
          isProcessingAnyMessage = false;
        }
      } catch (error: unknown) {
        console.error("Error in message handler:", error);
        // Clear processing flags in case of error
        isProcessingAnyMessage = false;
        if (message?.chat?.id) {
          const chatData = activeChats.get(message.chat.id);
          if (chatData) {
            chatData.isProcessing = false;
          }
        }
      }
    });

    // Register poll answer handler
    telegramPlugin.onPollAnswer(async (pollAnswer: PollAnswer) => {
      try {
        console.log(`Received poll answer from user ${pollAnswer.user.id}`);
        const optionIds = pollAnswer.option_ids.map(String);
        
        // Clear previous context data
        Object.keys(messageContext).forEach(key => delete messageContext[key]);
        
        // Update the message context for the agent
        messageContext.pollAnswer = pollAnswer;
        messageContext.userId = pollAnswer.user.id.toString();
        messageContext.selectedOptions = optionIds.join(", ");
        messageContext.messageType = 'poll_answer';
        // Set chat_id based on the user ID for poll answers
        messageContext.chat_id = pollAnswer.user.id.toString(); 
        
        // Run the agent step to process this poll answer
        await activity_agent.step({ verbose: true });
        
        // Signal success
        signalApiSuccess();
      } catch (error: unknown) {
        console.error("Error processing poll answer:", error);
        
        // Check for rate limiting error
        if (error instanceof Error && 
            (error.message.includes("429") || 
             error.message.includes("rate limit") || 
             error.message.includes("too many requests"))) {
          handleRateLimitError();
        }
      }
    });

    // Run the agent loop with rate limiting
    console.log("Bot is running, press Ctrl+C to stop");
    
    // Keep the process running with a continuous loop for agent steps
    while (true) {
      try {
        await activity_agent.step({ verbose: true });
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds between steps
      } catch (error: unknown) {
        console.error("Error in agent step:", error);
        
        // Check for rate limiting error
        if (error instanceof Error && 
            (error.message.includes("429") || 
             error.message.includes("rate limit") || 
             error.message.includes("too many requests"))) {
          handleRateLimitError();
        }
        
        // Wait after an error to prevent rapid retries
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }
  } catch (error: unknown) {
    console.error("Critical error in main function:", error);
    
    // Wait before attempting to restart
    const restartDelay = 30000; // 30 seconds
    console.log(`Waiting ${restartDelay/1000} seconds before attempting restart...`);
    await new Promise(resolve => setTimeout(resolve, restartDelay));
    
    // Attempt to restart
    console.log("Attempting to restart the bot...");
    main();
  }
}

// Start the agent
main(); 