import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const RAW_PREFIX = 'https://raw.githubusercontent.com/reawake97/bilibili_remove_ad/main/';
const REQUEST_TYPES = ['reject', 'reject-200', 'reject-dict', 'reject-array', 'reject-img', 'script-request-header', 'script-request-body'];
const RESPONSE_TYPES = ['jsonjq-response-body', 'script-response-body'];

function parseConf(file) {
    const rules = [];
    let hostnames = [];
    for (const raw of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || /^(#|;|\/\/)/.test(line)) continue;
        const host = /^hostname\s*=\s*(.+)$/.exec(line);
        if (host) {
            hostnames = host[1].split(',').map(item => item.trim());
            continue;
        }
        const match = /^(\S+) url (\S+)(?: (.+))?$/.exec(line);
        assert.ok(match, `无法解析的行：${line}`);
        rules.push({ line, regex: new RegExp(match[1]), type: match[2], arg: match[3] });
    }
    return { rules, hostnames };
}

const full = parseConf('Bilibili_remove_ads.conf');
const lite = parseConf('Bilibili_remove_ads_lite.conf');
const GRPC = 'scripts/bilibili.grpc.js';
const JSON_SCRIPT = 'scripts/bilibili.json.js';

test('每条规则的类型、参数合法，引用的脚本在仓库中存在', () => {
    for (const { rules } of [full, lite]) {
        for (const rule of rules) {
            assert.ok([...REQUEST_TYPES, ...RESPONSE_TYPES].includes(rule.type), rule.line);
            if (rule.type === 'jsonjq-response-body') assert.match(rule.arg, /^'[^']+'$/, rule.line);
            if (rule.type.startsWith('script-')) {
                assert.ok(rule.arg.startsWith(RAW_PREFIX), rule.line);
                assert.ok(fs.existsSync(path.join(ROOT, rule.arg.slice(RAW_PREFIX.length))), rule.arg);
            }
            if (rule.type.startsWith('reject')) assert.equal(rule.arg, undefined, rule.line);
        }
    }
});

// URL → [请求阶段命中的规则, 响应阶段命中的规则]；null 表示不应命中
const grpcResponse = ['script-response-body', GRPC];
const routes = [
    ['https://app.bilibili.com/x/v2/splash/show?build=1', null, ['jsonjq-response-body', 'show']],
    ['https://app.bilibili.com/x/v2/splash/event/list2?build=1', null, ['jsonjq-response-body', 'show']],
    ['https://app.bilibili.com/x/v2/splash/list?build=1', null, ['jsonjq-response-body', 'pull_interval']],
    ['https://app.bilibili.com/x/resource/show/tab/v2?build=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://app.bilibili.com/x/v2/feed/index?build=1', null, ['jsonjq-response-body', 'small_cover_v2']],
    ['https://app.bilibili.com/x/v2/feed/index/story?build=1', null, ['jsonjq-response-body', 'vertical_ad_av']],
    ['https://app.bilibili.com/x/resource/top/activity?build=1', null, ['jsonjq-response-body', '-404']],
    ['https://app.bilibili.com/x/resource/patch/tab/v2?build=1', null, ['jsonjq-response-body', '-404']],
    ['https://app.bilibili.com/x/v2/search/square?build=1', null, ['jsonjq-response-body', '-404']],
    ['https://api.bilibili.com/x/vip/ads/materials?build=1', null, ['jsonjq-response-body', '-404']],
    ['https://app.bilibili.com/x/v2/account/mine?build=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://app.bilibili.com/x/v2/account/mine/ipad?build=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://app.bilibili.com/x/v2/account/myinfo?build=1', null, null],
    ['https://app.bilibili.com/x/resource/show/skin?build=1', null, ['jsonjq-response-body', 'common_equip']],
    ['https://api.bilibili.com/pgc/activity/deliver/material/receive?build=1', null, ['jsonjq-response-body', 'close_win']],
    ['https://api.bilibili.com/pgc/view/v2/app/season?build=1', null, ['jsonjq-response-body', 'payment']],
    ['https://api.bilibili.com/pgc/page/channel?build=1', null, ['jsonjq-response-body', 'blackboard']],
    ['https://api.live.bilibili.com/xlive/e-commerce-interface/v1/ecommerce-user/get_shopping_info?room_id=1', ['reject-dict'], null],
    ['https://line3-h5-mobile-api.biligame.com/game/live/large_card_material?room_id=1', ['reject-dict'], null],
    ['https://api.live.bilibili.com/xlive/app-interface/v2/index/feed?build=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://api.live.bilibili.com/xlive/app-room/v1/index/getInfoByRoom?room_id=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://api.live.bilibili.com/xlive/app-room/v1/index/getInfoByUser?room_id=1', null, ['script-response-body', JSON_SCRIPT]],
    ['https://api.bilibili.com/x/pd-proxy/tracker?build=1', null, ['jsonjq-response-body', 'stun.chat']],
    ['https://api.live.bilibili.com/xlive/open-interface/v2/tracker/conf?build=1', null, ['jsonjq-response-body', 'tracker.chat']],
    ['https://api.bilibili.com/pgc/season/player/cards?season_id=1', ['reject-dict'], null],
    ['https://api.bilibili.com/pgc/season/player/ogv/cards?season_id=1', ['reject-dict'], null],
    ['https://api.bilibili.com/x/vip/ads/material/report?build=1', ['reject-dict'], null],
    ['https://app.bilibili.com/x/v2/search/defaultwords?build=1', ['reject-dict'], null],
    ['https://manga.bilibili.com/twirp/comic.v1.Comic/Flash?device=ios', ['reject-dict'], null],
    ['https://manga.bilibili.com/twirp/comic.v1.Comic/ListFlash?device=ios', ['reject-dict'], null],
];

const grpcRoutes = [];
for (const host of ['grpc.biliapi.net', 'app.bilibili.com']) {
    for (const method of [
        'bilibili.app.interface.v1.Teenagers/ModeStatus',
        'bilibili.app.interface.v1.Search/DefaultWords',
        'bilibili.app.view.v1.View/TFInfo',
        'bilibili.app.viewunite.v1.View/PlayPause',
        'bilibili.app.viewunite.v1.View/ViewEndPage',
    ]) {
        grpcRoutes.push([`https://${host}/${method}`, ['script-request-header', GRPC], null]);
    }
    for (const method of [
        'bilibili.app.viewunite.v1.View/View',
        'bilibili.main.community.reply.v1.Reply/MainList',
        'bilibili.app.dynamic.v2.Dynamic/DynAll',
        'bilibili.app.show.v1.Popular/Index',
        'bilibili.app.view.v1.View/View',
        'bilibili.app.view.v1.View/ViewProgress',
        'bilibili.app.view.v1.View/RelatesFeed',
        'bilibili.app.viewunite.v1.View/ViewProgress',
        'bilibili.app.viewunite.v1.View/RelatesFeed',
        'bilibili.app.viewunite.v1.View/AIRelateAsync',
        'bilibili.app.playerunite.v1.Player/PlayViewUnite',
        'bilibili.polymer.app.search.v1.Search/SearchAll',
        'bilibili.community.service.dm.v1.DM/DmView',
        'bilibili.pgc.gateway.player.v2.PlayURL/PlayView',
    ]) {
        grpcRoutes.push([`https://${host}/${method}`, null, grpcResponse]);
    }
    // 不处理：后台播放 / 投屏限制（PlayURL/PlayView）、空降助手（DmSegMobile）、评论详情等
    for (const method of [
        'bilibili.app.playurl.v1.PlayURL/PlayView',
        'bilibili.community.service.dm.v1.DM/DmSegMobile',
        'bilibili.main.community.reply.v1.Reply/DetailList',
    ]) {
        grpcRoutes.push([`https://${host}/${method}`, null, null]);
    }
}

function matched(rules, url, types) {
    return rules.filter(rule => types.includes(rule.type) && rule.regex.test(url));
}

function assertRoute(conf, url, request, response) {
    for (const [types, expected] of [
        [REQUEST_TYPES, request],
        [RESPONSE_TYPES, response],
    ]) {
        const hits = matched(conf.rules, url, types);
        if (!expected) {
            assert.equal(hits.length, 0, `${url} 不应命中：${hits.map(h => h.line).join('\n')}`);
            continue;
        }
        assert.equal(hits.length, 1, `${url} 应且只应命中一条 ${types === REQUEST_TYPES ? '请求' : '响应'}规则，实际 ${hits.length}`);
        assert.equal(hits[0].type, expected[0], url);
        if (expected[1]) assert.ok(hits[0].line.includes(expected[1]), `${url} 命中了 ${hits[0].line}`);
    }
    assert.ok(conf.hostnames.includes(new URL(url).hostname), `${new URL(url).hostname} 不在 hostname 中`);
}

test('完整版：每个接口命中预期的规则，且同一阶段只命中一条', () => {
    for (const [url, request, response] of [...routes, ...grpcRoutes]) assertRoute(full, url, request, response);
});

test('精简版 = 完整版去掉全部 gRPC 规则与 grpc.biliapi.net', () => {
    const isGrpc = rule => rule.line.includes(GRPC);
    assert.deepEqual(
        lite.rules.map(r => r.line),
        full.rules.filter(r => !isGrpc(r)).map(r => r.line)
    );
    assert.deepEqual(lite.hostnames, full.hostnames.filter(h => h !== 'grpc.biliapi.net'));
    for (const [url, request, response] of routes) assertRoute(lite, url, request, response);
    for (const [url] of grpcRoutes) {
        assert.equal(matched(lite.rules, url, [...REQUEST_TYPES, ...RESPONSE_TYPES]).length, 0, url);
    }
});

test('可选的「优化评论区加载」规则：取消注释后只作用于 View/View 与 MainList', () => {
    const line = fs
        .readFileSync(path.join(ROOT, 'Bilibili_remove_ads.conf'), 'utf8')
        .split('\n')
        .find(l => l.includes('script-request-body'));
    assert.ok(line && line.startsWith('# ^'), '默认应为注释状态');
    const regex = new RegExp(line.slice(2).split(' ')[0]);
    const hits = grpcRoutes.map(([url]) => url).filter(url => regex.test(url));
    assert.deepEqual(
        hits.map(url => url.replace(/^https:\/\/[^/]+\//, '')).sort(),
        ['bilibili.app.viewunite.v1.View/View', 'bilibili.app.viewunite.v1.View/View', 'bilibili.main.community.reply.v1.Reply/MainList', 'bilibili.main.community.reply.v1.Reply/MainList']
    );
});

/* ---------------- jq 表达式 ---------------- */

let jqAvailable = true;
try {
    execFileSync('jq', ['--version']);
} catch (e) {
    jqAvailable = false;
}

function jq(rule, input) {
    const expression = rule.arg.slice(1, -1);
    return JSON.parse(execFileSync('jq', ['-c', expression], { input: JSON.stringify(input) }).toString());
}

function jqRule(url) {
    const hits = matched(full.rules, url, ['jsonjq-response-body']);
    assert.equal(hits.length, 1, url);
    return hits[0];
}

const jqCases = [
    [
        'https://app.bilibili.com/x/v2/splash/show?x',
        { code: 0, data: { show: [{ id: 1 }], event_list: [{ id: 2 }], max_time: 5 } },
        { code: 0, data: { show: [], event_list: [], max_time: 5 } },
    ],
    ['https://app.bilibili.com/x/v2/splash/show?x', { code: -1, data: null }, { code: -1, data: null }],
    [
        'https://app.bilibili.com/x/v2/splash/list?x',
        { code: 0, data: { list: [{ id: 1, duration: 5 }] } },
        { code: 0, message: 'OK', ttl: 1, data: { max_time: 0, min_interval: 31536000, pull_interval: 31536000, keep_ids: [], show: [], list: [{}], splash_request_id: '' } },
    ],
    [
        'https://app.bilibili.com/x/v2/feed/index?x',
        {
            data: {
                items: [
                    { card_goto: 'av', card_type: 'small_cover_v2', id: 1 },
                    { card_goto: 'av', card_type: 'small_cover_v2', ad_info: {} },
                    { card_goto: 'banner', card_type: 'banner_v8' },
                    { card_goto: 'av', card_type: 'cm_v2' },
                    { card_goto: 'av', card_type: 'large_cover_v1', banner_item: [] },
                    { card_goto: 'av', card_type: 'large_cover_single_v9', id: 2 },
                ],
            },
        },
        {
            data: {
                items: [
                    { card_goto: 'av', card_type: 'small_cover_v2', id: 1 },
                    { card_goto: 'av', card_type: 'large_cover_single_v9', id: 2 },
                ],
            },
        },
    ],
    ['https://app.bilibili.com/x/v2/feed/index?x', { code: -101, data: null }, { code: -101, data: null }],
    [
        'https://app.bilibili.com/x/v2/feed/index/story?x',
        { data: { items: [{ card_goto: 'av', story_cart_icon: {}, game_info: {}, id: 1 }, { card_goto: 'vertical_ad_av' }, { card_goto: 'av', ad_info: {} }, { card_goto: 'vertical_ad_live' }] } },
        { data: { items: [{ card_goto: 'av', id: 1 }] } },
    ],
    ['https://app.bilibili.com/x/resource/top/activity?x', { code: 0, data: { online: {} } }, { code: -404, message: '-404', ttl: 1, data: null }],
    ['https://app.bilibili.com/x/resource/show/skin?x', { data: { common_equip: { id: 1 }, user_equip: null } }, { data: { user_equip: null } }],
    ['https://app.bilibili.com/x/resource/show/skin?x', { code: 0, data: null }, { code: 0, data: null }],
    [
        'https://api.bilibili.com/pgc/activity/deliver/material/receive?x',
        { code: 0, data: { container: [1] } },
        { code: 0, data: { closeType: 'close_win', container: [], showTime: '' }, message: 'success' },
    ],
    ['https://api.bilibili.com/pgc/view/v2/app/season?x', { data: { payment: { price: 1 }, title: 't' } }, { data: { title: 't' } }],
    [
        'https://api.bilibili.com/pgc/page/channel?x',
        {
            data: {
                modules: [
                    { type: 'TIP' },
                    {
                        type: 'BANNER',
                        module_data: {
                            items: [{ url: 'https://www.bilibili.com/blackboard/era/abc.html' }, { url: 'https://www.bilibili.com/bangumi/play/ss1' }, { title: 'no url' }],
                        },
                    },
                    { type: 'OTHER' },
                ],
            },
        },
        {
            data: {
                modules: [{ type: 'BANNER', module_data: { items: [{ url: 'https://www.bilibili.com/bangumi/play/ss1' }, { title: 'no url' }] } }, { type: 'OTHER' }],
            },
        },
    ],
    [
        'https://api.bilibili.com/x/pd-proxy/tracker?x',
        { code: 0, data: { stun: ['a:1', 'b:2'], turn: ['c:3'] } },
        { code: 0, data: { stun: ['stun.chat.bilibili.com:3478', 'stun.chat.bilibili.com:3478'], turn: ['stun.chat.bilibili.com:3478'] } },
    ],
    ['https://api.bilibili.com/x/pd-proxy/tracker?x', { code: -1, data: null }, { code: -1, data: null }],
    [
        'https://api.live.bilibili.com/xlive/open-interface/v2/tracker/conf?x',
        { data: { domains: ['wss://a', 'wss://b'], enable: 1 } },
        { data: { domains: ['wss://tracker.chat.bilibili.com'], enable: 1 } },
    ],
];

test('jq 表达式在示例数据上的输出符合预期', { skip: !jqAvailable && '未安装 jq' }, () => {
    for (const [url, input, expected] of jqCases) assert.deepEqual(jq(jqRule(url), input), expected, url);
});

test('jq 表达式不使用 jq 1.7+ 才有的写法（if 必须带 else，不用 IN / // / ?//）', () => {
    for (const rule of full.rules.filter(r => r.type === 'jsonjq-response-body')) {
        const expression = rule.arg.slice(1, -1).replace(/"(?:[^"\\]|\\.)*"/g, '""');
        assert.equal((expression.match(/\bif\b/g) || []).length, (expression.match(/\belse\b/g) || []).length, rule.line);
        assert.doesNotMatch(expression, /\bIN\(|\/\/|\?\/\//, rule.line);
    }
});

/* ---------------- 分流规则 ---------------- */

test('分流规则格式正确', () => {
    const lines = fs
        .readFileSync(path.join(ROOT, 'Bilibili_remove_ads.list'), 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    assert.ok(lines.length >= 7);
    for (const line of lines) {
        const [type, value, policy, ...rest] = line.split(',').map(s => s.trim());
        assert.ok(['host', 'host-suffix', 'host-keyword', 'host-wildcard'].includes(type), line);
        assert.ok(value && !value.includes(' '), line);
        assert.equal(policy, 'reject', line);
        assert.equal(rest.length, 0, line);
    }
});
