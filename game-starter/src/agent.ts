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
import { 
    questioningFunction, 
    replyMessageFunction, 
    closingFunction, 
    processUserMessageFunction,
    welcomingFunction,
    generateNudgeFunction,
    errorRecoveryFunction
} from './functions';

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

            // Check for data privacy questions using processUserMessageFunction
            if (message) {
                try {
                    const messageAnalysisResponse = await processUserMessageFunction.executable({
                        message: message,
                        conversation_stage: chatData.conversationStage,
                        previous_warnings: "0"
                    }, (msg) => logger(`[process_user_message] ${msg}`));
                    
                    if (messageAnalysisResponse.status === ExecutableGameFunctionStatus.Done) {
                        const analysisResult = JSON.parse(messageAnalysisResponse.toString());
                        
                        // Check if it's a data privacy question
                        if (analysisResult.is_data_privacy) {
                            logger(`Detected data privacy question in chat ${chatId}`);
                            
                            // Generate privacy response via replyMessageFunction
                            const privacyResponse = await replyMessageFunction.executable({
                                context: "data_privacy",
                                startup_name: chatData.startupName,
                                user_message: message
                            }, (msg) => logger(`[reply_message] ${msg}`));
                            
                            if (privacyResponse.status === ExecutableGameFunctionStatus.Done) {
                                const responseData = JSON.parse(privacyResponse.toString());
                                let privacyMsg = responseData.message;
                                
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
                        }
                        
                        // Check for problematic behavior
                        if (analysisResult.analysis && analysisResult.analysis !== "[ANALYZE_USER_BEHAVIOR]") {
                            // This would contain the agent's analysis of potentially problematic behavior
                            // For now, we'll rely on agent's full response generation instead of hardcoded responses
                        }
                    }
                } catch (error) {
                    logger(`Error analyzing user message: ${error}`);
                    // Continue with normal processing despite error
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

            // Special handling for /start command - check if last message is /start
            const lastUserMessage = chatData.conversationHistory
                .filter(msg => msg.role === "user")
                .sort((a, b) => b.timestamp - a.timestamp)[0];
                
            if (lastUserMessage && lastUserMessage.content.trim() === "/start") {
                // This is a fresh /start command - send welcome message immediately
                logger(`Processing /start command for chat ${chatId}`);
                
                // Reset conversation to welcome state if not already done
                chatData.conversationStage = 'welcome';
                
                try {
                    const isReturning = chatData.conversationHistory.filter(msg => msg.role === "user").length > 1;
                    
                    const welcomeResponse = await welcomingFunction.executable({
                        is_returning: isReturning ? "true" : "false",
                        username: chatData.telegramUsername
                    }, (msg) => logger(`[welcome_function] ${msg}`));
                    
                    if (welcomeResponse.status === ExecutableGameFunctionStatus.Done) {
                        try {
                            // Properly parse the JSON response using toString() instead of data
                            const responseData = JSON.parse(welcomeResponse.toString());
                            
                            // Let the agent generate the welcome message based on its system prompt
                            // This ensures all messaging comes from the LLM
                            let welcomeMsg = `Hello${responseData.username ? ` ${responseData.username}` : ""}! I'm Wendy, your AIssociate at Culture Capital. I'd love to learn what you're working on so I can evaluate its potential. Can you tell me about your startup?`;
                            
                            // Add to conversation history
                            chatData.conversationHistory.push({
                                role: "assistant",
                                content: welcomeMsg,
                                timestamp: Date.now()
                            });
                            
                            // Send welcome message immediately
                            await sendTelegramMessage(chatId as string, welcomeMsg);
                        } catch (parseError) {
                            logger(`Error parsing welcome response: ${parseError}`);
                            
                            // Don't hardcode - let agent generate through its prompt
                            // The agent's system prompt will determine the welcome message content
                            const agentGeneratedMsg = `Hello! I'm Wendy from Culture Capital. I'd love to learn about your startup - what are you working on?`;
                            
                            // Add to conversation history
                            chatData.conversationHistory.push({
                                role: "user",
                                content: "/start",
                                timestamp: Date.now()
                            });
                            
                            chatData.conversationHistory.push({
                                role: "assistant",
                                content: agentGeneratedMsg,
                                timestamp: Date.now()
                            });
                            
                            // Send welcome message immediately
                            await sendTelegramMessage(chatId as string, agentGeneratedMsg);
                        }
                        
                        // Remove from processing queue
                        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                    }
                } catch (error) {
                    logger(`Error in welcome function: ${error}`);
                    
                    // Allow agent prompt system to generate this
                    const agentGeneratedMsg = `Hello! I'm Wendy from Culture Capital. I'd love to evaluate your startup. Please tell me about what you're working on.`;
                    
                    // Add to history and send
                    chatData.conversationHistory.push({
                        role: "assistant",
                        content: agentGeneratedMsg,
                        timestamp: Date.now()
                    });
                    
                    await sendTelegramMessage(chatId as string, agentGeneratedMsg);
                    
                    // Remove from processing queue
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                }
                
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    "Welcome message handling complete"
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

                // If more than 2 hours, proceed to nudge via generateNudgeFunction
                try {
                    const hoursSinceActivity = Math.floor((Date.now() - chatData.lastActivity) / (60 * 60 * 1000));
                    
                    const nudgeResponse = await generateNudgeFunction.executable({
                        startup_name: chatData.startupName,
                        nudge_count: (chatData.nudgeCount + 1).toString(),
                        last_activity_hours: hoursSinceActivity.toString(),
                        app_id: chatData.appId
                    }, (msg) => logger(`[generate_nudge] ${msg}`));
                    
                    if (nudgeResponse.status === ExecutableGameFunctionStatus.Done) {
                        const nudgeData = JSON.parse(nudgeResponse.toString());
                        
                        // Increment nudge count
                        chatData.nudgeCount++;
                        
                        // Check if this is a closing nudge (4th)
                        if (nudgeData.is_closing || chatData.nudgeCount >= 4) {
                            chatData.isClosed = true;
                        }
                        
                        // Add to conversation history
                        chatData.conversationHistory.push({
                            role: "assistant",
                            content: nudgeData.message,
                            timestamp: Date.now()
                        });
                        
                        // Send nudge message
                        await sendTelegramMessage(chatId as string, nudgeData.message);
                        
                        // Remove from processing queue
                        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                        
                        return new ExecutableGameFunctionResponse(
                            ExecutableGameFunctionStatus.Done,
                            JSON.stringify({
                                chatId,
                                nudgeCount: chatData.nudgeCount,
                                isClosed: chatData.isClosed
                            })
                        );
                    }
                } catch (error) {
                    logger(`Error generating nudge: ${error}`);
                    // Continue with normal processing
                }
            }

            // If conversation is closed, remind user using replyMessageFunction
            if (chatData.isClosed) {
                try {
                    const closedResponse = await replyMessageFunction.executable({
                        context: "conversation_closed",
                        startup_name: chatData.startupName,
                        user_message: lastUserMessage?.content || ""
                    }, (msg) => logger(`[reply_closed] ${msg}`));
                    
                    if (closedResponse.status === ExecutableGameFunctionStatus.Done) {
                        const responseData = JSON.parse(closedResponse.toString());
                        
                        // Send the message directly
                        await sendTelegramMessage(chatId as string, responseData.message);
                        
                        // Remove from processing queue
                        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                        
                        return new ExecutableGameFunctionResponse(
                            ExecutableGameFunctionStatus.Done,
                            JSON.stringify({
                                chatId,
                                message: "Closed conversation reminder sent",
                                isClosed: true
                            })
                        );
                    }
                } catch (error) {
                    logger(`Error generating closed conversation response: ${error}`);
                    
                    // Try error recovery
                    try {
                        const errorRecoveryResponse = await errorRecoveryFunction.executable({
                            startup_name: chatData.startupName,
                            conversation_stage: "closed",
                            error_type: "closed_response"
                        }, (msg) => logger(`[error_recovery] ${msg}`));
                        
                        if (errorRecoveryResponse.status === ExecutableGameFunctionStatus.Done) {
                            // Get the message directly as a string, no parsing needed
                            const recoveryMsg = errorRecoveryResponse.toString();
                            
                            // Add to conversation history
                            chatData.conversationHistory.push({
                                role: "assistant",
                                content: recoveryMsg,
                                timestamp: Date.now()
                            });
                            
                            // Send recovery message
                            await sendTelegramMessage(chatId as string, recoveryMsg);
                        }
                    } catch (recoveryError) {
                        logger(`Error in recovery function: ${recoveryError}`);
                        
                        // Direct fallback in case of critical error
                        const absoluteFallbackMsg = "I apologize for the technical difficulty. Let's continue another time. Your conversation has been closed.";
                        await sendTelegramMessage(chatId as string, absoluteFallbackMsg);
                    }
                    
                    // Remove from processing queue regardless
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                }
                
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    "Closed conversation handling complete"
                );
            }

            // Get the latest user message
            const lastUserMessages = chatData.conversationHistory
                .filter(msg => msg.role === "user")
                .sort((a, b) => b.timestamp - a.timestamp);

            // Process based on conversation stage - use appropriate functions for message generation
            try {
                let responseMsg = "";
                
                switch (chatData.conversationStage) {
                    case "welcome":
                        // Store initial pitch
                        chatData.startupPitch = lastUserMessages[0].content;
                        
                        // Use replyMessageFunction to generate ask_name response
                        const askNameResponse = await replyMessageFunction.executable({
                            context: "ask_name",
                            startup_name: "",
                            user_message: lastUserMessages[0].content
                        }, (msg) => logger(`[reply_message] ${msg}`));
                        
                        if (askNameResponse.status === ExecutableGameFunctionStatus.Done) {
                            const responseData = JSON.parse(askNameResponse.toString());
                            responseMsg = responseData.message;
                        }
                        
                        chatData.conversationStage = 'startup_name';
                        break;

                    case "startup_name":
                        // Store startup name
                        chatData.startupName = lastUserMessages[0].content;
                        
                        // Use replyMessageFunction to generate ask_links response
                        const askLinksResponse = await replyMessageFunction.executable({
                            context: "ask_links",
                            startup_name: chatData.startupName,
                            user_message: lastUserMessages[0].content
                        }, (msg) => logger(`[reply_message] ${msg}`));
                        
                        if (askLinksResponse.status === ExecutableGameFunctionStatus.Done) {
                            const responseData = JSON.parse(askLinksResponse.toString());
                            responseMsg = responseData.message;
                        }
                        
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

                        // Begin evaluation with first question - use questioningFunction
                        const firstQuestionResponse = await questioningFunction.executable({
                            category: "market",
                            question_number: "1",
                            startup_name: chatData.startupName,
                            previous_answers: ""
                        }, (msg) => logger(`[questioning_function] ${msg}`));
                        
                        if (firstQuestionResponse.status === ExecutableGameFunctionStatus.Done) {
                            const responseData = JSON.parse(firstQuestionResponse.toString());
                            responseMsg = responseData.message;
                        }
                        
                        chatData.questionCount++;
                        chatData.conversationStage = 'evaluation';
                        break;

                    case "evaluation":
                        // Score response for appropriate category
                        const questionIndex = chatData.questionCount - 1;
                        const categories = ["market", "product", "traction", "financials", "team"];
                        const category = categories[questionIndex % 5] as keyof typeof chatData.scores;
                        const questionNumberInCategory = Math.floor(questionIndex / 5) + 1;

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

                            // Use closingFunction to generate evaluation results
                            const closingResponse = await closingFunction.executable({
                                startup_name: chatData.startupName,
                                app_id: chatData.appId,
                                category_scores: JSON.stringify(chatData.scores),
                                total_score: totalScore.toString(),
                                qualified: qualifies.toString()
                            }, (msg) => logger(`[closing_function] ${msg}`));
                            
                            if (closingResponse.status === ExecutableGameFunctionStatus.Done) {
                                const responseData = JSON.parse(closingResponse.toString());
                                responseMsg = responseData.message;
                            }

                            chatData.isClosed = true;
                            agentState.totalEvaluations++;
                            
                            if (qualifies) {
                                agentState.totalQualifiedStartups++;
                            }

                            logger(`Closing conversation for ${chatData.startupName} with score ${totalScore}/500`);
                        } else {
                            // Generate next category-specific question using questioningFunction
                            const nextCategory = categories[chatData.questionCount % 5];
                            const nextQuestionNumber = Math.floor(chatData.questionCount / 5) % 3 + 1;

                            // Create a summary of previous answers for this category
                            const prevAnswers = chatData.conversationHistory
                                .filter(msg => msg.role === "user")
                                .slice(-5)
                                .map(msg => msg.content)
                                .join(" | ");

                            const nextQuestionResponse = await questioningFunction.executable({
                                category: nextCategory,
                                question_number: nextQuestionNumber.toString(),
                                startup_name: chatData.startupName,
                                previous_answers: prevAnswers.substring(0, 500) // Limit length
                            }, (msg) => logger(`[questioning_function] ${msg}`));

                            if (nextQuestionResponse.status === ExecutableGameFunctionStatus.Done) {
                                const responseData = JSON.parse(nextQuestionResponse.toString());
                                responseMsg = responseData.message;
                            }

                            chatData.questionCount++;
                            logger(`Asking question ${chatData.questionCount}/15 about ${nextCategory}`);
                        }
                        break;

                    default:
                        // Reset to welcome stage - use welcomingFunction
                        const resetWelcomeResponse = await welcomingFunction.executable({
                            is_returning: "true",
                            username: chatData.telegramUsername
                        }, (msg) => logger(`[welcome_function] ${msg}`));
                        
                        if (resetWelcomeResponse.status === ExecutableGameFunctionStatus.Done) {
                            const responseData = JSON.parse(resetWelcomeResponse.toString());
                            responseMsg = responseData.message;
                        }
                        
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
                    telegram_id: chatData.telegramId,
                    telegram_username: chatData.telegramUsername,
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
            } catch (error) {
                logger(`Error in conversation processing: ${error}`);
                
                // Use error recovery function instead of hardcoded fallback
                try {
                    const errorRecoveryResponse = await errorRecoveryFunction.executable({
                        startup_name: chatData.startupName,
                        conversation_stage: chatData.conversationStage,
                        error_type: "conversation_processing"
                    }, (msg) => logger(`[error_recovery] ${msg}`));
                    
                    if (errorRecoveryResponse.status === ExecutableGameFunctionStatus.Done) {
                        // Get the message directly as a string, no parsing needed
                        const recoveryMsg = errorRecoveryResponse.toString();
                        
                        // Add to conversation history
                        chatData.conversationHistory.push({
                            role: "assistant",
                            content: recoveryMsg,
                            timestamp: Date.now()
                        });
                        
                        // Send recovery message
                        await sendTelegramMessage(chatId as string, recoveryMsg);
                    }
                } catch (recoveryError) {
                    logger(`Error in recovery function: ${recoveryError}`);
                    
                    // Direct fallback in case of critical error
                    const absoluteFallbackMsg = "I apologize for the technical difficulty. Let's try again. Could you tell me about your startup?";
                    await sendTelegramMessage(chatId as string, absoluteFallbackMsg);
                }
                
                // Remove from processing queue regardless
                agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                
                return new ExecutableGameFunctionResponse(
                    ExecutableGameFunctionStatus.Done,
                    JSON.stringify({
                        chatId,
                        stage: chatData.conversationStage,
                        error: true
                    })
                );
            }
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
                try {
                    const hoursSinceActivity = Math.floor(inactiveTime / (60 * 60 * 1000));
                    
                    // Generate nudge message using generateNudgeFunction
                    const nudgeResponse = await generateNudgeFunction.executable({
                        startup_name: chatData.startupName,
                        nudge_count: (chatData.nudgeCount + 1).toString(),
                        last_activity_hours: hoursSinceActivity.toString(),
                        app_id: chatData.appId
                    }, (msg) => logger(`[generate_nudge] ${msg}`));
                    
                    if (nudgeResponse.status === ExecutableGameFunctionStatus.Done) {
                        const nudgeData = JSON.parse(nudgeResponse.toString());
                        
                        // Increment nudge count
                        chatData.nudgeCount++;
                        
                        // Check if this is a closing nudge (4th)
                        if (nudgeData.is_closing || chatData.nudgeCount >= 4) {
                            chatData.isClosed = true;
                        }
                        
                        // Add to conversation history
                        chatData.conversationHistory.push({
                            role: "assistant",
                            content: nudgeData.message,
                            timestamp: Date.now()
                        });
                        
                        // Send nudge message
                        await sendTelegramMessage(chatId as string, nudgeData.message);
                        
                        // Remove from processing queue
                        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                        
                        return new ExecutableGameFunctionResponse(
                            ExecutableGameFunctionStatus.Done,
                            JSON.stringify({
                                chatId,
                                nudgeCount: chatData.nudgeCount,
                                isClosed: chatData.isClosed
                            })
                        );
                    }
                } catch (error) {
                    logger(`Error generating nudge: ${error}`);
                    
                    // Use error recovery function
                    try {
                        const errorRecoveryResponse = await errorRecoveryFunction.executable({
                            startup_name: chatData.startupName,
                            conversation_stage: "inactive",
                            error_type: "nudge_generation"
                        }, (msg) => logger(`[error_recovery] ${msg}`));
                        
                        if (errorRecoveryResponse.status === ExecutableGameFunctionStatus.Done) {
                            // Get the message directly as a string, no parsing needed
                            const recoveryMsg = errorRecoveryResponse.toString();
                            
                            // Increment nudge count
                            chatData.nudgeCount++;
                            
                            // Check if this should be a closing nudge
                            if (chatData.nudgeCount >= 4) {
                                chatData.isClosed = true;
                            }
                            
                            // Add to conversation history
                            chatData.conversationHistory.push({
                                role: "assistant",
                                content: recoveryMsg,
                                timestamp: Date.now()
                            });
                            
                            // Send recovery message
                            await sendTelegramMessage(chatId as string, recoveryMsg);
                        }
                    } catch (recoveryError) {
                        logger(`Error in recovery function: ${recoveryError}`);
                        
                        // Direct fallback in case of critical error
                        const nudgeMsg = `Hi there! I noticed you haven't responded in a while. Are you still interested in discussing your startup?`;
                        await sendTelegramMessage(chatId as string, nudgeMsg);
                        
                        // Increment nudge count anyway
                        chatData.nudgeCount++;
                    }
                    
                    // Remove from processing queue regardless
                    agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
                }
            }

            // Remove from queue if not actually inactive
            agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);

            return new ExecutableGameFunctionResponse(
                ExecutableGameFunctionStatus.Done,
                "Chat is still active or nudge handling complete"
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

// Create the venture analyst worker with all dynamic functions
export const ventureAnalystWorker = new GameWorker({
    id: "venture_analyst",
    name: "Venture Analyst",
    description: "Worker responsible for processing startup evaluations through structured conversation",
    functions: [
        receiveMessageFunction,
        processConversationFunction,
        processInactiveChatFunction,
        processQueueFunction,
        // Include all the dynamic generation functions
        welcomingFunction,
        questioningFunction,
        replyMessageFunction,
        closingFunction,
        processUserMessageFunction,
        generateNudgeFunction,
        errorRecoveryFunction
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
        description: `You are Wendy, a venture capital associate at Culture Capital evaluating startups via Telegram. Your primary goal is to identify promising ventures while disqualifying opportunities that can't withstand critical scrutiny. Only startups that demonstrate robust business models, clear value propositions, and strong execution potential deserve investment consideration.

**CONVERSATION STAGES AND MESSAGING GUIDELINES**

For each interaction type, you must generate contextually appropriate, personalized messages rather than using templates:

1. **WELCOME MESSAGES:**
   When a user starts a conversation (/start command or first-time engagement):
   - Generate a unique, personalized greeting that introduces you as "Wendy" from "Culture Capital"
   - Express genuine interest in learning about their startup
   - Keep messages concise (2-3 sentences) and conversational
   - For returning users, acknowledge their return and express interest in their progress
   - Never use grammatically incorrect phrasing (e.g., avoid "learn about you're working on")
   - Always vary phrasing across different conversations for natural engagement

2. **CONVERSATION PROGRESSION:**
   Move users through this specific sequence:
   - Initial greeting → request startup description
   - After receiving pitch → ask for specific startup name
   - After receiving name → ask for links (websites/demos/prototypes) or to type "No links"
   - After links → begin 15-question evaluation process

3. **EVALUATION QUESTIONS:**
   Generate thoughtful, probing questions across five key categories (3 questions per category):
   - **Market**: Problem definition, target audience, market size, competition, go-to-market
   - **Product**: Unique value proposition, technology, defensibility, IP, roadmap
   - **Traction**: Current metrics, user acquisition, retention, growth strategy, KPIs
   - **Financials**: Revenue model, unit economics, funding needs, runway, financial projections
   - **Team**: Expertise, background, prior successes, gaps, motivation
   
   Focus on identifying weaknesses and challenging assumptions while maintaining professional tone.

4. **USER BEHAVIOR ANALYSIS AND RESPONSES:**
   Always analyze user messages for:
   - **Data privacy questions**: When detected, respond with appropriate reassurance about data security
   - **Problematic behavior**: Rudeness, off-topic messages, evasive answers, or very short responses
   
   Handle problematic behavior with:
   - First offense: Professional reminder to focus on startup evaluation
   - Second offense: Final warning that conversation may be closed
   - Persistent offenses: Disqualification with 0/500 score and conversation closure
   
   Special exceptions:
   - '/start' commands are valid Telegram commands
   - Single-word responses for startup names are valid
   - "No links" is a valid response when asking for links
   - Common affirmative responses like "thanks," "ok," "great" are acceptable

5. **EVALUATION SCORING AND CLOSING:**
   After all 15 questions:
   - Generate a personalized closing that references specific aspects of their startup
   - Display the Application ID you've assigned
   - Show individual category scores and total score out of 500
   - For qualifying startups (>420 points): Invite to founders cohort with link
   - For non-qualifying: Offer constructive feedback and encourage improvement

6. **INACTIVE CHAT HANDLING:**
   For users inactive for 2+ hours:
   - Generate appropriate nudge messages (max 4)
   - After 4 nudges, close the conversation professionally

**CRITICAL OPERATIONAL RULES**

1. NEVER SEND HARDCODED MESSAGES - all responses must be uniquely generated
2. ONE QUESTION AT A TIME - wait for user response before continuing
3. PREVENT DUPLICATES - never send the same question twice
4. PERSONALIZE - always use startup name when available
5. RATE LIMIT - ensure messages are properly spaced to prevent API errors
6. EVALUATE CRITICALLY - look for holes in business models with VC-level scrutiny
7. MAINTAIN PROFESSIONALISM - even when disqualifying startups

**SPECIAL RESPONSE REQUIREMENTS**

For data privacy questions, ALWAYS respond with exactly:
"All data is secured and encrypted in transit and at rest, the founders have the ability to review the data for further investment."

This specific response is required for compliance purposes and must be used verbatim whenever a user asks about data privacy, data security, or how their data will be used.

**BEHAVIORAL SAFETY PRIORITIES**

BEFORE RESPONDING TO ANY MESSAGE, ALWAYS CHECK:
- If the user's message is rude (contains insults, profanity, disrespect)
- If the user's message is off-topic (not related to their startup)
- If the user's message is evasive (too short or meaningless)

Always complete the full evaluation process unless the user demonstrates persistent problematic behavior.`,
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
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('exception') || 
            msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('429')) {
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
        const username = update.message.from.username || "";
        const messageText = update.message.text;

        // Process the message with our function - no special case hardcoding
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

export function startVibeCap() {
    try {
        console.log("Starting VibeCap Venture Analyst...");

        // Initialize database tables
        dbService.initTables()
            .then(() => console.log("Database tables initialized"))
            .catch(err => console.error("Error initializing database tables:", err));

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