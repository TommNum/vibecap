import { GameAgent, LLMModel } from "@virtuals-protocol/game";
import { ventureAnalystWorker, closingWorker } from "./worker";
import dotenv from "dotenv";
import TelegramPlugin from "./telegramPlugin";

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

export const activity_agent = new GameAgent(process.env.API_KEY, {
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
    - Log all errors for debugging`,
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
        }),
        ventureAnalystWorker,
        closingWorker
    ],
    llmModel: "Qwen2.5-72B-Instruct",
    getAgentState
});

// Enhanced logger with timestamps and error highlighting
activity_agent.setLogger((agent: GameAgent, msg: string) => {
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