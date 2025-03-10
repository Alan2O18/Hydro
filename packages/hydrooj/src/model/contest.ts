import { sumBy } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { Counter, formatSeconds, Time } from '@hydrooj/utils/lib/utils';
import {
    ContestAlreadyAttendedError, ContestNotFoundError,
    ContestScoreboardHiddenError, ValidationError,
} from '../error';
import {
    BaseUserDict, ContestRule, ContestRules, ProblemDict,
    ScoreboardConfig, ScoreboardNode, ScoreboardRow, SubtaskResult, Tdoc,
} from '../interface';
import ranked from '../lib/rank';
import * as bus from '../service/bus';
import type { Handler } from '../service/server';
import { PERM, STATUS, STATUS_SHORT_TEXTS } from './builtin';
import * as document from './document';
import problem from './problem';
import user, { User } from './user';

interface AcmJournal {
    rid: ObjectId;
    pid: number;
    score: number;
    status: number;
    time: number;
}
interface AcmDetail extends AcmJournal {
    naccept?: number;
    npending?: number;
    penalty: number;
    real: number;
}

function buildContestRule<T>(def: ContestRule<T>): ContestRule<T>;
function buildContestRule<T>(def: Partial<ContestRule<T>>, baseRule: ContestRule<T>): ContestRule<T>;
function buildContestRule<T>(def: Partial<ContestRule<T>>, baseRule: ContestRule<T> = {} as any) {
    const base = baseRule._originalRule || {};
    const funcs = ['scoreboard', 'scoreboardRow', 'scoreboardHeader', 'stat'];
    const f = {};
    const rule = { ...baseRule, ...def };
    for (const key of funcs) {
        f[key] = def[key] || base[key];
        rule[key] = f[key].bind(rule);
    }
    rule._originalRule = f;
    return rule;
}

const acm = buildContestRule({
    TEXT: 'ACM/ICPC',
    check: () => { },
    statusSort: { accept: -1, time: 1 },
    submitAfterAccept: false,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    showSelfRecord: () => true,
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    showRecord: (tdoc, now) => now > tdoc.endAt && !isLocked(tdoc),
    stat(tdoc, journal: AcmJournal[]) {
        const naccept = Counter<number>();
        const npending = Counter<number>();
        const display: Record<number, AcmDetail> = {};
        const detail: Record<number, AcmDetail> = {};
        let accept = 0;
        let time = 0;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        const lockAt = isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal) {
            if (!this.submitAfterAccept && display[j.pid]?.status === STATUS.STATUS_ACCEPTED) continue;
            const real = Math.floor((j.rid.getTimestamp().getTime() - tdoc.beginAt.getTime()) / 1000);
            const penalty = 20 * 60 * naccept[j.pid];
            detail[j.pid] = {
                ...j, naccept: naccept[j.pid], time: real + penalty, real, penalty,
            };
            if (![STATUS.STATUS_ACCEPTED, STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_FORMAT_ERROR].includes(j.status)) {
                naccept[j.pid]++;
            }
            if (lockAt && j.rid.getTimestamp() > lockAt) {
                npending[j.pid]++;
                // FIXME this is tricky
                // @ts-ignore
                display[j.pid] ||= {};
                display[j.pid].npending = npending[j.pid];
                continue;
            }
            display[j.pid] = detail[j.pid];
        }
        for (const d of Object.values(display).filter((i) => i.status === STATUS.STATUS_ACCEPTED)) {
            accept++;
            time += d.time;
        }
        return {
            accept, time, detail, display,
        };
    },
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardRow = [
            { type: 'rank', value: '#' },
            { type: 'user', value: _('User') },
        ];
        if (config.isExport) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }
        columns.push({ type: 'solved', value: `${_('Solved')}\n${_('Total Time')}` });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push(
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, pdict[pid].title),
                    },
                    {
                        type: 'time',
                        value: '#{0} {1}'.format(i, _('Penalty (Minutes)')),
                    },
                );
            } else {
                columns.push({
                    type: 'problem',
                    value: String.fromCharCode(65 + i - 1),
                    raw: pid,
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({
            type: 'time',
            value: `${tsdoc.accept || 0}\n${formatSeconds(tsdoc.time || 0.0, false)}`,
            hover: formatSeconds(tsdoc.time || 0.0),
        });
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED) pdict[s.pid].nAccept++;
        }
        const tsddict = (config.lockAt ? tsdoc.display : tsdoc.detail) || {};
        for (const pid of tdoc.pids) {
            const doc = tsddict[pid] || {} as Partial<AcmDetail>;
            const accept = doc.status === STATUS.STATUS_ACCEPTED;
            const colTime = accept ? formatSeconds(doc.real, false).toString() : '';
            const colPenalty = doc.rid ? Math.ceil(doc.penalty / 60).toString() : '';
            if (config.isExport) {
                row.push(
                    { type: 'string', value: colTime },
                    { type: 'string', value: colPenalty },
                );
            } else {
                let value = '';
                if (doc.rid) value = `-${doc.naccept}`;
                if (accept) value = `${doc.naccept ? `+${doc.naccept}` : '<span class="icon icon-check"></span>'}\n${colTime}`;
                else if (doc.npending) value += `${value ? ' ' : ''}<span style="color:orange">+${doc.npending}</span>`;
                row.push({
                    type: 'record',
                    score: accept ? 100 : 0,
                    value,
                    hover: accept ? formatSeconds(doc.time) : '',
                    raw: doc.rid,
                    style: accept && doc.rid.getTimestamp().getTime() === meta?.first?.[pid]
                        ? 'background-color: rgb(217, 240, 199);'
                        : undefined,
                });
            }
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await ranked(cursor, (a, b) => a.score === b.score && a.time === b.time);
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await user.getListForRender(tdoc.domainId, uids);
        // Find first accept
        const first = {};
        const data = await document.collStatus.aggregate([
            {
                $match: {
                    domainId: tdoc.domainId,
                    docType: document.TYPE_CONTEST,
                    docId: tdoc.docId,
                    accept: { $gte: 1 },
                },
            },
            { $project: { r: { $objectToArray: '$detail' } } },
            { $unwind: '$r' },
            { $match: { 'r.v.status': STATUS.STATUS_ACCEPTED } },
            { $group: { _id: '$r.v.pid', first: { $min: '$r.v.rid' } } },
        ]).toArray() as any[];
        for (const t of data) first[t._id] = t.first.getTimestamp().getTime();

        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(
                    config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc, { first },
                ),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await ranked(cursor, (a, b) => a.accept === b.accept && a.time === b.time);
    },
});

const oi = buildContestRule({
    TEXT: 'OI',
    check: () => { },
    submitAfterAccept: true,
    statusSort: { score: -1 },
    stat(tdoc, journal) {
        const npending = Counter();
        const detail = {};
        const display = {};
        let score = 0;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        const lockAt = isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            if (!detail[j.pid] || detail[j.pid].score < j.score || this.submitAfterAccept) {
                detail[j.pid] = j;
                display[j.pid] ||= {};
                if (lockAt && j.rid.getTimestamp() > lockAt) {
                    npending[j.pid]++;
                    display[j.pid].npending = npending[j.pid];
                    continue;
                }
                display[j.pid] = j;
            }
        }
        for (const i in display) score += display[i].score || 0;
        return { score, detail, display };
    },
    showScoreboard: (tdoc, now) => now > tdoc.endAt,
    showSelfRecord: (tdoc, now) => now > tdoc.endAt,
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    showRecord: (tdoc, now) => now > tdoc.endAt && !isLocked(tdoc),
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardNode[] = [
            { type: 'rank', value: '#' },
            { type: 'user', value: _('User') },
        ];
        if (config.isExport) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }
        columns.push({ type: 'total_score', value: _('Total Score') });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push({
                    type: 'string',
                    value: '#{0} {1}'.format(i, pdict[tdoc.pids[i - 1]].title),
                });
            } else {
                columns.push({
                    type: 'problem',
                    value: String.fromCharCode(65 + i - 1),
                    raw: tdoc.pids[i - 1],
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const row: ScoreboardNode[] = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({ type: 'total_score', value: tsdoc.score || 0 });
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED) pdict[s.pid].nAccept++;
        }
        const tsddict = (config.lockAt ? tsdoc.display : tsdoc.detail) || {};
        for (const pid of tdoc.pids) {
            const index = `${tsdoc.uid}/${tdoc.domainId}/${pid}`;
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            const node: ScoreboardNode = (!config.isExport && !config.lockAt && isDone(tdoc)
                && meta?.psdict?.[index]?.rid
                && tsddict[pid]?.rid?.toHexString() !== meta?.psdict?.[index]?.rid?.toHexString())
                ? {
                    type: 'records',
                    value: '',
                    raw: [{
                        value: tsddict[pid]?.score ?? '-',
                        raw: tsddict[pid]?.rid || null,
                    }, {
                        value: meta?.psdict?.[index]?.score ?? '-',
                        raw: meta?.psdict?.[index]?.rid ?? null,
                    }],
                } : {
                    type: 'record',
                    value: `${tsddict[pid]?.score ?? '-'}${tsddict[pid]?.npending
                        ? `<span style="color:orange">+${tsddict[pid]?.npending}</span>` : ''}`,
                    raw: tsddict[pid]?.rid || null,
                };
            if (tsddict[pid]?.status === STATUS.STATUS_ACCEPTED && tsddict[pid]?.rid.getTimestamp().getTime() === meta?.first?.[pid]) {
                node.style = 'background-color: rgb(217, 240, 199);';
            }
            row.push(node);
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await ranked(cursor, (a, b) => a.score === b.score);
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await user.getListForRender(tdoc.domainId, uids);
        const psdict = {};
        const first = {};
        await Promise.all(tdoc.pids.map(async (pid) => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            const [data] = await getMultiStatus(tdoc.domainId, {
                docType: document.TYPE_CONTEST,
                docId: tdoc.docId,
                [`detail.${pid}.status`]: STATUS.STATUS_ACCEPTED,
            }).sort({ [`detail.${pid}.rid`]: 1 }).limit(1).toArray();
            first[pid] = data ? data.detail[pid].rid.getTimestamp().getTime() : Date.now() / 1000;
        }));
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        if (isDone(tdoc)) {
            const psdocs = await Promise.all(
                tdoc.pids.map((pid) => problem.getMultiStatus(tdoc.domainId, { docId: pid, uid: { $in: uids } }).toArray()),
            );
            for (const tpsdoc of psdocs) {
                for (const psdoc of tpsdoc) {
                    psdict[`${psdoc.uid}/${psdoc.domainId}/${psdoc.docId}`] = psdoc;
                }
            }
        }
        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(
                    config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc, { psdict, first },
                ),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await ranked(cursor, (a, b) => a.score === b.score);
    },
});

const ioi = buildContestRule({
    TEXT: 'IOI',
    submitAfterAccept: false,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    showSelfRecord: () => true,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
}, oi);

const strictioi = buildContestRule({
    TEXT: 'IOI(Strict)',
    submitAfterAccept: false,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    showSelfRecord: () => true,
    showScoreboard: (tdoc, now) => now > tdoc.endAt,
    stat(tdoc, journal) {
        const detail = {};
        let score = 0;
        const subtasks: Record<number, SubtaskResult> = {};
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            for (const i in j.subtasks) {
                if (!subtasks[i] || subtasks[i].score < j.subtasks[i].score) subtasks[i] = j.subtasks[i];
            }
            j.score = sumBy(Object.values(subtasks), 'score');
            j.status = Math.max(...Object.values(subtasks).map((i) => i.status));
            j.subtasks = subtasks;
            if (!detail[j.pid] || detail[j.pid].score < j.score) detail[j.pid] = j;
        }
        for (const i in detail) score += detail[i].score;
        return { score, detail };
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardNode[] = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({ type: 'total_score', value: tsdoc.score || 0 });
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED) pdict[s.pid].nAccept++;
        }
        for (const pid of tdoc.pids) {
            row.push({
                type: 'record',
                value: tsddict[pid]?.score || '',
                hover: Object.values(tsddict[pid]?.subtasks || {}).map((i: SubtaskResult) => `${STATUS_SHORT_TEXTS[i.status]} ${i.score}`).join(','),
                raw: tsddict[pid]?.rid,
                style: tsddict[pid]?.status === STATUS.STATUS_ACCEPTED && tsddict[pid]?.rid.getTimestamp().getTime() === meta?.first?.[pid]
                    ? 'background-color: rgb(217, 240, 199);'
                    : undefined,
            });
        }
        return row;
    },
}, ioi);

const ledo = buildContestRule({
    TEXT: 'Ledo',
    check: () => { },
    submitAfterAccept: false,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    stat(tdoc, journal) {
        const ntry = Counter<number>();
        const detail = {};
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            const vaild = ![STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_FORMAT_ERROR].includes(j.status);
            if (vaild) ntry[j.pid]++;
            const penaltyScore = vaild ? Math.round(Math.max(0.7, 0.95 ** (ntry[j.pid] - 1)) * j.score) : 0;
            if (!detail[j.pid] || detail[j.pid].penaltyScore < penaltyScore) {
                detail[j.pid] = {
                    ...j,
                    penaltyScore,
                    ntry: ntry[j.pid] - 1,
                };
            }
        }
        let score = 0;
        let originalScore = 0;
        for (const pid of tdoc.pids) {
            if (!detail[pid]) continue;
            score += detail[pid].penaltyScore;
            originalScore += detail[pid].score;
        }
        return {
            score, originalScore, detail,
        };
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({
            type: 'total_score',
            value: tsdoc.score || 0,
            hover: tsdoc.score !== tsdoc.originalScore ? _('Original score: {0}').format(tsdoc.originalScore) : '',
        });
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED) pdict[s.pid].nAccept++;
        }
        for (const pid of tdoc.pids) {
            row.push({
                type: 'record',
                value: tsddict[pid]?.penaltyScore || '',
                hover: tsddict[pid]?.ntry ? `-${tsddict[pid].ntry} (${Math.round(Math.max(0.7, 0.95 ** tsddict[pid].ntry) * 100)}%)` : '',
                raw: tsddict[pid]?.rid,
                style: tsddict[pid]?.status === STATUS.STATUS_ACCEPTED && tsddict[pid]?.rid.getTimestamp().getTime() === meta?.first?.[pid]
                    ? 'background-color: rgb(217, 240, 199);'
                    : undefined,
            });
        }
        return row;
    },
}, oi);

const homework = buildContestRule({
    TEXT: 'Assignment',
    hidden: true,
    check: () => { },
    submitAfterAccept: false,
    statusSort: { penaltyScore: -1, time: 1 },
    stat: (tdoc, journal) => {
        const effective = {};
        for (const j of journal) {
            if (tdoc.pids.includes(j.pid)) effective[j.pid] = j;
        }
        function time(jdoc) {
            const real = (jdoc.rid.getTimestamp().getTime() - tdoc.beginAt.getTime()) / 1000;
            return Math.floor(real);
        }

        function penaltyScore(jdoc) {
            const exceedSeconds = Math.floor(
                (jdoc.rid.getTimestamp().getTime() - tdoc.penaltySince.getTime()) / 1000,
            );
            if (exceedSeconds < 0) return jdoc.score;
            let coefficient = 1;
            const keys = Object.keys(tdoc.penaltyRules).map(parseFloat).sort((a, b) => a - b);
            for (const i of keys) {
                if (i * 3600 <= exceedSeconds) coefficient = tdoc.penaltyRules[i];
                else break;
            }
            return jdoc.score * coefficient;
        }
        const detail = [];
        for (const j in effective) {
            effective[j].penaltyScore = penaltyScore(effective[j]);
            effective[j].time = time(effective[j]);
            detail.push(effective[j]);
        }
        return {
            score: sumBy(detail, 'score'),
            penaltyScore: sumBy(detail, 'penaltyScore'),
            time: Math.sum(detail.map((d) => d.time)),
            detail: effective,
        };
    },
    showScoreboard: () => true,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardNode[] = [
            { type: 'rank', value: _('Rank') },
            { type: 'user', value: _('User') },
            { type: 'total_score', value: _('Score') },
        ];
        if (config.isExport) {
            columns.push({ type: 'string', value: _('Original Score') });
        }
        columns.push({ type: 'time', value: _('Total Time') });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push(
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, pdict[pid].title),
                    },
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, _('Original Score')),
                    },
                    {
                        type: 'time',
                        value: '#{0} {1}'.format(i, _('Time (Seconds)')),
                    },
                );
            } else {
                columns.push({
                    type: 'problem',
                    value: String.fromCharCode(65 + i - 1),
                    raw: pid,
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            {
                type: 'user',
                value: udoc.uname,
                raw: tsdoc.uid,
            },
            {
                type: 'string',
                value: tsdoc.penaltyScore || 0,
            },
        ];
        if (config.isExport) {
            row.push({ type: 'string', value: tsdoc.score || 0 });
        }
        row.push({ type: 'time', value: formatSeconds(tsdoc.time || 0, false), raw: tsdoc.time });
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED) pdict[s.pid].nAccept++;
        }
        for (const pid of tdoc.pids) {
            const rid = tsddict[pid]?.rid;
            const colScore = tsddict[pid]?.penaltyScore ?? '';
            const colOriginalScore = tsddict[pid]?.score ?? '';
            const colTime = tsddict[pid]?.time || '';
            const colTimeStr = colTime ? formatSeconds(colTime, false) : '';
            if (config.isExport) {
                row.push(
                    { type: 'string', value: colScore },
                    { type: 'string', value: colOriginalScore },
                    { type: 'time', value: colTime },
                );
            } else {
                row.push({
                    type: 'record',
                    score: tsddict[pid]?.penaltyScore || 0,
                    value: colScore === colOriginalScore
                        ? '{0}\n{1}'.format(colScore, colTimeStr)
                        : '{0} / {1}\n{2}'.format(colScore, colOriginalScore, colTimeStr),
                    raw: rid,
                });
            }
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await ranked(cursor, (a, b) => a.score === b.score);
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await user.getListForRender(tdoc.domainId, uids);
        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await ranked(cursor, (a, b) => a.score === b.score);
    },
});

export const RULES: ContestRules = {
    acm, oi, homework, ioi, ledo, strictioi,
};

function _getStatusJournal(tsdoc) {
    return tsdoc.journal.sort((a, b) => (a.rid.getTimestamp() - b.rid.getTimestamp()));
}

export async function add(
    domainId: string, title: string, content: string, owner: number,
    rule: string, beginAt = new Date(), endAt = new Date(), pids: number[] = [],
    rated = false, data: Partial<Tdoc<30>> = {},
) {
    if (!RULES[rule]) throw new ValidationError('rule');
    if (beginAt >= endAt) throw new ValidationError('beginAt', 'endAt');
    Object.assign(data, {
        content, owner, title, rule, beginAt, endAt, pids, attend: 0,
    });
    RULES[rule].check(data);
    await bus.parallel('contest/before-add', data);
    const res = await document.add(domainId, content, owner, document.TYPE_CONTEST, null, null, null, {
        ...data, title, rule, beginAt, endAt, pids, attend: 0, rated,
    });
    await bus.parallel('contest/add', data, res);
    return res;
}

export async function edit(domainId: string, tid: ObjectId, $set: Partial<Tdoc>) {
    if ($set.rule && !RULES[$set.rule]) throw new ValidationError('rule');
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    RULES[$set.rule || tdoc.rule].check(Object.assign(tdoc, $set));
    return await document.set(domainId, document.TYPE_CONTEST, tid, $set);
}

export async function del(domainId: string, tid: ObjectId) {
    await Promise.all([
        document.deleteOne(domainId, document.TYPE_CONTEST, tid),
        document.deleteMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }),
        document.deleteMulti(domainId, document.TYPE_DISCUSSION, { parentType: document.TYPE_CONTEST, parentId: tid }),
    ]);
}

export async function get(domainId: string, tid: ObjectId): Promise<Tdoc<30>> {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(tid);
    return tdoc;
}

export async function getRelated(domainId: string, pid: number, rule?: string) {
    const rules = Object.keys(RULES).filter((i) => !RULES[i].hidden);
    return await document.getMulti(domainId, document.TYPE_CONTEST, { pids: pid, rule: rule || { $in: rules } }).toArray();
}

export async function getStatus(domainId: string, tid: ObjectId, uid: number) {
    return await document.getStatus(domainId, document.TYPE_CONTEST, tid, uid);
}

async function _updateStatus(
    tdoc: Tdoc<30>, uid: number, rid: ObjectId, pid: number, status: STATUS, score: number,
    subtasks: Record<number, SubtaskResult>,
) {
    const tsdoc = await document.revPushStatus(tdoc.domainId, document.TYPE_CONTEST, tdoc.docId, uid, 'journal', {
        rid, pid, status, score, subtasks,
    }, 'rid');
    const journal = _getStatusJournal(tsdoc);
    const stats = RULES[tdoc.rule].stat(tdoc, journal);
    return await document.revSetStatus(tdoc.domainId, document.TYPE_CONTEST, tdoc.docId, uid, tsdoc.rev, { journal, ...stats });
}

export async function updateStatus(
    domainId: string, tid: ObjectId, uid: number, rid: ObjectId, pid: number,
    status = STATUS.STATUS_WRONG_ANSWER, score = 0, subtasks: Record<number, SubtaskResult> = {},
) {
    const tdoc = await get(domainId, tid);
    return await _updateStatus(tdoc, uid, rid, pid, status, score, subtasks);
}

export async function getListStatus(domainId: string, uid: number, tids: ObjectId[]) {
    const r = {};
    // eslint-disable-next-line no-await-in-loop
    for (const tid of tids) r[tid.toHexString()] = await getStatus(domainId, tid, uid);
    return r;
}

export async function attend(domainId: string, tid: ObjectId, uid: number, payload: any = {}) {
    try {
        await document.cappedIncStatus(domainId, document.TYPE_CONTEST, tid, uid, 'attend', 1, 0, 1, payload);
    } catch (e) {
        throw new ContestAlreadyAttendedError(tid, uid);
    }
    await document.inc(domainId, document.TYPE_CONTEST, tid, 'attend', 1);
    return {};
}

export function getMultiStatus(domainId: string, query: any) {
    return document.getMultiStatus(domainId, document.TYPE_CONTEST, query);
}

export function isNew(tdoc: Tdoc, days = 1) {
    const now = new Date().getTime();
    const readyAt = tdoc.beginAt.getTime();
    return (now < readyAt - days * Time.day);
}

export function isUpcoming(tdoc: Tdoc, days = 7) {
    const now = Date.now();
    const readyAt = tdoc.beginAt.getTime();
    return (now > readyAt - days * Time.day && now < readyAt);
}

export function isNotStarted(tdoc: Tdoc) {
    return (new Date()) < tdoc.beginAt;
}

export function isOngoing(tdoc: Tdoc, tsdoc?: any) {
    const now = new Date();
    if (tsdoc && tdoc.duration && tsdoc.startAt <= new Date(Date.now() - Math.floor(tdoc.duration * Time.hour))) return false;
    return (tdoc.beginAt <= now && now < tdoc.endAt);
}

export function isDone(tdoc: Tdoc, tsdoc?: any) {
    if (tdoc.endAt <= new Date()) return true;
    if (tsdoc && tdoc.duration && tsdoc.startAt <= new Date(Date.now() - Math.floor(tdoc.duration * Time.hour))) return true;
    return false;
}

export function isLocked(tdoc: Tdoc) {
    if (!tdoc.lockAt) return false;
    const now = new Date();
    return tdoc.lockAt < now && !tdoc.unlocked;
}

export function isExtended(tdoc: Tdoc) {
    const now = new Date().getTime();
    return tdoc.penaltySince.getTime() <= now && now < tdoc.endAt.getTime();
}

export function setStatus(domainId: string, tid: ObjectId, uid: number, $set: any) {
    return document.setStatus(domainId, document.TYPE_CONTEST, tid, uid, $set);
}

export function count(domainId: string, query: any) {
    return document.count(domainId, document.TYPE_CONTEST, query);
}

export function countStatus(domainId: string, query: any) {
    return document.countStatus(domainId, document.TYPE_CONTEST, query);
}

export function getMulti(
    domainId: string, query: Filter<document.DocType['30']> = {},
) {
    return document.getMulti(domainId, document.TYPE_CONTEST, query).sort({ beginAt: -1 });
}

export async function getAndListStatus(domainId: string, tid: ObjectId): Promise<[Tdoc, any[]]> {
    // TODO(iceboy): projection, pagination.
    const tdoc = await get(domainId, tid);
    const tsdocs = await document.getMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid })
        .sort(RULES[tdoc.rule].statusSort).toArray();
    return [tdoc, tsdocs];
}

export async function recalcStatus(domainId: string, tid: ObjectId) {
    const [tdoc, tsdocs] = await Promise.all([
        document.get(domainId, document.TYPE_CONTEST, tid),
        document.getMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }).toArray(),
    ]);
    const tasks = [];
    for (const tsdoc of tsdocs || []) {
        if (tsdoc.journal) {
            const journal = _getStatusJournal(tsdoc);
            const stats = RULES[tdoc.rule].stat(tdoc, journal);
            tasks.push(
                document.revSetStatus(
                    domainId, document.TYPE_CONTEST, tid,
                    tsdoc.uid, tsdoc.rev, { journal, ...stats },
                ),
            );
        }
    }
    return await Promise.all(tasks);
}

export async function unlockScoreboard(domainId: string, tid: ObjectId) {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc.lockAt || tdoc.unlocked) return;
    await edit(domainId, tid, { unlocked: true });
}

export function canViewHiddenScoreboard(this: { user: User }, tdoc: Tdoc<30>) {
    if (this.user.own(tdoc)) return true;
    if (tdoc.rule === 'homework') return this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
    return this.user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
}

export function canShowRecord(this: { user: User }, tdoc: Tdoc<30>, allowPermOverride = true) {
    if (RULES[tdoc.rule].showRecord(tdoc, new Date())) return true;
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return false;
}

export function canShowSelfRecord(this: { user: User }, tdoc: Tdoc<30>, allowPermOverride = true) {
    if (RULES[tdoc.rule].showSelfRecord(tdoc, new Date())) return true;
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return false;
}

export function canShowScoreboard(this: { user: User }, tdoc: Tdoc<30>, allowPermOverride = true) {
    if (RULES[tdoc.rule].showScoreboard(tdoc, new Date())) return true;
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return false;
}

export async function getScoreboard(
    this: Handler, domainId: string, tid: ObjectId, config: ScoreboardConfig,
): Promise<[Tdoc<30>, ScoreboardRow[], BaseUserDict, ProblemDict]> {
    const tdoc = await get(domainId, tid);
    if (!canShowScoreboard.call(this, tdoc)) throw new ContestScoreboardHiddenError(tid);
    const tsdocsCursor = getMultiStatus(domainId, { docId: tid }).sort(RULES[tdoc.rule].statusSort);
    const pdict = await problem.getList(domainId, tdoc.pids, true, true, problem.PROJECTION_CONTEST_DETAIL);
    const [rows, udict] = await RULES[tdoc.rule].scoreboard(
        config, this.translate.bind(this),
        tdoc, pdict, tsdocsCursor,
    );
    await bus.parallel('contest/scoreboard', tdoc, rows, udict, pdict);
    return [tdoc, rows, udict, pdict];
}

export const statusText = (tdoc: Tdoc, tsdoc?: any) => (
    isNew(tdoc)
        ? 'New'
        : isUpcoming(tdoc)
            ? 'Ready (☆▽☆)'
            : isOngoing(tdoc, tsdoc)
                ? 'Live...'
                : 'Done');

global.Hydro.model.contest = {
    RULES,
    add,
    getListStatus,
    getMultiStatus,
    attend,
    edit,
    del,
    get,
    getRelated,
    updateStatus,
    getStatus,
    count,
    countStatus,
    getMulti,
    setStatus,
    getAndListStatus,
    recalcStatus,
    unlockScoreboard,
    canShowRecord,
    canShowSelfRecord,
    canShowScoreboard,
    canViewHiddenScoreboard,
    getScoreboard,
    isNew,
    isUpcoming,
    isNotStarted,
    isOngoing,
    isDone,
    isLocked,
    isExtended,
    statusText,
};
