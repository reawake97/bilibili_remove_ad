/**
 * 哔哩哔哩去广告 · JSON 处理脚本（Quantumult X 专用）
 *
 * 仓库：https://github.com/reawake97/bilibili_remove_ad
 * 许可：GPL-3.0-or-later
 *
 * 对应 Loon 插件「哔哩哔哩去广告」中用 jq 文件 / 脚本处理的接口，逻辑与数据移植自 kokoryh/Sparkle（GPL-3.0）：
 *   /x/resource/show/tab/v2                 首页顶部与底部标签（tab_Bilibili_remove_ads.jq）
 *   /x/v2/account/mine(/ipad)               「我的」页面（mine_Bilibili_remove_ads.jq，不含伪装大会员的部分）
 *   /xlive/app-interface/v2/index/feed      直播首页
 *   /xlive/app-room/v1/index/getInfoByRoom  直播间
 *   /xlive/app-room/v1/index/getInfoByUser  直播间（用户信息）
 */

const I18N = {
    'zh-Hans_CN': {
        live: '直播',
        for_you: '推荐',
        trending: '热门',
        anime: '动画',
        film: '影视',
        messages: '消息',
        home: '首页',
        following: '动态',
        me: '我的',
        downloads: '离线缓存',
        history: '历史记录',
        my_favorites: '我的收藏',
        watch_later: '稍后再看',
        recommended_services: '推荐服务',
        customization: '个性装扮',
        mall: '会员购',
        my_wallet: '我的钱包',
        live_studio: '我的直播',
        more_services: '更多服务',
        help_center: '联系客服',
        settings: '设置',
    },
    'zh-Hant_HK': {
        live: '直播',
        for_you: '推薦',
        trending: '熱門',
        anime: '動畫',
        film: '影視',
        messages: '訊息',
        home: '首頁',
        following: '關注',
        me: '我的',
        downloads: '離線快取',
        history: '歷史記錄',
        my_favorites: '我的收藏',
        watch_later: '稍後再看',
        recommended_services: '我的服務',
        customization: '個性裝扮',
        mall: '會員購',
        my_wallet: '我的錢包',
        live_studio: '我的直播',
        more_services: '更多服務',
        help_center: '聯絡客服',
        settings: '設定',
    },
    en: {
        live: 'Live',
        for_you: 'For You',
        trending: 'Trending',
        anime: 'Anime',
        film: 'Film & TV',
        messages: 'Messages',
        home: 'Home',
        following: 'Following',
        me: 'Me',
        downloads: 'Downloads',
        history: 'History',
        my_favorites: 'My Favorites',
        watch_later: 'Watch Later',
        recommended_services: 'Recommended Services',
        customization: 'Customization',
        mall: 'Mall',
        my_wallet: 'My Wallet',
        live_studio: 'Live Studio',
        more_services: 'More Services',
        help_center: 'Help Center',
        settings: 'Settings',
    },
    ja: {
        live: 'ライブ',
        for_you: 'おすすめ',
        trending: '急上昇',
        anime: 'アニメ',
        film: '映画・ドラマ',
        messages: 'メッセージ',
        home: 'ホーム',
        following: 'フォロー',
        me: 'マイページ',
        downloads: 'オフライン保存',
        history: '履歴',
        my_favorites: 'お気に入り',
        watch_later: '後で見る',
        recommended_services: 'マイサービス',
        customization: 'カスタマイズ',
        mall: 'モール',
        my_wallet: 'ウォレット',
        live_studio: '配信スタジオ',
        more_services: 'その他のサービス',
        help_center: 'ヘルプセンター',
        settings: '設定',
    },
};

function getLayout(t) {
    return {
        tab: [
            { pos: 1, id: 731, name: t.live, tab_id: '直播tab', uri: 'bilibili://live/home' },
            { pos: 2, id: 477, name: t.for_you, tab_id: '推荐tab', uri: 'bilibili://pegasus/promo', default_selected: 1 },
            { pos: 3, id: 478, name: t.trending, tab_id: '热门tab', uri: 'bilibili://pegasus/hottopic' },
            { pos: 4, id: 3502, name: t.anime, tab_id: 'bangumi', uri: 'bilibili://pgc/bangumi_v2' },
            { pos: 5, id: 3503, name: t.film, tab_id: 'film', uri: 'bilibili://pgc/cinema_v2' },
        ],
        top: [
            {
                pos: 1,
                id: 176,
                name: t.messages,
                tab_id: '消息Top',
                uri: 'bilibili://link/im_home',
                icon: 'http://i0.hdslb.com/bfs/archive/d43047538e72c9ed8fd8e4e34415fbe3a4f632cb.png',
            },
        ],
        bottom: [
            {
                pos: 1,
                id: 177,
                name: t.home,
                tab_id: 'home',
                uri: 'bilibili://main/home/',
                icon: 'http://i0.hdslb.com/bfs/archive/63d7ee88d471786c1af45af86e8cb7f607edf91b.png',
                icon_selected: 'http://i0.hdslb.com/bfs/archive/e5106aa688dc729e7f0eafcbb80317feb54a43bd.png',
            },
            {
                pos: 2,
                id: 179,
                name: t.following,
                tab_id: 'dynamic',
                uri: 'bilibili://following/home/',
                icon: 'http://i0.hdslb.com/bfs/archive/86dfbe5fa32f11a8588b9ae0fccb77d3c27cedf6.png',
                icon_selected: 'http://i0.hdslb.com/bfs/archive/25b658e1f6b6da57eecba328556101dbdcb4b53f.png',
            },
            {
                pos: 5,
                id: 181,
                name: t.me,
                tab_id: '我的Bottom',
                uri: 'bilibili://user_center/',
                icon: 'http://i0.hdslb.com/bfs/archive/4b0b2c49ffeb4f0c2e6a4cceebeef0aab1c53fe1.png',
                icon_selected: 'http://i0.hdslb.com/bfs/archive/a54a8009116cb896e64ef14dcf50e5cade401e00.png',
            },
        ],
    };
}

function ipadItem(id, title, uri, icon) {
    return { id, title, uri, icon: `http://i0.hdslb.com/bfs/feed-admin/${icon}.png`, mng_resource: { icon_id: 0, icon: '' } };
}

function getSections(t) {
    const item = (id, title, uri, icon, extra) =>
        Object.assign({ id, title, uri, icon: `http://i0.hdslb.com/bfs/archive/${icon}.png` }, extra, { common_op_item: {} });
    return {
        sections_v2: [
            {
                items: [
                    item(396, t.downloads, 'bilibili://user_center/download', '5fc84565ab73e716d20cd2f65e0e1de9495d56f8'),
                    item(397, t.history, 'bilibili://user_center/history', '8385323c6acde52e9cd52514ae13c8b9481c1a16'),
                    item(3072, t.my_favorites, 'bilibili://user_center/favourite?version=2', 'd79b19d983067a1b91614e830a7100c05204a821'),
                    item(2830, t.watch_later, 'bilibili://user_center/watch_later_v2', '63bb768caa02a68cb566a838f6f2415f0d1d02d6', { need_login: 1 }),
                ],
                style: 1,
                button: {},
            },
            {
                title: t.recommended_services,
                items: [
                    item(402, t.customization, 'https://www.bilibili.com/h5/mall/home?navhide=1&f_source=shop&from=myservice', '0bcad10661b50f583969b5a188c12e5f0731628c'),
                    item(622, t.mall, 'bilibili://mall/home', '19c794f01def1a267b894be84427d6a8f67081a9'),
                    item(404, t.my_wallet, 'bilibili://bilipay/mine_wallet', 'f416634e361824e74a855332b6ff14e2e7c2e082'),
                    item(406, t.live_studio, 'bilibili://user_center/live_center', '1db5791746a0112890b77a0236baf263d71ecb27'),
                ],
                style: 1,
                button: {},
            },
            {
                title: t.more_services,
                items: [
                    item(407, t.help_center, 'bilibili://user_center/feedback', '7ca840cf1d887a45ee1ef441ab57845bf26ef5fa'),
                    item(410, t.settings, 'bilibili://user_center/setting', 'e932404f2ee62e075a772920019e9fbdb4b5656a'),
                ],
                style: 2,
                button: {},
            },
        ],
        ipad_sections: [
            ipadItem(747, '离线缓存', 'bilibili://user_center/download', '9bd72251f7366c491cfe78818d453455473a9678'),
            ipadItem(748, '历史记录', 'bilibili://user_center/history', '83862e10685f34e16a10cfe1f89dbd7b2884d272'),
            ipadItem(749, '我的收藏', 'bilibili://user_center/favourite', '6ae7eff6af627590fc4ed80c905e9e0a6f0e8188'),
            ipadItem(750, '稍后再看', 'bilibili://user_center/watch_later', '928ba9f559b02129e51993efc8afe95014edec94'),
        ],
        ipad_upper_sections: [ipadItem(752, '创作首页', '/uper/homevc', 'd20dfed3b403c895506b1c92ecd5874abb700c01')],
        ipad_recommend_sections: [
            ipadItem(755, '我的关注', 'bilibili://user_center/myfollows', 'fdd7f676030c6996d36763a078442a210fc5a8c0'),
            ipadItem(756, '我的消息', 'bilibili://link/im_home', 'e1471740130a08a48b02a4ab29ed9d5f2281e3bf'),
        ],
        ipad_more_sections: [
            ipadItem(763, '我的客服', 'bilibili://user_center/feedback', '7801a6180fb67cf5f8ee05a66a4668e49fb38788'),
            ipadItem(764, '设置', 'bilibili://user_center/setting', '34e8faea00b3dd78977266b58d77398b0ac9410b'),
        ],
    };
}

function getLocale(query) {
    const match = /[?&]s_locale=([^&#]*)/.exec(query || '');
    const locale = match ? decodeURIComponent(match[1]) : '';
    return I18N[locale] || I18N['zh-Hans_CN'];
}

// 只替换响应里已有的键
function patchExisting(target, patch) {
    for (const key of Object.keys(patch)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) target[key] = patch[key];
    }
}

function setAllValuesToNull(object) {
    for (const key of Object.keys(object)) object[key] = null;
}

const HANDLERS = {
    '/x/resource/show/tab/v2'(data, t) {
        patchExisting(data, getLayout(t));
    },

    '/x/v2/account/mine'(data, t) {
        ['answer', 'live_tip', 'vip_section', 'vip_section_v2', 'modular_vip_section'].forEach(key => delete data[key]);
        const sections = getSections(t);
        for (const key of Object.keys(sections)) {
            if (data[key]) data[key] = sections[key];
        }
    },

    '/xlive/app-interface/v2/index/feed'(data) {
        if (Array.isArray(data.card_list)) {
            data.card_list = data.card_list.filter(card => !['banner_v2', 'activity_card_v1'].includes(card.card_type));
        }
    },

    '/xlive/app-room/v1/index/getInfoByRoom'(data) {
        data.big_card_info = null;
        data.show_reserve_status = false;
        if (data.reserve_info) data.reserve_info.show_reserve_status = false;
        if (data.shopping_info) data.shopping_info.is_show = 0;
        if (data.activity_banner_info) setAllValuesToNull(data.activity_banner_info);
        if (data.function_card) setAllValuesToNull(data.function_card);
        const tabs = data.new_tab_info;
        if (tabs) {
            if (Array.isArray(tabs.outer_list)) tabs.outer_list = tabs.outer_list.filter(tab => tab.biz_id !== 33);
            if (Array.isArray(tabs.candidate_list) && Array.isArray(tabs.v2_outer_list)) {
                const excluded = [33, 36, 162, 186];
                tabs.candidate_list = tabs.candidate_list.filter(tab => !excluded.includes(tab.biz_id));
                tabs.v2_outer_list.forEach(tab => {
                    if (Array.isArray(tab.indices)) tab.indices = tab.indices.filter(id => !excluded.includes(id));
                });
            }
        }
    },

    '/xlive/app-room/v1/index/getInfoByUser'(data) {
        delete data.play_together_info;
        delete data.play_together_info_v2;
        if (data.function_card) setAllValuesToNull(data.function_card);
    },
};
HANDLERS['/x/v2/account/mine/ipad'] = HANDLERS['/x/v2/account/mine'];

(() => {
    try {
        const match = /^https?:\/\/[^/?#]+([^?#]*)(\?[^#]*)?/i.exec($request.url) || [];
        const handler = HANDLERS[match[1]];
        const body = handler && JSON.parse($response.body);
        if (!body || body.code !== 0 || !body.data || typeof body.data !== 'object') return $done({});
        handler(body.data, getLocale(match[2]));
        $done({ body: JSON.stringify(body) });
    } catch (e) {
        console.log(`[哔哩哔哩去广告][error] ${e}`);
        $done({});
    }
})();
