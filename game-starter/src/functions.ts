import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env file only in local development
// Railway automatically provides environment variables in production/staging
if (process.env.ENVIRONMENT !== 'production' && process.env.ENVIRONMENT !== 'staging') {
  console.log('Loading environment variables from .env file for local development');
  config({ path: resolve(__dirname, '../.env') });
} else {
  console.log(`Using environment variables from Railway (${process.env.ENVIRONMENT} environment)`);
}

import {
  GameFunction,
  ExecutableGameFunctionResponse,
  ExecutableGameFunctionStatus,
} from "@virtuals-protocol/game";

// Function to send questions and manage conversation flow
const questioningFunction = new GameFunction({
  name: "ask_question",
  description: "Ask the user questions about their startup and process their responses",
  args: [
    { name: "questionType", description: "Type of question to ask (welcome, pitch, market, traction, team, technology, revenue, problem)" },
    { name: "previousResponses", description: "Previous responses from the user to avoid duplicate questions" },
    { name: "questionCount", description: "Current count of questions asked to track limit" }
  ] as const,

  executable: async (args, logger) => {
    try {
      const { questionType, previousResponses, questionCount } = args;

      // Check if we've reached question limit
      const count = parseInt(questionCount as string) || 0;
      if (count >= 15) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "Question limit reached, proceed to closing"
        );
      }

      let message = "";

      // Generate appropriate question based on type and context
      if (questionType === "welcome") {
        message = "Hi! I am Wendy, your Associate at Vibe Capital. I'd like to learn about your startup to evaluate its potential. Could you start by telling me your startup's name and a 1-2 sentence description of what you do?";
      } else {
        // Generate dynamic, contextual questions based on previous responses
        // This will rely on the LLM's ability to formulate appropriate questions
        // No hardcoded word bank - the LLM should generate these based on context

        // Example logic for different question types (the actual implementation would rely on LLM)
        switch (questionType) {
          case "market":
            message = "Based on what you've shared, I'd like to understand more about your target market. What's the total addressable market size and how do you plan to capture it?";
            break;
          case "traction":
            message = "Let's talk about traction. How many daily active users do you have now, and what growth are you projecting in the next 6 months?";
            break;
          case "team":
            message = "Could you tell me about your founding team's background and relevant expertise in this domain?";
            break;
          case "technology":
            message = "What technological innovations set your product apart, and how have you designed your onboarding process to minimize friction?";
            break;
          case "revenue":
            message = "Regarding your business model, what's your current revenue situation and monetization strategy going forward?";
            break;
          case "problem":
            message = "What specific problem are you solving, and how painful is this problem for your target users?";
            break;
          default:
            message = "Could you elaborate more on your startup's vision and how you plan to execute it?";
        }
      }

      // Use reply_message function to send the question
      // In a real implementation, you would call the actual Telegram API here
      logger(`Sending question to user: ${message}`);

      // Here you would integrate with the Telegram webhook to send the message

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          message: message,
          questionCount: count + 1
        })
      );
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to ask question: " + errorMessage
      );
    }
  },
});

// Function to reply to user messages
const replyMessageFunction = new GameFunction({
  name: "reply_message",
  description: "Reply to a message",
  args: [
    { name: "message", description: "The message to reply" },
    {
      name: "media_url",
      description: "The media url to attach to the message",
      optional: true,
    },
  ] as const,

  executable: async (args, logger) => {
    try {
      // TODO: Implement replying to message with image
      if (args.media_url) {
        logger(`Reply with media: ${args.media_url}`);
      }

      // TODO: Implement replying to message
      logger(`Replying to message: ${args.message}`);

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        `Replied with message: ${args.message}`
      );
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to reply to message"
      );
    }
  },
});

// Function to close the conversation and provide evaluation
const closingFunction = new GameFunction({
  name: "close_conversation",
  description: "Close the conversation and provide final evaluation",
  args: [
    { name: "conversationData", description: "All collected data from the conversation" },
    { name: "isForced", description: "Whether this is a forced close due to question limit or user requested", optional: true },
    { name: "isClosed", description: "Whether the conversation is already closed", optional: true }
  ] as const,

  executable: async (args, logger) => {
    try {
      const { conversationData, isForced, isClosed } = args;

      // If conversation is already closed, remind the user
      if (isClosed) {
        const conversationObj = typeof conversationData === 'string'
          ? JSON.parse(conversationData)
          : conversationData || {};

        const appId = conversationObj.appId || `VC-${Date.now().toString(36)}-CLOSED`;
        const reminder = `I'm sorry, but our evaluation session has already concluded. Your application ID is ${appId}. Thank you again for your time!`;

        // Send the reminder via Telegram webhook
        logger(`Sending closure reminder: ${reminder}`);

        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({ message: reminder, closed: true })
        );
      }

      // Generate a unique App ID
      const appId = `VC-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`.toUpperCase();

      // Evaluate the startup based on the conversation data
      // This would be handled by the LLM's reasoning capabilities

      // Calculate scores (0-100) based on collected data
      const executionScore = Math.floor(Math.random() * 31) + 70; // Placeholder for actual evaluation logic
      const marketScore = Math.floor(Math.random() * 31) + 70;
      const growthScore = Math.floor(Math.random() * 31) + 70;
      const returnPotentialScore = Math.floor(Math.random() * 31) + 70;

      const overallScore = Math.floor((executionScore + marketScore + growthScore + returnPotentialScore) / 4);

      // Create closing message with App ID and scores
      const closingMessage = `Thank you for sharing details about your startup! Based on our conversation, I've completed my evaluation.\n\nYour Application ID is: ${appId}\n\nYour venture received an overall rating of ${overallScore}/100, reflecting our assessment of your execution capability, market approach, growth potential, and investment return profile.\n\nThe Vibe Capital team will contact you if there's interest in further discussions. Best of luck with your venture!`;

      // Send the closing message via Telegram webhook
      logger(`Sending closing message: ${closingMessage}`);

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          message: closingMessage,
          appId: appId,
          scores: {
            execution: executionScore,
            market: marketScore,
            growth: growthScore,
            returnPotential: returnPotentialScore,
            overall: overallScore
          },
          closed: true
        })
      );
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to close conversation: " + errorMessage
      );
    }
  },
});

// Function to process user messages
const processUserMessageFunction = new GameFunction({
  name: "process_user_message",
  description: "Process a user message and determine the next action",
  args: [
    { name: "conversationState", description: "Current state of the conversation" },
    { name: "message", description: "The user's message" },
  ] as const,

  executable: async (args, logger) => {
    try {
      const { conversationState, message } = args;

      // Store the user's response
      const stateObj = typeof conversationState === 'string'
        ? JSON.parse(conversationState)
        : conversationState || {};

      const updatedState = {
        ...stateObj,
        responses: [...(stateObj.responses || []), message]
      };

      // Determine if we've reached question limit
      const questionCount = updatedState.questionCount || 0;
      if (questionCount >= 15) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({
            action: "close_conversation",
            conversationState: updatedState,
            isForced: true
          })
        );
      }

      // Determine next question type based on conversation history
      // This would rely on the LLM's understanding of the conversation flow
      let nextQuestionType;

      if (updatedState.questionCount === 0) {
        // After welcome, ask about pitch
        nextQuestionType = "pitch";
      } else if (updatedState.questionCount === 1) {
        // After pitch, ask about market
        nextQuestionType = "market";
      } else {
        // For subsequent questions, cycle through the different categories
        // The actual implementation would be more sophisticated and context-aware
        const questionTypes = ["traction", "team", "technology", "revenue", "problem"];
        nextQuestionType = questionTypes[updatedState.questionCount % questionTypes.length];
      }

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          action: "ask_question",
          questionType: nextQuestionType,
          conversationState: updatedState
        })
      );
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to process user message: " + errorMessage
      );
    }
  },
});

// Function to generate personalized welcome messages via LLM
const welcomingFunction = new GameFunction({
  name: "generate_welcome_message",
  description: "Use LLM to generate a personalized, unique welcome message based on conversation context",
  args: [
    { name: "is_returning", description: "Whether this user has interacted before (true/false)", optional: true },
    { name: "username", description: "The Telegram username of the user if available", optional: true },
    { name: "conversation_stage", description: "Current stage of conversation (initial, interest_confirmed, collecting_details)", optional: true },
    { name: "startup_name", description: "Startup name if already provided", optional: true },
    { name: "startup_pitch", description: "Startup pitch if already provided", optional: true },
    { name: "user_response", description: "The user's latest response", optional: true }
  ] as const,
  
  executable: async (args, logger) => {
    try {
      const isReturning = args.is_returning === true || args.is_returning === "true";
      const username = args.username || "";
      const conversationStage = args.conversation_stage || "initial";
      const userResponse = args.user_response || "";
      const startupName = args.startup_name || "";
      const startupPitch = args.startup_pitch || "";
      
      // Create context string for logging
      let context = `${isReturning ? "returning" : "new"} user at stage ${conversationStage}`;
      if (username) context += ` with username ${username}`;
      
      logger(`Generating LLM message for ${context}`);
      
      // Initialize response data structure
      const responseData = {
        message: "",
        conversation_stage: conversationStage,
        startup_name: startupName,
        startup_pitch: startupPitch,
        collection_complete: false
      };
      
      // Create appropriate system prompt based on conversation stage
      let systemPrompt = "";
      
      if (conversationStage === "initial") {
        // First contact - system prompt for asking about interest in pitching
        systemPrompt = `
          You are Wendy, an AIssociate at Culture Capital, a venture capital firm.
          Generate a friendly, professional welcome message for a${isReturning ? " returning" : ""} potential founder${username ? ` named ${username}` : ""}.
          
          YOUR MESSAGE MUST:
          1. Start with a personal greeting (like "Hi", "Hello", "Aloha", or similar warm greeting)
          2. Include your name "Wendy" and your role as "AIssociate at Culture Capital"
          3. Ask if they're interested in pitching their startup to you today
          4. Make it clear that your purpose is to learn about and evaluate startups with potential
          
          TONE GUIDELINES:
          - Be friendly but professional (you're representing a VC firm)
          - Be concise (keep the message under 2 sentences)
          - Show enthusiasm about hearing their ideas
          - Sound natural and conversational, not scripted
          
          The message should feel personally crafted for this interaction, not like a template.
        `;
        
        // Next stage will depend on user response
        responseData.conversation_stage = "awaiting_interest_confirmation";
        
      } else if (conversationStage === "awaiting_interest_confirmation") {
        // Analyze user response to determine if they're interested
        const positiveResponses = ["yes", "yeah", "yep", "sure", "ok", "okay", "definitely", "absolutely", "interested", "of course"];
        const isPositive = positiveResponses.some(response => 
          userResponse.toLowerCase().includes(response)
        );
        
        // System prompt for requesting startup details
        systemPrompt = `
          You are Wendy, an AIssociate at Culture Capital, a venture capital firm.
          The user ${isPositive ? "has expressed interest" : "may be interested"} in pitching their startup.
          
          Generate a friendly, professional message requesting specific details about their startup.
          
          YOUR MESSAGE MUST:
          1. ${isPositive ? "Acknowledge their interest positively" : "Gently encourage them to share details"}
          2. Specifically ask for their startup name
          3. Request a 1-2 sentence description of what their startup does
          4. Make it clear that this information will help you evaluate their venture
          
          TONE GUIDELINES:
          - Be friendly but professional
          - Be direct and clear about what information you need
          - Show enthusiasm about learning more
          - Keep the message concise (1-3 sentences)
        `;
        
        responseData.conversation_stage = "collecting_details";
        
      } else if (conversationStage === "collecting_details") {
        // Analyze user response to extract startup information
        // This would be handled by sophisticated NLP in a real implementation
        // For now, use some basic checks to determine if this looks like a valid response
        
        const words = userResponse.split(/\s+/);
        const hasValidResponse = words.length >= 5; // Very basic check for minimum content
        
        if (hasValidResponse) {
          // Extract startup name and pitch using simple heuristics
          // In practice, you'd want more sophisticated extraction
          
          // Store extracted information (this simplified version just stores the response)
          // A more advanced implementation would use NLP to extract these properly
          responseData.startup_name = userResponse.split(/[.!?]/)[0].trim();
          responseData.startup_pitch = userResponse;
          
          // System prompt for confirming and transitioning to evaluation
          systemPrompt = `
            You are Wendy, an AIssociate at Culture Capital, a venture capital firm.
            The user has just shared information about their startup.
            
            Generate a message that:
            1. Thanks them for sharing details
            2. Confirms you've recorded their information
            3. Transitions to evaluation by asking about their target market
            4. Specifically asks what problem they're solving and how painful it is for users
            
            TONE GUIDELINES:
            - Be appreciative and enthusiastic about their venture
            - Sound genuinely interested in learning more
            - Be professional but warm
            - Keep your message under 3 sentences
          `;
          
          responseData.conversation_stage = "evaluation";
          responseData.collection_complete = true;
          
        } else {
          // System prompt for requesting more details
          systemPrompt = `
            You are Wendy, an AIssociate at Culture Capital, a venture capital firm.
            The user hasn't provided enough information about their startup.
            
            Generate a message that:
            1. Gently explains you need more information
            2. Clearly requests their startup's name
            3. Asks for a 1-2 sentence description of what they're building
            4. Emphasizes this will help you properly evaluate their venture
            
            TONE GUIDELINES:
            - Be encouraging and helpful, not critical
            - Be specific about what information you need
            - Be concise but friendly
          `;
          
          responseData.conversation_stage = "collecting_details";
        }
      }
      
      // Here you would call your LLM with the systemPrompt
      // In a real implementation, this would be an API call to OpenAI, Anthropic, etc.
      // For this example, I'll simulate the response
      
      // Simulated LLM-generated message based on the system prompt
      // In a real implementation, this would come from the LLM API
      
      // *******************************************
      // In an actual implementation, you would:
      // 1. Call your LLM API with the systemPrompt
      // 2. Get the generated text response
      // 3. Assign it to responseData.message
      // *******************************************
      
      // For demonstration purposes only - simulate different responses
      // These would actually come from the LLM in a real implementation
      if (conversationStage === "initial") {
        responseData.message = username ?
          `Aloha ${username}! I'm Wendy, your AIssociate at Culture Capital. Would you be interested in pitching your startup to me today? I'm here to learn about and evaluate ventures with potential.` :
          `Hi there! I'm Wendy, an AIssociate working with Culture Capital. I'm looking for promising startups to evaluate - would you like to pitch yours to me today?`;
      } else if (conversationStage === "awaiting_interest_confirmation") {
        responseData.message = `Great! I'd love to hear about your venture. Could you please share your startup's name and give me a 1-2 sentence description of what you're building?`;
      } else if (conversationStage === "collecting_details" && hasValidResponse) {
        responseData.message = `Thanks for sharing those details! I've noted them down. Now, I'd like to understand more about your target market - what specific problem are you solving, and how painful is this problem for your users?`;
      } else {
        responseData.message = `I need a bit more information to properly evaluate your startup. Could you please provide your startup's name and a brief 1-2 sentence description of what you're building?`;
      }
      
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify(responseData)
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate welcome message: " + errorMessage
      );
    }
  },
});

export {
  questioningFunction,
  replyMessageFunction,
  closingFunction,
  processUserMessageFunction,
  welcomingFunction
};