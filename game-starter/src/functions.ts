import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env file only in local development
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

// Function to generate personalized welcome messages
const welcomingFunction = new GameFunction({
  name: "generate_welcome_message",
  description: "Generate a personalized welcome message for new or returning users",
  args: [
    { name: "is_returning", description: "Whether this user has conversed before ('true' or 'false')" },
    { name: "username", description: "User's Telegram username if available" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const isReturning = args.is_returning === "true";
      const username = args.username || "";
      
      logger(`Generating welcome message for ${isReturning ? "returning" : "new"} user${username ? ` with username ${username}` : ""}`);
      
      // THIS IS THE KEY CHANGE - return a direct string message that the agent will replace
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        `Hello${username ? ` ${username}` : ""}! I'm Wendy, your AIssociate at Culture Capital. I'd love to learn what you're working on so I can evaluate its potential. Can you tell me about your startup?`
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

// Function to generate evaluation questions
const questioningFunction = new GameFunction({
  name: "generate_evaluation_question",
  description: "Generate a tailored question to evaluate a specific aspect of a startup",
  args: [
    { name: "category", description: "Category to evaluate: market, product, traction, financials, or team" },
    { name: "question_number", description: "Which question in sequence (1-3) for this category" },
    { name: "startup_name", description: "Name of the startup being evaluated" },
    { name: "previous_answers", description: "Summary of previous answers in this category if available" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const { category, question_number, startup_name, previous_answers } = args;
      
      logger(`Generating ${category} question #${question_number} for ${startup_name || "startup"}`);
      
      // Return a direct string message instead of JSON
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        `Let's talk about the ${category} aspect of ${startup_name || "your startup"}. Question ${question_number}: How would you describe your target market size and the specific customer segments you're addressing?`
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate evaluation question: " + errorMessage
      );
    }
  },
});

// Function to generate contextual responses
const replyMessageFunction = new GameFunction({
  name: "generate_response",
  description: "Generate appropriate response based on conversation context",
  args: [
    { name: "context", description: "Context requiring response (ask_name, ask_links, behavior_warning, data_privacy, etc.)" },
    { name: "startup_name", description: "Name of startup if available" },
    { name: "user_message", description: "User's message being responded to" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const { context, startup_name, user_message } = args;
      
      logger(`Generating ${context} response for ${startup_name || "startup"}`);
      
      // Return a direct string message instead of JSON
      let responseMsg = "";
      
      switch (context) {
        case "ask_name":
          responseMsg = `Thanks for sharing that! What's the name of your startup?`;
          break;
        case "ask_links":
          responseMsg = `Great to learn about ${startup_name || "your startup"}! Do you have any websites, demos, or product links you'd like to share? If not, just type "No links".`;
          break;
        case "conversation_closed":
          responseMsg = `I'm sorry, but our evaluation of ${startup_name || "your startup"} has been completed. If you'd like to start a new evaluation, please type /start.`;
          break;
        default:
          responseMsg = `I understand. Let's continue discussing ${startup_name || "your startup"}.`;
      }
      
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        responseMsg
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate response: " + errorMessage
      );
    }
  },
});

// Function to generate closing evaluations
const closingFunction = new GameFunction({
  name: "generate_closing_evaluation",
  description: "Generate final evaluation with scores and next steps",
  args: [
    { name: "startup_name", description: "Name of the startup" },
    { name: "app_id", description: "Application ID assigned to this startup" },
    { name: "category_scores", description: "JSON string with scores for each category" },
    { name: "total_score", description: "Total evaluation score (0-500)" },
    { name: "qualified", description: "Whether startup qualified ('true' or 'false')" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const { startup_name, app_id, category_scores, total_score, qualified } = args;
      const isQualified = args.qualified === "true";
      
      logger(`Generating final evaluation for ${startup_name || "startup"} with score ${total_score}/500`);
      
      // Build a direct string message with the evaluation details
      let scores = "";
      try {
        const parsedScores = JSON.parse(category_scores || "{}");
        scores = Object.entries(parsedScores)
          .map(([category, score]) => `${category.charAt(0).toUpperCase() + category.slice(1)}: ${score}/100`)
          .join('\n');
      } catch (e) {
        scores = "Scores unavailable";
      }
      
      const closingMsg = `Thank you for sharing details about ${startup_name || "your startup"}!\n\n` +
        `Your application ID is: ${app_id}\n\n` +
        `Here's your evaluation:\n${scores}\n` +
        `Total score: ${total_score}/500\n\n` +
        (isQualified ? 
          `Congratulations! Your startup has qualified for our founders cohort. We'll be in touch soon with next steps.` :
          `We appreciate your submission, but your startup doesn't meet our current investment criteria. We encourage you to continue developing your business and apply again in the future.`);
      
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        closingMsg
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate closing evaluation: " + errorMessage
      );
    }
  },
});

// Function to analyze user messages
const processUserMessageFunction = new GameFunction({
  name: "analyze_user_message",
  description: "Analyze user message for data privacy questions, problematic behavior, etc.",
  args: [
    { name: "message", description: "User message content to analyze" },
    { name: "conversation_stage", description: "Current stage in conversation flow" },
    { name: "previous_warnings", description: "Number of previous behavior warnings issued" }
  ] as const,
  executable: async (args, logger) => {
    try {
      // Add default empty string to message parameter
      const { message = "", conversation_stage, previous_warnings } = args;
      
      logger(`Analyzing user message at ${conversation_stage} stage`);
      
      // For this function, we need to return structured data
      // But we'll make it super simple to parse
      const isDataPrivacy = message.toLowerCase().includes("data privacy") || 
                       message.toLowerCase().includes("protect my data") ||
                       message.toLowerCase().includes("what will you do with my data");
      
      // Return a simple JSON string that's easy to parse
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          is_data_privacy: isDataPrivacy
        })
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to analyze user message: " + errorMessage
      );
    }
  },
});

// Generate nudge messages for inactive users
const generateNudgeFunction = new GameFunction({
  name: "generate_nudge",
  description: "Generate a nudge message for inactive users",
  args: [
    { name: "startup_name", description: "Name of the startup if available" },
    { name: "nudge_count", description: "Number of previous nudges (1-4)" },
    { name: "last_activity_hours", description: "Hours since last user activity" },
    { name: "app_id", description: "Application ID for the conversation" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const { startup_name, nudge_count, last_activity_hours, app_id } = args;
      
      const count = parseInt(nudge_count as string) || 1;
      const isClosing = count >= 4;
      
      logger(`Generating ${isClosing ? "closing" : "nudge"} message #${count} for ${startup_name || "startup"}`);
      
      // Create a simple JSON response that's easy to parse
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          message: `Hi there! I noticed you haven't responded in a while${startup_name ? ` regarding ${startup_name}` : ""}. ${isClosing ? "Since we haven't heard back from you, I'm closing this evaluation. Feel free to start a new one anytime with /start." : "Are you still interested in continuing our conversation?"}`,
          is_closing: isClosing
        })
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate nudge message: " + errorMessage
      );
    }
  },
});

// Generate error recovery messages
const errorRecoveryFunction = new GameFunction({
  name: "generate_error_recovery",
  description: "Generate a response when an error occurs in processing",
  args: [
    { name: "startup_name", description: "Name of the startup if available" },
    { name: "conversation_stage", description: "Current stage in conversation" },
    { name: "error_type", description: "Type of error that occurred" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const { startup_name, conversation_stage, error_type } = args;
      
      logger(`Generating error recovery for ${error_type} at ${conversation_stage} stage`);
      
      // Return a direct message string rather than a JSON structure
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        `I apologize for the technical issue. Let's continue our conversation${startup_name ? ` about ${startup_name}` : ""}. Could you tell me more about your startup?`
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Failed,
        "Failed to generate error recovery: " + errorMessage
      );
    }
  },
});

export {
  questioningFunction,
  replyMessageFunction,
  closingFunction,
  processUserMessageFunction,
  welcomingFunction,
  generateNudgeFunction,
  errorRecoveryFunction
};