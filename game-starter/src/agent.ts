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
  
  dotenv.config();
  
  if (!process.env.API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error('API_KEY and TELEGRAM_BOT_TOKEN are required in environment variables');
  }
  
  // Rate limiting configuration
  const RATE_LIMIT = {
    MIN_DELAY: 10000, // 10 seconds minimum between actions
    MAX_DELAY: 60000, // 60 seconds maximum
    CURRENT_DELAY: 10000,
    BACKOFF_FACTOR: 1.5
  };
  
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
      lastActivity: number;
      nudgeCount: number;
      questionCount: number;
      messageCount: number;
      conversationHistory: Array<{role: string; content: string; timestamp: number}>;
      isClosed: boolean;
      scores: Record<string, number>;
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
        lastActivity: Date.now(),
        nudgeCount: 0,
        questionCount: 0,
        messageCount: 0,
        conversationHistory: [],
        isClosed: false,
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
    
    // If it's been less than our current delay threshold since the last processing, wait
    if (timeSinceLastProcess < RATE_LIMIT.CURRENT_DELAY) {
      const waitTime = RATE_LIMIT.CURRENT_DELAY - timeSinceLastProcess;
      console.log(`Rate limiting: Waiting ${waitTime}ms before processing next request (level: ${agentState.rateLimitCounter})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Update the last processed time
    agentState.lastProcessedTime = Date.now();
    
    // Check for inactive chats that need nudges
    const currentTime = Date.now();
    Object.entries(agentState.activeChats).forEach(([chatId, chatData]) => {
      // Skip closed conversations
      if (chatData.isClosed) return;
      
      // Check if chat is inactive (2 hours)
      const inactiveTime = currentTime - chatData.lastActivity;
      if (inactiveTime > 2 * 60 * 60 * 1000) { // 2 hours
        if (chatData.nudgeCount < 4) {
          // Add to processing queue if not already there
          if (!agentState.processingQueue.includes(chatId)) {
            agentState.processingQueue.push(chatId);
          }
        } else if (chatData.nudgeCount >= 4) {
          // Auto-close after 4 nudges
          chatData.isClosed = true;
          if (!agentState.processingQueue.includes(chatId)) {
            agentState.processingQueue.push(chatId);
          }
        }
      }
    });
    
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
  
  // Create a Telegram plugin with the required functions
  export const telegramPlugin = new TelegramPlugin({
    credentials: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    description: "Telegram bot plugin that handles message sending and receiving for the VibeCap venture analyst system",
    id: "telegram_connector",
    name: "Telegram Connector"
  });
  
  // Comprehensive function to process messages based on conversation stage
  const processMessageFunction = new GameFunction({
    name: "process_user_message",
    description: "Process a user message based on conversation stage and update internal state",
    args: [
      { name: "chatId", description: "The chat ID where the message was received" },
      { name: "userId", description: "The user ID who sent the message" },
      { name: "message", description: "The message content received from the user" },
      { name: "currentStage", description: "Current conversation stage (welcome, pitch, links, evaluation, closing)" }
    ] as const,
  
    executable: async (args, logger) => {
      try {
        const { chatId, userId, message = '', currentStage } = args;
        
        // Initialize or get chat data
        const chatData = initChatData(chatId as string, userId as string);
        
        // Update activity timestamp
        chatData.lastActivity = Date.now();
        chatData.messageCount++;
        
        // Add message to conversation history
        chatData.conversationHistory.push({
          role: "user",
          content: message,
          timestamp: Date.now()
        });
        
        // Process based on conversation stage
        let response = "";
        let nextStage = currentStage;
        
        switch (currentStage) {
          case "welcome":
            // Store initial pitch information
            chatData.startupPitch = message;
            response = "Thanks for sharing! Could you provide the name of your startup?";
            nextStage = "startup_name";
            break;
            
          case "startup_name":
            // Store startup name
            chatData.startupName = message;
            response = "Great! Do you have any links to demos, websites, or prototypes? Please share them now, or type 'No links' if you don't have any.";
            nextStage = "links";
            break;
            
          case "links":
            // Store links if any
            if (message.toLowerCase() !== "no links") {
              // Extract URLs from message
              const urlRegex = /(https?:\/\/[^\s]+)/g;
              const links = message.match(urlRegex) || [];
              chatData.startupLinks = links;
            }
            
            // Begin evaluation with first question
            response = "Thanks! Now I'd like to understand more about your target market. What specific problem are you solving, and how painful is this problem for your users?";
            chatData.questionCount++;
            nextStage = "evaluation";
            break;
            
          case "evaluation":
            // Update relevant score based on question count (simplified for example)
            const questionIndex = chatData.questionCount - 1;
            const categories = ["market", "product", "traction", "financials", "team"];
            const category = categories[questionIndex % 5];
            
            // Score response (in real implementation, this would be more sophisticated)
            chatData.scores[category] += Math.floor(Math.random() * 15) + 10; // 10-25 points per answer
            chatData.scores[category] = Math.min(chatData.scores[category], 100); // Cap at 100
            
            // Generate next question or move to closing
            if (chatData.questionCount >= 15) {
              // Move to closing after 15 questions
              nextStage = "closing";
              
              // Calculate total score
              const totalScore = Object.values(chatData.scores).reduce((sum, score) => sum + score, 0);
              const qualifies = totalScore > 420;
              
              // Prepare closing message
              response = `Thank you for sharing details about ${chatData.startupName}! 🌺\n\nYour Application ID is: ${chatData.appId}\n\n`;
              response += `Your venture received the following scores:\n`;
              
              for (const [category, score] of Object.entries(chatData.scores)) {
                response += `- ${category.charAt(0).toUpperCase() + category.slice(1)}: ${score}/100\n`;
              }
              
              response += `\nTotal Score: ${totalScore}/500\n\n`;
              
              if (qualifies) {
                response += `We're impressed with your venture! Please join Wendy's Founders Cohort to discuss next steps: https://t.me/+MqqBtDgyCFhhODc5`;
                agentState.totalQualifiedStartups++;
              } else {
                response += `Thank you for your submission. Please revisit and pitch again in one week to join Wendy's Founders Cohort.`;
              }
              
              chatData.isClosed = true;
              agentState.totalEvaluations++;
            } else {
              // Generate next question based on conversation flow and question count
              const nextQuestions = [
                "How large is your target market in terms of potential users and revenue?",
                "What makes your product different from existing solutions in the market?",
                "Could you share your current traction metrics (users, growth rate, retention)?",
                "What's your current revenue model and financial situation?",
                "Tell me about your founding team's background and relevant expertise.",
                "How do you plan to acquire customers and what's your CAC/LTV ratio?",
                "What are the biggest challenges you're facing right now?",
                "How defensible is your technology or business model?",
                "What's your vision for the company in the next 3-5 years?",
                "If you don't raise funding, how will you continue to grow the business?",
                "What key metrics do you track to measure success?",
                "How do you handle user feedback and product iterations?",
                "What's your distribution strategy to reach your target market?",
                "How do you plan to use the funding you're seeking?"
              ];
              
              // Get next question
              response = nextQuestions[chatData.questionCount - 1];
              chatData.questionCount++;
            }
            break;
            
          case "closing":
            // Handle any messages after closing
            response = `I appreciate your additional input, but our evaluation for ${chatData.startupName} is complete. Your Application ID is ${chatData.appId}. If you have a new startup to pitch, please start a new conversation.`;
            break;
            
          default:
            // Default welcome message for any other stage
            response = "Hi! I am Wendy, your Associate at Vibe Capital. I'd like to learn about your startup to evaluate its potential. Could you start by telling me what your startup does in 1-2 sentences?";
            nextStage = "welcome";
        }
        
        // Add response to conversation history
        chatData.conversationHistory.push({
          role: "assistant",
          content: response,
          timestamp: Date.now()
        });
        
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({
            response,
            nextStage,
            chatData
          })
        );
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Failed,
          "Failed to process message: " + errorMessage
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
        
        // If already closed, remove from queue
        if (chatData.isClosed) {
          // Remove from processing queue
          agentState.processingQueue = agentState.processingQueue.filter(id => id !== chatId);
          return new ExecutableGameFunctionResponse(
            ExecutableGameFunctionStatus.Done,
            "Chat already closed"
          );
        }
        
        // If inactive for 2+ hours
        const inactiveTime = Date.now() - chatData.lastActivity;
        if (inactiveTime > 2 * 60 * 60 * 1000) { // 2 hours
          chatData.nudgeCount++;
          
          let message = "";
          if (chatData.nudgeCount >= 4) {
            // Close conversation after 4 nudges
            message = `I haven't heard back from you regarding ${chatData.startupName || "your startup"}, so I'll be closing this evaluation. Feel free to start a new conversation when you're ready to continue. Your application ID is ${chatData.appId}.`;
            chatData.isClosed = true;
          } else {
            // Send nudge
            message = `I noticed it's been a while since our last interaction. Are you still there? I'd love to continue our conversation about ${chatData.startupName || "your startup"}.`;
          }
          
          // Add to conversation history
          chatData.conversationHistory.push({
            role: "assistant",
            content: message,
            timestamp: Date.now()
          });
          
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
  
  // Create workers with unified state
  export const ventureAnalystWorker = new GameWorker({
    id: "venture_analyst",
    name: "Venture Analyst",
    description: "Worker responsible for processing user messages, evaluating startup potential, and managing conversation flow",
    functions: [
      processMessageFunction,
      processInactiveChatFunction
    ],
    getEnvironment: async () => {
      // Return a clean copy of agent state to avoid mutation
      return {
        activeChats: { ...agentState.activeChats },
        processingQueue: [...agentState.processingQueue],
        totalEvaluations: agentState.totalEvaluations,
        totalQualifiedStartups: agentState.totalQualifiedStartups
      };
    }
  });
  
  // Function to initialize the agent with a shared environment getter
  export const initializeAgent = () => {
    // Ensure API_KEY is available
    if (!process.env.API_KEY) {
      throw new Error('API_KEY is required in environment variables');
    }
    
    console.log("Initializing Venture Capital Assistant agent");
    
    const agent = new GameAgent(process.env.API_KEY, {
      name: "vibecap_associate",
      goal: "Evaluate startups through structured conversation, scoring responses against key metrics, and qualifying promising ventures",
      description: `You are Wendy, a venture capital associate who evaluates startups via Telegram conversations. You must:
  
  1. MAINTAIN STRICT RATE LIMITS: Wait 10+ seconds between messages and API calls.
  2. FOLLOW CONVERSATION FLOW:
     - Welcome new users → Request startup pitch → Collect startup name → Ask for demo links
     - Ask ONE evaluation question at a time (never multiple questions)
     - Ask 15 total evaluation questions covering: Market, Team, Financials, Traction, Product
     - Wait for user responses before asking next question
     - Show typing indicator while preparing responses
  
  3. MANAGE STATE:
     - Track conversation stage, startup details, and scores per chat
     - Process messages according to conversation stage
     - Score responses (up to 100 points per category)
     - Handle inactive chats (nudge after 2 hours, close after 4 nudges)
     
  4. CLOSE CONVERSATIONS:
     - Provide final evaluation after 15 questions
     - Include Application ID and category scores
     - If total score exceeds 420/500: Provide founders cohort link
     - If score below 420/500: Suggest reapplying in one week
     
  USE TELEPORT PLUGIN CORRECTLY:
  - All messages MUST be sent via telegram_connector.send_message
  - All media via telegram_connector.send_media
  - All typing indicators via telegram_connector.send_chat_action`,
      workers: [
        telegramPlugin.getWorker({
          functions: [
            telegramPlugin.sendMessageFunction,
            telegramPlugin.sendMediaFunction,
            telegramPlugin.deleteMessageFunction,
          ],
          getEnvironment: async () => {
            // Return agent state data for context
            return {
              activeChats: { ...agentState.activeChats },
              processingQueue: [...agentState.processingQueue]
            };
          }
        }),
        ventureAnalystWorker
      ],
      llmModel: "Qwen2.5-72B-Instruct", // Advanced model for nuanced evaluation
      getAgentState
    });
    
    // Enhanced logger with timestamps
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