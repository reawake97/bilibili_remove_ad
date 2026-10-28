import test from 'node:test';
import assert from 'node:assert/strict';
import { JSON_SCRIPT, runScript, assertPassThrough } from './helpers.mjs';

function run(url, body) {
    return runScript(JSON_SCRIPT, { url, method: 'GET', response: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } });
}

const parse = result => JSON.parse(result.body);

test('首页标签：按 s_locale 本地化，且只替换响应里已有的键', async () => {
    const body = { code: 0, data: { tab: [{ id: 1, name: '游戏中心' }], bottom: [{ id: 9, name: '会员购' }], extra: 1 } };
    const { result } = await run('https://app.bilibili.com/x/resource/show/tab/v2?mobi_app=iphone&s_locale=zh-Hant_HK', body);
    const data = parse(result).data;
    assert.deepEqual(data.tab.map(t => t.name), ['直播', '推薦', '熱門', '動畫', '影視']);
    assert.deepEqual(data.bottom.map(t => t.name), ['首頁', '關注', '我的']);
    assert.equal(data.top, undefined);
    assert.equal(data.extra, 1);

    const zh = await run('https://app.bilibili.com/x/resource/show/tab/v2?mobi_app=iphone', body);
    assert.deepEqual(parse(zh.result).data.tab.map(t => t.name), ['直播', '推荐', '热门', '动画', '影视']);
});

test('我的页面：替换服务列表、移除大会员推广，不伪装大会员', async () => {
    const vip = { status: 0, type: 0, due_date: 0 };
    const body = {
        code: 0,
        data: {
            mid: 1,
            vip: { ...vip },
            vip_type: 0,
            answer: { text: '答题' },
            live_tip: {},
            vip_section: {},
            vip_section_v2: {},
            modular_vip_section: {},
            sections_v2: [{ title: '创作中心' }, { title: '推荐服务', items: [{ title: '游戏中心' }] }],
            ipad_sections: [{ title: '游戏中心' }],
        },
    };
    for (const path of ['/x/v2/account/mine', '/x/v2/account/mine/ipad']) {
        const { result } = await run(`https://app.bilibili.com${path}?s_locale=zh-Hans_CN`, body);
        const data = parse(result).data;
        assert.deepEqual(data.vip, vip);
        assert.equal(data.vip_type, 0);
        for (const key of ['answer', 'live_tip', 'vip_section', 'vip_section_v2', 'modular_vip_section']) assert.equal(key in data, false);
        assert.deepEqual(data.sections_v2.map(s => s.title), [undefined, '推荐服务', '更多服务']);
        assert.deepEqual(data.sections_v2[0].items.map(i => i.title), ['离线缓存', '历史记录', '我的收藏', '稍后再看']);
        assert.equal(data.ipad_sections.length, 4);
        assert.equal('ipad_upper_sections' in data, false);
    }
});

test('直播：首页横幅、直播间活动 / 商品 / 预约等', async () => {
    const feed = await run('https://api.live.bilibili.com/xlive/app-interface/v2/index/feed?x=1', {
        code: 0,
        data: { card_list: [{ card_type: 'banner_v2' }, { card_type: 'small_card_v1' }, { card_type: 'activity_card_v1' }] },
    });
    assert.deepEqual(parse(feed.result).data.card_list, [{ card_type: 'small_card_v1' }]);

    const room = await run('https://api.live.bilibili.com/xlive/app-room/v1/index/getInfoByRoom?room_id=1', {
        code: 0,
        data: {
            room_info: { short_id: 1 },
            big_card_info: { a: 1 },
            show_reserve_status: true,
            reserve_info: { show_reserve_status: true },
            shopping_info: { is_show: 1 },
            activity_banner_info: { top: [1], bottom: [2] },
            function_card: { wish_list_card: {}, follow_card: {} },
            new_tab_info: {
                outer_list: [{ biz_id: 33 }, { biz_id: 1 }],
                candidate_list: [{ biz_id: 36 }, { biz_id: 2 }],
                v2_outer_list: [{ indices: [33, 2, 186] }],
            },
        },
    });
    const data = parse(room.result).data;
    assert.equal(data.big_card_info, null);
    assert.equal(data.show_reserve_status, false);
    assert.equal(data.reserve_info.show_reserve_status, false);
    assert.equal(data.shopping_info.is_show, 0);
    assert.deepEqual(data.activity_banner_info, { top: null, bottom: null });
    assert.deepEqual(data.function_card, { wish_list_card: null, follow_card: null });
    assert.deepEqual(data.new_tab_info.outer_list, [{ biz_id: 1 }]);
    assert.deepEqual(data.new_tab_info.candidate_list, [{ biz_id: 2 }]);
    assert.deepEqual(data.new_tab_info.v2_outer_list, [{ indices: [2] }]);

    const user = await run('https://api.live.bilibili.com/xlive/app-room/v1/index/getInfoByUser?room_id=1', {
        code: 0,
        data: { play_together_info: {}, play_together_info_v2: {}, function_card: { a: 1 }, info: 1 },
    });
    assert.deepEqual(parse(user.result).data, { function_card: { a: null }, info: 1 });
});

test('错误码、非 JSON、未知接口都原样放行', async () => {
    assertPassThrough((await run('https://app.bilibili.com/x/resource/show/tab/v2?x=1', { code: -400, data: null })).result);
    assertPassThrough((await run('https://app.bilibili.com/x/v2/account/mine?x=1', { code: 0 })).result);
    assertPassThrough((await run('https://app.bilibili.com/x/v2/unknown?x=1', { code: 0, data: {} })).result);
    const invalid = await runScript(JSON_SCRIPT, {
        url: 'https://app.bilibili.com/x/v2/account/mine?x=1',
        method: 'GET',
        response: { headers: {}, body: '<html>' },
    });
    assertPassThrough(invalid.result);
});
