import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { GRPC_SCRIPT, runScript, pb, concat, decode, fieldsOf, text, grpcFrame, unframe, bytesOf, assertPassThrough } from './helpers.mjs';

const UA_PINK = 'bili-universal/81200100 os/ios model/iPhone 16 Pro mobi_app/iphone build/81200100 osVer/26.0 network/2 channel/AppStore';
const UA_WHITE = 'bili-inter/71300100 os/ios model/iPhone 16 mobi_app/iphone_i build/71300100 osVer/26.0';
const UA_BLUE = 'bili-blue/81200100 os/ios model/iPhone 16 mobi_app/iphone_b build/81200100 osVer/26.0';
const GRPC_URL = method => `https://grpc.biliapi.net/${method}`;

function respond(method, message, { requestHeaders = { 'user-agent': UA_PINK, te: 'trailers' }, responseHeaders, compress, url } = {}) {
    const body = compress ? grpcFrame(message, zlib.gzipSync(message)) : grpcFrame(message);
    return runScript(GRPC_SCRIPT, {
        url: url || GRPC_URL(method),
        headers: requestHeaders,
        response: { headers: responseHeaders || { 'content-type': 'application/grpc' }, bodyBytes: body },
    });
}

function processed(result) {
    assert.ok(result.bodyBytes, '应返回 bodyBytes');
    const frame = unframe(bytesOf(result.bodyBytes));
    assert.equal(frame.flag, 0, '输出应为不压缩的 gRPC 帧');
    return frame.message;
}

/* ---------------- 评论区 Reply/MainList ---------------- */

const reply = (message, links = []) =>
    pb.msg(14, pb.int(1, 1001), pb.msg(12, pb.str(1, message), ...links.map(link => pb.msg(5, pb.str(1, link), pb.msg(2, pb.str(1, '商品'))))));

const mainList = concat(
    pb.msg(1, pb.int(1, 20), pb.str(2, 'cursor')), // 未知字段：分页游标
    pb.msg(11, pb.str(1, 'cm-ad')),
    reply('正常的置顶评论'),
    reply('淘宝搜索同款'),
    reply('链接见下', ['https://b23.tv/mall-abc123']),
    pb.msg(15, pb.int(1, 2002), pb.msg(12, pb.str(1, '普通评论'))), // 未知字段：普通评论列表
    pb.msg(27, pb.str(1, 'mixed-card-1')),
    pb.msg(27, pb.str(1, 'mixed-card-2')),
    pb.msg(28, pb.int(1, 1)),
    pb.msg(28, pb.int(1, 3)),
    pb.msg(28, pb.int(1, 5)),
    pb.int(99, 7)
);

test('MainList：去掉广告位、混排卡片、推广置顶卡片和带货置顶评论，其余字段逐字节保留', async () => {
    const { result, doneCount } = await respond('bilibili.main.community.reply.v1.Reply/MainList', mainList);
    assert.equal(doneCount, 1);
    const out = processed(result);
    const original = decode(mainList);
    const fields = decode(out);
    assert.deepEqual(fields.map(f => f.no), [1, 14, 15, 28, 99]);
    assert.deepEqual(fields[0].raw, original[0].raw);
    assert.deepEqual(fields[2].raw, original.find(f => f.no === 15).raw);
    assert.equal(text(fieldsOf(fieldsOf(fields[1].value, 12)[0].value, 1)[0].value), '正常的置顶评论');
    assert.equal(fieldsOf(fields[3].value, 1)[0].value, 1);
    assert.equal(result.headers['grpc-status'], '0');
    assert.equal(result.headers['content-type'], 'application/grpc');
});

test('MainList：gzip 压缩的响应也能处理', async () => {
    const { result } = await respond('bilibili.main.community.reply.v1.Reply/MainList', mainList, { compress: true });
    assert.deepEqual(decode(processed(result)).map(f => f.no), [1, 14, 15, 28, 99]);
});

test('MainList：走 app.bilibili.com（HTTP/1.1 降级路径）时同样处理', async () => {
    const { result } = await respond('bilibili.main.community.reply.v1.Reply/MainList', mainList, {
        url: 'https://app.bilibili.com/bilibili.main.community.reply.v1.Reply/MainList',
        requestHeaders: { 'User-Agent': UA_PINK, 'X-Bili-Moss-Engine-Type': '1' },
    });
    assert.deepEqual(decode(processed(result)).map(f => f.no), [1, 14, 15, 28, 99]);
    assert.equal(result.headers['grpc-status'], '0');
});

/* ---------------- grpc-status 响应头规则 ---------------- */

const statusCases = [
    ['粉 B + te: trailers → 补', { 'user-agent': UA_PINK, te: 'trailers' }, {}, '0'],
    ['粉 B + engine-type 1 → 补', { 'user-agent': UA_PINK, 'x-bili-moss-engine-type': '1' }, {}, '0'],
    ['粉 B 无 te / engine → 不补', { 'user-agent': UA_PINK }, {}, undefined],
    ['已有 grpc-status 不覆盖', { 'user-agent': UA_PINK, te: 'trailers' }, { 'Grpc-Status': '0' }, undefined],
    ['白 B 不能带 grpc-status: 0', { 'user-agent': UA_WHITE, te: 'trailers' }, { 'grpc-status': '0' }, undefined],
    ['蓝 B 必须带', { 'user-agent': UA_BLUE }, {}, '0'],
];

for (const [name, requestHeaders, extraResponseHeaders, expected] of statusCases) {
    test(`grpc-status：${name}`, async () => {
        const { result } = await respond('bilibili.main.community.reply.v1.Reply/MainList', mainList, {
            requestHeaders,
            responseHeaders: { 'content-type': 'application/grpc', ...extraResponseHeaders },
        });
        assert.equal(result.headers['grpc-status'], expected);
        if (name.startsWith('已有')) assert.equal(result.headers['Grpc-Status'], '0');
        if (name.startsWith('白 B')) assert.equal(Object.keys(result.headers).includes('grpc-status'), false);
    });
}

test('没有广告可删时：响应头也不用改就放行，需要补 grpc-status 时原样返回响应体', async () => {
    const clean = concat(pb.msg(1, pb.int(1, 20)), reply('正常的置顶评论'), pb.msg(28, pb.int(1, 1)));
    const untouched = await respond('bilibili.main.community.reply.v1.Reply/MainList', clean, {
        responseHeaders: { 'content-type': 'application/grpc', 'grpc-status': '0' },
    });
    assertPassThrough(untouched.result);

    const compressed = grpcFrame(clean, zlib.gzipSync(clean));
    const fixed = await runScript(GRPC_SCRIPT, {
        url: GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'),
        headers: { 'user-agent': UA_PINK, te: 'trailers' },
        response: { headers: { 'content-type': 'application/grpc', 'grpc-encoding': 'gzip' }, bodyBytes: compressed },
    });
    assert.equal(fixed.result.headers['grpc-status'], '0');
    assert.deepEqual(bytesOf(fixed.result.bodyBytes), compressed);
});

/* ---------------- 视频详情 viewunite View/View ---------------- */

const relateCard = (type, extra = []) => pb.msg(1, pb.int(1, type), ...extra);
const viewReply = concat(
    pb.msg(1, pb.int(1, 114514), pb.str(2, 'BV1xx411c7mD')), // 未知字段：稿件信息
    pb.msg(3, pb.int(1, 1), pb.msg(7, pb.str(1, '充电'))),
    pb.msg(
        5,
        pb.msg(
            1,
            pb.int(1, 1),
            pb.msg(
                2,
                pb.int(1, 9), // 未知字段
                pb.msg(2, pb.int(1, 3), pb.msg(5, pb.msg(1, pb.str(1, '标签')), pb.str(2, '标题'))),
                pb.msg(2, pb.int(1, 18), pb.str(4, '活动')),
                pb.msg(
                    2,
                    pb.int(1, 28),
                    pb.msg(
                        22,
                        relateCard(1, [pb.str(2, '正常视频')]),
                        relateCard(4),
                        relateCard(1, [pb.str(11, 'cm')]),
                        relateCard(1, [pb.msg(12, pb.str(6, 'ad-unique'))]),
                        relateCard(1, [pb.msg(12, pb.str(1, 'title'))])
                    )
                ),
                pb.msg(2, pb.int(1, 55)),
                pb.msg(2, pb.int(1, 63)),
                pb.msg(2, pb.int(1, 100), pb.str(3, '未知模块'))
            )
        ),
        pb.msg(1, pb.int(1, 2), pb.msg(3, pb.str(1, '评论'), pb.int(2, 4096))) // 评论 Tab，必须原样保留
    ),
    pb.msg(7, pb.str(1, 'cm')),
    pb.fixed32(20, 0xdeadbeef),
    pb.fixed64(21, 12345)
);

test('View/View：去广告，评论 Tab 与未知字段逐字节保留', async () => {
    const { result } = await respond('bilibili.app.viewunite.v1.View/View', viewReply);
    const out = processed(result);
    const fields = decode(out);
    const original = decode(viewReply);
    assert.deepEqual(fields.map(f => f.no), [1, 3, 5, 20, 21]);
    assert.deepEqual(fields[0].raw, original[0].raw);
    assert.deepEqual(fields[3].raw, original.find(f => f.no === 20).raw);
    assert.deepEqual(decode(fields[1].value).map(f => f.no), [1]);

    const tabModules = fieldsOf(fields[2].value, 1);
    assert.equal(tabModules.length, 2);
    const originalReplyTab = fieldsOf(original.find(f => f.no === 5).value, 1)[1];
    assert.deepEqual(tabModules[1].raw, originalReplyTab.raw);

    const intro = fieldsOf(tabModules[0].value, 2)[0].value;
    assert.equal(fieldsOf(intro, 1)[0].value, 9);
    const modules = fieldsOf(intro, 2).map(f => f.value);
    assert.deepEqual(modules.map(m => fieldsOf(m, 1)[0].value), [3, 28, 100]);
    const headline = fieldsOf(modules[0], 5)[0].value;
    assert.deepEqual(decode(headline).map(f => f.no), [2]);
    const cards = fieldsOf(fieldsOf(modules[1], 22)[0].value, 1).map(f => f.value);
    assert.equal(cards.length, 2);
    assert.equal(text(fieldsOf(cards[0], 2)[0].value), '正常视频');
});

test('AIRelateAsync / RelatesFeed：过滤广告卡片', async () => {
    const asyncReply = concat(pb.str(1, 'cm'), pb.msg(2, pb.msg(1, pb.int(1, 18)), pb.msg(1, pb.int(1, 28), pb.msg(22, relateCard(1), relateCard(5)))));
    const { result } = await respond('bilibili.app.viewunite.v1.View/AIRelateAsync', asyncReply);
    const modules = fieldsOf(fieldsOf(processed(result), 2)[0].value, 1);
    assert.equal(modules.length, 1);
    assert.equal(fieldsOf(fieldsOf(modules[0].value, 22)[0].value, 1).length, 1);

    const feed = concat(relateCard(1), relateCard(6), relateCard(11), relateCard(1, [pb.str(11, 'x')]));
    const second = await respond('bilibili.app.viewunite.v1.View/RelatesFeed', feed);
    assert.equal(fieldsOf(processed(second.result), 1).length, 1);
});

/* ---------------- 其他接口 ---------------- */

test('DynAll：去掉话题、广告卡片、直播推荐，最常访问默认保留', async () => {
    const upList = pb.msg(2, pb.msg(2, pb.str(1, 'up1')), pb.int(4, 1), pb.msg(10, pb.str(1, 'live')));
    const dyn = concat(
        pb.msg(1, pb.msg(1, pb.int(1, 1), pb.str(2, 'a')), pb.msg(1, pb.int(1, 15)), pb.msg(1, pb.int(1, 18)), pb.msg(1, pb.int(1, 2)), pb.int(5, 1)),
        upList,
        pb.msg(3, pb.str(1, 'topic'))
    );
    const { result } = await respond('bilibili.app.dynamic.v2.Dynamic/DynAll', dyn);
    const fields = decode(processed(result));
    assert.deepEqual(fields.map(f => f.no), [1, 2]);
    assert.deepEqual(fieldsOf(fields[0].value, 1).map(f => fieldsOf(f.value, 1)[0].value), [1, 2]);
    assert.deepEqual(fieldsOf(fields[0].value, 5).length, 1);
    assert.deepEqual(fields[1].raw, upList);
});

test('Popular：只保留推荐来源且无广告的视频卡片', async () => {
    const card = (fromType, ad) => pb.msg(1, pb.msg(1, pb.msg(1, pb.str(14, fromType), ...(ad ? [pb.str(12, 'ad')] : []))));
    const popular = concat(card('recommend'), card('recommend', true), card('operation'), pb.msg(1, pb.msg(11, pb.str(1, 'ad'))), pb.msg(1, pb.msg(10, pb.str(1, 'x'))), pb.msg(1, pb.msg(5, pb.str(1, 'other'))));
    const { result } = await respond('bilibili.app.show.v1.Popular/Index', popular);
    const items = fieldsOf(processed(result), 1);
    assert.deepEqual(items.map(f => decode(f.value)[0].no), [1, 5]);
});

test('DmView：去掉问卷、活动弹幕与互动指令弹幕', async () => {
    const dm = concat(pb.int(1, 1), pb.str(18, 'a'), pb.str(18, 'b'), pb.msg(22, pb.str(1, 'vote'), pb.str(1, 'like'), pb.int(2, 3)), pb.str(25, 'qoe'));
    const { result } = await respond('bilibili.community.service.dm.v1.DM/DmView', dm);
    const fields = decode(processed(result));
    assert.deepEqual(fields.map(f => f.no), [1, 22]);
    assert.deepEqual(decode(fields[1].value).map(f => f.no), [2]);
});

test('SearchAll：去掉广告条目', async () => {
    const item = linktype => pb.msg(4, pb.str(4, linktype), pb.str(5, 'payload'));
    const search = concat(pb.int(1, 1), item('video'), item('special_ad'), item('web_ad_card'), item('bangumi'));
    const { result } = await respond('bilibili.polymer.app.search.v1.Search/SearchAll', search);
    assert.deepEqual(fieldsOf(processed(result), 4).map(f => text(fieldsOf(f.value, 4)[0].value)), ['video', 'bangumi']);
});

test('PlayViewUnite / pgc PlayView：只去掉提示条，不改播放能力配置', async () => {
    const arcConfs = pb.msg(2, pb.msg(1, pb.int(1, 9), pb.msg(2, pb.int(1, 1), pb.int(2, 1), pb.msg(3, pb.str(1, '需要大会员')))));
    const unite = concat(pb.msg(1, pb.str(1, 'vod')), arcConfs, pb.msg(9, pb.int(1, 1), pb.msg(2, pb.str(1, 'prompt'))));
    const { result } = await respond('bilibili.app.playerunite.v1.Player/PlayViewUnite', unite);
    const fields = decode(processed(result));
    assert.deepEqual(fields[1].raw, arcConfs);
    assert.deepEqual(decode(fields[2].value).map(f => f.no), [1]);

    const extConf = pb.msg(6, pb.int(1, 1), pb.msg(3, pb.int(1, 7), pb.str(2, '不支持投屏')));
    const pgc = concat(pb.msg(5, pb.int(1, 1), pb.msg(8, pb.str(1, 'try watch'))), extConf);
    const second = await respond('bilibili.pgc.gateway.player.v2.PlayURL/PlayView', pgc);
    const pgcFields = decode(processed(second.result));
    assert.deepEqual(decode(pgcFields[0].value).map(f => f.no), [1]);
    assert.deepEqual(pgcFields[1].raw, extConf);
});

test('iPad View/View、ViewProgress、RelatesFeed', async () => {
    const relate = cm => pb.msg(10, pb.str(1, 'r'), ...(cm ? [pb.str(28, 'cm')] : []));
    const ipad = concat(pb.msg(1, pb.str(1, 'arc')), pb.msg(4, pb.int(1, 1), pb.str(9, 'elec')), relate(false), relate(true), pb.str(23, 'l'), pb.str(30, 'c'), pb.str(31, 'c'), pb.str(41, 'c'), pb.str(50, 's'));
    const { result } = await respond('bilibili.app.view.v1.View/View', ipad);
    const fields = decode(processed(result));
    assert.deepEqual(fields.map(f => f.no), [1, 4, 10]);
    assert.deepEqual(decode(fields[1].value).map(f => f.no), [1]);

    const progress = await respond('bilibili.app.view.v1.View/ViewProgress', concat(pb.str(1, 'guide'), pb.msg(2, pb.str(1, 'md5'))));
    assert.deepEqual(decode(processed(progress.result)).map(f => f.no), [2]);

    const unite = await respond('bilibili.app.viewunite.v1.View/ViewProgress', concat(pb.msg(2, pb.str(1, 'md5')), pb.str(4, 'dm')));
    assert.deepEqual(decode(processed(unite.result)).map(f => f.no), [2]);
});

/* ---------------- 异常情况：一律原样放行 ---------------- */

test('未知接口、损坏的响应、多帧响应都放行（$done({})）', async () => {
    const unknown = await respond('bilibili.app.unknown.v1.Foo/Bar', mainList);
    assertPassThrough(unknown.result);

    const broken = await runScript(GRPC_SCRIPT, {
        url: GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'),
        headers: { te: 'trailers' },
        response: { headers: {}, bodyBytes: concat([0, 0, 0, 0, 50], [1, 2, 3]) },
    });
    assertPassThrough(broken.result);

    const twoFrames = concat(grpcFrame(mainList), grpcFrame(mainList));
    const multi = await runScript(GRPC_SCRIPT, {
        url: GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'),
        headers: { te: 'trailers' },
        response: { headers: {}, bodyBytes: twoFrames },
    });
    assertPassThrough(multi.result);

    const garbage = await respond('bilibili.main.community.reply.v1.Reply/MainList', Uint8Array.from([0x0f, 0xff, 0xff]));
    assertPassThrough(garbage.result);
});

test('gRPC-Web trailer 帧原样保留', async () => {
    const trailer = concat([0x80, 0, 0, 0, 15], Array.from(new TextEncoder().encode('grpc-status:0\r\n')));
    const { result } = await runScript(GRPC_SCRIPT, {
        url: GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'),
        headers: { 'user-agent': UA_PINK, te: 'trailers' },
        response: { headers: { 'content-type': 'application/grpc' }, bodyBytes: concat(grpcFrame(mainList), trailer) },
    });
    const frame = unframe(bytesOf(result.bodyBytes));
    assert.deepEqual(frame.rest, trailer);
});

test('gzip 解压与 Node zlib 一致（随机数据 / 各压缩等级 / 大块数据）', async () => {
    const sizes = [0, 1, 100, 5000, 70000];
    for (const size of sizes) {
        for (const level of [0, 1, 6, 9]) {
            const data = new Uint8Array(size);
            for (let i = 0; i < size; i++) data[i] = i % 7 === 0 ? (Math.random() * 256) | 0 : 'bilibili'.charCodeAt(i % 8);
            // 带一条广告，迫使脚本解压、删除后重新编码；其余数据必须原样保留
            const kept = pb.bytes(1, data);
            const message = concat(kept, pb.msg(4, pb.str(4, 'special_ad')));
            const { result } = await runScript(GRPC_SCRIPT, {
                url: GRPC_URL('bilibili.polymer.app.search.v1.Search/SearchAll'),
                headers: { te: 'trailers' },
                response: { headers: {}, bodyBytes: grpcFrame(message, zlib.gzipSync(message, { level })) },
            });
            const frame = unframe(bytesOf(result.bodyBytes));
            assert.equal(frame.flag, 0);
            assert.deepEqual(frame.message, kept, `size=${size} level=${level}`);
        }
    }
});

/* ---------------- 请求阶段：mock ---------------- */

const LOON_MOCKS = {
    'bilibili.app.interface.v1.Teenagers/ModeStatus': 'AAAAABMKEQgCEgl0ZWVuYWdlcnMgAioA',
    'bilibili.app.interface.v1.Search/DefaultWords': 'AAAAACEaHeaQnOe0ouinhumikeOAgeeVquWJp+aIlnVw5Li7KAE=',
    'bilibili.app.view.v1.View/TFInfo': 'AAAAAAA=',
    'bilibili.app.viewunite.v1.View/PlayPause': 'AAAAAAA=',
    'bilibili.app.viewunite.v1.View/ViewEndPage': 'AAAAAAA=',
};

for (const [method, base64] of Object.entries(LOON_MOCKS)) {
    test(`mock：${method} 与 Loon 插件返回的内容一致`, async () => {
        for (const host of ['grpc.biliapi.net', 'app.bilibili.com']) {
            const { result, fetchCalls } = await runScript(GRPC_SCRIPT, { url: `https://${host}/${method}`, headers: { 'user-agent': UA_PINK } });
            assert.equal(result.status, 'HTTP/1.1 200 OK');
            assert.equal(result.headers['grpc-status'], '0');
            assert.equal(result.headers['Content-Type'], 'application/grpc');
            assert.deepEqual(Buffer.from(bytesOf(result.bodyBytes)).toString('base64'), base64);
            assert.equal(fetchCalls.length, 0);
        }
    });
}

/* ---------------- 请求阶段：优化评论区加载 ---------------- */

const REQUEST_BODY = grpcFrame(concat(pb.int(1, 114514), pb.int(2, 1)));
const okResponse = (message = mainList, headers = {}) =>
    Promise.resolve({
        statusCode: 200,
        headers: { 'Content-Type': 'application/grpc', 'Content-Length': '999', 'Content-Encoding': 'gzip', 'grpc-encoding': 'gzip', ...headers },
        bodyBytes: grpcFrame(message, zlib.gzipSync(message)).buffer,
    });

function optimize(url, fetch, headers = {}) {
    return runScript(GRPC_SCRIPT, {
        url,
        headers: { Host: new URL(url).host, 'Content-Length': String(REQUEST_BODY.length), 'user-agent': UA_PINK, te: 'trailers', 'content-type': 'application/grpc', 'x-bili-metadata-bin': 'abc', ...headers },
        body: REQUEST_BODY,
        fetch,
    });
}

test('优化评论区加载：脚本请求成功时直接返回去广告后的完整响应', async () => {
    const { result, fetchCalls } = await optimize(GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'), () => okResponse());
    assert.equal(fetchCalls.length, 1);
    const request = fetchCalls[0];
    assert.equal(request.url, GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'));
    assert.equal(request.method, 'POST');
    assert.deepEqual(bytesOf(request.bodyBytes), REQUEST_BODY);
    assert.deepEqual(Object.keys(request.headers).sort(), ['content-type', 'te', 'user-agent', 'x-bili-metadata-bin', 'x-bili-remove-ads']);
    assert.equal(result.status, 'HTTP/1.1 200 OK');
    assert.equal(result.headers['grpc-status'], '0');
    assert.equal(result.headers['grpc-encoding'], 'gzip');
    assert.equal(result.headers['Content-Length'], undefined);
    assert.equal(result.headers['Content-Encoding'], undefined);
    assert.deepEqual(decode(unframe(bytesOf(result.bodyBytes)).message).map(f => f.no), [1, 14, 15, 28, 99]);
});

test('优化评论区加载：grpc.biliapi.net 失败后换 app.bilibili.com', async () => {
    const { result, fetchCalls } = await optimize(GRPC_URL('bilibili.app.viewunite.v1.View/View'), (request, index) =>
        index === 0 ? Promise.reject({ error: 'The network connection was lost.' }) : okResponse(viewReply)
    );
    assert.deepEqual(fetchCalls.map(r => new URL(r.url).host), ['grpc.biliapi.net', 'app.bilibili.com']);
    assert.equal(result.status, 'HTTP/1.1 200 OK');
    assert.deepEqual(decode(unframe(bytesOf(result.bodyBytes)).message).map(f => f.no), [1, 3, 5, 20, 21]);
});

test('优化评论区加载：响应无效（非 200 / grpc-status 非 0 / 非 gRPC）时不采用', async () => {
    const responses = [
        Promise.resolve({ statusCode: 503, headers: { 'content-type': 'application/grpc' }, bodyBytes: grpcFrame(mainList).buffer }),
        okResponse(mainList, { 'grpc-status': '13' }),
    ];
    const { result, fetchCalls } = await optimize(GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'), (request, index) => responses[index]);
    assert.equal(fetchCalls.length, 2);
    assertPassThrough(result);

    const html = await optimize('https://app.bilibili.com/bilibili.main.community.reply.v1.Reply/MainList', () =>
        Promise.resolve({ statusCode: 200, headers: { 'content-type': 'text/html' }, bodyBytes: new TextEncoder().encode('<html></html>').buffer })
    );
    assert.equal(html.fetchCalls.length, 1);
    assertPassThrough(html.result);
});

test('优化评论区加载：全部失败或超时则放行原请求', async () => {
    const failed = await optimize(GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'), () => Promise.reject({ error: 'offline' }));
    assert.equal(failed.fetchCalls.length, 2);
    assertPassThrough(failed.result);

    const started = Date.now();
    const hung = await optimize('https://app.bilibili.com/bilibili.main.community.reply.v1.Reply/MainList', () => new Promise(() => {}));
    assertPassThrough(hung.result);
    assert.ok(Date.now() - started >= 2900 && Date.now() - started < 6000);
});

test('优化评论区加载：脚本自己发出的请求（带标记）直接放行，避免循环', async () => {
    const { result, fetchCalls } = await optimize(GRPC_URL('bilibili.main.community.reply.v1.Reply/MainList'), () => okResponse(), { 'x-bili-remove-ads': '1' });
    assert.equal(fetchCalls.length, 0);
    assertPassThrough(result);
});

test('请求阶段：其他接口直接放行', async () => {
    const { result, fetchCalls } = await optimize(GRPC_URL('bilibili.app.dynamic.v2.Dynamic/DynAll'), () => okResponse());
    assert.equal(fetchCalls.length, 0);
    assertPassThrough(result);
});

/* ---------------- 非默认设置 ---------------- */

const withSetting = (key, value) => code => {
    const replaced = code.replace(new RegExp(`(\\n\\s*${key}: )[^,]+,`), `$1${JSON.stringify(value)},`);
    assert.notEqual(replaced, code, `未找到设置项 ${key}`);
    return replaced;
};

function respondWith(transform, method, message) {
    return runScript(GRPC_SCRIPT, {
        url: GRPC_URL(method),
        headers: { 'user-agent': UA_PINK, te: 'trailers' },
        response: { headers: { 'content-type': 'application/grpc' }, bodyBytes: grpcFrame(message) },
        transform,
    });
}

const upItem = name => pb.msg(2, pb.str(1, name));
const dynWithUpList = live =>
    concat(pb.msg(1, pb.msg(1, pb.int(1, 1))), pb.msg(2, pb.int(1, 7), upItem('up1'), upItem('up2'), ...(live ? [pb.int(4, 1), pb.msg(10, pb.str(1, 'live1')), pb.msg(10, pb.str(1, 'live2'))] : [])));

test('设置 displayUpList: hide → 去掉最常访问', async () => {
    const { result } = await respondWith(withSetting('displayUpList', 'hide'), 'bilibili.app.dynamic.v2.Dynamic/DynAll', dynWithUpList(true));
    assert.deepEqual(decode(processed(result)).map(f => f.no), [1]);
});

test('设置 displayUpList: auto → 没有直播时去掉，有直播时把直播移到前面并加分隔', async () => {
    const transform = withSetting('displayUpList', 'auto');
    const none = await respondWith(transform, 'bilibili.app.dynamic.v2.Dynamic/DynAll', dynWithUpList(false));
    assert.deepEqual(decode(processed(none.result)).map(f => f.no), [1]);

    const live = await respondWith(transform, 'bilibili.app.dynamic.v2.Dynamic/DynAll', dynWithUpList(true));
    const upList = fieldsOf(processed(live.result), 2)[0].value;
    assert.deepEqual(decode(upList).map(f => f.no), [1, 2, 2, 2, 2, 4]);
    const items = fieldsOf(upList, 2).map(f => f.value);
    assert.deepEqual(items.map(item => text(fieldsOf(item, 1)[0].value)), ['live1', 'live2', 'up1', 'up2']);
    assert.deepEqual(items.map(item => (fieldsOf(item, 11)[0] || {}).value), [undefined, 1, undefined, undefined]);
});

test('设置 purifyComment: false → 保留带货置顶评论', async () => {
    const { result } = await respondWith(withSetting('purifyComment', false), 'bilibili.main.community.reply.v1.Reply/MainList', mainList);
    assert.equal(fieldsOf(processed(result), 14).length, 3);
});
