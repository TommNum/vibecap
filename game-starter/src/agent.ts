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
  
  // Extend GameAgent with a call method
  // This is necessary because the current GameAgent implementation doesn't include this method
  declare module "@virtuals-protocol/game" {
    interface GameAgent {
      call(workerId: string, functionName: string, args: Record<string, any>): Promise<string | null>;
    }
  }
  
  // Implementation of the call method for GameAgent
  GameAgent.prototype.call = async function(workerId: string, functionName: string, args: Record<string, any>): Promise<string | null> {
    try {
      const worker = this.getWorkerById(workerId);
      const fn = worker.functions.find(fn => fn.name === functionName);
      
      if (!fn) {
        console.error(`Function ${functionName} not found in worker ${workerId}`);
        return null;
      }
      
      // Convert args to the format expected by the function
      const formattedArgs = Object.entries(args).reduce((acc, [key, value]) => {
        acc[key] = { value: String(value) };
        return acc;
      }, {} as Record<string, { value: string }>);
      
      const result = await fn.execute(formattedArgs, (msg: string) => console.log(`[${this.name}] ${msg}`));
      return result.feedback;
    } catch (error) {
      console.error(`Error executing ${workerId}.${functionName}:`, error);
      return null;
    }
  };
  
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
      conversationStage: string;
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
        conversationStage: 'welcome', // Initial stage
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
    
    // Rate limiting
    if (timeSinceLastProcess < RATE_LIMIT.CURRENT_DELAY) {
      const waitTime = RATE_LIMIT.CURRENT_DELAY - timeSinceLastProcess;
      console.log(`Rate limiting: Waiting ${waitTime}ms before processing next request (level: ${agentState.rateLimitCounter})`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Update the last processed time
    agentState.lastProcessedTime = Date.now();
    
    // Check for inactive chats
    const currentTime = Date.now();
    Object.entries(agentState.activeChats).forEach(([chatId, chatData]) => {
      if (chatData.isClosed) return;
      
      const inactiveTime = currentTime - chatData.lastActivity;
      if (inactiveTime > 2 * 60 * 60 * 1000) { // 2 hours
        if (chatData.nudgeCount < 4) {
          if (!agentState.processingQueue.includes(chatId)) {
            agentState.processingQueue.push(chatId);
          }
        } else if (chatData.nudgeCount >= 4) {
          chatData.isClosed = true;
          if (!agentState.processingQueue.includes(chatId)) {
            agentState.processingQueue.push(chatId);
          }
        }
      }
    });
    
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
  
  // Create Telegram plugin
  export const telegramPlugin = new TelegramPlugin({
    credentials: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    description: "Telegram bot plugin that handles message sending and receiving for the VibeCap venture analyst system",
    id: "telegram_connector",
    name: "Telegram Connector"
  });
  
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
        chatData.messageCount++;
        
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
        
        // If conversation is closed, remind user
        if (chatData.isClosed) {
          const reminderMsg = `I appreciate your message, but our evaluation for ${chatData.startupName || "your startup"} is complete. Your Application ID is ${chatData.appId}. If you have a new startup to pitch, please start a new conversation.`;
          
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
          const welcomeMsg = "Hi! I am Wendy, your Associate at Vibe Capital. I'd like to learn about your startup to evaluate its potential. Could you start by telling me what your startup does in 1-2 sentences?";
          
          chatData.conversationHistory.push({
            role: "assistant",
            content: welcomeMsg,
            timestamp: Date.now()
          });
          
          logger(`Sending welcome message to chat ${chatId}`);
          
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
        
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({
            action,
            chatId
          })
        );
      } catch (e) {
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
    description: "Worker responsible for processing startup evaluations through structured conversation",
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
  
  // Initialize the agent
  export const initializeAgent = () => {
    if (!process.env.API_KEY) {
      throw new Error('API_KEY is required in environment variables');
    }
    
    console.log("Initializing VibeCap Venture Analyst agent");
    
    const agent = new GameAgent(process.env.API_KEY, {
      name: "vibecap_associate",
      goal: "Evaluate startups through structured conversation, scoring responses and qualifying promising ventures",
      description: `You are Wendy, a venture capital associate evaluating startups via Telegram. Follow these critical rules:
  
  1. WAIT FOR USER MESSAGES: Monitor the queue for incoming messages and respond promptly but with patience.
  
  2. USE ONE QUESTION AT A TIME: Ask exactly one question per message and wait for a response before continuing.
  
  3. FOLLOW EVALUATION FLOW:
     - Welcome → Get pitch → Get startup name → Ask for links → Ask 15 evaluation questions → Close
     - Track conversation stage to ensure proper flow
     - Show typing indicator while preparing responses
  
  4. MAINTAIN RATE LIMITS: Wait 10+ seconds between each message to prevent rate limiting.
  
  5. PROCESS MESSAGES CORRECTLY:
     - When Telegram sends a message, use venture_analyst.receive_message
     - Use venture_analyst.process_conversation to generate responses
     - Use telegram_connector.send_chat_action for typing indicators
     - Use telegram_connector.send_message to respond
  
  6. SCORING SYSTEM:
     - Score each response in one of five categories (market, product, traction, financials, team)
     - Maximum 100 points per category
     - After 15 questions, calculate final score and provide recommendation
  
  7. CLOSING PROCESS:
     - Show final scores and total (out of 500)
     - Provide Founders Cohort link if score > 420
     - Suggest reapplying in one week if score < 420
     - Include Application ID and hibiscus emoji (🌺)
  
  8. INACTIVE HANDLING:
     - Send nudge after 2 hours of inactivity
     - Close conversation after 4 nudges`,
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
    
    // Set up queue processing
    setInterval(() => {
      if (agentState.processingQueue.length > 0) {
        console.log(`Processing queue: ${agentState.processingQueue.length} items waiting`);
        
        // Get queue processing instructions
        agent.call('venture_analyst', 'process_queue', {})
          .then((result: string | null) => {
            if (result && typeof result === 'string') {
              try {
                const data = JSON.parse(result);
                if (data.action && data.chatId) {
                  // First show typing indicator
                  agent.call('telegram_connector', 'send_chat_action', {
                    chat_id: data.chatId,
                    action: 'typing'
                  }).then(() => {
                    // Process according to action type
                    agent.call('venture_analyst', data.action, {
                      chatId: data.chatId
                    }).then((actionResult: string | null) => {
                      if (actionResult && typeof actionResult === 'string') {
                        try {
                          const resultData = JSON.parse(actionResult);
                          if (resultData.message && resultData.chatId) {
                            // Send the response message
                            agent.call('telegram_connector', 'send_message', {
                              chat_id: resultData.chatId,
                              text: resultData.message
                            });
                          }
                        } catch (e) {
                          console.error('Error processing action result:', e);
                        }
                      }
                    });
                  });
                }
              } catch (e) {
                console.error('Error processing queue result:', e);
              }
            }
          })
          .catch((error: Error) => {
            console.error('Error in queue processing:', error);
          });
      }
    }, 15000); // Check every 15 seconds
    
    return agent;
  };
  
  // Function to handle incoming webhook updates
  export const handleTelegramUpdate = (update: any) => {
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id.toString();
      const userId = update.message.from.id.toString();
      const messageText = update.message.text;
      
      // Get agent instance
      const agent = initializeAgent();
      
      // Show typing indicator immediately
      agent.call('telegram_connector', 'send_chat_action', {
        chat_id: chatId,
        action: 'typing'
      });
      
      // Receive and queue the message
      agent.call('venture_analyst', 'receive_message', {
        chatId,
        userId,
        message: messageText
      });
    }
  };