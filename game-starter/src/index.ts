import { activity_agent, telegramPlugin } from './agent';

async function main() {
    try {
        // Initialize the agent
        await activity_agent.init();
        // await activity_agent.initWorkers()

        telegramPlugin.onMessage(async (msg) => {
            console.log('Custom message handler:', msg);
        });

        telegramPlugin.onPollAnswer((pollAnswer) => {
            console.log('Custom poll answer handler:', pollAnswer);
            // You can process the poll answer as needed
        });

        telegramPlugin.onMessage(async (msg) => {
            const agentTgWorker = activity_agent.getWorkerById(telegramPlugin.getWorker().id);
            const task = "Reply to chat id: " + msg.chat.id + " and the incoming is message: " + msg.text + " and the message id is: " + msg.message_id;

            await agentTgWorker.runTask(task, {
                verbose: true, // Optional: Set to true to log each step
            });
        });


        // Run the agent
        while (true) {
            await activity_agent.step({ verbose: true });
        }
    } catch (error) {
        console.error("Error running activity recommender:", error);
    }
}

main(); 