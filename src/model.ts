import { ObjectId } from "hydrooj";

export interface PackJudge {
    _id: string;
    domain: string;
    contestId: string;
    filePath: string;
    problemDirs: string[];
    candidates: Array<{ id: string; name: string }>;
    judgeRecords: Record<string, Record<string, ObjectId>>;
    judgeStatus: 'pending' | 'scanning' | 'ready' | 'judging' | 'completed' | 'error';
    progress: {
        total: number;
        judged: number;
        startAt?: Date;
    };
    actualBasePath?: string;
    actualPath?: string;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}
