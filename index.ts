// @noErrors
// @module: esnext
// @filename: index.ts
import { ensureDirSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs-extra';
import { v7 } from 'uuid';
import path from 'path';
import { WithId } from 'mongodb';
import {
    Context, db, Handler, ObjectId, param, PERM, PRIV, Types,
    ContestModel, RecordModel as record, UserModel as user, sleep, Tdoc, STATUS
} from 'hydrooj';

declare module 'hydrooj' {
    interface Collections {
        packJudge: PackJudge;
    }
}

interface PackJudge {
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
        submitted: number;
        startAt?: Date;
    };
    createdAt: Date;
    updatedAt: Date;
}

import config from './config';
import { dataURLToU8Array, readGBKFile, unzip } from './src/tools';
const buf = require('crypto').randomBytes(32);

const coll = db.collection('packJudge');

/**
 * 批量评测 Handler
 * 只有比赛所有者或域管理员才能访问
 */
class PackJudgeHandler extends Handler {
    tdoc?: Tdoc;
    tsdoc?: any;

    @param('tid', Types.ObjectId)
    async __prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await ContestModel.get(domainId, tid);
        // 检查权限：必须是比赛所有者或有编辑比赛权限
        if (!this.user.own(this.tdoc)) {
            this.checkPerm(PERM.PERM_EDIT_CONTEST);
        }
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const pjudges = await coll.find({ 
            domain: domainId, 
            contestId: tid.toHexString() 
        }).sort({ createdAt: -1 }).limit(10).toArray();

        this.response.body = {
            tdoc: this.tdoc,
            pjudges,
        };
        this.response.template = 'contest_pack_judge.html';
    }

    renderTitle() {
        return '批量评测';
    }

    @param('tid', Types.ObjectId)
    @param('op', Types.String, true)
    @param('file', Types.String, true)
    @param('problemDirs', Types.ArrayOf(Types.String), true)
    @param('packJudgeId', Types.String, true)
    @param('mode', Types.Range(['all', 'unjudged', 'selected']), true)
    @param('selectedIds', Types.ArrayOf(Types.String), true)
    async post(domainId: string, tid: ObjectId, op?: string, file?: string, problemDirs?: string[], packJudgeId?: string, mode?: string, selectedIds?: string[]) {
        if (file && problemDirs) {
            return this.doUpload(domainId, tid, file, problemDirs);
        }
        if (op === 'status') {
            return this.doStatus(domainId, tid, packJudgeId, op);
        }
        if (op === 'result') {
            return this.doResult(domainId, tid, packJudgeId, op);
        }
        if (packJudgeId && mode) {
             return this.doStartJudge(domainId, tid, packJudgeId, mode, selectedIds);
        }
        
        this.response.status = 400;
        this.response.body = { error: 'Invalid request' };
    }

    /**
     * 上传并扫描压缩包
     */
    async doUpload(domainId: string, tid: ObjectId, file: string, problemDirs: string[]) {
        const uuid = v7();
        const filePath = path.join(config.tmpdir, uuid);
        
        try {
            // 创建记录
            await coll.insertOne({
                _id: uuid,
                domain: domainId,
                contestId: tid.toHexString(),
                filePath,
                problemDirs,
                candidates: [],
                judgeRecords: {},
                judgeStatus: 'scanning',
                progress: { total: 0, judged: 0, submitted: 0 },
                createdAt: new Date(),
                updatedAt: new Date(),
            } as any);

            // 保存文件
            ensureDirSync(filePath);
            writeFileSync(path.join(filePath, 'package.zip'), dataURLToU8Array(file));

            // 异步扫描
            this.scanPackage(uuid).catch(console.error);

            this.response.type = 'json';
            this.response.body = {
                success: true,
                packJudgeId: uuid,
                message: 'Package uploaded, scanning...',
            };
        } catch (err) {
            console.error(err);
            this.response.type = 'json';
            this.response.body = {
                success: false,
                error: err.message,
            };
        }
    }

    /**
     * 扫描压缩包，识别准考证号和题目
     */
    async scanPackage(packJudgeId: string) {
        try {
            const pjudge = await coll.findOne({ _id: packJudgeId });
            if (!pjudge) throw new Error('PackJudge not found');

            const filePath = pjudge.filePath;
            const packagePath = path.join(filePath, 'package');

            // 解压
            await unzip(path.join(filePath, 'package.zip'), packagePath);

            let files = readdirSync(packagePath);
            let basePath = packagePath;
            
            // 如果只有一个子文件夹，进入子文件夹
            if (files.length === 1 && statSync(path.join(packagePath, files[0])).isDirectory()) {
                basePath = path.join(packagePath, files[0]);
                files = readdirSync(basePath);
                // 更新实际的包路径
                await coll.updateOne({ _id: packJudgeId }, {
                    $set: { actualPath: basePath }
                });
            }

            console.log(`[PackJudge] Scanning ${packJudgeId} at ${basePath}, files: ${files.length}`);

            // 扫描准考证号文件夹
            const candidates: Array<{ id: string; name: string }> = [];
            const dirs = files;
            let totalFiles = 0;

            for (const dir of dirs) {
                const dirPath = path.join(basePath, dir);
                if (!statSync(dirPath).isDirectory()) continue;
                
                // 检查是否包含题目文件夹
                const hasProblemDir = pjudge.problemDirs.some(pdir => {
                    const problemPath = path.join(dirPath, pdir);
                    // 检查目录是否存在，或者是否存在同名文件
                    return existsSync(problemPath) && statSync(problemPath).isDirectory();
                });

                if (hasProblemDir) {
                    candidates.push({ id: dir, name: dir });
                    for (const pdir of pjudge.problemDirs) {
                        const cppFile = path.join(dirPath, pdir, `${pdir}.cpp`);
                        if (existsSync(cppFile)) totalFiles++;
                    }
                }
            }

            console.log(`[PackJudge] Found ${candidates.length} candidates, ${totalFiles} files for ${packJudgeId}`);

            const currentPj = await coll.findOne({ _id: packJudgeId });
            if (currentPj && currentPj.judgeStatus === 'scanning') {
                await coll.updateOne({ _id: packJudgeId }, {
                    $set: {
                        candidates,
                        judgeStatus: 'ready',
                        'progress.total': totalFiles,
                        updatedAt: new Date(),
                        actualBasePath: basePath,
                    }
                });
            } else {
                await coll.updateOne({ _id: packJudgeId }, {
                    $set: {
                        candidates,
                        'progress.total': totalFiles,
                        updatedAt: new Date(),
                        actualBasePath: basePath,
                    }
                });
            }
        } catch (err) {
            console.error('Scan package error:', err);
            await coll.updateOne({ _id: packJudgeId }, {
                $set: {
                    judgeStatus: 'error',
                    error: err.message,
                    updatedAt: new Date(),
                }
            });
        }
    }

    /**
     * 获取包评测状态
     */
    async doStatus(_domainId: string, tid: ObjectId, packJudgeId: string, op: string) {
        if (op !== 'status') return;
        const pjudge = await coll.findOne({ _id: packJudgeId });
        
        this.response.type = 'json';
        this.response.body = {
            success: true,
            status: pjudge.judgeStatus,
            candidates: pjudge.candidates,
            progress: pjudge.progress,
        };
    }

    /**
     * 开始评测
     */
    async doStartJudge(domainId: string, tid: ObjectId, packJudgeId: string, mode: string, selectedIds?: string[]) {
        const pjudge = await coll.findOne({ _id: packJudgeId });
        if (!pjudge) throw new Error('PackJudge not found');
        if (pjudge.judgeStatus === 'judging' || pjudge.judgeStatus === 'scanning') {
            this.response.type = 'json';
            this.response.body = { success: false, error: '正在扫描或评测中，请稍后' };
            return;
        }

        // 更新状态
        await coll.updateOne({ _id: packJudgeId }, {
            $set: {
                judgeStatus: 'judging',
                'progress.startAt': new Date(),
                updatedAt: new Date(),
            }
        });

        this.response.type = 'json';
        this.response.body = { success: true, message: 'Judge started' };

        // 异步执行评测
        this.startJudge(domainId, tid, packJudgeId, mode, selectedIds).catch(console.error);
    }

    /**
     * 执行评测
     */
    async startJudge(domainId: string, tid: ObjectId, packJudgeId: string, mode: string, selectedIds?: string[]) {
        try {
            const pjudge = await coll.findOne({ _id: packJudgeId });
            if (!pjudge) throw new Error('PackJudge not found');

            const tdoc = await ContestModel.get(domainId, tid);
            const pids = tdoc.pids;
            const basePath = pjudge.actualBasePath || path.join(pjudge.filePath, 'package');

            // 确定要评测的候选人
            let candidatesToJudge = pjudge.candidates;
            if (mode === 'selected' && selectedIds) {
                candidatesToJudge = pjudge.candidates.filter(c => selectedIds.includes(c.id));
            } else if (mode === 'unjudged') {
                candidatesToJudge = pjudge.candidates.filter(c => !pjudge.judgeRecords[c.id]);
            }

            let judged = 0;
            const judgeRecords = pjudge.judgeRecords || {};

            for (const candidate of candidatesToJudge) {
                const candidateId = candidate.id;
                
                // 确保用户存在（创建正常用户）
                let uid = await user.getByUname(domainId, candidateId).then((u: any) => u?._id);
                if (!uid) {
                    // 创建正常用户，使用准考证号作为用户名和邮箱
                    try {
                        uid = await user.create(
                            `${candidateId}@packjudge.local`,  // 邮箱
                            candidateId,                        // 用户名
                            (() => {
                                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                                let pw = '';
                                for (let i = 0; i < 32; i++) pw += chars[buf[i] % chars.length];
                                return pw;
                            })(),
                            undefined,                          // 自动分配 uid
                            '127.0.0.1',                       // IP
                            0                                   // priv = 0 (普通用户)
                        );
                    } catch (e) {
                        console.error(`Failed to create user ${candidateId}:`, e);
                    }
                }

                // 检查用户是否已经参加比赛，如果没有则让用户参加
                const tsdoc = await db.collection('document.status').findOne({
                    docType: 30,
                    docId: tid,
                    uid,
                    domainId
                });
                if (!tsdoc || !tsdoc.attend) {
                    await ContestModel.attend(domainId, tid, uid);
                }

                judgeRecords[candidateId] = judgeRecords[candidateId] || {};

                // 对每道题目进行评测
                for (let i = 0; i < pjudge.problemDirs.length; i++) {
                    const problemDir = pjudge.problemDirs[i];
                    const problemPath = path.join(basePath, candidateId, problemDir);
                    const cppFile = path.join(problemPath, `${problemDir}.cpp`);

                    if (existsSync(cppFile)) {
                        try {
                            const code = await readGBKFile(cppFile);
                            const codeWithComment = `// packjudge: ${packJudgeId}
// user: ${candidateId}
// problem: ${problemDir}

${code}`;

                            const rid = await record.add(
                                domainId,
                                pids[i],
                                uid,
                                'cc.cc14o2',
                                codeWithComment,
                                true,
                                { contest: tid }
                            );

                            judgeRecords[candidateId][problemDir] = rid;
                            
                            // 立即更新数据库，确保前端能及时获取到 rid
                            const updateKey = `judgeRecords.${candidateId}.${problemDir}`;
                            await coll.updateOne({ _id: packJudgeId }, {
                                $set: {
                                    [updateKey]: rid,
                                    updatedAt: new Date(),
                                }
                            });

                            await sleep(500); // 避免提交过快
                        } catch (err) {
                            console.error(`Error judging ${candidateId}/${problemDir}:`, err);
                        }
                    }
                }

            }

        } catch (err) {
            console.error('Judge error:', err);
            await coll.updateOne({ _id: packJudgeId }, {
                $set: {
                    judgeStatus: 'error',
                    error: err.message,
                    updatedAt: new Date(),
                }
            });
        }
    }

    /**
     * 获取评测结果
     */
    async doResult(domainId: string, tid: ObjectId, packJudgeId: string, op: string) {
        if (op !== 'result') return;
        const pjudge = await coll.findOne({ _id: packJudgeId });
        if (!pjudge) {
            this.response.type = 'json';
            this.response.body = { success: false, error: 'PackJudge not found' };
            return;
        }

        const judgeResult: Record<string, Record<string, any>> = {};
        let submittedCount = 0;
        const totalProblems = pjudge.progress.total;
        
        for (const candidateId of Object.keys(pjudge.judgeRecords)) {
            const userRecords = pjudge.judgeRecords[candidateId];
            judgeResult[candidateId] = {};
            
            for (const problemDir of Object.keys(userRecords)) {
                const rid = userRecords[problemDir];
                if (!rid) continue;
                submittedCount++;
                
                judgeResult[candidateId][problemDir] = {
                    _id: rid,
                };
            }
        }

        // 更新进度和状态
        let newStatus = pjudge.judgeStatus;
        if (pjudge.judgeStatus === 'judging') {
            if (submittedCount === totalProblems && totalProblems > 0) {
                newStatus = 'completed';
            }
        }

        await coll.updateOne({ _id: packJudgeId }, {
            $set: {
                'progress.submitted': submittedCount,
                judgeStatus: newStatus,
                updatedAt: new Date(),
            }
        });

        this.response.type = 'json';
        this.response.body = {
            success: true,
            judgeResult,
            progress: {
                total: totalProblems,
                submitted: submittedCount,
                startAt: pjudge.progress.startAt
            },
            status: newStatus,
            problemDirs: pjudge.problemDirs,
        };
    }
}

// Hydro 会在服务初始化完成后调用该函数
export async function apply(ctx: Context) {
    ctx.Route('contest_packjudge', '/contest/:tid/pack', PackJudgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.on('handler/after', async (handler: Handler) => {
        if (!handler.response.template) return;
        // 检查是否是比赛相关的页面并且不是作业 (homework)
        const tdoc = (handler as any).tdoc;
        if (tdoc && tdoc.rule !== 'homework') {
            const tid = tdoc.docId || tdoc._id; // 确保获取到 ObjectId

            // 检查权限：只有比赛所有者或有编辑权限的人才能看到 批量评测
            if (!handler.user.own(tdoc) && !handler.user.hasPerm(PERM.PERM_EDIT_CONTEST)) return;

            // 注入导航
            handler.response.body.overrideNav = [
                {
                    name: 'contest_main',
                    args: {},
                    displayName: 'Back to contest list',
                    checker: () => true,
                },
                {
                    name: 'contest_detail',
                    displayName: tdoc.title,
                    args: { tid, prefix: 'contest_detail' },
                    checker: () => true,
                },
                {
                    name: 'contest_problemlist',
                    args: { tid, prefix: 'contest_problemlist' },
                    checker: () => true,
                },
                {
                    name: 'contest_scoreboard',
                    args: { tid, prefix: 'contest_scoreboard' },
                    checker: () => ContestModel.canShowScoreboard.call(handler, tdoc, true),
                },
                {
                    name: 'contest_packjudge',
                    displayName: '批量评测',
                    args: { tid, prefix: 'contest_packjudge' },
                    checker: () => true,
                }
            ];
        }
    });
}
