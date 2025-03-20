// Types for chat functionality
export interface ChatState {
    conversationStage: string;
    startupName: string;
    startupPitch: string;
    startupLinks: string[];
    questionCount: number;
    scores: {
        market: number;
        product: number;
        traction: number;
        financials: number;
        team: number;
    };
}

export interface ChatOptions {
    partnerId: string;
    partnerName: string;
    getStateFn: () => ChatState;
}

export enum FunctionResultStatus {
    Success = 'success',
    Failed = 'failed',
    Pending = 'pending'
}

export interface FunctionResult {
    status: FunctionResultStatus;
    message?: string;
    data?: any;
}

export interface Function {
    name: string;
    description: string;
    execute: (input: any) => Promise<FunctionResult>;
}

export interface ChatResponse {
    message: string;
    functionCall?: {
        fn_name: string;
        args: any;
    };
} 