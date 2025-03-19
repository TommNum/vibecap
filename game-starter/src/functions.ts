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
    { name: "username", description: "User's Telegram username if available" },
    { name: "message", description: "The message to reply" }
  ] as const,
  executable: async (args, logger) => {
    try {
      const isReturning = args.is_returning === "true";
      const username = args.username || "";

      logger(`Generating welcome message for ${isReturning ? "returning" : "new"} user${username ? ` with username ${username}` : ""}`);

      // Generate different welcome messages based on whether the user is returning
      let welcomeText;

      if (isReturning) {
        welcomeText = `Welcome back${username ? ` ${username}` : ""}! I'm glad you've returned to chat with me at Culture Capital. I'd love to hear what you're working on now and evaluate its potential. What can you tell me about your startup?`;
      } else {
        welcomeText = `Hello${username ? ` ${username}` : ""}! I'm Wendy, your AIssociate at Culture Capital. I'd love to learn what you're working on so I can evaluate its potential. Can you tell me about your startup?`;
      }

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        args.message ?? welcomeText
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
      const { category, question_number, startup_name } = args;

      logger(`Generating ${category} question #${question_number} for ${startup_name || "startup"}`);

      // Return a direct question string based on category and question number
      let questionText;
      if (category === "market") {
        questionText = `Tell me more about your target market for ${startup_name || "your startup"}. Who are your ideal customers and what problem are you solving for them?`;
      } else if (category === "product") {
        questionText = `What makes your product unique compared to existing solutions in the market?`;
      } else if (category === "traction") {
        questionText = `What kind of traction do you have so far with ${startup_name || "your startup"}? Any metrics you can share?`;
      } else if (category === "financials") {
        questionText = `What's your current revenue model and financial situation?`;
      } else {
        questionText = `Tell me about your founding team and their relevant experience in this domain.`;
      }

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        questionText // Direct string message
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

      // Generate appropriate contextual response based on the context
      let responseText;

      if (context === "ask_name") {
        responseText = `Thanks for sharing that information! To better evaluate your startup, I'd like to know its name. What's the name of your startup?`;
      } else if (context === "ask_links") {
        responseText = `Great to learn about ${startup_name || "your startup"}! Do you have any websites, demos, or product links you'd like to share? If not, just type "No links".`;
      } else if (context === "conversation_closed") {
        responseText = `I'm sorry, but our evaluation of ${startup_name || "your startup"} has been completed. If you'd like to start a new evaluation, please type /start.`;
      } else if (context === "behavior_warning") {
        responseText = `I appreciate your engagement, but I'd like to focus our conversation on evaluating ${startup_name || "your startup"}. Could you please share more specific details about your business?`;
      } else {
        responseText = `Thanks for sharing that information about ${startup_name || "your startup"}. Let's continue our evaluation.`;
      }

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        responseText
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
      const isQualified = qualified === "true";
      const score = parseInt(total_score || "0");

      logger(`Generating final evaluation for ${startup_name || "startup"} with score ${score}/500`);

      // Parse the category scores
      let scoresText = "";
      try {
        const parsedScores = JSON.parse(category_scores || "{}");
        scoresText = Object.entries(parsedScores)
          .map(([category, score]) => `${category.charAt(0).toUpperCase() + category.slice(1)}: ${score}/100`)
          .join('\n');
      } catch (e) {
        scoresText = "Scores unavailable";
      }

      // Generate different closing messages based on qualification status
      let qualificationText;
      if (isQualified) {
        qualificationText = `Congratulations! ${startup_name || "Your startup"} has qualified for our founders cohort. A member of our investment team will be in touch within 5 business days to discuss next steps.`;
      } else {
        qualificationText = `While there are interesting aspects to ${startup_name || "your startup"}, it doesn't currently meet our investment criteria. We encourage you to continue developing your business and consider reapplying in 3-6 months.`;
      }

      // Compose the full closing message
      const closingText = `Thank you for sharing details about ${startup_name || "your startup"}!\n\n` +
        `Your application ID is: ${app_id}\n\n` +
        `Here's your evaluation:\n${scoresText}\n` +
        `Total score: ${score}/500\n\n` +
        qualificationText;

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        closingText
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
      const { message = "", conversation_stage, previous_warnings } = args;

      logger(`Analyzing user message at ${conversation_stage} stage`);

      // Improved data privacy detection with more variations
      const lowerMessage = message.toLowerCase();
      const isDataPrivacy =
        lowerMessage.includes("data privacy") ||
        lowerMessage.includes("protect my data") ||
        lowerMessage.includes("what will you do with my data") ||
        lowerMessage.includes("what do you do with my data") ||
        lowerMessage.includes("how do you use my data") ||
        lowerMessage.includes("data security") ||
        lowerMessage.includes("information security") ||
        lowerMessage.includes("is my data safe") ||
        lowerMessage.includes("data protection") ||
        lowerMessage.includes("privacy policy") ||
        lowerMessage.includes("share my data") ||
        lowerMessage.includes("data stored") ||
        (lowerMessage.includes("my data") && (
          lowerMessage.includes("what") ||
          lowerMessage.includes("how") ||
          lowerMessage.includes("asking about") ||
          lowerMessage.includes("question about")
        )) ||
        (lowerMessage.includes("privacy") && lowerMessage.includes("data"));

      // Also detect if user is asking a direct question about the process
      const isDirectQuestion =
        (lowerMessage.startsWith("what") ||
          lowerMessage.startsWith("how") ||
          lowerMessage.startsWith("why") ||
          lowerMessage.includes("?")) &&
        !isDataPrivacy; // Don't double-count data privacy questions

      // Return appropriate analysis result
      if (isDataPrivacy) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "DATA_PRIVACY_QUESTION"
        );
      } else if (isDirectQuestion) {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "DIRECT_QUESTION"
        );
      } else {
        return new ExecutableGameFunctionResponse(
          ExecutableGameFunctionStatus.Done,
          "NORMAL_MESSAGE"
        );
      }
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

      const count = parseInt(nudge_count || "1");
      const isClosing = count >= 4;
      const hours = parseInt(last_activity_hours || "2");

      logger(`Generating ${isClosing ? "closing" : "nudge"} message #${count} for ${startup_name || "startup"}`);

      // Generate different nudge messages based on the count
      let nudgeText;

      if (isClosing) {
        nudgeText = `Since we haven't heard back from you regarding ${startup_name || "your startup"} in ${hours} hours, I'm closing this evaluation for now. If you're still interested in getting evaluated by Culture Capital, you can start a new conversation anytime by typing /start.`;
      } else if (count === 1) {
        nudgeText = `Hi there! It's been ${hours} hours since your last message about ${startup_name || "your startup"}. Are you still interested in continuing our conversation? I'd love to hear more.`;
      } else if (count === 2) {
        nudgeText = `I'm following up on our conversation about ${startup_name || "your startup"}. If you're still interested in completing the evaluation process, I'm here to continue. Is there anything specific you'd like me to clarify?`;
      } else {
        nudgeText = `This is my final check-in regarding our evaluation of ${startup_name || "your startup"}. If I don't hear back from you soon, I'll need to close this conversation. Would you like to continue?`;
      }

      // For this function, we still need to return a structured object
      // since the agent.ts code is looking for specific properties
      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        JSON.stringify({
          message: nudgeText,
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

      // Generate different recovery messages based on the error type and conversation stage
      let recoveryText;

      if (error_type === "conversation_processing") {
        recoveryText = `I apologize for the technical issue. Let's continue our conversation about ${startup_name || "your startup"}. Could you share more details about what you're building?`;
      } else if (error_type === "closed_response") {
        recoveryText = `I'm sorry, but our evaluation of ${startup_name || "your startup"} has been completed. You can start a new evaluation by typing /start.`;
      } else if (error_type === "nudge_generation") {
        recoveryText = `I noticed we haven't continued our conversation about ${startup_name || "your startup"} in a while. Are you still interested in completing the evaluation?`;
      } else {
        recoveryText = `I apologize for the technical difficulty. Let's continue our conversation${startup_name ? ` about ${startup_name}` : ""}. Could you tell me more about your startup?`;
      }

      return new ExecutableGameFunctionResponse(
        ExecutableGameFunctionStatus.Done,
        recoveryText
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