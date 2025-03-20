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
        const state = options.getStateFn ? options.getStateFn() : {
            conversationStage: 'welcome',
            startupName: '',
            startupPitch: '',
            startupLinks: [],
            questionCount: 0,
            scores: {
                market: 0,
                product: 0,
                traction: 0,
                financials: 0,
                team: 0
            }
        };

        // Ensure state matches ChatState type
        const chatState: ChatState = {
            conversationStage: state.conversationStage || 'welcome',
            startupName: state.startupName || '',
            startupPitch: state.startupPitch || '',
            startupLinks: state.startupLinks || [],
            questionCount: state.questionCount || 0,
            scores: {
                market: state.scores?.market || 0,
                product: state.scores?.product || 0,
                traction: state.scores?.traction || 0,
                financials: state.scores?.financials || 0,
                team: state.scores?.team || 0
            }
        };

        this.chats.set(partnerId, chatState);

        return {
            next: async (message: string): Promise<ChatResponse> => {
                try {
                    // Get current state
                    const state = this.chats.get(partnerId);
                    console.log(`[ChatAgent] Sending message to Virtuals API for ${partnerId}:`, message);

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

                    console.log(`[ChatAgent] Raw response from Virtuals API for ${partnerId}:`, JSON.stringify(response.data, null, 2));

                    // Handle different possible response structures
                    let messageText = '';
                    let functionCall = null;

                    // Try different possible response structures
                    if (response.data.message) {
                        messageText = response.data.message;
                    } else if (response.data.response) {
                        messageText = response.data.response;
                    } else if (response.data.content) {
                        messageText = response.data.content;
                    } else if (typeof response.data === 'string') {
                        messageText = response.data;
                    }

                    // Handle function calls if present
                    if (response.data.function_call) {
                        functionCall = response.data.function_call;
                    } else if (response.data.functionCall) {
                        functionCall = response.data.functionCall;
                    }

                    console.log(`[ChatAgent] Processed response for ${partnerId}:`, {
                        message: messageText,
                        functionCall
                    });

                    return {
                        message: messageText,
                        functionCall
                    };
                } catch (error) {
                    console.error(`[ChatAgent] Error in chat ${partnerId}:`, error);
                    if (axios.isAxiosError(error)) {
                        console.error(`[ChatAgent] API Error details:`, {
                            status: error.response?.status,
                            data: error.response?.data,
                            headers: error.response?.headers
                        });
                    }
                    throw error;
                }
            }
        };
    }
} 