import { ChatOptions, ChatResponse, ChatState } from './types';
import axios from 'axios';

export class ChatAgent {
    private apiKey: string;
    private guidelines: string;
    private chats: Map<string, ChatState>;

    constructor(apiKey: string, guidelines: string) {
        this.apiKey = apiKey;
        this.guidelines = guidelines;
        this.chats = new Map();
    }

    async createChat(options: ChatOptions): Promise<any> {
        const { partnerId, partnerName, getStateFn } = options;

        // Initialize chat state
        this.chats.set(partnerId, getStateFn());

        return {
            next: async (message: string): Promise<ChatResponse> => {
                try {
                    // Get current state
                    const state = getStateFn();

                    // Make API call to Virtuals API
                    const response = await axios.post(
                        'https://api.virtuals.io/v1/chat',
                        {
                            message,
                            state,
                            guidelines: this.guidelines,
                            partnerId,
                            partnerName
                        },
                        {
                            headers: {
                                'Authorization': `Bearer ${this.apiKey}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );

                    return {
                        message: response.data.message,
                        functionCall: response.data.functionCall
                    };
                } catch (error) {
                    console.error('Error in chat:', error);
                    throw error;
                }
            }
        };
    }
} 