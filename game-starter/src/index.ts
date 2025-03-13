import { activity_agent } from './agent';

async function main() {
    try {
        // Initialize the agent
        await activity_agent.init();
        // await activity_agent.initWorkers()

        // Run the agent
        while (true) {
            await activity_agent.step({ verbose: true });
        }
    } catch (error) {
        console.error("Error running activity recommender:", error);
    }
}

main(); 