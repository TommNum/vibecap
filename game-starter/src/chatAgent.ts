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
        console.log(`[ChatAgent] Creating new chat for partner ${partnerId} (${partnerName})`);

        // Initialize chat state
        this.chats.set(partnerId, getStateFn());
        console.log(`[ChatAgent] Initialized chat state for ${partnerId}`);

        return {
            next: async (message: string): Promise<ChatResponse> => {
                try {
                    // Get current state
                    const state = getStateFn();
                    console.log(`[ChatAgent] Current state for ${partnerId}:`, state);

                    // Make API call to Virtuals API
                    console.log(`[ChatAgent] Making API call for ${partnerId} with message:`, message);
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

                    console.log(`[ChatAgent] Got API response for ${partnerId}:`, {
                        status: response.status,
                        hasMessage: !!response.data.message,
                        hasFunctionCall: !!response.data.functionCall
                    });

                    return {
                        message: response.data.message,
                        functionCall: response.data.functionCall
                    };
                } catch (error) {
                    console.error(`[ChatAgent] Error in chat ${partnerId}:`, error);
                    if (axios.isAxiosError(error)) {
                        console.error(`[ChatAgent] API Error details for ${partnerId}:`, {
                            status: error.response?.status,
                            data: error.response?.data,
                            headers: error.response?.headers
                        });
                    }
                    throw error; // Re-throw to be handled by the caller
                }
            }
        };
    }
} 