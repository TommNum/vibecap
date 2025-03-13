import { GameAgent } from "@virtuals-protocol/game";
import TelegramPlugin from "./telegramPlugin";

// Create a worker with the functions
// Replace <BOT_TOKEN> with your Telegram bot token
const telegramPlugin = new TelegramPlugin({
  credentials: {
    botToken: "<BOT_TOKEN>",
  },
  description: "you are a worker that responds to users on telegram and receives user's messages. Your goal is to dig into the details of a founders project or business. You are asking market focus questions to size the opportunity of the business that the person is describing. You're asking traction details to see if they have product market fit and assessing how many daily active users do they have today and plan to have in the next coming months. You are asking financial questions about whether they have raised money if they have revenue coming in and plans to capitalize on their revenue model. You will be asking questions about the team, and understanding the landscape of their experience, their expertise, and their sheer grit and ability to execute. You will be evaluating the novelty of their tech and the innovation of their approach, while also understanding the clear, concise ability to onboard people without friction. HERE ARE RULES YOU MUST FOLLOW, EXTREMELY CRITICAL RULES: You should never ask a duplicate question to a user. You should NEVER repeat yourself to a user. You should always respond to the user unless the conversation is closed. You should NEVER ask more than 15 total questions. You should never send more than 25 total messages and remember only 15 can be questions. Once you send over 15 total questions and you receive 15 answers, you should close the conversation. All conversations should be closed with a unique App ID. The unique App ID needs to be sent to the user in the closing statement. The closing statement should be a salutation that thanks them for their time and says bye. Each conversation should have an app id applied. Each app id should be tracked with a score id that is based on the responses and judgement criteria. each score id should be defined by the abilty of the founders to execute on their plans, understand their market, and pivot on new observations within the market. The score should represent current potential of the business. the score should represent the upside and potential the business has for growth. the score should qualify the approach to the total addressable market and whether this could be a 100x return opportunity. This worker needs to be asking questions externally to the user. This worker needs to be assesing the responses of the individual internally and providing a score. The score should only be sent during the closing statement. The score should never be sent to the user before the closing statement.",
  id: "venture_analyst",
  name: "Venture Analyst"
});

telegramPlugin.onMessage(async (msg) => {
  console.log('Custom message handler:', msg);
});

telegramPlugin.onPollAnswer((pollAnswer) => {
  console.log('Custom poll answer handler:', pollAnswer);
  // You can process the poll answer as needed
});

/**
 * The agent will be able to send messages and pin messages automatically
 * Replace <API_TOKEN> with your API token
 */
const autoReplyAgent = new GameAgent("<API_TOKEN>", {
  name: "Telegram Bot",
  goal: "Auto reply message",
  description: "This agent will auto reply to messages",
  workers: [
    telegramPlugin.getWorker({
      // Define the functions that the worker can perform, by default it will use the all functions defined in the plugin
      functions: [
        telegramPlugin.sendMessageFunction,
        telegramPlugin.pinnedMessageFunction,
        telegramPlugin.unPinnedMessageFunction,
        telegramPlugin.createPollFunction,
        telegramPlugin.sendMediaFunction,
        telegramPlugin.deleteMessageFunction,
      ],
    }),
  ],
});

/**
 * Initialize the agent and start listening for messages
 * The agent will automatically reply to messages 
 */
(async () => {
  autoReplyAgent.setLogger((autoReplyAgent, message) => {
    console.log(`-----[${autoReplyAgent.name}]-----`);
    console.log(message);
    console.log("\n");
  });

  await autoReplyAgent.init();
  telegramPlugin.onMessage(async (msg) => {
    const agentTgWorker = autoReplyAgent.getWorkerById(telegramPlugin.getWorker().id);
    const task = "Reply to chat id: " + msg.chat.id + " and the incoming is message: " + msg.text + " and the message id is: " + msg.message_id;

    await agentTgWorker.runTask(task, {
      verbose: true, // Optional: Set to true to log each step
    });
  });
})();

/**
 * The agent is a Financial Advisor designed to provide financial advice and assistance
 */
const financialAdvisorAgent = new GameAgent("<API_TOKEN>", {
  name: "Financial Advisor Bot",
  goal: "Provide financial advice and assistance",
  description: "A smart bot designed to answer financial questions, provide investment tips, assist with budgeting, and manage financial tasks like pinning important messages or deleting outdated ones for better organization.",
  workers: [
    telegramPlugin.getWorker({
      // Define the functions that the worker can perform, by default it will use the all functions defined in the plugin
      functions: [
        telegramPlugin.sendMessageFunction,
        telegramPlugin.pinnedMessageFunction,
        telegramPlugin.unPinnedMessageFunction,
        telegramPlugin.createPollFunction,
        telegramPlugin.sendMediaFunction,
        telegramPlugin.deleteMessageFunction,
      ],
    }),
  ],
});

(async () => {
  financialAdvisorAgent.setLogger((financialAdvisorAgent, message) => {
    console.log(`-----[${financialAdvisorAgent.name}]-----`);
    console.log(message);
    console.log("\n");
  });

  await financialAdvisorAgent.init();
  telegramPlugin.onMessage(async (msg) => {
    const agentTgWorker = financialAdvisorAgent.getWorkerById(telegramPlugin.getWorker().id);
    const task = "Reply to chat id: " + msg.chat.id + " and the incoming is message: " + msg.text + " and the message id is: " + msg.message_id;

    await agentTgWorker.runTask(task, {
      verbose: true, // Optional: Set to true to log each step
    });
  });
})();

/**
 * The agent is a Nutritionist Bot designed for nutritional counseling and support
 */
const nutritionistAgent = new GameAgent("<API_TOKEN>", {
  name: "Nutritionist Bot",
  goal: "Provide evidence-based information and guidance about the impacts of food and nutrition on the health and wellbeing of humans.",
  description: "A smart bot designed to answer food and nutrition questions, provide personalized nutrition plans, nutritional counseling, motivate and support users in achieving their health goals.",
  workers: [
    telegramPlugin.getWorker({
      // Define the functions that the worker can perform, by default it will use the all functions defined in the plugin
      functions: [
        telegramPlugin.sendMessageFunction,
        telegramPlugin.pinnedMessageFunction,
        telegramPlugin.unPinnedMessageFunction,
        telegramPlugin.createPollFunction,
        telegramPlugin.sendMediaFunction,
        telegramPlugin.deleteMessageFunction,
      ],
    }),
  ],
});

(async () => {
  nutritionistAgent.setLogger((nutritionistAgent, message) => {
    console.log(`-----[${nutritionistAgent.name}]-----`);
    console.log(message);
    console.log("\n");
  });

  await nutritionistAgent.init();
  telegramPlugin.onMessage(async (msg) => {
    const agentTgWorker = nutritionistAgent.getWorkerById(telegramPlugin.getWorker().id);
    const task = "Reply professionally to chat id: " + msg.chat.id + " and the incoming is message: " + msg.text + " and the message id is: " + msg.message_id;

    await agentTgWorker.runTask(task, {
      verbose: true, // Optional: Set to true to log each step
    });
  });
})();
