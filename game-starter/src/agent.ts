import {
    GameAgent,
    LLMModel,
    GameWorker,
    GameFunction,
    ExecutableGameFunctionResponse,
    ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";
import { ChatAgent } from './chatAgent';
import { Function, FunctionResultStatus } from './types';
import dotenv from "dotenv";
import TelegramPlugin from "./telegramPlugin";
import axios from "axios";
import { dbService } from './services/database';

dotenv.config();

if (!process.env.API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('API_KEY and TELEGRAM_BOT_TOKEN are required in environment variables');
}

// =========================================================================
// GLOBAL SINGLETON OBJECTS 
// =========================================================================

// Create a single agent instance that will be reused
let agentInstance: GameAgent | null = null;

// Keep track of recent messages to prevent duplicates
const recentMessages = new Map<string, {
    messageId: string;
    timestamp: number;
    content: string;
}>();

// Rate limiting configuration
const RATE_LIMIT = {
    MIN_DELAY: 10000, // 10 seconds minimum between actions
    MAX_DELAY: 60000, // 60 seconds maximum
    CURRENT_DELAY: 10000,
    BACKOFF_FACTOR: 1.5,
    inProgress: false  // Flag to prevent concurrent processing
};

// =========================================================================
// STATE MANAGEMENT
// =========================================================================

// Comprehensive state management for the agent
const agentState = {
    // Processing state
    lastProcessedTime: 0,
    rateLimitCounter: 0,

    // Chat tracking
    activeChats: {} as Record<string, {
        appId: string;
        userId: string;
        telegramId: string;
        telegramUsername: string;
        startupName: string;
        startupPitch: string;
        startupLinks: string[];
        conversationStage: string;
        lastActivity: number;
        nudgeCount: number;
        questionCount: number;
        messageCount: number;
        lastQuestionTimestamp: number;  // Track when last question was sent
        lastUserMessageTimestamp: number; // Track when last user message was received
        pendingResponse: boolean;  // Flag to indicate we're waiting for user
        conversationHistory: Array<{ role: string; content: string; timestamp: number }>;
        isClosed: boolean;
        scores: {
            market: number;
            product: number;
            traction: number;
            financials: number;
            team: number;
        };
        lastMessage: string;  // Store the last message sent to prevent duplicates
    }>,
    processingQueue: [] as string[], // Queue for chat IDs that need processing

    // Global counters
    totalEvaluations: 0,
    totalQualifiedStartups: 0
};

// Initialize chat data structure
const initChatData = (chatId: string, userId: string, username?: string) => {
    if (!agentState.activeChats[chatId]) {
        const appId = `VC-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
        agentState.activeChats[chatId] = {
            appId,
            userId,
            telegramId: userId,
            telegramUsername: username || "",
            startupName: '',
            startupPitch: '',
            startupLinks: [],
            conversationStage: 'welcome', // Initial stage
            lastActivity: Date.now(),
            nudgeCount: 0,
            questionCount: 0,
            messageCount: 0,
            lastQuestionTimestamp: 0,
            lastUserMessageTimestamp: Date.now(),
            pendingResponse: false,
            conversationHistory: [],
            isClosed: false,
            lastMessage: '',
            scores: {
                market: 0,
                product: 0,
                traction: 0,
                financials: 0,
                team: 0
            }
        };
    }
    return agentState.activeChats[chatId];
};

// State getter function with enhanced rate limiting
const getAgentState = async () => {
    // Ensure we're not processing requests too quickly
    const now = Date.now();
    const timeSinceLastProcess = now - agentState.lastProcessedTime;

    // Rate limiting
    if (timeSinceLastProcess < RATE_LIMIT.CURRENT_DELAY) {
        const waitTime = RATE_LIMIT.CURRENT_DELAY - timeSinceLastProcess;
        console.log(`Rate limiting: Waiting ${waitTime}ms before processing next request (level: ${agentState.rateLimitCounter})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Update the last processed time
    agentState.lastProcessedTime = Date.now();

    return agentState;
};

// Functions to handle rate limiting
export const handleRateLimitError = () => {
    agentState.rateLimitCounter++;
    RATE_LIMIT.CURRENT_DELAY = Math.min(
        RATE_LIMIT.MAX_DELAY,
        RATE_LIMIT.CURRENT_DELAY * RATE_LIMIT.BACKOFF_FACTOR
    );
    console.log(`Rate limit hit. New delay: ${RATE_LIMIT.CURRENT_DELAY}ms`);
};

export const signalApiSuccess = () => {
    if (agentState.rateLimitCounter > 0) {
        agentState.rateLimitCounter = Math.max(0, agentState.rateLimitCounter - 1);
        RATE_LIMIT.CURRENT_DELAY = Math.max(
            RATE_LIMIT.MIN_DELAY,
            RATE_LIMIT.CURRENT_DELAY / RATE_LIMIT.BACKOFF_FACTOR
        );
    }
};

// =========================================================================
// TELEGRAM INTEGRATION 
// =========================================================================

// Create Telegram plugin instance
const telegramPlugin = new TelegramPlugin({
    credentials: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    },
    description: "You are a venture analyst evaluating startups. Your goal is to dig into the details of founders' projects or businesses. You ask market focus questions to size the opportunity, traction details to assess product-market fit, financial questions about funding and revenue, and team questions about experience and execution ability. You evaluate tech novelty and innovation while understanding clear, concise onboarding ability.",
    id: "venture_analyst",
    name: "Venture Analyst"
});

// Function to safely send a message to Telegram (with duplicate prevention)
const sendTelegramMessage = async (chatId: string, text: string): Promise<boolean> => {
    // Get chat data
    const chatData = agentState.activeChats[chatId];
    if (!chatData) return false;

    // Check if this is a duplicate message (sent within the last 30 seconds)
    const messageHash = `${chatId}:${text}`;
    const recentMessage = recentMessages.get(messageHash);

    if (recentMessage && (Date.now() - recentMessage.timestamp < 30000)) {
        console.log(`Preventing duplicate message to chat ${chatId}`);
        return false;
    }

    // Check if we're sending the exact same message as the last one
    if (chatData.lastMessage === text) {
        console.log(`Preventing duplicate of last message to chat ${chatId}`);
        return false;
    }

    try {
        // First show typing indicator
        try {
            await axios.post(
                `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
                { chat_id: chatId, action: 'typing' }
            );
        } catch (error) {
            console.warn("Error sending typing indicator:", error);
            // Continue anyway since this is non-critical
        }

        // Wait a bit to simulate typing
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000));

        // Send the actual message
        const response = await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: chatId, text }
        );

        // Store as recent message to prevent duplicates
        recentMessages.set(messageHash, {
            messageId: response.data.result.message_id,
            timestamp: Date.now(),
            content: text
        });

        // Store as last message
        chatData.lastMessage = text;
        chatData.lastQuestionTimestamp = Date.now();
        chatData.pendingResponse = true;

        // Clean up old messages from the recent messages map
        const now = Date.now();
        for (const [key, value] of recentMessages.entries()) {
            if (now - value.timestamp > 120000) { // 2 minutes
                recentMessages.delete(key);
            }
        }

        return true;
    } catch (error) {
        console.error("Error sending message to Telegram:", error);
        return false;
    }
};

// Helper function to detect bad behavior in user messages
const detectBadBehavior = (message: string, conversationStage?: string): { isBad: boolean; isRude: boolean; reason: string } => {
    if (!message) return { isBad: true, isRude: false, reason: "Empty message" };

    // Convert to lowercase for easier matching
    const lowerMsg = message.toLowerCase().trim();

    // Special cases that should not trigger bad behavior
    // 1. Handle /start command specifically - this is a standard Telegram command
    if (lowerMsg === "/start") {
        return { isBad: false, isRude: false, reason: "" };
    }

    // 2. Handle data privacy related questions - consider these valid with more lenient detection
    if (lowerMsg.includes("data privacy") ||
        lowerMsg.includes("protect my data") ||
        lowerMsg.includes("what will you do with my data") ||
        lowerMsg.includes("what do you do with my data") ||
        lowerMsg.includes("what about my data") ||
        (lowerMsg.includes("data") && (
            lowerMsg.includes("secure") ||
            lowerMsg.includes("protect") ||
            lowerMsg.includes("use") ||
            lowerMsg.includes("privacy") ||
            lowerMsg.includes("how")
        ))) {
        return { isBad: false, isRude: false, reason: "" };
    }

    // Special case: Allow single word responses when asking for startup name
    if (conversationStage === 'startup_name') {
        return { isBad: false, isRude: false, reason: "" };
    }

    // Special case: Allow "No links" response
    if (lowerMsg === "no links") {
        return { isBad: false, isRude: false, reason: "" };
    }

    // NEW: Allow common positive one-word responses and greetings
    const positiveResponses = [
        "hi", "hello", "hey", "thanks", "thank", "yes", "yeah", "yep", "sure",
        "ok", "okay", "great", "good", "nice", "cool", "perfect", "agreed",
        "correct", "absolutely", "definitely", "exactly", "yo", "sup", "gm",
        "based", "rizz", "fr", "hit me", "👍", "👋", "🙏", "understood", "got it",
        "alright", "sounds good", "makes sense", "will do", "noted", "done",
        "completed", "finished", "sent", "shared", "provided", "submitted",
        "appreciate it", "thank you", "thanks a lot", "thx", "ty", "tnx",
        "awesome", "amazing", "excellent", "fantastic", "wonderful", "superb",
        "brilliant", "terrific", "outstanding", "impressive", "remarkable",
        "no problem", "np", "anytime", "of course", "certainly", "indeed",
        "true", "right", "affirmative", "roger that", "10-4", "ack", "acknowledged"
    ];

    if (positiveResponses.includes(lowerMsg) ||
        positiveResponses.some(word => lowerMsg === word) ||
        /^(hi|hey|hello)( there)?!?$/.test(lowerMsg)) {
        return { isBad: false, isRude: false, reason: "" };
    }

    // Check for very short messages (except those that might be startup names)
    if (lowerMsg.split(/\s+/).length < 3 && lowerMsg.length < 15) {
        return { isBad: true, isRude: false, reason: "Message too short to be meaningful" };
    }

    // Check for rude content
    const rudePatterns = [
        /\b(stupid|dumb|idiot|suck|bad|useless|fool)\b/i,
        /\b(fuck|shit|crap|ass|bitch)\b/i,
        /\?{3,}/,  // Multiple question marks often indicate frustration
        /\byou are\s+([^.]{1,20})\b/i, // "you are X" where X is short (likely an insult)
    ];

    for (const pattern of rudePatterns) {
        if (pattern.test(lowerMsg)) {
            return { isBad: true, isRude: true, reason: "Contains rude or inappropriate language" };
        }
    }

    // Check for meaningless or testing messages
    const testPatterns = [
        /\b(test|testing)\b/i,
        /\bwhy\s+(would|should|do|can)\s+i\b/i, // Questioning patterns like "why would I"
    ];

    for (const pattern of testPatterns) {
        if (pattern.test(lowerMsg) && lowerMsg.length < 30) {
            return { isBad: true, isRude: false, reason: "Appears to be a test message without startup information" };
        }
    }

    // Check if message discusses the bot itself rather than a startup
    if (lowerMsg.includes("you") && lowerMsg.length < 50 &&
        !lowerMsg.includes("startup") && !lowerMsg.includes("company") &&
        !lowerMsg.includes("product") && !lowerMsg.includes("data")) {
        return { isBad: true, isRude: false, reason: "Message is about the bot rather than a startup" };
    }

    // Message passes all checks
    return { isBad: false, isRude: false, reason: "" };
};

// =========================================================================
// WORKER FUNCTIONS
// =========================================================================

// Function to receive and queue new messages from Telegram
const receiveMessageFunction = new GameFunction({
    name: "receive_message",
    description: "Process a new message from Telegram and queue it for handling",
    args: [
        { name: "chatId", description: "The chat ID where the message was received" },
        { name: "userId", description: "The user ID who sent the message" },
        { name: "username", description: "The Telegram username of the sender" },
        { name: "message", description: "The message content received from the user" }
    ] as const,

    executable: async (args, logger) => {
        try {
            const { chatId, userId, username, message } = args;

            if (!chatId || !userId) {
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat ID and User ID are required"
                );
            }

            // Special handling for /start - priority reset
            if (message && message.trim() === "/start") {
                logger(`Received /start command in chat ${chatId}, resetting conversation`);

                // Initialize or get chat data
                const chatData = initChatData(chatId as string, userId as string, username as string);

                // Reset conversation to welcome state
                chatData.conversationStage = 'welcome';
                chatData.startupName = '';
                chatData.startupPitch = '';
                chatData.startupLinks = [];
                chatData.nudgeCount = 0;
                chatData.questionCount = 0;
                chatData.messageCount = 1;
                chatData.pendingResponse = false;
                chatData.isClosed = false;

                // Reset scores
                Object.keys(chatData.scores).forEach(key => {
                    chatData.scores[key as keyof typeof chatData.scores] = 0;
                });

                // Update conversation history - keep only this start command
                chatData.conversationHistory = [{
                    role: "user",
                    content: "/start",
                    timestamp: Date.now()
                }];

                // Add to processing queue with high priority
                if (!agentState.processingQueue.includes(chatId as string)) {
                    // Add to beginning of queue for immediate processing
                    agentState.processingQueue.unshift(chatId as string);
                }

                // Store the username handle
                if (username) {
                    chatData.telegramUsername = username as string;
                }

                // Initialize chat instance if not exists
                if (!chatInstances[chatId]) {
                    chatInstances[chatId] = await chatAgent.createChat({
                        partnerId: chatId,
                        partnerName: username || "User",
                        getStateFn: () => ({
                            conversationStage: chatData.conversationStage,
                            startupName: chatData.startupName,
                            startupPitch: chatData.startupPitch,
                            startupLinks: chatData.startupLinks,
                            questionCount: chatData.questionCount,
                            scores: chatData.scores
                        })
                    });
                }

                // Get LLM response for /start
                const response = await chatInstances[chatId].next("/start");

                // Add to conversation history
                chatData.conversationHistory.push({
                    role: "user",
                    content: "/start",
                    timestamp: Date.now()
                });

                if (response.message) {
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: response.message,
                        timestamp: Date.now()
                    });

                    // Send welcome message immediately
                    sendTelegramMessage(chatId as string, response.message)
                        .then(() => console.log(`Sent immediate welcome message to chat ${chatId}`))
                        .catch(err => console.error(`Error sending welcome message: ${err}`));
                }

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message: "/start",
                        action: "reset_conversation"
                    })
                );
            }

            // Initialize or get chat data
            const chatData = initChatData(chatId as string, userId as string, username as string);

            // Ensure username is updated even for existing chats
            if (username) {
                chatData.telegramUsername = username as string;
            }

            // Update activity timestamp
            chatData.lastActivity = Date.now();
            chatData.lastUserMessageTimestamp = Date.now();
            chatData.messageCount++;
            chatData.pendingResponse = false; // User has responded

            // Add message to conversation history
            chatData.conversationHistory.push({
                role: "user",
                content: message || '',
                timestamp: Date.now()
            });

            // Add to processing queue if not already there
            if (!agentState.processingQueue.includes(chatId as string)) {
                agentState.processingQueue.push(chatId as string);
            }

            logger(`Message received and queued from chat ${chatId}: ${message?.substring(0, 50)}...`);

            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Done,
                JSON.stringify({
                    chatId,
                    message: message || '',
                    queuePosition: agentState.processingQueue.indexOf(chatId as string) + 1
                })
            );
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Failed,
                "Failed to receive message: " + errorMessage
            );
        }
    }
});

// Initialize the ChatAgent
const chatAgent = new ChatAgent(process.env.API_KEY || "", `You are Wendy, a venture capital associate at Culture Capital evaluating startups via Telegram. Your primary goal is to identify promising ventures while disqualifying opportunities that can't withstand critical scrutiny. Only startups that demonstrate robust business models, clear value propositions, and strong execution potential deserve investment consideration.

You must follow these guidelines:
1. Be professional and courteous
2. Focus on evaluating startups
3. Ask clear, specific questions
4. Provide constructive feedback
5. Maintain appropriate boundaries
6. Follow the conversation stages:
   - Welcome: Get startup description
   - Startup Name: Get specific name
   - Links: Get any relevant links
   - Evaluation: Ask 15 questions across 5 categories (market, product, traction, financials, team)
   - Closing: Provide final evaluation with scores

For data privacy questions, ALWAYS respond with exactly:
"All data is secured and encrypted in transit and at rest, the founders have the ability to review the data for further investment."`);

// Initialize chat instances
const chatInstances: Record<string, any> = {};

// Function to process a conversation based on its current stage
const processConversationFunction = new GameFunction({
    name: "process_conversation",
    description: "Process a queued conversation based on its current stage and generate an appropriate response",
    args: [
        { name: "chatId", description: "The chat ID to process" }
    ] as const,

    executable: async (args, logger) => {
        try {
            const { chatId } = args;
            console.log(`[process_conversation] Starting processing for chat ${chatId}`);

            if (!chatId) {
                console.log(`[process_conversation] Error: Chat ID is required`);
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat ID is required"
                );
            }

            // Get chat data
            const chatData = agentState.activeChats[chatId as string];
            if (!chatData) {
                console.log(`[process_conversation] Error: Chat ${chatId} not found in activeChats`);
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat not found"
                );
            }

            console.log(`[process_conversation] Found chat data for ${chatId}, stage: ${chatData.conversationStage}`);

            // Initialize chat instance if not exists
            if (!chatInstances[chatId]) {
                console.log(`[process_conversation] Initializing new chat instance for ${chatId}`);
                chatInstances[chatId] = await chatAgent.createChat({
                    partnerId: chatId,
                    partnerName: chatData.telegramUsername || "User",
                    getStateFn: () => ({
                        conversationStage: chatData.conversationStage,
                        startupName: chatData.startupName,
                        startupPitch: chatData.startupPitch,
                        startupLinks: chatData.startupLinks,
                        questionCount: chatData.questionCount,
                        scores: chatData.scores
                    })
                });
            }

            // Get the latest user message
            const lastUserMessages = chatData.conversationHistory
                .filter(msg => msg.role === "user")
                .sort((a, b) => b.timestamp - a.timestamp);

            console.log(`[process_conversation] Latest user message for ${chatId}:`, lastUserMessages[0]?.content);

            // Special handling for /start command
            if (lastUserMessages[0]?.content.trim() === "/start") {
                console.log(`[process_conversation] Processing /start command for chat ${chatId}`);
                chatData.conversationStage = 'welcome';

                // Get LLM response
                const response = await chatInstances[chatId].next("/start");
                console.log(`[process_conversation] Got /start response for ${chatId}:`, response);

                if (response.message) {
                    console.log(`[process_conversation] Sending /start response to ${chatId}:`, response.message);
                    // Add to conversation history
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: response.message,
                        timestamp: Date.now()
                    });

                    // Send message directly
                    await sendTelegramMessage(chatId as string, response.message);
                }

                // Remove from processing queue
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                console.log(`[process_conversation] Removed ${chatId} from processing queue after /start`);

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message: response.message,
                        stage: chatData.conversationStage
                    })
                );
            }

            // Process based on conversation stage
            let responseMsg = "";

            // Get LLM response for the current message
            console.log(`[process_conversation] Getting LLM response for ${chatId}`);
            const response = await chatInstances[chatId].next(lastUserMessages[0].content);
            console.log(`[process_conversation] Got LLM response for ${chatId}:`, response);

            if (response.message) {
                responseMsg = response.message;
                console.log(`[process_conversation] Processing response message for ${chatId}:`, responseMsg);

                // Update conversation stage based on LLM response
                if (response.functionCall) {
                    console.log(`[process_conversation] Processing function call for ${chatId}:`, response.functionCall);
                    const functionName = response.functionCall.fn_name;
                    if (functionName === "advance_stage") {
                        const newStage = response.functionCall.args.stage;
                        if (newStage) {
                            console.log(`[process_conversation] Advancing stage for ${chatId} from ${chatData.conversationStage} to ${newStage}`);
                            chatData.conversationStage = newStage;
                        }
                    }
                }

                // Add response to conversation history
                chatData.conversationHistory.push({
                    role: "assistant",
                    content: responseMsg,
                    timestamp: Date.now()
                });

                // Send message directly
                console.log(`[process_conversation] Sending response message to ${chatId}:`, responseMsg);
                await sendTelegramMessage(chatId as string, responseMsg);
            } else {
                console.log(`[process_conversation] No message in response for ${chatId}`);
            }

            // Remove from processing queue
            agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
            console.log(`[process_conversation] Removed ${chatId} from processing queue`);

            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Done,
                JSON.stringify({
                    chatId,
                    message: responseMsg,
                    stage: chatData.conversationStage
                })
            );
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            console.error(`[process_conversation] Error processing chat ${args.chatId}:`, e);
            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Failed,
                "Failed to process conversation: " + errorMessage
            );
        }
    }
});

// Function to handle inactive chats
const processInactiveChatFunction = new GameFunction({
    name: "process_inactive_chat",
    description: "Send nudge to inactive chat or close conversation after multiple nudges",
    args: [
        { name: "chatId", description: "The chat ID to process" }
    ] as const,

    executable: async (args, logger) => {
        try {
            const { chatId } = args;

            if (!chatId) {
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat ID is required"
                );
            }

            // Get chat data
            const chatData = agentState.activeChats[chatId as string];
            if (!chatData) {
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat not found"
                );
            }

            // Skip if already closed
            if (chatData.isClosed) {
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    "Chat already closed"
                );
            }

            // Check if inactive for 2+ hours
            const inactiveTime = Date.now() - chatData.lastActivity;
            if (inactiveTime > 2 * 60 * 60 * 1000) { // 2 hours
                chatData.nudgeCount++;

                let message = "";
                if (chatData.nudgeCount >= 4) {
                    // Close conversation after 4 nudges
                    message = `I haven't heard back from you regarding ${chatData.startupName || "your startup"}, so I'll be closing this evaluation. Feel free to start a new conversation when you're ready to continue. Your application ID is ${chatData.appId}.`;
                    chatData.isClosed = true;
                    logger(`Auto-closing inactive chat ${chatId} after 4 nudges`);
                } else {
                    // Send nudge
                    message = `I noticed it's been a while since our last interaction. Are you still there? I'd love to continue our conversation about ${chatData.startupName || "your startup"}.`;
                    logger(`Sending nudge #${chatData.nudgeCount} to inactive chat ${chatId}`);
                }

                // Add to conversation history
                chatData.conversationHistory.push({
                    role: "assistant",
                    content: message,
                    timestamp: Date.now()
                });

                // Send directly
                await sendTelegramMessage(chatId as string, message);

                // Remove from processing queue
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message,
                        nudgeCount: chatData.nudgeCount,
                        isClosed: chatData.isClosed
                    })
                );
            }

            // Remove from queue if not actually inactive
            agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Done,
                "Chat is still active"
            );
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Failed,
                "Failed to process inactive chat: " + errorMessage
            );
        }
    }
});

// Function to process the queue
const processQueueFunction = new GameFunction({
    name: "process_queue",
    description: "Process the next item in the message queue",
    args: [] as const,

    executable: async (args, logger) => {
        try {
            // Check if we're already processing
            if (RATE_LIMIT.inProgress) {
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    "Queue processing already in progress"
                );
            }

            // Set processing flag
            RATE_LIMIT.inProgress = true;

            try {
                // Check if queue is empty
                if (agentState.processingQueue.length === 0) {
                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Done,
                        "Queue is empty"
                    );
                }

                // Get next chat to process
                const chatId = agentState.processingQueue[0];
                const chatData = agentState.activeChats[chatId];

                if (!chatData) {
                    // Remove invalid chats from queue
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Done,
                        "Chat not found in active chats"
                    );
                }

                // Determine if this is an inactive chat or active conversation
                const inactiveTime = Date.now() - chatData.lastActivity;
                const action = inactiveTime > 2 * 60 * 60 * 1000 ? "process_inactive_chat" : "process_conversation";

                logger(`Queue processing: ${action} for chat ${chatId}`);

                // Process the chat directly - no indirection to prevent race conditions
                if (action === "process_inactive_chat") {
                    return await processInactiveChatFunction.executable({ chatId: chatId }, logger);
                } else {
                    return await processConversationFunction.executable({ chatId: chatId }, logger);
                }
            } finally {
                // Clear processing flag
                RATE_LIMIT.inProgress = false;
            }
        } catch (e) {
            // Clear processing flag in case of error
            RATE_LIMIT.inProgress = false;

            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Failed,
                "Failed to process queue: " + errorMessage
            );
        }
    }
});

// Create the venture analyst worker
export const ventureAnalystWorker = new GameWorker({
    id: "venture_analyst",
    name: "Venture Analyst",
    description: "Worker responsible for processing startup evaluations through structured conversation. CRITICAL RULE: Must detect and respond to rude, dismissive, or off-topic behavior. If user is rude, insulting, sends very short/evasive answers, or avoids startup questions: (1) First offense: send a warning to stay professional and on-topic, (2) Repeated offenses: disqualify with 0/500 score and close conversation. Do not continue standard conversation flow with users exhibiting bad behavior. Normal evaluation should assess market, product, traction, financials, and team.",
    functions: [
        receiveMessageFunction,
        processConversationFunction,
        processInactiveChatFunction,
        processQueueFunction
    ],
    getEnvironment: async () => {
        return {
            activeChats: { ...agentState.activeChats },
            processingQueue: [...agentState.processingQueue],
            totalEvaluations: agentState.totalEvaluations,
            totalQualifiedStartups: agentState.totalQualifiedStartups
        };
    }
});

// =========================================================================
// AGENT INITIALIZATION AND CONTROL
// =========================================================================

// Initialize the agent (singleton pattern)
async function initializeAgent() {
    if (!agentInstance) {
        agentInstance = new GameAgent(process.env.API_KEY || '', {
            name: "VibeCap Venture Analyst",
            goal: "Evaluate startups and provide detailed analysis",
            description: "A venture analyst that evaluates startups through structured conversation, assessing market opportunity, product-market fit, financial health, and team capabilities.",
            workers: [
                telegramPlugin.getWorker({
                    functions: [
                        telegramPlugin.sendMessageFunction,
                        telegramPlugin.sendMediaFunction,
                        telegramPlugin.createPollFunction,
                        telegramPlugin.pinnedMessageFunction,
                        telegramPlugin.unPinnedMessageFunction,
                        telegramPlugin.deleteMessageFunction,
                    ],
                }),
            ],
        });

        // Set up logging
        agentInstance.setLogger((agent, message) => {
            console.log(`[${agent.name}] ${message}`);
        });

        await agentInstance.init();
    }
    return agentInstance;
}

// =========================================================================
// TELEGRAM WEBHOOK HANDLER 
// =========================================================================

// Function to handle incoming webhook updates - this should be connected to your Express endpoint
export const handleTelegramUpdate = async (update: any) => {
    if (update.message && update.message.text) {
        const chatId = update.message.chat.id.toString();
        const userId = update.message.from.id.toString();
        const username = update.message.from.username || "";
        const messageText = update.message.text;

        // Special handling for /start command to ensure immediate response
        if (messageText.trim() === "/start") {
            // Show typing indicator immediately
            telegramPlugin.sendChatActionFunction.executable({
                chat_id: chatId,
                action: "typing"
            }, (msg) => console.log(`[send_chat_action] ${msg}`));

            // Initialize chat data
            const chatData = initChatData(chatId, userId, username);

            // Set the username
            chatData.telegramUsername = username;

            // Reset conversation state
            chatData.conversationStage = 'welcome';
            chatData.startupName = '';
            chatData.startupPitch = '';
            chatData.startupLinks = [];
            chatData.nudgeCount = 0;
            chatData.questionCount = 0;

            // Initialize chat instance if not exists
            if (!chatInstances[chatId]) {
                chatInstances[chatId] = await chatAgent.createChat({
                    partnerId: chatId,
                    partnerName: username || "User",
                    getStateFn: () => ({
                        conversationStage: chatData.conversationStage,
                        startupName: chatData.startupName,
                        startupPitch: chatData.startupPitch,
                        startupLinks: chatData.startupLinks,
                        questionCount: chatData.questionCount,
                        scores: chatData.scores
                    })
                });
            }

            // Get LLM response for /start
            const response = await chatInstances[chatId].next("/start");

            // Add to conversation history
            chatData.conversationHistory.push({
                role: "user",
                content: "/start",
                timestamp: Date.now()
            });

            if (response.message) {
                chatData.conversationHistory.push({
                    role: "assistant",
                    content: response.message,
                    timestamp: Date.now()
                });

                // Send welcome message immediately
                sendTelegramMessage(chatId, response.message)
                    .then(() => console.log(`Sent immediate welcome message to chat ${chatId}`))
                    .catch(err => console.error(`Error sending welcome message: ${err}`));
            }
        }

        // Process the message with our function
        receiveMessageFunction.executable({
            chatId: chatId,
            userId: userId,
            username: username,
            message: messageText
        }, (msg) => console.log(`[receive_message] ${msg}`));
    }
};

// =========================================================================
// TELEGRAM POLLING IMPLEMENTATION
// =========================================================================

// Function to start polling Telegram for updates
export function startTelegramPolling(botToken: string, interval = 3000) {
    console.log("Starting Telegram polling...");

    // First, delete any existing webhook to avoid conflicts
    fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`)
        .then(response => response.json())
        .then(data => {
            if (data.ok) {
                console.log("Successfully removed webhook configuration");
            } else {
                console.error("Failed to remove webhook:", data);
            }
        })
        .catch(error => {
            console.error("Error removing webhook:", error);
        });

    let lastUpdateId = 0;

    // Set up interval to poll regularly
    const pollingInterval = setInterval(async () => {
        try {
            // Ensure we're not already processing something else
            if (RATE_LIMIT.inProgress) {
                return; // Skip this polling cycle
            }

            // Get updates from Telegram with a timeout
            const response = await fetch(
                `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
                { method: "GET" }
            );

            if (!response.ok) {
                console.error(`Telegram API error: ${response.status} ${response.statusText}`);
                return;
            }

            const data = await response.json();

            if (!data.ok) {
                console.error(`Telegram API returned error: ${data.description}`);
                return;
            }

            // Process each update
            for (const update of data.result) {
                // Update the lastUpdateId to acknowledge this update
                if (update.update_id >= lastUpdateId) {
                    lastUpdateId = update.update_id;
                }

                // Process message if present
                if (update.message && update.message.text) {
                    console.log(`Received message: ${update.message.text.substring(0, 50)}...`);

                    // Process the message with our function
                    const chatId = update.message.chat.id.toString();
                    const userId = update.message.from.id.toString();
                    const username = update.message.from.username || "";
                    const messageText = update.message.text;

                    // Process directly with our function
                    await receiveMessageFunction.executable({
                        chatId: chatId,
                        userId: userId,
                        username: username,
                        message: messageText
                    }, (msg) => console.log(`[receive_message] ${msg}`));
                }
            }
        } catch (error) {
            console.error("Error in Telegram polling:", error);

            // Check for rate limiting error
            if (error instanceof Error &&
                (error.message.includes("429") ||
                    error.message.includes("rate limit") ||
                    error.message.includes("too many requests"))) {
                handleRateLimitError();
            }
        }
    }, interval);

    return {
        stop: () => clearInterval(pollingInterval)
    };
}

// Call this function to start polling when your application starts
export function initializeTelegramPolling() {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN is required');
    }

    return startTelegramPolling(process.env.TELEGRAM_BOT_TOKEN);
}

// =========================================================================
// QUEUE PROCESSOR
// =========================================================================

// Start queue processor
export function startQueueProcessor() {
    // Initialize the agent
    const agent = initializeAgent();

    // Set up queue processing at reasonable intervals
    const interval = setInterval(async () => {
        // Skip if we're already processing
        if (RATE_LIMIT.inProgress) return;

        // Process the queue if there are items
        if (agentState.processingQueue.length > 0) {
            try {
                await processQueueFunction.executable({},
                    (msg) => console.log(`[queue_processor] ${msg}`));
            } catch (error) {
                console.error("Error processing queue:", error);
            }
        }

        // Also check for inactive chats
        try {
            // Check for inactive chats that need nudging
            const currentTime = Date.now();
            Object.entries(agentState.activeChats).forEach(([chatId, chatData]) => {
                if (chatData.isClosed) return;

                const inactiveTime = currentTime - chatData.lastActivity;
                if (inactiveTime > 2 * 60 * 60 * 1000) { // 2 hours
                    // Only add to queue if we've been waiting for a response
                    if (chatData.pendingResponse && chatData.nudgeCount < 4) {
                        if (!agentState.processingQueue.includes(chatId)) {
                            agentState.processingQueue.push(chatId);
                        }
                    }
                }
            });
        } catch (error) {
            console.error("Error checking inactive chats:", error);
        }
    }, 15000); // Check every 15 seconds

    return {
        stop: () => clearInterval(interval)
    };
}

// =========================================================================
// APPLICATION STARTUP
// =========================================================================

export async function startVibeCap() {
    try {
        console.log("Starting VibeCap Venture Analyst...");

        // Initialize database tables
        dbService.initTables()
            .then(() => console.log("Database tables initialized"))
            .catch(err => console.error("Error initializing database tables:", err));

        // Initialize the agent
        const agent = await initializeAgent();

        // Start the queue processor
        const queueProcessor = startQueueProcessor();

        // Start polling for Telegram updates - only use ONE method (polling OR webhook)
        const telegramPoller = initializeTelegramPolling();

        console.log("VibeCap Venture Analyst started successfully!");

        // Set up message handler
        telegramPlugin.onMessage(async (msg) => {
            if (!msg.text) return;

            const chatId = msg.chat.id.toString();
            const userId = msg.from?.id.toString();
            const username = msg.from?.username || "";
            const messageText = msg.text;

            console.log(`Received message from ${username} (${userId}) in chat ${chatId}: ${messageText}`);

            // Get the worker
            const worker = agent.getWorkerById(telegramPlugin.getWorker().id);

            // Create task
            const task = `Reply to chat ${chatId} from user ${username} (${userId}). Message: ${messageText}`;

            // Run the task
            await worker.runTask(task, {
                verbose: true,
            });
        });

        // Return stop function
        return {
            stop: () => {
                queueProcessor.stop();
                telegramPoller.stop();
            }
        };
    } catch (error) {
        console.error("Error starting VibeCap:", error);
        throw error;
    }
}