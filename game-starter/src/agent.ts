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
      conversationHistory: Array<{role: string; content: string; timestamp: number}>;
      isClosed: boolean;
      scores: Record<string, number>;
      lastMessage: string;  // Store the last message sent to prevent duplicates
      offTopicCount: number;
      lastMessageWasOffTopic: boolean;
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
        },
        offTopicCount: 0,
        lastMessageWasOffTopic: false
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
          await sendTelegramMessage(chatId as string, welcomeMsg);
          
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
            const possibleName = extractStartupName(lastUserMessages[0].content);
            responseMsg = `Just to confirm, your startup's name is "${possibleName}". Is that correct? (Yes/No)`;
            chatData.conversationStage = 'confirm_name';
            break;
            
          case "confirm_name":
            // Handle user confirmation
            if (message.toLowerCase() === "yes") {
              chatData.startupName = possibleName;
              responseMsg = "Great! Do you have any links to demos, websites, or prototypes? Please share them now, or type 'No links' if you don't have any.";
              chatData.conversationStage = 'links';
            } else {
              responseMsg = "I'm sorry, I didn't catch that. Could you please repeat your response?";
              chatData.conversationStage = 'confirm_name';
            }
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
            const category = categories[questionIndex % 5];
            
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
  
  // Function to detect off-topic or inappropriate content
  const detectOffTopicContent = new GameFunction({
    name: "detect_off_topic_content",
    description: "Analyze a message to determine if it's off-topic, inappropriate, or unrelated to startup discussions",
    args: [
      { name: "message", description: "The message content to analyze" }
    ] as const,
    
    executable: async (args, logger) => {
      try {
        const { message } = args;
        
        if (!message) {
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Failed,
            "Message content is required"
          );
        }
        
        // Define patterns that might indicate off-topic or inappropriate content
        const offTopicPatterns = [
          // Offensive language patterns
          /\b(fuck|shit|ass|bitch|cunt|dick|pussy|asshole|bastard)\b/i,
          
          // Non-startup related commands or questions
          /\b(tell me a joke|what is your name|who made you|how do you work|are you ai)\b/i,
          
          // Testing or probing patterns
          /\b(test|testing|just checking|what can you do)\b/i,
          
          // Random unrelated topics
          /\b(weather|sports|news|politics|movie|game|play|song|music)\b/i
        ];
        
        // Look for matches with off-topic patterns
        const isOffTopic = offTopicPatterns.some(pattern => pattern.test(message as string));
        
        // Exclude legitimate greetings from being flagged
        const greetingPatterns = /\b(hello|hi|hey|greetings|good morning|good afternoon|good evening)\b/i;
        const isJustGreeting = greetingPatterns.test(message as string) && (message as string).length < 20;
        
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({
            isOffTopic: isOffTopic && !isJustGreeting,
            reason: isOffTopic ? "Message contains potential off-topic or inappropriate content" : "Message appears relevant"
          })
        );
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          "Failed to analyze message content: " + errorMessage
        );
      }
    }
  });
  
  // Function to handle off-topic messages with appropriate responses
  const handleOffTopicMessageFunction = new GameFunction({
    name: "handle_off_topic_message",
    description: "Generate appropriate responses to off-topic or inappropriate messages",
    args: [
      { name: "chatId", description: "The chat ID where the off-topic message was received" },
      { name: "message", description: "The off-topic message content" }
    ] as const,
    
    executable: async (args, logger) => {
      try {
        const { chatId, message } = args;
        
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
        
        // Increment off-topic count
        chatData.offTopicCount = (chatData.offTopicCount || 0) + 1;
        chatData.lastMessageWasOffTopic = true;
        
        // Check if we've reached the limit
        if (chatData.offTopicCount >= 7) {
          // Close the conversation
          return await closeOffTopicConversationFunction.executable({ chatId }, logger);
        }
        
        // Generate a redirect response based on current situation
        let responseMsg = "";
        const remainingWarnings = 7 - chatData.offTopicCount;
        
        // Different responses based on how many warnings they've had
        if (chatData.offTopicCount === 1) {
          responseMsg = `I appreciate your message, but I'm specifically here to evaluate startup pitches. Could we please stay focused on your business concept? `;
        } else if (chatData.offTopicCount < 4) {
          responseMsg = `I notice we're getting off-topic. As a venture capital associate, my role is to analyze startups. You have ${remainingWarnings} warnings before this evaluation will be closed. `;
        } else {
          responseMsg = `This is a reminder that I'm here solely to evaluate startup pitches. This is warning #${chatData.offTopicCount} of 7 before your evaluation is closed with a failing score. `;
        }
        
        // Add stage-specific prompt to get back on track
        switch (chatData.conversationStage) {
          case "welcome":
            responseMsg += "Could you please tell me about your startup and what it does?";
            break;
          case "startup_name":
            responseMsg += "I still need to know the name of your startup. What is it called?";
            break;
          case "confirm_name":
            responseMsg += `Is "${chatData.startupName}" the correct name of your startup? Please answer Yes or No.`;
            break;
          case "links":
            responseMsg += "Do you have any links to demos, websites, or prototypes to share? If not, just say 'No links'.";
            break;
          case "evaluation":
            // Find the last asked question and repeat it
            const lastQuestion = chatData.conversationHistory
              .filter(msg => msg.role === "assistant" && !msg.content.includes("off-topic"))
              .pop();
            
            if (lastQuestion) {
              responseMsg += "Let's get back to our evaluation. " + lastQuestion.content;
            } else {
              responseMsg += "Let's continue evaluating your startup. What problem is your startup solving?";
            }
            break;
          default:
            responseMsg += "Could you tell me about your startup?";
        }
        
        // Add to conversation history
        chatData.conversationHistory.push({
          role: "assistant",
          content: responseMsg,
          timestamp: Date.now()
        });
        
        // Send the message
        await sendTelegramMessage(chatId as string, responseMsg);
        
        // Remove from processing queue
        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
        
        logger(`Handled off-topic message in chat ${chatId} (warning #${chatData.offTopicCount})`);
        
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({
            chatId,
            message: responseMsg,
            offTopicCount: chatData.offTopicCount,
            remainingWarnings
          })
        );
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          "Failed to handle off-topic message: " + errorMessage
        );
      }
    }
  });
  
  // Function to close conversation after too many off-topic messages
  const closeOffTopicConversationFunction = new GameFunction({
    name: "close_off_topic_conversation",
    description: "Close a conversation due to too many off-topic or inappropriate messages",
    args: [
      { name: "chatId", description: "The chat ID to close" }
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
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            "Chat already closed"
          );
        }
        
        // Create closure message
        const closureMessage = `I notice our conversation has veered off-topic multiple times. As a venture capital associate, I'm specifically here to evaluate startup pitches. Your conversation has been closed with a score of 0/500 due to lack of relevant startup information. If you have a genuine startup to pitch, please start a new conversation and stay focused on your business concept. Your Application ID was ${chatData.appId}.`;
        
        // Mark conversation as closed
        chatData.isClosed = true;
        
        // Zero out scores
        for (const category in chatData.scores) {
          chatData.scores[category] = 0;
        }
        
        // Add to conversation history
        chatData.conversationHistory.push({
          role: "assistant",
          content: closureMessage,
          timestamp: Date.now()
        });
        
        // Send message
        await sendTelegramMessage(chatId as string, closureMessage);
        
        // Remove from processing queue
        agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
        
        logger(`Closed conversation ${chatId} due to off-topic violations`);
        
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done, 
          JSON.stringify({
            chatId,
            message: closureMessage,
            reason: "Too many off-topic messages"
          })
        );
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          "Failed to close off-topic conversation: " + errorMessage
        );
      }
    }
  });
  
  // Create the venture analyst worker
  export const ventureAnalystWorker = new GameWorker({
    id: "venture_analyst",
    name: "Venture Analyst",
    description: "Worker responsible for processing startup evaluations through structured conversation",
    functions: [
      receiveMessageFunction,
      processConversationFunction,
      processInactiveChatFunction,
      processQueueFunction,
      detectOffTopicContent,
      handleOffTopicMessageFunction,
      closeOffTopicConversationFunction
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
      description: `You are Wendy, a venture capital associate evaluating startups via Telegram. Follow these critical rules:

1. ONE QUESTION AT A TIME: Never send multiple questions in succession. Always wait for a user response.

2. PREVENT DUPLICATES: Ensure the same question is never sent twice within a short timeframe.

3. FOLLOW CONVERSATION FLOW: Progress through welcome → pitch → name → links → 15 evaluation questions → closing.

4. MAINTAIN RATE LIMITS: Messages must be spaced at least 10 seconds apart to prevent API errors.

5. INACTIVE HANDLING: Only send nudges after 2 hours of inactivity, with maximum 4 nudges over 8 hours.

6. SCORING: Score all responses in the five categories. After 15 total questions are answered, provide the final score and next steps.

7. OFF-TOPIC DETECTION: Identify when users are being annoying, off-topic, coy, mean, or rude, but treat normal greetings as acceptable.

8. PROFESSIONAL REDIRECT: When users go off-topic, firmly but professionally redirect them back to startup evaluation with clear warnings.

9. CONSEQUENCES: After 7 off-topic messages, close the conversation with a failing score. Each on-topic message reduces the warning count by 1.

Your job is specifically to evaluate startups, not engage in casual conversation. Apply venture capital standards to qualify promising ventures while maintaining a professional, direct approach.`,
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
      }, (msg) => console.log(`[receive_message] ${msg}`