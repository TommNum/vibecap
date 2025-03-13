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
      if (questionCount >= 15) {
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
          questionCount: questionCount + 1
        })
      );
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to ask question: " + e.message
      );
    }
  },
});

// Function to reply to user messages
const replyMessageFunction = new GameFunction({
  name: "reply_message",
  description: "Reply to a user message",
  args: [
    { name: "message", description: "The message to reply" }
  ] as const,

  executable: async (args, logger) => {
    try {
      // Log the message being sent
      logger(`Replying to message: ${args.message}`);

      // Here you would integrate with the Telegram webhook to send the message
      
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        `Replied with message: ${args.message}`
      );
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to reply to message: " + e.message
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
        const reminder = `I'm sorry, but our evaluation session has already concluded. Your application ID is ${conversationData.appId}. Thank you again for your time!`;
        
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
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to close conversation: " + e.message
      );
    }
  },
});

// Function to process incoming user messages
const processUserMessageFunction = new GameFunction({
  name: "process_user_message",
  description: "Process incoming user messages and determine next action",
  args: [
    { name: "message", description: "The message received from the user" },
    { name: "conversationState", description: "Current state of the conversation including question count, previous responses, etc." },
    { name: "isClosed", description: "Whether the conversation is already closed", optional: true }
  ] as const,
  
  executable: async (args, logger) => {
    try {
      const { message, conversationState, isClosed } = args;
      
      // If conversation is closed, use closing function to remind user
      if (isClosed) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({ action: "remind_closed", conversationState })
        );
      }
      
      // Check if this is a start command
      if (message.toLowerCase() === '/start') {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          JSON.stringify({ 
            action: "start_conversation", 
            questionType: "welcome",
            conversationState: {
              ...conversationState,
              questionCount: 0,
              responses: []
            }
          })
        );
      }
      
      // Store the user's response
      const updatedState = {
        ...conversationState,
        responses: [...(conversationState.responses || []), message]
      };
      
      // Determine if we've reached question limit
      if (updatedState.questionCount >= 15) {
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
    } catch (e) {
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to process user message: " + e.message
      );
    }
  },
});

export {
  questioningFunction,
  replyMessageFunction,
  closingFunction,
  processUserMessageFunction
};