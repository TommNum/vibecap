import { GameAgent, LLMModel } from "@virtuals-protocol/game";
import { ventureAnalystWorker, closingWorker } from "./worker";
import dotenv from "dotenv";
import TelegramPlugin from "./telegramPlugin";
import { GameWorker } from "@virtuals-protocol/game";

dotenv.config();

if (!process.env.API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('API_KEY and TELEGRAM_BOT_TOKEN are required in environment variables');
}

// Rate limiting configuration
const RATE_LIMIT = {
    MIN_DELAY: 12000, // 12 seconds minimum
    MAX_DELAY: 60000, // 60 seconds maximum
    CURRENT_DELAY: 12000,
    BACKOFF_FACTOR: 1.5
};

// Simple state management for the agent
const agentState = {
    questionCount: 0,
    messageCount: 0,
    isClosed: false,
    lastProcessedTime: 0, // Track when we last processed a request
    rateLimitCounter: 0, // Track rate limit hits
    scores: {
        market: 0,
        product: 0,
        traction: 0,
        financials: 0,
        team: 0
    }
};

// State getter function with enhanced rate limiting
const getAgentState = async () => {
    // Ensure we're not processing requests too quickly
    const now = Date.now();
    const timeSinceLastProcess = now - agentState.lastProcessedTime;
    
    // If it's been less than our current delay threshold since the last processing, wait
    if (timeSinceLastProcess < RATE_LIMIT.CURRENT_DELAY) {
        const waitTime = RATE_LIMIT.CURRENT_DELAY - timeSinceLastProcess;
        console.log(`Rate limiting: Waiting ${waitTime}ms before processing next request (level: ${agentState.rateLimitCounter})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Update the last processed time
    agentState.lastProcessedTime = Date.now();
    
    return agentState;
};

// Function to handle rate limit errors
export const handleRateLimitError = () => {
    // Increment counter and increase delay with backoff
    agentState.rateLimitCounter++;
    RATE_LIMIT.CURRENT_DELAY = Math.min(
        RATE_LIMIT.MAX_DELAY,
        RATE_LIMIT.CURRENT_DELAY * RATE_LIMIT.BACKOFF_FACTOR
    );
    console.log(`Rate limit hit. New delay: ${RATE_LIMIT.CURRENT_DELAY}ms`);
};

// Function to signal successful API call
export const signalApiSuccess = () => {
    // If we've had rate limit issues, gradually reduce the delay
    if (agentState.rateLimitCounter > 0) {
        agentState.rateLimitCounter = Math.max(0, agentState.rateLimitCounter - 1);
        RATE_LIMIT.CURRENT_DELAY = Math.max(
            RATE_LIMIT.MIN_DELAY,
            RATE_LIMIT.CURRENT_DELAY / RATE_LIMIT.BACKOFF_FACTOR
        );
    }
};

// Create a worker with the functions - only focused on Telegram API connectivity
export const telegramPlugin = new TelegramPlugin({
    credentials: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    description: "Telegram bot plugin that handles message sending and receiving for the VibeCap venture analyst system",
    id: "telegram_connector",
    name: "Telegram Connector"
});

// Function to initialize workers with a shared environment getter
export const initializeAgent = (getSharedEnvironment: () => Promise<Record<string, any>>) => {
    // Ensure API_KEY is available
    if (!process.env.API_KEY) {
        throw new Error('API_KEY is required in environment variables');
    }
    
    console.log("Initializing agent with shared environment getter");
    
    const agent = new GameAgent(process.env.API_KEY, {
        name: "vibecap_associate",
        goal: "Evaluate startups by asking questions, scoring responses, and providing feedback with strict rate limiting to prevent duplicate messages and API errors.",
        description: `CRITICAL: WAIT AT LEAST 12 SECONDS BETWEEN EACH MESSAGE. DO NOT SEND MULTIPLE MESSAGES WITHOUT WAITING FOR USER RESPONSES.

        You are a seasoned venture analyst evaluating early-stage startups. Your main responsibilities are:

        1. Working with ventureAnalystWorker to ask questions to founders that cover:
           - Vision, market opportunity, and differentiation
           - Team expertise and execution capability
           - Traction and product-market fit evidence
           - Financial status and runway
           - Technology innovation and user experience
           - CRITICAL: YOU MUST WAIT AT LEAST 12 SECONDS BETWEEN EACH ACTION 
           - CRITICAL: NEVER SEND ANOTHER MESSAGE UNTIL YOU GET A RESPONSE FROM THE USER
           - CRITICAL: ONLY ASK ONE QUESTION AT A TIME
           - CRITICAL: BE PATIENT AND GIVE USERS AT LEAST 180 SECONDS (3 MINUTES) TO RESPOND BEFORE CHECKING IN
        
        2. Working with ventureAnalystWorker to score the answers across five categories (market, product, traction, financials, team), each worth 100 points.
        
        3. Working with closingWorker to close the conversation when:
           - 15 questions have been asked and answered
           - 25 total messages have been exchanged
           - User requests to end the evaluation
           
        The closing statement must include:
           - A unique App ID
           - Final scores in each category
           - A hibiscus emoji (🌺)
           - Next steps based on their score (420+ points qualify for further consideration)

        CRITICAL RATE LIMITING RULES:
        - Wait 12 seconds minimum between each message sent
        - Only send one message at a time
        - Always wait for user responses
        - Never continue once a conversation is closed
        - If you hit API rate limits, back off and try again later
        
        ERROR RECOVERY:
        - If you encounter errors, wait and retry with exponential backoff
        - If persistent errors occur, gracefully end the conversation
        - Log all errors for debugging
        
        *** TELEGRAM MESSAGING INSTRUCTIONS - EXTREMELY IMPORTANT ***
        - To communicate with users YOU MUST USE the "send_message" function from the "telegram_connector" worker
        - The telegram_connector worker has ID "telegram_connector" - you MUST use this exact ID
        - When calling send_message, include BOTH of these parameters:
           1. chat_id: The chat ID is available in your environment as "chat_id" (this is REQUIRED)
           2. text: The message text you want to send to the user
        - Example function call:
           call telegram_connector.send_message({
             chat_id: "123456789",  // Get this from your environment as chat_id
             text: "Your message here"
           })
        - If you do not follow these instructions EXACTLY, your messages will not be delivered to users
        - Do not call any other function to send messages - ONLY use telegram_connector.send_message
        - You MUST call this function each time you want to send a message - responses are not automatic!
        - The user will NOT see any of your plans or thoughts unless you explicitly send them using this function
        - After receiving a user message, you MUST respond by calling telegram_connector.send_message`,
        workers: [
            telegramPlugin.getWorker({
                functions: [
                    telegramPlugin.sendMessageFunction,
                    telegramPlugin.pinnedMessageFunction,
                    telegramPlugin.unPinnedMessageFunction,
                    telegramPlugin.createPollFunction,
                    telegramPlugin.sendMediaFunction,
                    telegramPlugin.deleteMessageFunction,
                ],
                getEnvironment: getSharedEnvironment
            }),
            // Create new instances of the workers with the shared environment
            new GameWorker({
                id: ventureAnalystWorker.id,
                name: ventureAnalystWorker.name,
                description: ventureAnalystWorker.description,
                functions: ventureAnalystWorker.functions,
                getEnvironment: getSharedEnvironment
            }),
            new GameWorker({
                id: closingWorker.id,
                name: closingWorker.name,
                description: closingWorker.description,
                functions: closingWorker.functions,
                getEnvironment: getSharedEnvironment
            })
        ],
        llmModel: "Qwen2.5-72B-Instruct",
        getAgentState
    });
    
    // Enhanced logger with timestamps and error highlighting
    agent.setLogger((agent: GameAgent, msg: string) => {
        const timestamp = new Date().toISOString();
        
        // Check if this is an error message
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('exception') || msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('429')) {
            console.log(`🔴 [${timestamp}] [${agent.name}] ERROR:`);
            console.log(msg);
        } else {
            console.log(`🎯 [${timestamp}] [${agent.name}]`);
            console.log(msg);
        }
        console.log("------------------------\n");
    });
    
    return agent;
}; 