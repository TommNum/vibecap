import { initializeAgent } from './agent';

// Function to start polling Telegram for updates
export function startTelegramPolling(botToken: string, interval = 1000) {
  console.log("Starting Telegram polling...");
  let lastUpdateId = 0;
  
  // Set up interval to poll regularly
  const pollingInterval = setInterval(async () => {
    try {
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
      
      // Process each update and queue messages
      for (const update of data.result) {
        // Update the lastUpdateId to acknowledge this update
        if (update.update_id >= lastUpdateId) {
          lastUpdateId = update.update_id;
        }
        
        // Process message if present
        if (update.message && update.message.text) {
          console.log(`Received message: ${update.message.text.substring(0, 50)}...`);
          
          // Get the agent
          const agent = initializeAgent();
          
          // Process the message with your existing handler
          const chatId = update.message.chat.id.toString();
          const userId = update.message.from.id.toString();
          const messageText = update.message.text;
          
          // Show typing indicator
          agent.call('telegram_connector', 'send_chat_action', {
            chat_id: chatId,
            action: 'typing'
          });
          
          // Queue message for processing
          agent.call('venture_analyst', 'receive_message', {
            chatId,
            userId,
            message: messageText
          });
        }
      }
    } catch (error) {
      console.error("Error in Telegram polling:", error);
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