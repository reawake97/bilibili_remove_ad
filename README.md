# 哔哩哔哩去广告 · Quantumult X 修复版

修复 [墨鱼 BiliBiliAds.conf](https://ddgksf2013.top/rewrite/BiliBiliAds.conf) 在 Quantumult X 里导致**评论区加载不出来**的问题。规则按 Loon 插件 [哔哩哔哩去广告](https://kelee.one/Tool/Loon/Lpx/Bilibili_remove_ads.lpx)（作者 kokoryh）逐条移植，配套的 QX 专用脚本不依赖任何第三方库。

## 订阅

```ini
[rewrite_remote]
https://raw.githubusercontent.com/reawake97/bilibili_remove_ad/main/Bilibili_remove_ads.conf, tag=哔哩哔哩去广告, update-interval=172800, opt-parser=false, enabled=true

[filter_remote]
# 可选，对应 Loon 插件的 [Rule]：屏蔽备用 API 域名与 P2P。不要设置 force-policy
https://raw.githubusercontent.com/reawake97/bilibili_remove_ad/main/Bilibili_remove_ads.list, tag=哔哩哔哩去广告, update-interval=172800, opt-parser=false, enabled=true
```

使用前请注意：

1. 停用墨鱼的 BiliBiliAds.conf 以及其他哔哩哔哩去广告重写，规则重复会互相干扰。
2. 需要已安装并信任 MitM 证书。hostname 已写在重写里；如果你在本地 `[mitm]` 里手写过 `*.bilibili.com`、`*.biliapi.net` 之类的通配，建议删掉。
3. 需要支持 `jsonjq-response-body` 的 Quantumult X（build 845 及以上）。
4. 启用后杀掉哔哩哔哩重新打开。开屏广告有本地缓存，可能要过一两次才消失。

| 文件 | 说明 |
| --- | --- |
| `Bilibili_remove_ads.conf` | 完整版（推荐） |
| `Bilibili_remove_ads_lite.conf` | 精简版：不解密 gRPC，视频详情、评论区、弹幕等 gRPC 请求完全不经过脚本；代价是视频页、动态、搜索里的广告不会去除。完整版仍有问题时再用，两者不要同时启用 |
| `Bilibili_remove_ads.list` | 可选分流规则 |
| `scripts/bilibili.grpc.js` | gRPC 脚本 |
| `scripts/bilibili.json.js` | JSON 脚本（首页标签、我的页面、直播） |

## 评论区为什么加载不出来

问题出在墨鱼配置对 gRPC 的处理上。

**1. 改写过的 gRPC 响应缺少 `grpc-status`。** 视频详情 `bilibili.app.viewunite.v1.View/View`（评论 Tab 的配置也在这个响应里）和评论列表 `bilibili.main.community.reply.v1.Reply/MainList` 都走 gRPC。gRPC 的结果码 `grpc-status` 放在 HTTP trailers 里，代理用脚本改写响应体后 trailers 会丢失，而新版客户端（请求头带 `x-bili-moss-engine-type: 1`）收到没有 `grpc-status` 的响应会直接判为失败。

2026 年 1 月，kokoryh/Sparkle（[5b755f9](https://github.com/kokoryh/Sparkle/commit/5b755f94deb584b23bbd3973ea508a27cd842e2a)、[58bd211](https://github.com/kokoryh/Sparkle/commit/58bd211f0147def0a8dea7257a775dbbf678a68b)）和 BiliUniverse（现 Biliverse）ADBlock（[e8b7051](https://github.com/Biliverse/ADBlock/commit/e8b70518a52ffe109f5554f3bb1b7b6e4a04a216)，[v0.6.23](https://github.com/Biliverse/ADBlock/releases/tag/v0.6.23) 更新说明「修复 grpc 响应头缺失的问题」）先后加入了给改写过的响应补 `grpc-status: 0` 的修复。墨鱼配置至今仍固定引用 2025 年 4 月的 ADBlock **v0.6.19** `response.bundle.js`（约 0.9 MB）来改写 View/View 等接口：响应被客户端判为失败，评论区就加载不出来。

**2. MitM 范围过大。** `*.bilibili.com, *.bili*.*, *.bilibili.*, *biliapi.net` 这些通配几乎解密了哔哩哔哩的全部流量。Quantumult X 的 MitM 不支持 HTTP/2，客户端在 HTTP/1.1 下会改走 app.bilibili.com（见 [app2smile 的说明](https://github.com/app2smile/rules/blob/master/module/bilibili.sgmodule)），解密的范围越大越慢。

**Loon 插件为什么没问题：** Loon 支持 MitM over HTTP/2（插件说明里要求开启）；它用的 kokoryh 脚本会补 `grpc-status`；另外还有「优化评论区加载异常」（`optimizeRequest`），让脚本自己请求 View/View 和 MainList，失败时换主机重试。

## 这个仓库怎么修

- **按 Loon 插件逐条移植**：`response.json.jq` → `jsonjq-response-body`；`response.body.mock`（JSON）→ jq 常量；`reject_dict` → `reject-dict`；`jq_file`（首页标签、我的页面）和直播脚本 → `bilibili.json.js`；gRPC mock 与 protobuf 脚本 → `bilibili.grpc.js`。
- **重写 gRPC 脚本**：kokoryh 的脚本在 QX 下会直接报错 `QuantumultX is not supported`，kelee.one 的资源也只对 Loon 开放，所以重写了一个 QX 专用、无第三方依赖的版本（约 36 KB）：
  - 直接在 protobuf 线格式上删除 / 过滤广告字段，没有改动的字段（包括评论 Tab）逐字节保留，不依赖完整的 proto 定义；
  - 按 kokoryh 与 Biliverse 的规则补 `grpc-status` 响应头：粉版、蓝版补，白版（国际版）不补；
  - 自带 gzip 解压（QX 没有 `$utils.ungzip`）；
  - 解析失败、流式多帧等情况一律原样放行，不会把响应改坏。
- **收窄 MitM**：只解密 app.bilibili.com、api.bilibili.com、api.live.bilibili.com、grpc.biliapi.net、line3-h5-mobile-api.biligame.com、manga.bilibili.com。
- **测试**：`test/` 里用 Node 模拟 QX 的脚本环境（没有 `TextDecoder` / `URL`，提供 `$request`、`$response`、`$task`、`$done`），覆盖各接口的去广告结果、未知字段保留、gzip（与 Node zlib 对拍）、`grpc-status` 规则、mock 与 Loon 插件逐字节一致、jq 表达式（用 jq 实跑）、规则路由等。运行：`node --test test/*.test.mjs`。

## 与 Loon 插件的对照

| Loon 插件 | 本重写 |
| --- | --- |
| 开屏：splash show / event/list2 / list | jsonjq |
| 首页标签 tab/v2（jq_file） | `bilibili.json.js` |
| 推荐流 feed/index、竖屏视频流 feed/index/story | jsonjq |
| 右上角活动、patch tab、热搜发现、vip ads materials（mock -404） | jsonjq 常量 |
| 我的页面 mine(/ipad)（jq_file） | `bilibili.json.js`（不含伪装大会员的部分） |
| 统一皮肤 skin | jsonjq |
| 番剧：deliver/material/receive、view/v2/app/season、page/channel | jsonjq |
| 直播：购物信息、游戏大卡片、直播首页与直播间 | reject-dict / `bilibili.json.js` |
| P2P：pd-proxy tracker、直播 tracker conf | jsonjq（配合可选分流规则） |
| gRPC mock：青少年模式、搜索默认词、TFInfo、PlayPause、ViewEndPage | `bilibili.grpc.js`（script-request-header） |
| gRPC：DynAll、Popular、View/View、ViewProgress、RelatesFeed、AIRelateAsync、PlayViewUnite、SearchAll、DmView、MainList、pgc PlayView | `bilibili.grpc.js`（script-response-body） |
| 优化评论区加载 optimizeRequest | `bilibili.grpc.js`（script-request-body），默认注释，见下 |
| [Rule]：备用 API 域名、P2P | `Bilibili_remove_ads.list` |
| —— | 额外保留墨鱼原配置里的番剧小卡片、「点击追番」卡片、白版搜索默认词、漫画开屏（reject-dict） |

## 「优化评论区加载」

Loon 插件里默认开启，这里默认注释掉。它依赖 `$task.fetch` 重新发出 gRPC 请求，这一路径没有在 QX 真机上验证过；评论区的修复靠的是上面补的 `grpc-status`，并不依赖它。如果启用完整版后评论区仍然加载得慢，可以把重写里那一行取消注释试试（需要把远程重写复制到本地编辑，或 fork 本仓库）。脚本请求失败时会自动放行原请求。

## 没有移植的部分

- **伪装大会员、解除后台播放 / 投屏限制**（Loon 插件里的 myinfo 与我的页面 vip 字段、`PlayURL/PlayView` 与 `PlayViewUnite` 的播放能力配置）：这些是解锁付费功能，不属于去广告。
- **空降助手（SponsorBlock）**：依赖第三方服务，Loon 插件里也默认关闭。
- **插件参数**：QX 没有插件参数，固定为 Loon 插件的默认值（动态「最常访问」显示，移除评论区置顶广告开启）。要修改请 fork 后改 `scripts/bilibili.grpc.js` 顶部的 `SETTINGS`。
- **逻辑 / 端口分流规则**：AND/OR 规则改写成等价的 `host-wildcard`；`DEST-PORT` 规则 QX 不支持。

## 已知限制

- 只在本地模拟的 QX 脚本环境里测试过，没有在 iOS 真机上的 Quantumult X 中实测。遇到问题请提 issue，并附上 QX 日志（脚本日志前缀为 `[哔哩哔哩去广告]`，把 `SETTINGS.logLevel` 改为 `debug` 可看到更多信息）。
- QX 不支持 MitM over HTTP/2，这一点重写解决不了，完整版里的 gRPC 请求会走 HTTP/1.1。如果评论区或视频页仍偶发异常，换精简版即可。

## 致谢与许可

- [kokoryh/Sparkle](https://github.com/kokoryh/Sparkle)：Loon 插件所用的脚本、jq 与 proto 字段定义
- [iKeLee](https://hub.kelee.one)：Loon 插件「哔哩哔哩去广告」
- [Biliverse/ADBlock](https://github.com/Biliverse/ADBlock)：`grpc-status` 响应头规则
- [app2smile/rules](https://github.com/app2smile/rules)、[ddgksf2013](https://ddgksf2013.top)

脚本移植自 GPL-3.0 项目 kokoryh/Sparkle，本仓库同样以 [GPL-3.0](LICENSE) 发布。
