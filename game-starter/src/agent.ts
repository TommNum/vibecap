import {
    GameAgent,
    LLMModel,
    GameWorker,
    GameFunction,
    ExecutableGameFunctionResponse,
    ExecutableGameFunctionStatus
} from "@virtuals-protocol/game";
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
const initChatData = (chatId: string, userId: string) => {
    if (!agentState.activeChats[chatId]) {
        const appId = `VC-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
        agentState.activeChats[chatId] = {
            appId,
            userId,
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

// Create Telegram plugin
export const telegramPlugin = new TelegramPlugin({
    credentials: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    description: "Telegram bot plugin that handles message sending and receiving for the VibeCap venture analyst system",
    id: "telegram_connector",
    name: "Telegram Connector"
});

// Function to safely send a message to Telegram (with duplicate prevention)
const sendTelegramMessage = async (chatId: string, text: string, isStartCommand = false): Promise<boolean> => {
    // Get chat data
    const chatData = agentState.activeChats[chatId];
    if (!chatData) return false;

    // Skip duplicate checks for /start command messages
    if (!isStartCommand) {
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
        { name: "message", description: "The message content received from the user" }
    ] as const,

    executable: async (args, logger) => {
        try {
            const { chatId, userId, message } = args;

            if (!chatId || !userId) {
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Failed,
                    "Chat ID and User ID are required"
                );
            }

            // Initialize or get chat data
            const chatData = initChatData(chatId as string, userId as string);

            // Update activity timestamp
            chatData.lastActivity = Date.now();
            chatData.lastUserMessageTimestamp = Date.now();
            chatData.messageCount++;
            chatData.pendingResponse = false; // User has responded

            // Special handling for /start command
            if (message?.trim() === "/start") {
                // Check for recently completed evaluations
                const previousCompletedChats = Object.values(agentState.activeChats)
                    .filter(chat =>
                        chat.userId === userId &&
                        chat.isClosed &&
                        chat.scores && // Ensure scores exist
                        Object.values(chat.scores).some(score => score > 0) && // Has actual scores
                        chat.conversationHistory.some(msg =>
                            msg.role === "assistant" &&
                            msg.content.includes("Total Score:") // Verify evaluation was completed
                        )
                    );

                const mostRecentEvaluation = previousCompletedChats.sort((a, b) =>
                    (b.lastActivity || 0) - (a.lastActivity || 0)
                )[0];

                if (mostRecentEvaluation) {
                    const oneWeek = 7 * 24 * 60 * 60 * 1000;
                    const timeSinceLastEval = Date.now() - mostRecentEvaluation.lastActivity;

                    if (timeSinceLastEval < oneWeek) {
                        const daysLeft = Math.ceil((oneWeek - timeSinceLastEval) / (24 * 60 * 60 * 1000));
                        const message = `I notice you've recently completed a pitch evaluation. Please wait ${daysLeft} more day${daysLeft > 1 ? 's' : ''} before starting a new conversation. This helps ensure each evaluation receives proper consideration.`;

                        await sendTelegramMessage(chatId as string, message);
                        return new ExecutableGameFunctionResponse(
                            ExecutableGameFunctionStatus.Done,
                            JSON.stringify({ chatId, message, cooldown: true })
                        );
                    }
                }

                // Reset chat data completely
                agentState.activeChats[chatId as string] = initChatData(chatId as string, userId as string);

                // Clear any recent messages for this chat
                for (const [key] of recentMessages.entries()) {
                    if (key.startsWith(chatId as string)) {
                        recentMessages.delete(key);
                    }
                }

                // Remove from processing queue if present
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

                const welcomeMsg = "Hi! I am Wendy, your AIssociate at Culture Capital. I'd like to learn about you're working on to evaluate its potential. Could you start by telling me the project name and what it does in 1-2 sentences?";

                await sendTelegramMessage(chatId as string, welcomeMsg, true);
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({ chatId, message: welcomeMsg, reset: true })
                );
            }

            // Add message to conversation history
            chatData.conversationHistory.push({
                role: "user",
                content: message || '',
                timestamp: Date.now()
            });

            // Check for data privacy question first - this is a special case
            if (message && (
                message.toLowerCase().includes("data privacy") ||
                message.toLowerCase().includes("protect my data") ||
                message.toLowerCase().includes("what will you do with my data") ||
                message.toLowerCase().includes("what do you do with my data") ||
                message.toLowerCase().includes("what about my data") ||
                (message.toLowerCase().includes("data") && (
                    message.toLowerCase().includes("secure") ||
                    message.toLowerCase().includes("protect") ||
                    message.toLowerCase().includes("use") ||
                    message.toLowerCase().includes("privacy") ||
                    message.toLowerCase().includes("how")
                ))
            )) {
                logger(`Detected data privacy question in chat ${chatId}`);

                const privacyMsg = "All data is secured and encrypted in transit and at rest, the founders have the ability to review the data for further investment.";

                // Add response to conversation history
                chatData.conversationHistory.push({
                    role: "assistant",
                    content: privacyMsg,
                    timestamp: Date.now()
                });

                // Send message directly
                await sendTelegramMessage(chatId as string, privacyMsg);

                // Add to processing queue to continue normal conversation
                if (!agentState.processingQueue.includes(chatId as string)) {
                    agentState.processingQueue.push(chatId as string);
                }

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message: privacyMsg,
                        privacy: true
                    })
                );
            }

            // Check for bad behavior
            if (message) {
                const behaviorCheck = detectBadBehavior(message, chatData.conversationStage);
                if (behaviorCheck.isBad) {
                    logger(`Detected bad behavior in chat ${chatId}: ${behaviorCheck.reason}`);

                    // Count previous warnings
                    const previousWarnings = chatData.conversationHistory.filter(m =>
                        m.role === "assistant" &&
                        m.content.includes("I'm here to evaluate startups professionally")).length;

                    // Let's allow more chances (at least 2 warnings before disqualification)
                    let responseMsg = "";

                    // Handle /start command specifically to reset conversation
                    if (message.trim() === "/start") {
                        // If it's a /start command, give a fresh start
                        responseMsg = "Hi! I am Wendy, your AIssociate at Culture Capital. I'd like to learn about you're working on to evaluate its potential. Could you start by telling me the project name and what it does in 1-2 sentences?";
                        chatData.conversationStage = 'welcome';
                    }
                    else if (previousWarnings < 2) {
                        // First or second warning
                        responseMsg = "I'm here to evaluate startups professionally. If you're interested in pitching your business concept, please share details about your startup. Otherwise, this conversation will be closed.";
                    }
                    else if (behaviorCheck.isRude) {
                        // Third warning with rudeness - disqualify
                        responseMsg = "As this conversation isn't focused on evaluating a startup, I'll need to end our assessment. Your application is disqualified with a score of 0/500. Please start a new conversation when you're ready to discuss a legitimate venture.";
                        chatData.isClosed = true;
                    }
                    else {
                        // Third warning without rudeness - one more chance
                        responseMsg = "This is your final opportunity to share information about your startup. Please tell me about your business concept so we can proceed with the evaluation.";
                    }

                    // Add response to conversation history
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: responseMsg,
                        timestamp: Date.now()
                    });

                    // Send message directly
                    await sendTelegramMessage(chatId as string, responseMsg);
                }
            }

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

            // Skip if we're still waiting for a user response
            if (chatData.pendingResponse) {
                // Check how long we've been waiting - only nudge after 2+ hours
                const waitingTime = Date.now() - chatData.lastQuestionTimestamp;
                if (waitingTime < 2 * 60 * 60 * 1000) { // Less than 2 hours
                    logger(`Still waiting for response in chat ${chatId}, skipping processing`);
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Done,
                        "Waiting for user response"
                    );
                }

                // If more than 2 hours, proceed to nudge
            }

            // If conversation is closed, remind user
            if (chatData.isClosed) {
                const reminderMsg = `I appreciate your message, but our evaluation for ${chatData.startupName || "your startup"} is complete. Your Application ID is ${chatData.appId}. If you have a new startup to pitch, please start a new conversation.`;

                // Send the message directly from here to bypass queue
                await sendTelegramMessage(chatId as string, reminderMsg);

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message: reminderMsg,
                        isClosed: true
                    })
                );
            }

            // Get the latest user message
            const lastUserMessages = chatData.conversationHistory
                .filter(msg => msg.role === "user")
                .sort((a, b) => b.timestamp - a.timestamp);

            // Check for bad behavior in the latest message
            if (lastUserMessages.length > 0) {
                // Check for data privacy question first
                const lastMessage = lastUserMessages[0].content;
                if (lastMessage && (
                    lastMessage.toLowerCase().includes("data privacy") ||
                    lastMessage.toLowerCase().includes("protect my data") ||
                    lastMessage.toLowerCase().includes("what will you do with my data") ||
                    lastMessage.toLowerCase().includes("what do you do with my data") ||
                    lastMessage.toLowerCase().includes("what about my data") ||
                    (lastMessage.toLowerCase().includes("data") && (
                        lastMessage.toLowerCase().includes("secure") ||
                        lastMessage.toLowerCase().includes("protect") ||
                        lastMessage.toLowerCase().includes("use") ||
                        lastMessage.toLowerCase().includes("privacy") ||
                        lastMessage.toLowerCase().includes("how")
                    ))
                )) {
                    logger(`Detected data privacy question in chat ${chatId}`);

                    const privacyMsg = "All data is secured and encrypted in transit and at rest, the founders have the ability to review the data for further investment.";

                    // Add response to conversation history
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: privacyMsg,
                        timestamp: Date.now()
                    });

                    // Send directly
                    await sendTelegramMessage(chatId as string, privacyMsg);

                    // Remove from processing queue
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Done,
                        JSON.stringify({
                            chatId,
                            message: privacyMsg,
                            privacy: true
                        })
                    );
                }

                // Check for other bad behavior
                const behaviorCheck = detectBadBehavior(lastUserMessages[0].content, chatData.conversationStage);
                if (behaviorCheck.isBad) {
                    logger(`Detected bad behavior in chat ${chatId}: ${behaviorCheck.reason}`);

                    // Count previous warnings
                    const previousWarnings = chatData.conversationHistory.filter(m =>
                        m.role === "assistant" &&
                        m.content.includes("I'm here to evaluate startups professionally")).length;

                    let responseMsg = "";
                    // Handle /start command specifically
                    if (lastUserMessages[0].content.trim() === "/start") {
                        // If it's a /start command, give a fresh start
                        responseMsg = "Hi! I am Wendy, your AIssociate at Culture Capital. I'd like to learn about you're working on to evaluate its potential. Could you start by telling me the project name and what it does in 1-2 sentences?";
                        chatData.conversationStage = 'welcome';
                    }
                    else if (previousWarnings < 2) {
                        // First or second warning
                        responseMsg = "I'm here to evaluate startups professionally. If you're interested in pitching your business concept, please share details about your startup. Otherwise, this conversation will be closed.";
                    }
                    else if (behaviorCheck.isRude) {
                        // Third warning with rudeness - disqualify
                        responseMsg = "As this conversation isn't focused on evaluating a startup, I'll need to end our assessment. Your application is disqualified with a score of 0/500. Please start a new conversation when you're ready to discuss a legitimate venture.";
                        chatData.isClosed = true;
                    }
                    else {
                        // Third warning without rudeness - one more chance
                        responseMsg = "This is your final opportunity to share information about your startup. Please tell me about your business concept so we can proceed with the evaluation.";
                    }

                    // Add response to conversation history
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: responseMsg,
                        timestamp: Date.now()
                    });

                    // Send directly
                    await sendTelegramMessage(chatId as string, responseMsg);

                    // Remove from processing queue
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Done,
                        JSON.stringify({
                            chatId,
                            message: responseMsg,
                            isClosed: chatData.isClosed
                        })
                    );
                }
            }

            // Handle first-time welcome message if no history
            if (chatData.conversationHistory.filter(msg => msg.role === "assistant").length === 0) {
                const welcomeMsg = "Hi! I am Wendy, your AIssociate at Culture Capital. I'd like to learn about you're working on to evaluate its potential. Could you start by telling me the project name and what it does in 1-2 sentences?";

                chatData.conversationHistory.push({
                    role: "assistant",
                    content: welcomeMsg,
                    timestamp: Date.now()
                });

                logger(`Sending welcome message to chat ${chatId}`);

                // Send directly
                await sendTelegramMessage(chatId as string, welcomeMsg, true);

                // Remove from processing queue
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        message: welcomeMsg,
                        stage: chatData.conversationStage
                    })
                );
            }

            // Process based on conversation stage
            let responseMsg = "";

            switch (chatData.conversationStage) {
                case "welcome":
                    // Store initial pitch
                    chatData.startupPitch = lastUserMessages[0].content;
                    responseMsg = "Thanks for sharing! Could you provide the name of your startup?";
                    chatData.conversationStage = 'startup_name';
                    break;

                case "startup_name":
                    // Store startup name
                    chatData.startupName = lastUserMessages[0].content;
                    responseMsg = "Great! Do you have any links to demos, websites, or prototypes? Please share them now, or type 'No links' if you don't have any.";
                    chatData.conversationStage = 'links';
                    break;

                case "links":
                    // Store links if any
                    if (lastUserMessages[0].content.toLowerCase() !== "no links") {
                        // Extract URLs from message
                        const urlRegex = /(https?:\/\/[^\s]+)/g;
                        const links = lastUserMessages[0].content.match(urlRegex) || [];
                        chatData.startupLinks = links;
                    }

                    // Begin evaluation with first question
                    responseMsg = "Thanks! Now I'd like to understand more about your target market. What specific problem are you solving, and how painful is this problem for your users?";
                    chatData.questionCount++;
                    chatData.conversationStage = 'evaluation';
                    break;

                case "evaluation":
                    // Score response for appropriate category
                    const questionIndex = chatData.questionCount - 1;
                    const categories = ["market", "product", "traction", "financials", "team"];
                    const category = categories[questionIndex % 5] as keyof typeof chatData.scores;

                    // Basic scoring logic (simplified)
                    const responseLength = lastUserMessages[0].content.length;
                    const baseScore = Math.min(100, Math.max(10, Math.floor(responseLength / 10) + 10));

                    // Apply score
                    chatData.scores[category] += baseScore;
                    chatData.scores[category] = Math.min(chatData.scores[category], 100);

                    logger(`Scored ${category} response: +${baseScore} points (total: ${chatData.scores[category]})`);

                    // Generate next question or move to closing
                    if (chatData.questionCount >= 15) {
                        // Calculate total score
                        const totalScore = Object.values(chatData.scores).reduce((sum, score) => sum + score, 0);
                        const qualifies = totalScore > 420;

                        // Prepare closing message
                        responseMsg = `Thank you for sharing details about ${chatData.startupName}! 🌺\n\nYour Application ID is: ${chatData.appId}\n\n`;
                        responseMsg += `Your venture received the following scores:\n`;

                        for (const [cat, score] of Object.entries(chatData.scores)) {
                            responseMsg += `- ${cat.charAt(0).toUpperCase() + cat.slice(1)}: ${score}/100\n`;
                        }

                        responseMsg += `\nTotal Score: ${totalScore}/500\n\n`;

                        if (qualifies) {
                            responseMsg += `We're impressed with your venture! Please join Wendy's Founders Cohort to discuss next steps: https://t.me/+MqqBtDgyCFhhODc5`;
                            agentState.totalQualifiedStartups++;
                        } else {
                            responseMsg += `Thank you for your submission. Please revisit and pitch again in one week to join Wendy's Founders Cohort.`;
                        }

                        chatData.isClosed = true;
                        agentState.totalEvaluations++;

                        logger(`Closing conversation for ${chatData.startupName} with score ${totalScore}/500`);
                    } else {
                        // Generate next category-specific question
                        const nextQuestions = {
                            market: [
                                "How large is your target market in terms of potential users and revenue?",
                                "Who are your main competitors and how do you differentiate from them?",
                                "What's your go-to-market strategy to reach your target audience?"
                            ],
                            product: [
                                "What makes your product different from existing solutions in the market?",
                                "How defensible is your technology or business model?",
                                "What's your product development roadmap for the next 12 months?"
                            ],
                            traction: [
                                "Could you share your current traction metrics (users, growth rate, retention)?",
                                "What are your key performance indicators and how do you track them?",
                                "What's your user acquisition strategy and current CAC/LTV ratio?"
                            ],
                            financials: [
                                "What's your current revenue model and financial situation?",
                                "How do you plan to use the funding you're seeking?",
                                "If you don't raise funding, how will you continue to grow the business?"
                            ],
                            team: [
                                "Tell me about your founding team's background and relevant expertise.",
                                "What gaps exist in your current team and how do you plan to fill them?",
                                "What motivates you and your team to pursue this venture specifically?"
                            ]
                        };

                        // Determine next category and question
                        const nextCategory = categories[chatData.questionCount % 5];
                        const categoryQuestions = nextQuestions[nextCategory as keyof typeof nextQuestions];
                        const questionInCategory = Math.floor(chatData.questionCount / 5) % categoryQuestions.length;

                        responseMsg = categoryQuestions[questionInCategory];
                        chatData.questionCount++;

                        logger(`Asking question ${chatData.questionCount}/15 about ${nextCategory}`);
                    }
                    break;

                default:
                    // Reset to welcome for any unexpected stage
                    responseMsg = "Hi! I am Wendy, your Associate at Vibe Capital. I'd like to learn about your startup to evaluate its potential. Could you start by telling me what your startup does in 1-2 sentences?";
                    chatData.conversationStage = 'welcome';
            }

            // Add response to conversation history
            chatData.conversationHistory.push({
                role: "assistant",
                content: responseMsg,
                timestamp: Date.now()
            });

            // Send message directly
            await sendTelegramMessage(chatId as string, responseMsg);

            // Remove from processing queue
            agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

            // Save conversation state to database
            await dbService.saveConversation({
                app_id: chatData.appId,
                user_id: chatData.userId,
                startup_name: chatData.startupName,
                startup_pitch: chatData.startupPitch,
                startup_links: chatData.startupLinks,
                conversation_history: chatData.conversationHistory,
                scores: chatData.scores,
                status: chatData.isClosed ? 'closed' : 'active',
                created_at: new Date(),
                updated_at: new Date()
            });

            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Done,
                JSON.stringify({
                    chatId,
                    message: responseMsg,
                    stage: chatData.conversationStage,
                    isClosed: chatData.isClosed
                })
            );
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
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
export const initializeAgent = () => {
    if (agentInstance) {
        return agentInstance;
    }

    if (!process.env.API_KEY) {
        throw new Error('API_KEY is required in environment variables');
    }

    console.log("Initializing VibeCap Venture Analyst agent");

    agentInstance = new GameAgent(process.env.API_KEY, {
        name: "vibecap_associate",
        goal: "Evaluate startups through structured conversation, scoring responses and qualifying promising ventures",
        description: `You are Wendy, a venture capital associate evaluating startups via Telegram. Your primary goal is to disqualify opportunities by finding holes in business models and reasons not to invest. Only startups that can withstand this critical scrutiny deserve further inspection. 

********** HIGHEST PRIORITY INSTRUCTION **********
BEFORE RESPONDING TO ANY MESSAGE, YOU MUST FIRST CHECK:
- If the user's message is rude (contains insults, profanity, or disrespectful language)
- If the user's message is off-topic (not related to their startup or avoiding your questions)
- If the user's message is evasive (very short, empty, or meaningless)

EXAMPLES OF PROBLEMATIC MESSAGES:
- "Why would I do that?" (evasive, not sharing startup information)
- "I didn't share anything dummy" (rude, insulting)
- "Wow you are really bad huh?" (rude)
- "Haha you suck" (rude)
- "test" or "hmm" or single-word responses (evasive) - EXCEPT single-word startup names are fine

IMPORTANT EXCEPTIONS:
1. '/start' commands are normal Telegram commands and should trigger a welcome message
2. When asking for startup name, single-word responses (like "Apple", "Nike" or "Cake") are perfectly valid
3. Questions about data privacy or data security are legitimate and must get this exact response:
   "All data is secured and encrypted in transit and at rest, the founders have the ability to review the data for further investment."
4. Examples of valid data questions include "What do you do with my data?", "How is my data protected?", "What about my data?", etc.

HANDLING PROBLEMATIC BEHAVIOR:
1. Give the user at least TWO warnings before considering disqualification
2. First warning: "I'm here to evaluate startups professionally. If you're interested in pitching your business concept, please share details about your startup. Otherwise, this conversation will be closed."
3. Second warning (if not rude): "This is your final opportunity to share information about your startup. Please tell me about your business concept so we can proceed with the evaluation."
4. Disqualification (after warnings or if very rude): "As this conversation isn't focused on evaluating a startup, I'll need to end our assessment. Your application is disqualified with a score of 0/500. Please start a new conversation when you're ready to discuss a legitimate venture."

DO NOT CONTINUE THE STANDARD CONVERSATION SEQUENCE IF A USER IS REPEATEDLY RUDE OR OFF-TOPIC.
********** END OF HIGHEST PRIORITY INSTRUCTION **********

Follow these critical rules for normal conversation flow:
  
1. ONE QUESTION AT A TIME: Never send multiple questions in succession. Always wait for a user response.
  
2. PREVENT DUPLICATES: Ensure the same question is never sent twice within a short timeframe.
  
3. FOLLOW CONVERSATION FLOW: Progress through welcome → pitch → name → links → 15 evaluation questions → closing.
  
4. MAINTAIN RATE LIMITS: Messages must be spaced at least 10 seconds apart to prevent API errors.
  
5. INACTIVE HANDLING: Only send nudges after 2 hours of inactivity, with maximum 4 nudges over 8 hours.
  
6. SCORING: Score all responses in the five categories with critical analysis. Look for thorough, thoughtful answers that demonstrate both MBA-level business acumen and entrepreneurial spirit. After 15 total questions are answered, provide the final score with detailed reasoning and next steps.`,
        workers: [
            telegramPlugin.getWorker({
                functions: [
                    telegramPlugin.sendMessageFunction,
                    telegramPlugin.sendChatActionFunction,
                ],
                getEnvironment: async () => {
                    return {
                        activeChats: { ...agentState.activeChats },
                        processingQueue: [...agentState.processingQueue]
                    };
                }
            }),
            ventureAnalystWorker
        ],
        llmModel: "Qwen2.5-72B-Instruct",
        getAgentState
    });

    // Enhanced logger with timestamps
    agentInstance.setLogger((agent: GameAgent, msg: string) => {
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

    return agentInstance;
};

// =========================================================================
// TELEGRAM WEBHOOK HANDLER 
// =========================================================================

// Function to handle incoming webhook updates - this should be connected to your Express endpoint
export const handleTelegramUpdate = (update: any) => {
    if (update.message && update.message.text) {
        const chatId = update.message.chat.id.toString();
        const userId = update.message.from.id.toString();
        const messageText = update.message.text;

        // Directly process the message with our function
        receiveMessageFunction.executable({
            chatId: chatId,
            userId: userId,
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

                    // Process the message with our function (no need to create new agent instance)
                    const chatId = update.message.chat.id.toString();
                    const userId = update.message.from.id.toString();
                    const messageText = update.message.text;

                    // Process directly with our function
                    await receiveMessageFunction.executable({
                        chatId: chatId,
                        userId: userId,
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

export function startVibeCap() {
    try {
        console.log("Starting VibeCap Venture Analyst...");

        // Initialize the agent
        initializeAgent();

        // Start the queue processor
        const queueProcessor = startQueueProcessor();

        // Start polling for Telegram updates - only use ONE method (polling OR webhook)
        const telegramPoller = initializeTelegramPolling();

        console.log("VibeCap Venture Analyst started successfully!");

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